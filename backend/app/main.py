"""FastAPI backend: meeting-room availability grid.

Two auth paths (see auth.py): paste a Graph access token (works without admin),
or sign in via Supabase's Azure OAuth provider once SUPABASE_* is configured.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import html
import json
import logging
from contextlib import asynccontextmanager
from datetime import date as date_cls, datetime, timedelta, timezone
from typing import Literal
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from starlette.middleware.sessions import SessionMiddleware

from . import auth, availability, graph
from .config import get_settings

log = logging.getLogger("vngmeet")
settings = get_settings()
AVAILABILITY_CACHE_TTL = timedelta(minutes=5)
SCHEDULE_MAX_DURATION_MINUTES = 3 * 60
_AVAILABILITY_REFRESH_LOCK = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start background jobs when their required integrations are configured."""
    scheduler = None
    if settings.supabase_enabled and not settings.availability_refresh_disabled:
        from apscheduler.schedulers.asyncio import AsyncIOScheduler
        from apscheduler.triggers.cron import CronTrigger

        scheduler = AsyncIOScheduler(timezone=settings.timezone)
        if settings.graph_app_enabled:
            scheduler.add_job(
                _safe_refresh,
                CronTrigger(
                    minute=settings.availability_refresh_minutes,
                    timezone=settings.timezone,
                ),
                id="refresh_availability",
                max_instances=1,
                coalesce=True,
                misfire_grace_time=120,
            )
        scheduler.add_job(
            _safe_process_scheduled_bookings,
            CronTrigger(hour=0, minute=0, second=15, timezone=settings.timezone),
            id="process_scheduled_bookings",
            max_instances=1,
            coalesce=True,
            misfire_grace_time=300,
        )
        scheduler.add_job(
            _safe_process_room_scouts,
            CronTrigger(minute="1,31", second=0, timezone=settings.timezone),
            id="process_room_scouts",
            max_instances=1,
            coalesce=True,
            misfire_grace_time=120,
        )
        if settings.graph_app_enabled:
            # Prime the cache shortly after boot so the grid isn't empty on first load.
            scheduler.add_job(_safe_refresh, "date", run_date=None)
        scheduler.start()
        log.warning(
            "Background scheduler started (availability=%s, scheduled_bookings=True, room_scouts=True, cron minute=%s).",
            settings.graph_app_enabled,
            settings.availability_refresh_minutes,
        )
    else:
        log.warning(
            "Background scheduler NOT started "
            "(supabase_enabled=%s, disabled=%s). "
            "Cache will refresh on demand from the requesting user's delegated token; "
            "scheduled bookings and room scouts will not run automatically.",
            settings.supabase_enabled,
            settings.availability_refresh_disabled,
        )
    try:
        yield
    finally:
        if scheduler:
            scheduler.shutdown(wait=False)


async def _safe_refresh() -> None:
    """Scheduler entry point: never let an exception kill the job thread."""
    try:
        await availability.refresh_availability()
    except Exception as e:  # noqa: BLE001
        log.exception("refresh_availability failed: %s", e)


async def _safe_process_scheduled_bookings() -> None:
    """Scheduler entry point for pending schedule bookings."""
    try:
        await process_scheduled_bookings()
    except Exception as e:  # noqa: BLE001
        log.exception("process_scheduled_bookings failed: %s", e)


async def _safe_process_room_scouts() -> None:
    """Scheduler entry point for Room Scout notifications."""
    try:
        await process_room_scouts()
    except Exception as e:  # noqa: BLE001
        log.exception("process_room_scouts failed: %s", e)


app = FastAPI(title="VNG Meet — Meeting Room Availability", lifespan=lifespan)

app.add_middleware(SessionMiddleware, secret_key=settings.session_secret, same_site="lax")
# FRONTEND_URL may be a comma-separated list so the same backend can serve
# multiple origins (e.g. local dev + a deployed frontend on AgentBase).
_cors_origins = [o.strip() for o in settings.frontend_url.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #
def _profile_email(claims: dict) -> str | None:
    for key in ("email", "upn", "preferred_username", "unique_name", "name"):
        value = claims.get(key)
        if isinstance(value, str) and "@" in value:
            return value.strip().lower()
    return None


def _profile_display_name(claims: dict) -> str:
    return (
        _profile_email(claims)
        or next(
            (
                value.strip()
                for key in ("name", "preferred_username", "upn", "email", "unique_name")
                if isinstance((value := claims.get(key)), str) and value.strip()
            ),
            "Graph token",
        )
    )


def _profile_auth_user_id(claims: dict) -> str | None:
    value = claims.get("sub")
    if not isinstance(value, str):
        return None
    try:
        UUID(value)
    except ValueError:
        return None
    return value


def _upsert_user_profile(claims: dict) -> str | None:
    """Mirror the signed-in user into public.user_profiles."""
    user_id = _profile_auth_user_id(claims)
    email = _profile_email(claims)
    if not email:
        log.warning("could not upsert user profile: token has no email-like claim")
        return None
    if not settings.supabase_enabled:
        log.warning("could not upsert user profile: Supabase service role not configured")
        return None
    try:
        from .supabase_client import get_supabase

        now = datetime.now(timezone.utc).isoformat()
        payload = {
            "email": email,
            "last_seen_at": now,
            "updated_at": now,
        }
        if user_id:
            payload["auth_user_id"] = user_id
        supabase = get_supabase()
        res = (
            supabase.table("user_profiles")
            .upsert(payload, on_conflict="email")
            .execute()
        )
        if res.data and res.data[0].get("id"):
            return str(res.data[0]["id"])

        res = (
            supabase.table("user_profiles")
            .select("id")
            .eq("email", email)
            .limit(1)
            .execute()
        )
        return str(res.data[0]["id"]) if res.data else None
    except Exception as e:  # noqa: BLE001 - profile mirroring must not block login
        log.warning("could not upsert user profile: %s", e)
        return None


def _profile_is_complete(profile: dict | None) -> bool:
    if not profile:
        return False
    office = str(profile.get("office") or "").strip()
    return bool(office)


def _profile_field_options() -> dict[str, list[dict]]:
    if not settings.supabase_enabled:
        raise HTTPException(503, "User profile options require Supabase configuration.")
    try:
        from .supabase_client import get_supabase

        rows = (
            get_supabase()
            .table("user_profile_field_options")
            .select("field, value, label, parent_field, parent_value, display_order")
            .eq("enabled", True)
            .order("display_order")
            .execute()
            .data
            or []
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Could not load user profile options: {e}")

    options = {"office": [], "floor": [], "building": [], "preferredRooms": []}
    for row in rows:
        field = row.get("field")
        if field not in options:
            continue
        options[field].append(
            {
                "value": row.get("value") or "",
                "label": row.get("label") or row.get("value") or "",
                "parentField": row.get("parent_field"),
                "parentValue": row.get("parent_value"),
            }
        )

    try:
        from .supabase_client import get_supabase

        room_rows = (
            get_supabase()
            .table("meeting_room_metadata")
            .select("name, email, office")
            .eq("in_use", True)
            .order("name")
            .execute()
            .data
            or []
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Could not load room options: {e}")

    for row in room_rows:
        email = (row.get("email") or "").strip().lower()
        if not email:
            continue
        options["preferredRooms"].append(
            {
                "value": email,
                "label": row.get("name") or email,
                "parentField": "office",
                "parentValue": row.get("office"),
            }
        )
    return options


def _validate_profile_selection(values: dict) -> dict:
    options = _profile_field_options()

    def allowed(field: str, value: str, parent_value: str | None = None) -> bool:
        for option in options[field]:
            if option["value"] != value:
                continue
            if parent_value is None:
                return option.get("parentValue") in (None, "")
            return option.get("parentValue") == parent_value
        return False

    office = str(values.get("office") or "").strip()
    floor = str(values.get("floor") or "").strip()
    building = str(values.get("building") or "").strip()
    preferred_rooms = [
        str(room or "").strip().lower()
        for room in (values.get("preferred_rooms") or [])
        if str(room or "").strip()
    ]

    if not office or not allowed("office", office):
        raise HTTPException(400, "Office không hợp lệ.")

    if len(preferred_rooms) > 3:
        raise HTTPException(400, "Prefered rooms chỉ được chọn tối đa 3 phòng.")

    room_options = options["preferredRooms"]
    room_values = {room["value"]: room for room in room_options}
    for room in preferred_rooms:
        option = room_values.get(room)
        if not option or option.get("parentValue") != office:
            raise HTTPException(400, "Prefered room không hợp lệ với office đã chọn.")

    if office != "campus":
        return {
            "office": office,
            "floor": "",
            "building": "",
            "preferred_rooms": preferred_rooms,
        }

    if floor and not allowed("floor", floor, office):
        raise HTTPException(400, "Floor không hợp lệ.")
    if building and not allowed("building", building, office):
        raise HTTPException(400, "Building không hợp lệ.")
    return {
        "office": office,
        "floor": floor,
        "building": building,
        "preferred_rooms": preferred_rooms,
    }


def _profile_payload(profile: dict | None, email: str | None = None) -> dict | None:
    if not profile and not email:
        return None
    row = profile or {}
    profile_email = (row.get("email") or email or "").strip().lower()
    return {
        "email": profile_email,
        "email_username": row.get("email_username")
        or (profile_email.split("@", 1)[0] if "@" in profile_email else ""),
        "office": row.get("office") or "",
        "floor": row.get("floor") or "",
        "building": row.get("building") or "",
        "preferred_rooms": row.get("preferred_rooms") or [],
        "book_without_confirmation": bool(row.get("book_without_confirmation")),
        "theme": row.get("theme") or "system",
        "language": row.get("language") or "vi",
        "role": row.get("role") or "user",
    }


def _read_user_profile(profile_id: str | None, email: str | None = None) -> dict | None:
    if not settings.supabase_enabled or not profile_id and not email:
        return None
    try:
        from .supabase_client import get_supabase

        query = (
            get_supabase()
            .table("user_profiles")
            .select(
                "id, email, email_username, office, floor, building, "
                "preferred_rooms, book_without_confirmation, theme, language, role"
            )
            .limit(1)
        )
        if profile_id:
            query = query.eq("id", profile_id)
        else:
            query = query.eq("email", email)
        res = query.execute()
        return res.data[0] if res.data else None
    except Exception as e:  # noqa: BLE001 - profile reads should not break auth checks
        log.warning("could not read user profile: %s", e)
        return None


def _me_profile_response(claims: dict) -> tuple[dict | None, bool]:
    email = _profile_email(claims)
    if not settings.supabase_enabled:
        return _profile_payload(None, email), True

    profile_id = _upsert_user_profile(claims)
    profile = _read_user_profile(profile_id, email)
    return _profile_payload(profile, email), _profile_is_complete(profile)


def _claims_from_bearer(request: Request) -> dict:
    bearer = request.headers.get("Authorization", "")
    if not bearer.startswith("Bearer "):
        raise HTTPException(401, "Not authenticated")
    return auth.verify_jwt(bearer[len("Bearer ") :])


def _request_identity(request: Request) -> tuple[str | None, str | None]:
    """Return (auth.users id, email) for either auth path without fetching Graph."""
    bearer = request.headers.get("Authorization", "")
    if bearer.startswith("Bearer "):
        claims = _claims_from_bearer(request)
        return claims.get("sub"), _profile_email(claims)

    token = auth.get_manual_token(auth.session_id(request))
    if not token:
        raise HTTPException(401, "Not authenticated")
    claims = auth.get_manual_claims(auth.session_id(request))
    return None, _profile_email(claims)


async def _booking_auth_context(
    request: Request,
) -> tuple[str, str | None, str | None, str | None]:
    """Return Graph token, auth.users id, user_profiles id, and email."""
    if request.headers.get("Authorization", "").startswith("Bearer "):
        claims = _claims_from_bearer(request)
        auth_user_id = claims["sub"]
        graph_token = await auth.get_graph_token(auth_user_id)
        return (
            graph_token,
            auth_user_id,
            _upsert_user_profile(claims),
            _profile_email(claims),
        )

    token = auth.get_manual_token(auth.session_id(request))
    if not token:
        raise HTTPException(401, "Not authenticated")
    claims = auth.get_manual_claims(auth.session_id(request))
    return token, None, _upsert_user_profile(claims), _profile_email(claims)


@app.post("/api/auth/token")
async def set_token(request: Request, access_token: str = Body(..., embed=True)):
    """Manual mode: paste a Graph access token (e.g. from Graph Explorer).

    Token does not auto-refresh — paste again when it expires (~1h). Works without
    admin consent / Supabase.
    """
    if not access_token or not access_token.strip():
        raise HTTPException(400, "access_token rỗng")
    claims = await auth.verify_manual_graph_token(access_token)
    sid = auth.session_id(request)
    auth.set_manual_token(sid, access_token, claims)
    _upsert_user_profile(claims)
    return JSONResponse({"ok": True, "username": _profile_display_name(claims)})


@app.post("/api/auth/link")
def link_microsoft(request: Request, provider_refresh_token: str = Body(..., embed=True)):
    """Supabase mode: store the Microsoft refresh token after Azure sign-in."""
    bearer = request.headers.get("Authorization", "")
    if not bearer.startswith("Bearer "):
        raise HTTPException(401, "Not authenticated")
    claims = auth.verify_jwt(bearer[len("Bearer ") :])
    if not provider_refresh_token or not provider_refresh_token.strip():
        raise HTTPException(400, "provider_refresh_token rỗng")
    auth.store_refresh_token(claims["sub"], provider_refresh_token.strip())
    return {"ok": True}


@app.get("/api/auth/me")
def me(request: Request):
    bearer = request.headers.get("Authorization", "")
    if bearer.startswith("Bearer "):
        claims = _claims_from_bearer(request)
        profile, profile_complete = _me_profile_response(claims)
        return JSONResponse(
            {
                "authenticated": True,
                "username": _profile_display_name(claims),
                "email": _profile_email(claims),
                "graphLinked": auth.has_refresh_token(claims["sub"]),
                "profile": profile,
                "profileComplete": profile_complete,
            }
        )
    sid = auth.session_id(request)
    token = auth.get_manual_token(sid)
    if not token:
        return JSONResponse({"authenticated": False})
    claims = auth.get_manual_claims(sid)
    profile, profile_complete = _me_profile_response(claims)
    return JSONResponse(
        {
            "authenticated": True,
            "username": _profile_display_name(claims),
            "email": _profile_email(claims),
            "profile": profile,
            "profileComplete": profile_complete,
        }
    )


@app.post("/api/users/me/activity")
def touch_user_activity(request: Request):
    """Update the current user's profile activity timestamp."""
    if request.headers.get("Authorization", "").startswith("Bearer "):
        claims = _claims_from_bearer(request)
    else:
        token = auth.get_manual_token(auth.session_id(request))
        if not token:
            raise HTTPException(401, "Not authenticated")
        claims = auth.get_manual_claims(auth.session_id(request))
    _upsert_user_profile(claims)
    return {"ok": True}


@app.post("/api/auth/logout")
def logout(request: Request):
    auth.logout(auth.session_id(request))
    return JSONResponse({"ok": True})


# --------------------------------------------------------------------------- #
# Rooms & schedule
# --------------------------------------------------------------------------- #
def _room_metadata() -> dict[str, dict]:
    """email (lowercased) -> row from `meeting_room_metadata`.

    Empty dict when Supabase isn't configured or the read fails — enrichment is
    best-effort and must never block listing rooms.
    """
    if not settings.supabase_enabled:
        return {}
    try:
        from .supabase_client import get_supabase

        rows = (
            get_supabase()
            .table("meeting_room_metadata")
            .select(
                "email, office, building, floor, zone, capacity, capacity_size, "
                "thumbnail_link, direction"
            )
            .execute()
            .data
        )
    except Exception:
        return {}
    out: dict[str, dict] = {}
    for r in rows or []:
        email = (r.get("email") or "").strip().lower()
        if email:
            out[email] = r
    return out


def _enrich_rooms(rooms: list[dict]) -> list[dict]:
    """Merge Supabase metadata onto Graph rooms (matched by email).

    Graph values win when present; the table fills the gaps (notably the
    findRooms() fallback, which returns null building/floor/capacity) and adds
    zone/office, which Graph doesn't expose.
    """
    meta = _room_metadata()
    if not meta:
        return rooms
    enriched: list[dict] = []
    for r in rooms:
        m = meta.get((r.get("email") or "").strip().lower())
        if m:
            r = {
                **r,
                "building": r.get("building") or m.get("building"),
                "floor": r.get("floor") or m.get("floor"),
                "capacity": r.get("capacity") or m.get("capacity"),
                "capacity_size": m.get("capacity_size"),
                "zone": m.get("zone"),
                "office": m.get("office"),
                "thumbnail_link": m.get("thumbnail_link"),
                "direction": m.get("direction"),
            }
        enriched.append(r)
    return enriched


@app.get("/api/rooms")
async def rooms(request: Request):
    token, _ = await auth.resolve_token(request)
    try:
        return _enrich_rooms(await graph.list_rooms(token))
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, e.response.text)


def _time_labels() -> list[str]:
    labels = []
    cur = settings.business_start_hour * 60
    end = settings.business_end_hour * 60
    while cur < end:
        labels.append(f"{cur // 60:02d}:{cur % 60:02d}")
        cur += settings.slot_minutes
    return labels


@app.get("/api/schedule")
async def schedule(
    request: Request,
    days: int = Query(7, ge=1, le=31),
    emails: str = Query("", description="Comma-separated room emails; empty = all rooms"),
):
    token, _ = await auth.resolve_token(request)
    tz = ZoneInfo(settings.timezone)

    # Resolve which rooms to query.
    try:
        all_rooms = _enrich_rooms(await graph.list_rooms(token))
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, e.response.text)

    wanted = {e.strip().lower() for e in emails.split(",") if e.strip()}
    rooms_list = [r for r in all_rooms if not wanted or r["email"].lower() in wanted]
    room_emails = [r["email"] for r in rooms_list]

    times = _time_labels()
    today = datetime.now(tz).date()
    day_list = [(today + timedelta(days=i)).isoformat() for i in range(days)]

    # grid[email] -> list (per time) of list (per day) of status int
    grids: dict[str, list[list[int]]] = {
        e: [[0] * days for _ in times] for e in room_emails
    }

    # One getSchedule call per day (business hours only) keeps slicing trivial.
    for di, day in enumerate(day_list):
        start_iso = f"{day}T{settings.business_start_hour:02d}:00:00"
        end_iso = f"{day}T{settings.business_end_hour:02d}:00:00"
        try:
            views = await graph.get_schedule(
                token, room_emails, start_iso, end_iso, settings.timezone, settings.slot_minutes
            )
        except httpx.HTTPStatusError as e:
            raise HTTPException(e.response.status_code, e.response.text)
        for email, view in views.items():
            if email not in grids:
                continue
            for ti in range(len(times)):
                status = 0 if ti < len(view) and view[ti] == "0" else 1
                grids[email][ti][di] = status

    return {
        "timezone": settings.timezone,
        "slotMinutes": settings.slot_minutes,
        "days": day_list,
        "times": times,
        "rooms": [
            {**r, "grid": grids[r["email"]]} for r in rooms_list
        ],
    }


# --------------------------------------------------------------------------- #
# Availability cache (read from Supabase; refresh on demand when stale)
# --------------------------------------------------------------------------- #
def _require_auth(request: Request) -> None:
    """Allow any authenticated session (Supabase JWT or manual token) — but do
    NOT fetch a Graph token until the cache is known to be stale."""
    _request_identity(request)


def _parse_cache_updated_at(value: object) -> datetime | None:
    """Parse Supabase timestamptz values into timezone-aware UTC datetimes."""
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str) and value:
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _availability_refresh_lock() -> asyncio.Lock:
    global _AVAILABILITY_REFRESH_LOCK
    if _AVAILABILITY_REFRESH_LOCK is None:
        _AVAILABILITY_REFRESH_LOCK = asyncio.Lock()
    return _AVAILABILITY_REFRESH_LOCK


def _read_availability_cache(
    sb,
    room_ids: list[str],
    day_list: list[str],
) -> dict[tuple[str, str], dict]:
    """Load room_availability rows for the requested rooms and date window."""
    if not room_ids or not day_list:
        return {}
    rows = (
        sb.table("room_availability")
        .select("room_id, date, slots, slot_owner_ids, updated_at")
        .in_("room_id", room_ids)
        .gte("date", day_list[0])
        .lte("date", day_list[-1])
        .execute()
        .data
        or []
    )
    return {(row["room_id"], str(row["date"])): row for row in rows}


def _availability_cache_is_stale(
    cache: dict[tuple[str, str], dict],
    room_ids: list[str],
    day_list: list[str],
) -> bool:
    """True when any requested cache row is missing, malformed, or older than TTL."""
    expected_days = day_list[: min(len(day_list), settings.availability_days)]
    if not room_ids or not expected_days:
        return False

    cutoff = datetime.now(timezone.utc) - AVAILABILITY_CACHE_TTL
    for room_id in room_ids:
        for day in expected_days:
            row = cache.get((room_id, day))
            if not row:
                return True
            slots = row.get("slots") or []
            if len(slots) != availability.SLOTS_PER_DAY:
                return True
            owner_ids = row.get("slot_owner_ids") or []
            if len(owner_ids) != availability.SLOTS_PER_DAY:
                return True
            updated_at = _parse_cache_updated_at(row.get("updated_at"))
            if not updated_at or updated_at < cutoff:
                return True
    return False


def _availability_cache_is_empty(
    cache: dict[tuple[str, str], dict],
    room_ids: list[str],
    day_list: list[str],
) -> bool:
    expected_days = day_list[: min(len(day_list), settings.availability_days)]
    if not room_ids or not expected_days:
        return False
    return not any(
        (room_id, day) in cache for room_id in room_ids for day in expected_days
    )


async def _ensure_availability_cache_fresh(
    request: Request,
    sb,
    room_ids: list[str],
    day_list: list[str],
) -> dict[tuple[str, str], dict]:
    """Refresh room_availability with the current user's Graph token when stale.

    The read path remains cheap when the cache is fresh. When rows are missing or
    older than five minutes, the backend briefly borrows the request user's Graph
    access, updates Supabase via service role, and then serves the refreshed rows.
    """
    cache = _read_availability_cache(sb, room_ids, day_list)
    if not _availability_cache_is_stale(cache, room_ids, day_list):
        return cache

    async with _availability_refresh_lock():
        # Another request may have refreshed the table while we waited.
        cache = _read_availability_cache(sb, room_ids, day_list)
        if not _availability_cache_is_stale(cache, room_ids, day_list):
            return cache

        was_empty = _availability_cache_is_empty(cache, room_ids, day_list)
        token, _ = await auth.resolve_token(request)
        summary = await availability.refresh_availability_delegated(token)
        log.info("availability cache refreshed on-demand: %s", summary)

        cache = _read_availability_cache(sb, room_ids, day_list)
        if was_empty and _availability_cache_is_empty(cache, room_ids, day_list):
            raise HTTPException(
                503,
                "Availability cache is empty and on-demand refresh did not produce data.",
            )
        return cache


def _availability_slot_index(time_value: str | None) -> int | None:
    if not time_value:
        return None
    try:
        hour, minute = [int(part) for part in time_value.split(":")[:2]]
    except (TypeError, ValueError):
        return None
    total_minutes = hour * 60 + minute
    idx = total_minutes // settings.availability_slot_minutes
    return max(0, min(availability.SLOTS_PER_DAY, idx))


def _profile_email_by_id(sb, profile_ids: set[str]) -> dict[str, str]:
    if not profile_ids:
        return {}
    try:
        rows = (
            sb.table("user_profiles")
            .select("id, email")
            .in_("id", list(profile_ids))
            .execute()
            .data
            or []
        )
        return {
            str(row["id"]): row["email"].strip().lower()
            for row in rows
            if row.get("id") and row.get("email")
        }
    except Exception as e:  # noqa: BLE001 - booking-owner overlay is best-effort
        log.warning("could not read user profiles by id for booking overlay: %s", e)
        return {}


@app.get("/api/availability")
async def availability_grid(
    request: Request,
    days: int = Query(14, ge=1, le=31),
    emails: str = Query(
        "",
        description="Comma-separated room emails; empty = all in-use rooms",
    ),
):
    """Browse-grid data served from the room_availability cache.

    Same response shape as /api/schedule so the frontend grid is a drop-in swap.
    The cache stores full-day 15-min slots; here we fold them into the displayed
    business-hours window at slot_minutes granularity. If the requested cache
    rows are missing or older than five minutes, the backend refreshes the table
    with the current user's delegated Graph token before returning the grid.
    """
    _, current_user_email = _request_identity(request)
    current_user_email = (current_user_email or "").strip().lower()
    if not settings.supabase_enabled:
        raise HTTPException(503, "Availability cache requires Supabase configuration.")
    from .supabase_client import get_supabase

    tz = ZoneInfo(settings.timezone)
    today = datetime.now(tz).date()
    day_list = [(today + timedelta(days=i)).isoformat() for i in range(days)]
    times = _time_labels()
    sub_per_slot = max(1, settings.slot_minutes // settings.availability_slot_minutes)

    sb = get_supabase()
    rooms_list = [
        r
        for r in (
            sb.table("meeting_room_metadata")
            .select(
                "id, name, email, building, floor, zone, capacity, capacity_size, "
                "office, thumbnail_link, direction"
            )
            .eq("in_use", True)
            .execute()
            .data
            or []
        )
        if r.get("email")
    ]
    wanted = {e.strip().lower() for e in emails.split(",") if e.strip()}
    if wanted:
        rooms_list = [r for r in rooms_list if r["email"].lower() in wanted]

    room_ids = [r["id"] for r in rooms_list]
    cache = await _ensure_availability_cache_fresh(request, sb, room_ids, day_list)
    owner_profile_ids = {
        str(owner_id)
        for row in cache.values()
        for owner_id in (row.get("slot_owner_ids") or [])
        if owner_id
    }
    owner_email_by_profile_id = _profile_email_by_id(sb, owner_profile_ids)

    # Precompute, for each display time label, the underlying 15-min slot indices.
    base_idx = [int(t[:2]) * 4 + int(t[3:5]) // (60 // 4) for t in times]
    # (hour*4 + minute//15) — minute is 0/30 for 30-min slots, both land cleanly.

    out_rooms = []
    for r in rooms_list:
        api_grid = [[0] * days for _ in times]
        for di, day in enumerate(day_list):
            row = cache.get((r["id"], day))
            slots = row.get("slots") if row else []
            slot_owner_ids = row.get("slot_owner_ids") if row else []
            # A day still holding seeded -1 slots hasn't been refreshed from Graph
            # yet (it's beyond the live-availability window). Bookings made there
            # are "schedule" bookings, so the grid uses a distinct status band:
            #   3 = free / schedule-bookable, 4 = scheduled by someone else,
            #   5 = your scheduled. Instant days keep 0/1/2.
            schedule_day = any(s == -1 for s in slots)
            for ti, start in enumerate(base_idx):
                owner_profile_id = next(
                    (
                        str(slot_owner_ids[start + k])
                        for k in range(sub_per_slot)
                        if start + k < len(slot_owner_ids)
                        and slot_owner_ids[start + k]
                    ),
                    None,
                )
                owner_email = (
                    owner_email_by_profile_id.get(owner_profile_id)
                    if owner_profile_id
                    else None
                )
                is_your_booking = bool(owner_email and owner_email == current_user_email)
                if schedule_day:
                    # No Graph busy data here; only app schedule bookings (tracked
                    # via slot_owner_ids) occupy slots. Everything else is bookable.
                    if is_your_booking:
                        final_value = 5
                    elif owner_profile_id:
                        final_value = 4
                    else:
                        final_value = 3
                else:
                    busy = any(
                        start + k < len(slots) and slots[start + k] != 0
                        for k in range(sub_per_slot)
                    )
                    final_value = 2 if is_your_booking else (1 if owner_profile_id or busy else 0)
                api_grid[ti][di] = final_value
        out_rooms.append({**r, "grid": api_grid})

    return {
        "timezone": settings.timezone,
        "slotMinutes": settings.slot_minutes,
        "days": day_list,
        "times": times,
        "rooms": out_rooms,
    }


@app.post("/api/availability/refresh")
async def availability_refresh(request: Request):
    """Force an immediate cache refresh into the room_availability table.

    When app-only Graph creds are configured, refreshes server-side with no
    signed-in user (the same path the background scheduler uses). Otherwise falls
    back to the requesting user's DELEGATED token via /me/calendar/getSchedule —
    so the cache can be populated today, before app-only admin consent lands.
    """
    try:
        if settings.graph_app_enabled:
            _require_auth(request)
            summary = await availability.refresh_availability()
        else:
            token, _ = await auth.resolve_token(request)
            summary = await availability.refresh_availability_delegated(token)
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, e.response.text)
    return {"ok": True, **summary}


# --------------------------------------------------------------------------- #
# Room Scout
# --------------------------------------------------------------------------- #
class RoomScoutRequest(BaseModel):
    duration_minutes: int = Field(ge=15, le=480)
    capacity_size: Literal["small", "medium", "large"] | None = None
    scout_start_time: str | None = None  # "HH:MM"
    scout_end_time: str | None = None  # "HH:MM"
    ignore_lunch_break: bool = False
    office: str | None = None


def _end_of_today(tz: ZoneInfo) -> datetime:
    tomorrow = datetime.now(tz).date() + timedelta(days=1)
    return datetime.combine(tomorrow, datetime.min.time(), tzinfo=tz)


def _time_to_minutes(value: object) -> int | None:
    try:
        hour, minute = str(value).split(":")
        total = int(hour) * 60 + int(minute)
    except (ValueError, AttributeError):
        return None
    if 0 <= total <= 24 * 60:
        return total
    return None


def _minutes_to_label(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _scout_scan_window(tz: ZoneInfo, scout: dict) -> tuple[int, int, int]:
    """Slot range to scan today for a free `duration` block.

    Returns (scan_start_idx, scan_end_idx, duration_slots). We scan the whole
    configured scout range [scout_start_time, scout_end_time) and report a match
    if any room is free for the duration *anywhere* inside it — e.g. scout range
    14:00-18:00, duration 2h, a room free 15:00-17:00 counts. If the range is
    missing we fall back to the full day.
    """
    avail = settings.availability_slot_minutes

    start_minutes = _time_to_minutes(scout.get("scout_start_time"))
    end_minutes = _time_to_minutes(scout.get("scout_end_time"))
    start_idx = (start_minutes // avail) if start_minutes is not None else 0
    end_idx = (
        (end_minutes + avail - 1) // avail
        if end_minutes is not None
        else availability.SLOTS_PER_DAY
    )
    if end_idx <= start_idx:
        end_idx = availability.SLOTS_PER_DAY

    duration_slots = max(
        1,
        (int(scout.get("duration_minutes") or 30) + avail - 1) // avail,
    )
    scan_start = max(0, start_idx)
    scan_end = min(end_idx, availability.SLOTS_PER_DAY)
    return scan_start, scan_end, duration_slots


def _token_has_mail_send(token: str | None) -> bool:
    """True when the Graph access token carries the Mail.Send permission.

    Delegated tokens list granted scopes in the space-delimited `scp` claim;
    application tokens use `roles`. We accept either so the check works in both
    the manual-token and Supabase/Azure auth paths.
    """
    if not token:
        return False
    claims = auth.decode_jwt_claims(token)
    granted = f"{claims.get('scp', '')} {claims.get('roles', '')}"
    return "mail.send" in granted.lower().split()


MAIL_SEND_REQUIRED_MESSAGE = (
    "Bạn cần cấp quyền gửi mail (Mail.Send) để dùng Room Scout."
)


def _room_scout_token_for_create(token: str | None, auth_user_id: str | None) -> str | None:
    # Supabase/Azure users can be refreshed from provider_tokens. Manual-token
    # users need an encrypted copy so the scheduler can send mail later.
    if auth_user_id:
        return None
    return _encrypt_scheduled_graph_token(token)


def _has_free_block(slots: list, scan_start: int, scan_end: int, duration_slots: int) -> bool:
    """True when there's a free (all-zero) block of `duration_slots` consecutive
    slots somewhere inside [scan_start, scan_end)."""
    run = 0
    for idx in range(scan_start, scan_end):
        if slots[idx] == 0:
            run += 1
            if run >= duration_slots:
                return True
        else:
            run = 0
    return False


def _available_room_scout_matches(sb, scout: dict, day: str) -> tuple[list[dict], str, str]:
    tz = ZoneInfo(settings.timezone)
    scan_start, scan_end, duration_slots = _scout_scan_window(tz, scout)
    start_time = _minutes_to_label(scan_start * settings.availability_slot_minutes)
    end_time = _minutes_to_label(scan_end * settings.availability_slot_minutes)
    if scan_start + duration_slots > scan_end:
        return [], start_time, end_time

    query = (
        sb.table("meeting_room_metadata")
        .select("id, name, email, capacity, capacity_size, building, floor, office")
        .eq("in_use", True)
        .order("capacity")
    )
    office = str(scout.get("office") or "").strip()
    if office:
        query = query.eq("office", office)
    rooms = [r for r in (query.execute().data or []) if r.get("id") and r.get("email")]

    wanted_size = str(scout.get("capacity_size") or "").strip().lower()
    if wanted_size:
        rooms = [r for r in rooms if _effective_capacity_size(r) == wanted_size]
    if not rooms:
        return [], start_time, end_time

    # Lunch break 12:00-13:00 → slot indices [48, 52) at 15-min granularity.
    ignore_lunch = bool(scout.get("ignore_lunch_break"))
    avail = settings.availability_slot_minutes
    lunch_slots = range((12 * 60) // avail, (13 * 60) // avail)

    cache = _read_availability_cache(sb, [r["id"] for r in rooms], [day])
    matches: list[dict] = []
    for room in rooms:
        row = cache.get((room["id"], day))
        slots = row.get("slots") if row else []
        if len(slots) != availability.SLOTS_PER_DAY:
            continue
        if ignore_lunch:
            # Treat the lunch window as free/skippable so a block may span it.
            slots = list(slots)
            for idx in lunch_slots:
                slots[idx] = 0
        if _has_free_block(slots, scan_start, scan_end, duration_slots):
            matches.append(room)
    return matches, start_time, end_time


def _room_scout_signature(day: str, start_time: str, end_time: str, rooms: list[dict]) -> str:
    emails = ",".join(sorted(str(r.get("email") or "").lower() for r in rooms))
    return f"{day}|{start_time}|{end_time}|{emails}"


def _room_scout_email_body(scout: dict, rooms: list[dict], day: str, start_time: str, end_time: str) -> str:
    rows = "\n".join(
        "<tr>"
        f"<td style='padding:8px 12px;border-bottom:1px solid #eee'>{html.escape(str(room.get('name') or room.get('email') or 'Room'))}</td>"
        f"<td style='padding:8px 12px;border-bottom:1px solid #eee'>{html.escape(str(room.get('capacity') or ''))}</td>"
        f"<td style='padding:8px 12px;border-bottom:1px solid #eee'>{html.escape(str(room.get('building') or ''))}</td>"
        f"<td style='padding:8px 12px;border-bottom:1px solid #eee'>{html.escape(str(room.get('floor') or ''))}</td>"
        "</tr>"
        for room in rooms[:12]
    )
    extra = "" if len(rooms) <= 12 else f"<p>And {len(rooms) - 12} more room(s).</p>"
    size = str(scout.get("capacity_size") or "any").strip().lower() or "any"
    return f"""
    <div style="font-family:Arial,sans-serif;color:#18181b;line-height:1.5">
      <h2 style="margin:0 0 12px">Room Scout found available rooms</h2>
      <p>Window: <strong>{html.escape(day)} {html.escape(start_time)} - {html.escape(end_time)}</strong></p>
      <p>Free for {int(scout.get("duration_minutes") or 0)} minutes. Capacity: {html.escape(size)}.</p>
      <table style="border-collapse:collapse;margin-top:12px">
        <thead>
          <tr>
            <th align="left" style="padding:8px 12px;border-bottom:2px solid #ddd">Room</th>
            <th align="left" style="padding:8px 12px;border-bottom:2px solid #ddd">Capacity</th>
            <th align="left" style="padding:8px 12px;border-bottom:2px solid #ddd">Building</th>
            <th align="left" style="padding:8px 12px;border-bottom:2px solid #ddd">Floor</th>
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
      {extra}
      <p style="margin-top:16px"><a href="{html.escape(settings.public_url)}">Open VNG Meet to book</a></p>
    </div>
    """


async def _room_scout_graph_token(row: dict) -> str:
    auth_user_id = str(row.get("auth_user_id") or "").strip()
    if auth_user_id:
        return await auth.get_graph_token(auth_user_id)
    return _decrypt_scheduled_graph_token(row.get("graph_access_token"))


async def process_room_scouts() -> dict:
    if not settings.supabase_enabled:
        raise RuntimeError("Supabase not configured; cannot process room scouts.")
    from .supabase_client import get_supabase

    sb = get_supabase()
    tz = ZoneInfo(settings.timezone)
    now = datetime.now(timezone.utc)
    today = datetime.now(tz).date().isoformat()

    sb.table("room_scouts").update(
        {"status": "expired", "updated_at": now.isoformat()}
    ).eq("status", "active").lte("expires_at", now.isoformat()).execute()

    scouts = (
        sb.table("room_scouts")
        .select(
            "id, user_id, auth_user_id, email, duration_minutes, capacity_size, "
            "scout_start_time, scout_end_time, ignore_lunch_break, office, "
            "graph_access_token, last_notified_signature"
        )
        .eq("status", "active")
        .gt("expires_at", now.isoformat())
        .execute()
        .data
        or []
    )
    if not scouts:
        return {"checked": 0, "notified": 0, "matches": 0, "errors": 0}

    errors = 0
    notified = 0
    total_matches = 0
    try:
        if settings.graph_app_enabled:
            await availability.refresh_availability()
        else:
            token = await _room_scout_graph_token(scouts[0])
            await availability.refresh_availability_delegated(token)
    except Exception as e:  # noqa: BLE001 - stale cache can still be useful
        errors += 1
        log.warning("room scout availability refresh failed: %s", e)

    for scout in scouts:
        scout_id = scout["id"]
        checked_at = datetime.now(timezone.utc).isoformat()
        try:
            rooms, start_time, end_time = _available_room_scout_matches(sb, scout, today)
            total_matches += len(rooms)
            update = {"last_checked_at": checked_at, "updated_at": checked_at}
            if rooms:
                # Dedup on the configured range (not the now-clamped scan window),
                # so we don't re-email the same match set as the day advances.
                sig_start = scout.get("scout_start_time") or start_time
                sig_end = scout.get("scout_end_time") or end_time
                signature = _room_scout_signature(today, sig_start, sig_end, rooms)
                if signature != scout.get("last_notified_signature"):
                    token = await _room_scout_graph_token(scout)
                    await graph.send_mail(
                        token,
                        scout["email"],
                        f"Room Scout: {len(rooms)} room(s) available at {start_time}",
                        _room_scout_email_body(scout, rooms, today, start_time, end_time),
                    )
                    update["last_notified_at"] = checked_at
                    update["last_notified_signature"] = signature
                    notified += 1
            sb.table("room_scouts").update(update).eq("id", scout_id).execute()
        except Exception as e:  # noqa: BLE001 - one scout must not block others
            errors += 1
            log.warning("room scout failed for %s: %s", scout_id, e)
            sb.table("room_scouts").update(
                {"last_checked_at": checked_at, "updated_at": checked_at}
            ).eq("id", scout_id).execute()

    return {
        "checked": len(scouts),
        "notified": notified,
        "matches": total_matches,
        "errors": errors,
    }


@app.get("/api/room-scouts")
async def list_room_scouts(request: Request):
    token, _auth_user_id, user_profile_id, _email = await _booking_auth_context(request)
    can_send_mail = _token_has_mail_send(token)
    if not user_profile_id or not settings.supabase_enabled:
        return {"scouts": [], "can_send_mail": can_send_mail}
    from .supabase_client import get_supabase

    rows = (
        get_supabase()
        .table("room_scouts")
        .select(
            "id, email, duration_minutes, capacity_size, scout_start_time, scout_end_time, "
            "ignore_lunch_break, office, status, last_checked_at, last_notified_at, "
            "expires_at, created_at"
        )
        .eq("user_id", user_profile_id)
        .order("created_at", desc=True)
        .limit(20)
        .execute()
        .data
        or []
    )
    return {"scouts": rows, "can_send_mail": can_send_mail}


@app.post("/api/room-scouts")
async def create_room_scout(request: Request, payload: RoomScoutRequest):
    token, auth_user_id, user_profile_id, email = await _booking_auth_context(request)
    if not settings.supabase_enabled or not user_profile_id or not email:
        raise HTTPException(503, "Room Scout requires Supabase and a user profile email.")
    if not _token_has_mail_send(token):
        raise HTTPException(403, MAIL_SEND_REQUIRED_MESSAGE)
    from .supabase_client import get_supabase

    profile = _read_user_profile(user_profile_id, email) or {}
    office = (payload.office or profile.get("office") or "").strip() or None

    start_minutes = _time_to_minutes(payload.scout_start_time)
    end_minutes = _time_to_minutes(payload.scout_end_time)
    if start_minutes is None or end_minutes is None or end_minutes <= start_minutes:
        raise HTTPException(422, "Scout range must have a valid start and end time.")
    if end_minutes - start_minutes < payload.duration_minutes:
        raise HTTPException(422, "Scout range must be at least as long as the duration.")

    tz = ZoneInfo(settings.timezone)
    now = datetime.now(timezone.utc).isoformat()
    row = {
        "user_id": user_profile_id,
        "auth_user_id": auth_user_id,
        "email": email,
        "duration_minutes": payload.duration_minutes,
        "capacity_size": payload.capacity_size,
        "scout_start_time": _minutes_to_label(start_minutes),
        "scout_end_time": _minutes_to_label(end_minutes),
        "ignore_lunch_break": payload.ignore_lunch_break,
        "office": office,
        "status": "active",
        "graph_access_token": _room_scout_token_for_create(token, auth_user_id),
        "expires_at": _end_of_today(tz).astimezone(timezone.utc).isoformat(),
        "updated_at": now,
    }
    res = get_supabase().table("room_scouts").insert(row).execute()
    return {"ok": True, "scout": res.data[0] if res.data else row}


@app.delete("/api/room-scouts/{scout_id}")
async def stop_room_scout(request: Request, scout_id: str, outcome: str = "canceled"):
    # outcome: "canceled" (user gave up) or "success" (user found a room).
    _token, _auth_user_id, user_profile_id, _email = await _booking_auth_context(request)
    if not user_profile_id or not settings.supabase_enabled:
        raise HTTPException(503, "Room Scout requires Supabase.")
    status = "success" if outcome == "success" else "canceled"
    from .supabase_client import get_supabase

    now = datetime.now(timezone.utc).isoformat()
    get_supabase().table("room_scouts").update(
        {"status": status, "updated_at": now}
    ).eq("id", scout_id).eq("user_id", user_profile_id).execute()
    return {"ok": True, "status": status}


@app.post("/api/room-scouts/process")
async def run_room_scouts_now(request: Request):
    _require_auth(request)
    try:
        summary = await process_room_scouts()
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    return {"ok": True, **summary}


# --------------------------------------------------------------------------- #
# Bookings
# --------------------------------------------------------------------------- #
ATTENDEE_EMAIL_DOMAIN = "@vng.com.vn"


def _normalize_attendees(values: list[str] | None) -> list[str]:
    """The booking modal lets users type bare domains (e.g. "cuongdm4"); append
    the org email suffix so we store and send full addresses. Entries that
    already contain "@" are kept as-is. Blanks are dropped."""
    normalized: list[str] = []
    for raw in values or []:
        value = (raw or "").strip()
        if not value:
            continue
        normalized.append(value if "@" in value else f"{value}{ATTENDEE_EMAIL_DOMAIN}")
    return normalized


class BookingRequest(BaseModel):
    room_email: str
    room_name: str | None = None
    date: str  # "2026-06-11"
    start_time: str  # "09:00"
    end_time: str  # "10:00"
    booking_type: Literal["instant", "schedule", "scheduled"] = "instant"
    method: Literal["manual", "chatbot"] = "manual"
    subject: str
    attendees: list[str] = []
    body: str | None = None

    @field_validator("attendees")
    @classmethod
    def _normalize(cls, value: list[str]) -> list[str]:
        return _normalize_attendees(value)


class UpdateBookingRequest(BaseModel):
    """Editable fields of an existing booking. All optional — only sent fields change."""

    date: str | None = None  # "2026-06-11"
    start_time: str | None = None  # "09:00"
    end_time: str | None = None  # "10:00"
    subject: str | None = None
    attendees: list[str] | None = None
    body: str | None = None

    @field_validator("attendees")
    @classmethod
    def _normalize(cls, value: list[str] | None) -> list[str] | None:
        # None means "leave attendees unchanged" — preserve it.
        return None if value is None else _normalize_attendees(value)


class ChatSendRequest(BaseModel):
    content: str
    thread_id: str | None = None


class ChatThreadRenameRequest(BaseModel):
    title: str = Field(min_length=1, max_length=120)


class ChatBookingActionRequest(BaseModel):
    thread_id: str
    confirmation_id: str
    action: Literal["accept", "reject", "expire"]
    booking: BookingRequest | None = None
    # When the user ticks "book without confirmation next time" on the card.
    book_without_confirmation: bool = False


class UserProfileUpdateRequest(BaseModel):
    office: str
    floor: str = ""
    building: str = ""
    preferred_rooms: list[str] = Field(default_factory=list)
    book_without_confirmation: bool | None = None
    theme: str | None = None
    language: str | None = None


@app.get("/api/users/profile-options")
def user_profile_options(request: Request):
    _request_identity(request)
    return _profile_field_options()


@app.patch("/api/users/me/profile")
def update_my_profile(request: Request, payload: UserProfileUpdateRequest):
    if not settings.supabase_enabled:
        raise HTTPException(503, "User profile requires Supabase configuration.")

    if request.headers.get("Authorization", "").startswith("Bearer "):
        claims = _claims_from_bearer(request)
    else:
        token = auth.get_manual_token(auth.session_id(request))
        if not token:
            raise HTTPException(401, "Not authenticated")
        claims = auth.get_manual_claims(auth.session_id(request))

    cleaned = _validate_profile_selection(payload.model_dump())
    # _validate_profile_selection only keeps location fields; carry the toggle
    # through separately when the client sent it.
    if payload.book_without_confirmation is not None:
        cleaned["book_without_confirmation"] = payload.book_without_confirmation
    if payload.theme is not None:
        theme = str(payload.theme).strip().lower()
        if theme not in ("system", "light", "dark"):
            raise HTTPException(400, "Theme không hợp lệ.")
        cleaned["theme"] = theme
    if payload.language is not None:
        language = str(payload.language).strip().lower()
        if language not in ("en", "vi"):
            raise HTTPException(400, "Language không hợp lệ.")
        cleaned["language"] = language

    profile_id = _upsert_user_profile(claims)
    if not profile_id:
        raise HTTPException(503, "Could not resolve user profile.")

    try:
        from .supabase_client import get_supabase

        now = datetime.now(timezone.utc).isoformat()
        res = (
            get_supabase()
            .table("user_profiles")
            .update({**cleaned, "updated_at": now, "last_seen_at": now})
            .eq("id", profile_id)
            .execute()
        )
        profile = _read_user_profile(profile_id, _profile_email(claims))
        if not res.data and not profile:
            raise HTTPException(404, "User profile not found.")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Could not update user profile: {e}")

    return {
        "ok": True,
        "profile": _profile_payload(profile, _profile_email(claims)),
        "profileComplete": _profile_is_complete(profile),
    }


CHAT_BOT_EMAIL = "booking-bot@vngmeet.local"
CHAT_MAX_OPTIONS = 5
CHAT_SYSTEM_PROMPT = """Bạn là trợ lý đặt lịch cho app booking phòng họp.

Phạm vi hỗ trợ:
Chỉ trả lời các câu hỏi liên quan đến đặt lịch, kiểm tra lịch trống, đặt phòng họp, chỉ đường/tìm vị trí phòng họp, đổi lịch hoặc huỷ lịch.
Nếu người dùng hỏi ngoài phạm vi này, hãy trả lời ngắn gọn: “Mình chỉ hỗ trợ các yêu cầu liên quan đến đặt lịch và phòng họp.”

Nhiệm vụ chính:
- Hiểu nhu cầu đặt lịch của người dùng.
- Dùng API/function calling để kiểm tra phòng trống theo thời gian, số người, địa điểm hoặc yêu cầu cụ thể.
- Gợi ý các khung giờ và phòng có thể đặt.
- Trả chỉ đường/map đến phòng họp khi user hỏi vị trí hoặc cách đi đến một phòng.
- Chỉ gợi ý phòng trong office của user theo ngữ cảnh profile, trừ khi profile chưa có office.
- Xác nhận đủ thông tin trước khi chuẩn bị phiếu đặt phòng.
- Gọi API/function calling để tạo phiếu xác nhận đặt phòng; chỉ book thật sau khi người dùng bấm Đồng ý trên card.

Luồng xử lý:
1. Người dùng hỏi có phòng phù hợp không.
2. Kiểm tra thông tin đã có: ngày, giờ bắt đầu, giờ kết thúc hoặc thời lượng, nhu cầu phòng (nhỏ/vừa/lớn), địa điểm/khu vực.
3. Nếu thiếu thông tin cần thiết, hỏi bổ sung ngắn gọn.
   Nếu user chỉ nhập con số hoặc khoảng số mơ hồ (ví dụ "2-4", "3", "2 đến 4") mà không nói rõ đó là ngày (mùng mấy), thứ trong tuần, hay khung giờ, KHÔNG được tự đoán; hãy hỏi lại để làm rõ ý của user là ngày, thứ hay giờ.
4. Khi đủ thông tin, gọi function kiểm tra lịch/phòng trống.
5. Trả về danh sách phòng và khung giờ có thể đặt theo đúng thứ tự API trả về.
   Nếu không có phòng trống trọn khoảng thời gian, dùng split_suggestions để gợi ý tách phòng.
   Nếu cũng không tách được, dùng alternate_suggestions để gợi ý khung giờ khác cùng duration.
6. Khi người dùng chọn phòng, kiểm tra lại các trường bắt buộc để đặt lịch.
7. Khi người dùng muốn đặt phòng, gọi function book_room cho đặt tức thì hoặc schedule_room cho scheduled booking để tạo card xác nhận với các thông tin đã điền.
8. Xử lý kết quả book_room/schedule_room theo trường trả về:
   - Nếu trả về requires_confirmation=true: KHÔNG nói đã đặt phòng; chỉ nói người dùng kiểm tra card và bấm Đồng ý hoặc Từ chối.
   - Nếu trả về booked=true (user đã bật chế độ đặt phòng không cần xác nhận): báo luôn kết quả. Nếu pending=true thì nói scheduled booking đã được tạo và sẽ tự đặt khi lịch mở; nếu không thì chỉ cần báo đặt phòng thành công. KHÔNG trả link Outlook/calendar hay bất kỳ link xác nhận nào. Sau đó BẮT BUỘC gọi get_room_directions cho phòng vừa đặt và đính kèm map dưới dạng ẢNH (không phải link).
   - Nếu ok=false: báo thất bại kèm lý do và đề xuất phòng/giờ khác.
9. Báo kết quả đặt phòng thành công hoặc thất bại sau khi hệ thống nhận action từ card.

Luồng chỉ đường:
- Khi user hỏi "chỉ đường", "đường đến", "map", "ở đâu", "vị trí" kèm tên phòng, gọi function get_room_directions.
- Nếu tìm thấy phòng, trả tên phòng, office/building/floor/zone nếu có, direction nếu có, và ẢNH map nếu có map_link. KHÔNG trả map dưới dạng link, chỉ trả dưới dạng ảnh.
- Nếu user chỉ nói tên như "Chỉ đường đến Tokyo", hiểu Tokyo là tên phòng.
- Nếu user nhập một tên có vẻ là tên phòng nhưng sai chính tả hoặc gần giống một tên phòng đã biết (ví dụ "Tokio" thay vì "Tokyo", "Singapor" thay vì "Singapore"), đừng tự đoán chắc chắn; hãy hỏi lại để xác nhận có phải user muốn nói đến phòng đó không trước khi tra cứu hoặc đặt.
- Nếu dữ liệu direction/map note trong DB là tiếng Anh nhưng user hỏi bằng tiếng Việt, hãy dịch/diễn đạt lại phần hướng dẫn sang tiếng Việt tự nhiên; không trả nguyên văn tiếng Anh trừ tên riêng, tầng, toà nhà, khu vực hoặc landmark.

Nguyên tắc phản hồi:
- Trả lời ngắn gọn, rõ ràng, tập trung vào hành động tiếp theo.
- Trả lời cùng ngôn ngữ với người dùng. Nếu user hỏi tiếng Việt, toàn bộ câu trả lời nên là tiếng Việt tự nhiên, kể cả hướng dẫn đường đi lấy từ metadata tiếng Anh.
- Không hỏi số lượng người tham dự. Thay vào đó hỏi nhu cầu phòng để user chọn: nhỏ (4 người), vừa (5-12 người), lớn (13+ người); rồi truyền capacity_size là small/medium/large tương ứng. Nếu user tự nói rõ con số thì mới truyền capacity.
- Sức chứa phòng được phân loại theo cột capacity_size (small/medium/large), không dựa trên con số capacity thô.
- Chỉ hỗ trợ đặt phòng vào ngày làm việc trong tuần (Thứ 2 đến Thứ 6). Nếu user yêu cầu Thứ 7 hoặc Chủ nhật, báo ngắn gọn rằng chỉ đặt được vào ngày làm việc T2-T6 và gợi ý chọn ngày làm việc gần nhất. Khi gợi ý ngày/khung giờ, không trả ra Thứ 7 hoặc Chủ nhật.
- Không bịa phòng, giờ trống hoặc trạng thái booking nếu chưa có dữ liệu từ API.
- Nếu API không trả về phòng phù hợp, gợi ý người dùng đổi thời gian, địa điểm hoặc tiêu chí.
- Nếu người dùng không nói tên cuộc họp, để trống subject; hệ thống sẽ tự điền tên mặc định.
- Nếu đặt lịch ngoài vùng live availability/schedule-bookable, truyền booking_type="scheduled"; còn đặt tức thì thì booking_type="instant".
- Trả nhiều option hữu ích nhưng tối đa 5 option.
- Khi liệt kê/gợi ý phòng, KHÔNG hiển thị map hay ảnh map. Chỉ hiển thị map trong 2 trường hợp: (1) user hỏi vị trí/chỉ đường (gọi get_room_directions), hoặc (2) sau khi đặt phòng thành công thì gọi get_room_directions cho phòng vừa đặt để đính kèm map. Trong cả 2 trường hợp, map phải được trả dưới dạng ẢNH map, không trả dưới dạng link.
- Không hỏi thêm về thiết bị phòng họp.
- Nếu book thất bại, giải thích lý do nếu API có trả về và đề xuất thử phòng/giờ khác.
- Nếu người dùng muốn đổi lịch hoặc huỷ lịch, hiện app chưa có API đổi/huỷ; hãy xin thông tin và nói ngắn gọn rằng bạn chưa thể thực hiện tự động trong phiên bản này.
"""


CHAT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "check_room_availability",
            "description": "Kiểm tra danh sách phòng họp còn trống theo ngày, giờ, sức chứa và khu vực.",
            "parameters": {
                "type": "object",
                "properties": {
                    "date": {
                        "type": "string",
                        "description": "Ngày cần đặt, định dạng YYYY-MM-DD.",
                    },
                    "start_time": {
                        "type": "string",
                        "description": "Giờ bắt đầu, định dạng HH:MM theo timezone Asia/Ho_Chi_Minh.",
                    },
                    "end_time": {
                        "type": "string",
                        "description": "Giờ kết thúc, định dạng HH:MM theo timezone Asia/Ho_Chi_Minh.",
                    },
                    "capacity_size": {
                        "type": "string",
                        "enum": ["small", "medium", "large"],
                        "description": "Nhu cầu phòng do user chọn: small = nhỏ (4 người), medium = vừa (5-12 người), large = lớn (13+ người). Ưu tiên dùng trường này thay vì hỏi số người.",
                    },
                    "capacity": {
                        "type": "integer",
                        "description": "Số người tham dự, chỉ dùng khi user tự nói rõ con số. Backend map <=4 thành small, 5-12 thành medium, 13+ thành large.",
                    },
                    "location": {
                        "type": "string",
                        "description": "Địa điểm/khu vực/tầng/toà/office user yêu cầu.",
                    },
                },
                "required": ["date", "start_time", "end_time"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_room_directions",
            "description": "Lấy thông tin vị trí/chỉ đường/map đến một phòng họp theo tên phòng.",
            "parameters": {
                "type": "object",
                "properties": {
                    "room_name": {
                        "type": "string",
                        "description": "Tên phòng user muốn tìm/chỉ đường đến, ví dụ Tokyo.",
                    },
                },
                "required": ["room_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "book_room",
            "description": "Tạo card xác nhận đặt phòng với thông tin đã điền; chưa đặt phòng thật.",
            "parameters": {
                "type": "object",
                "properties": {
                    "room_email": {"type": "string", "description": "Email phòng họp."},
                    "room_name": {"type": "string", "description": "Tên phòng họp."},
                    "date": {"type": "string", "description": "Ngày đặt, định dạng YYYY-MM-DD."},
                    "start_time": {"type": "string", "description": "Giờ bắt đầu HH:MM."},
                    "end_time": {"type": "string", "description": "Giờ kết thúc HH:MM."},
                    "subject": {"type": "string", "description": "Tiêu đề cuộc họp; để trống nếu user không nói tên, hệ thống sẽ tự điền."},
                    "attendees": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Email người tham dự, nếu có.",
                    },
                    "body": {"type": "string", "description": "Nội dung mô tả cuộc họp."},
                    "booking_type": {
                        "type": "string",
                        "enum": ["instant", "scheduled"],
                        "description": "instant cho booking live; scheduled cho ngày/slot schedule-bookable.",
                    },
                },
                "required": ["date", "start_time", "end_time"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "schedule_room",
            "description": "Tạo card xác nhận scheduled booking; chưa đặt phòng thật cho đến khi user bấm Đồng ý.",
            "parameters": {
                "type": "object",
                "properties": {
                    "room_email": {"type": "string", "description": "Email phòng họp."},
                    "room_name": {"type": "string", "description": "Tên phòng họp."},
                    "date": {"type": "string", "description": "Ngày đặt, định dạng YYYY-MM-DD."},
                    "start_time": {"type": "string", "description": "Giờ bắt đầu HH:MM."},
                    "end_time": {"type": "string", "description": "Giờ kết thúc HH:MM."},
                    "subject": {"type": "string", "description": "Tiêu đề cuộc họp; để trống nếu user không nói tên, hệ thống sẽ tự điền."},
                    "attendees": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Email người tham dự, nếu có.",
                    },
                    "body": {"type": "string", "description": "Nội dung mô tả cuộc họp."},
                },
                "required": ["date", "start_time", "end_time"],
            },
        },
    },
]


def _require_supabase_chat():
    if not settings.supabase_enabled:
        raise HTTPException(503, "Chat history requires Supabase configuration.")
    from .supabase_client import get_supabase

    return get_supabase()


def _current_user_profile_id(request: Request) -> str:
    if request.headers.get("Authorization", "").startswith("Bearer "):
        claims = _claims_from_bearer(request)
    else:
        token = auth.get_manual_token(auth.session_id(request))
        if not token:
            raise HTTPException(401, "Not authenticated")
        claims = auth.get_manual_claims(auth.session_id(request))
    profile_id = _upsert_user_profile(claims)
    if not profile_id:
        raise HTTPException(503, "Could not resolve user profile for chat.")
    return profile_id


def _bot_profile_id(sb) -> str:
    res = (
        sb.table("user_profiles")
        .upsert(
            {
                "email": CHAT_BOT_EMAIL,
                "last_seen_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
            on_conflict="email",
        )
        .execute()
    )
    if res.data and res.data[0].get("id"):
        return str(res.data[0]["id"])
    rows = (
        sb.table("user_profiles")
        .select("id")
        .eq("email", CHAT_BOT_EMAIL)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        raise HTTPException(503, "Could not initialize chat bot profile.")
    return str(rows[0]["id"])


def _assert_thread_owner(sb, thread_id: str, user_profile_id: str) -> dict:
    rows = (
        sb.table("thread")
        .select("id, user_id, title, created_at, updated_at")
        .eq("id", thread_id)
        .eq("user_id", user_profile_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        raise HTTPException(404, "Thread not found.")
    return rows[0]


def _create_thread(sb, user_profile_id: str, content: str) -> dict:
    title = content.strip().replace("\n", " ")
    if len(title) > 64:
        title = title[:61].rstrip() + "..."
    rows = (
        sb.table("thread")
        .insert({"user_id": user_profile_id, "title": title or "Chat mới"})
        .execute()
        .data
        or []
    )
    if not rows:
        raise HTTPException(503, "Could not create chat thread.")
    return rows[0]


def _insert_chat_message(
    sb,
    thread_id: str,
    from_user_id: str,
    to_user_id: str,
    content: str,
    metadata: dict | None = None,
) -> dict:
    rows = (
        sb.table("messages")
        .insert(
            {
                "thread_id": thread_id,
                "from_user_id": from_user_id,
                "to_user_id": to_user_id,
                "content": content,
                "metadata": metadata or {},
            }
        )
        .execute()
        .data
        or []
    )
    if not rows:
        raise HTTPException(503, "Could not save chat message.")
    sb.table("thread").update(
        {"updated_at": datetime.now(timezone.utc).isoformat()}
    ).eq("id", thread_id).execute()
    return rows[0]


def _message_role(row: dict, bot_profile_id: str) -> str:
    return "assistant" if str(row.get("from_user_id")) == bot_profile_id else "user"


def _chat_message_response(row: dict, role: str) -> dict:
    return {
        "id": row["id"],
        "role": role,
        "content": row.get("content") or "",
        "created_at": row.get("created_at"),
        "metadata": row.get("metadata") or {},
    }


def _chat_messages_for_llm(sb, thread_id: str, bot_profile_id: str) -> list[dict]:
    rows = (
        sb.table("messages")
        .select("from_user_id, content, created_at")
        .eq("thread_id", thread_id)
        .order("created_at", desc=True)
        .limit(30)
        .execute()
        .data
        or []
    )
    return [
        {"role": _message_role(row, bot_profile_id), "content": row.get("content") or ""}
        for row in reversed(rows)
    ]


def _llm_text(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        text = value.get("text") or value.get("content")
        if isinstance(text, (str, list, dict)):
            return _llm_text(text)
        return ""
    if isinstance(value, list):
        chunks: list[str] = []
        for item in value:
            if isinstance(item, (str, dict, list)):
                chunks.append(_llm_text(item))
            elif item:
                chunks.append(str(item))
        return "".join(chunks)
    return str(value or "")


def _llm_reasoning_text(message: dict) -> str:
    chunks: list[str] = []
    for key in ("reasoning_content", "reasoning", "reasoning_text"):
        text = _llm_text(message.get(key)).strip()
        if text:
            chunks.append(text)

    details = message.get("reasoning_details")
    if isinstance(details, list):
        for item in details:
            if isinstance(item, dict):
                text = _llm_text(item.get("text") or item.get("content")).strip()
                if text:
                    chunks.append(text)
            else:
                text = _llm_text(item).strip()
                if text:
                    chunks.append(text)

    return "\n\n".join(dict.fromkeys(chunks))


def _assistant_content_with_reasoning(
    message: dict,
    prior_reasoning: list[str] | None = None,
) -> str:
    content = _llm_text(message.get("content")).strip()
    reasoning_parts = [part for part in (prior_reasoning or []) if part.strip()]
    current_reasoning = _llm_reasoning_text(message)
    if current_reasoning:
        reasoning_parts.append(current_reasoning)

    reasoning = "\n\n".join(dict.fromkeys(reasoning_parts)).strip()
    if not reasoning or "<think" in content.lower():
        return content
    if not content:
        return f"<think>\n{reasoning}\n</think>"
    return f"<think>\n{reasoning}\n</think>\n\n{content}"


def _chat_completion_url() -> str:
    if not settings.llm_base_url or not settings.llm_api_key or not settings.llm_model:
        raise HTTPException(
            503,
            "Missing LLM_BASE_URL / LLM_API_KEY / LLM_MODEL configuration.",
        )
    return settings.llm_base_url.rstrip("/") + "/chat/completions"


def _chat_slot_range(start_time: str, end_time: str) -> tuple[int, int]:
    start = _availability_slot_index(start_time)
    end = _availability_slot_index(end_time)
    if start is None or end is None or end <= start:
        raise ValueError("invalid_time_range")
    return start, end


def _chat_time_from_slot(idx: int) -> str:
    minutes = idx * settings.availability_slot_minutes
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _chat_slot_is_bookable(slots: list, idx: int) -> bool:
    """True for live-free slots and seeded schedule-bookable slots."""
    if idx < 0 or idx >= len(slots):
        return False
    return slots[idx] in (0, -1)


def _chat_slot_has_scheduled_owner(slot_owner_ids: list, idx: int) -> bool:
    return idx < len(slot_owner_ids) and bool(slot_owner_ids[idx])


def _numeric_floor(value: object) -> int | None:
    text = str(value or "")
    digits = "".join(ch for ch in text if ch.isdigit() or ch == "-")
    if not digits or digits == "-":
        return None
    try:
        return int(digits)
    except ValueError:
        return None


def _capacity_rank(room: dict) -> int:
    capacity_size = _effective_capacity_size(room) or ""
    if capacity_size == "medium":
        return 0
    if capacity_size == "large":
        return 1
    if capacity_size == "small":
        return 2
    return 3


def _capacity_size_for_people(value: object) -> str | None:
    if not isinstance(value, int) or value <= 0:
        return None
    if value <= 4:
        return "small"
    if value <= 12:
        return "medium"
    return "large"


def _normalize_capacity_size(value: object) -> str | None:
    size = str(value or "").strip().lower()
    return size if size in {"small", "medium", "large"} else None


def _effective_capacity_size(room: dict) -> str | None:
    # Source of truth for a room's size is the `capacity_size` column; only fall
    # back to deriving from the numeric `capacity` when the column is missing.
    explicit = str(room.get("capacity_size") or "").lower() or None
    return explicit or _capacity_size_for_people(room.get("capacity"))


def _location_rank(room: dict, profile: dict | None) -> tuple[int, int, int]:
    user_building = str((profile or {}).get("building") or "").strip().lower()
    room_building = str(room.get("building") or "").strip().lower()
    same_building = bool(user_building and room_building and user_building == room_building)
    user_floor = _numeric_floor((profile or {}).get("floor"))
    room_floor = _numeric_floor(room.get("floor"))
    has_floor = user_floor is not None and room_floor is not None
    same_floor = has_floor and user_floor == room_floor

    if same_building and same_floor:
        return (0, 0, 0)
    if not same_building and same_floor:
        return (1, 0, 0)
    if has_floor:
        gap = abs(room_floor - user_floor)
        above = 1 if room_floor > user_floor else 0
        return (2 if same_building else 3, gap, above)
    return (4, 9999, 1)


def _sort_chat_rooms_like_browse(rooms: list[dict], profile: dict | None) -> list[dict]:
    preferred = {
        str(room or "").strip().lower()
        for room in ((profile or {}).get("preferred_rooms") or [])
        if str(room or "").strip()
    }

    def key(item: tuple[int, dict]) -> tuple:
        index, room = item
        email = str(room.get("email") or "").strip().lower()
        return (
            0 if email in preferred else 1,
            _capacity_rank(room),
            *_location_rank(room, profile),
            str(room.get("name") or "").lower(),
            index,
        )

    return [room for _, room in sorted(enumerate(rooms), key=key)]


def _room_result(room: dict, include_map: bool = False) -> dict:
    # Map/direction are only attached when explicitly requested (directions tool
    # or a completed booking) so the room listing stays map-free.
    result = {
        "name": room.get("name"),
        "email": room.get("email"),
        "building": room.get("building"),
        "floor": room.get("floor"),
        "zone": room.get("zone"),
        "office": room.get("office"),
        "capacity": room.get("capacity"),
        "capacity_size": _effective_capacity_size(room),
        "booking_type": room.get("_booking_type") or "instant",
    }
    if include_map:
        result["map_link"] = room.get("map_link")
        result["direction"] = room.get("direction")
    return result


def _rows_for_chat_availability(
    sb, requested_capacity_size: str | None, location: str, profile: dict | None
) -> list[dict]:
    rows = (
        sb.table("meeting_room_metadata")
        .select(
            "id, name, email, building, floor, zone, capacity, capacity_size, "
            "office, map_link, direction"
        )
        .eq("in_use", True)
        .execute()
        .data
        or []
    )
    user_office = str((profile or {}).get("office") or "").strip()
    if user_office:
        rows = [r for r in rows if str(r.get("office") or "").strip() == user_office]
    if requested_capacity_size:
        rows = [
            r
            for r in rows
            if _effective_capacity_size(r) == requested_capacity_size
        ]
    if location:
        rows = [
            r
            for r in rows
            if location
            in " ".join(
                str(r.get(k) or "").lower()
                for k in ("name", "building", "floor", "zone", "office")
            )
        ]
    return _sort_chat_rooms_like_browse(rows, profile)


def _room_bookable_for_range(cache_row: dict | None, start_idx: int, end_idx: int) -> str | None:
    slots = list(cache_row.get("slots") or []) if cache_row else []
    owners = list(cache_row.get("slot_owner_ids") or []) if cache_row else []
    if len(slots) != availability.SLOTS_PER_DAY:
        return None
    if start_idx < 0 or end_idx > len(slots) or end_idx <= start_idx:
        return None
    if len(owners) != availability.SLOTS_PER_DAY:
        owners = [None] * availability.SLOTS_PER_DAY
    uses_scheduled_slot = False
    for idx in range(start_idx, end_idx):
        if _chat_slot_has_scheduled_owner(owners, idx) or not _chat_slot_is_bookable(slots, idx):
            return None
        if slots[idx] == -1:
            uses_scheduled_slot = True
    return "scheduled" if uses_scheduled_slot else "instant"


def _split_room_suggestions(
    rows: list[dict],
    cache: dict[tuple[str, str], dict],
    day: str,
    start_idx: int,
    end_idx: int,
    profile: dict | None,
) -> list[dict]:
    segments: list[dict] = []
    idx = start_idx
    while idx < end_idx:
        best: tuple[int, dict, str] | None = None
        for order, room in enumerate(rows):
            row = cache.get((room["id"], day))
            slots = list(row.get("slots") or []) if row else []
            owners = list(row.get("slot_owner_ids") or []) if row else []
            if len(owners) != availability.SLOTS_PER_DAY:
                owners = [None] * availability.SLOTS_PER_DAY
            if len(slots) != availability.SLOTS_PER_DAY:
                continue
            if _chat_slot_has_scheduled_owner(owners, idx) or not _chat_slot_is_bookable(slots, idx):
                continue
            end = idx
            uses_scheduled_slot = False
            while end < end_idx:
                if _chat_slot_has_scheduled_owner(owners, end) or not _chat_slot_is_bookable(slots, end):
                    break
                uses_scheduled_slot = uses_scheduled_slot or slots[end] == -1
                end += 1
            if best is None or end > best[0]:
                room_copy = {**room, "_booking_type": "scheduled" if uses_scheduled_slot else "instant"}
                best = (end, room_copy, str(room.get("id")))
                if end == end_idx:
                    break
        if best is None or best[0] <= idx:
            return []
        segments.append(
            {
                "date": day,
                "start_time": _chat_time_from_slot(idx),
                "end_time": _chat_time_from_slot(best[0]),
                "room": _room_result(best[1]),
            }
        )
        idx = best[0]
    # Avoid suggesting a "split" with the same room for the whole duration.
    if len({segment["room"]["email"] for segment in segments}) <= 1:
        return []
    return segments


def _half_day_group(start_idx: int) -> str:
    return "morning" if start_idx < (12 * 60 // settings.availability_slot_minutes) else "afternoon"


def _alternate_priority(requested_date: date_cls, candidate_date: date_cls, start_idx: int, requested_start_idx: int) -> tuple:
    same_day = candidate_date == requested_date
    same_half = _half_day_group(start_idx) == _half_day_group(requested_start_idx)
    if same_day and same_half:
        tier = 0
    elif same_day:
        tier = 1
    else:
        tier = 2
    distance = abs(
        (datetime.combine(candidate_date, datetime.min.time()) + timedelta(minutes=start_idx * settings.availability_slot_minutes))
        - (datetime.combine(requested_date, datetime.min.time()) + timedelta(minutes=requested_start_idx * settings.availability_slot_minutes))
    )
    return (tier, distance, candidate_date.isoformat(), abs(start_idx - requested_start_idx))


def _alternate_time_suggestions(
    rows: list[dict],
    cache: dict[tuple[str, str], dict],
    day_list: list[str],
    requested_date: str,
    start_idx: int,
    end_idx: int,
    profile: dict | None,
) -> list[dict]:
    duration = end_idx - start_idx
    if duration <= 0:
        return []
    try:
        requested_day = date_cls.fromisoformat(requested_date)
    except ValueError:
        return []
    candidates: list[tuple[tuple, dict]] = []
    business_start = settings.business_start_hour * 60 // settings.availability_slot_minutes
    business_end = settings.business_end_hour * 60 // settings.availability_slot_minutes
    for day in day_list:
        try:
            candidate_day = date_cls.fromisoformat(day)
        except ValueError:
            continue
        latest_start = business_end - duration
        for candidate_start in range(business_start, latest_start + 1):
            candidate_end = candidate_start + duration
            for room in rows:
                booking_type = _room_bookable_for_range(
                    cache.get((room["id"], day)), candidate_start, candidate_end
                )
                if not booking_type:
                    continue
                room_copy = {**room, "_booking_type": booking_type}
                candidates.append(
                    (
                        _alternate_priority(
                            requested_day, candidate_day, candidate_start, start_idx
                        ),
                        {
                            "date": day,
                            "start_time": _chat_time_from_slot(candidate_start),
                            "end_time": _chat_time_from_slot(candidate_end),
                            "room": _room_result(room_copy),
                        },
                    )
                )
                break
    seen: set[tuple[str, str, str]] = set()
    suggestions: list[dict] = []
    for _, suggestion in sorted(candidates, key=lambda item: item[0]):
        key = (suggestion["date"], suggestion["start_time"], suggestion["room"]["email"])
        if key in seen:
            continue
        seen.add(key)
        suggestions.append(suggestion)
        if len(suggestions) >= CHAT_MAX_OPTIONS:
            break
    return suggestions


def _norm_room_lookup(value: object) -> str:
    return " ".join(str(value or "").strip().lower().split())


def _find_room_metadata(room_name: object = None, room_email: object = None) -> dict | None:
    """Find one in-use room by exact or fuzzy name/email metadata."""
    if not settings.supabase_enabled:
        return None

    room_name_norm = _norm_room_lookup(room_name)
    room_email_norm = _norm_room_lookup(room_email)
    if not room_name_norm and not room_email_norm:
        return None

    from .supabase_client import get_supabase

    rows = (
        get_supabase()
        .table("meeting_room_metadata")
        .select(
            "id, name, email, office, building, floor, zone, capacity, capacity_size, "
            "map_link, direction"
        )
        .eq("in_use", True)
        .execute()
        .data
        or []
    )

    def room_name_matches(row: dict) -> bool:
        name = _norm_room_lookup(row.get("name"))
        email = _norm_room_lookup(row.get("email"))
        return bool(room_name_norm and room_name_norm in {name, email})

    def room_email_matches(row: dict) -> bool:
        return bool(room_email_norm and room_email_norm == _norm_room_lookup(row.get("email")))

    match = next((row for row in rows if room_name_matches(row)), None)
    if not match:
        match = next((row for row in rows if room_email_matches(row)), None)
    if not match and room_name_norm:
        candidates = [
            row
            for row in rows
            if room_name_norm in _norm_room_lookup(row.get("name"))
            or _norm_room_lookup(row.get("name")) in room_name_norm
        ]
        if len(candidates) == 1:
            match = candidates[0]

    return match


def _resolve_booking_room_from_metadata(payload: BookingRequest) -> BookingRequest:
    """Resolve the room email/name from meeting_room_metadata instead of trusting LLM."""
    if not settings.supabase_enabled:
        return payload

    if not _norm_room_lookup(payload.room_name) and not _norm_room_lookup(payload.room_email):
        raise HTTPException(400, "Thiếu tên phòng hoặc email phòng.")

    match = _find_room_metadata(payload.room_name, payload.room_email)
    if not match or not match.get("email"):
        raise HTTPException(
            400,
            "Không tìm thấy phòng trong meeting_room_metadata. "
            "Bạn chọn lại đúng tên phòng nhé.",
        )

    payload.room_email = str(match["email"]).strip()
    payload.room_name = str(match.get("name") or match["email"]).strip()
    return payload


async def _tool_get_room_directions(args: dict) -> dict:
    room_name = str(args.get("room_name") or "").strip()
    if not room_name:
        return {"ok": False, "error": "Thiếu tên phòng cần chỉ đường."}

    room = _find_room_metadata(room_name)
    if not room:
        return {
            "ok": False,
            "error": "Không tìm thấy phòng này trong meeting_room_metadata.",
        }

    return {
        "ok": True,
        "room": _room_result(room, include_map=True),
    }


def _extract_room_direction_query(content: str) -> str | None:
    text = " ".join(content.strip().split())
    lower = text.lower()
    triggers = (
        "chỉ đường đến",
        "chi duong den",
        "đường đến",
        "duong den",
        "map đến",
        "map den",
        "vị trí phòng",
        "vi tri phong",
        "phòng",
    )
    if not any(trigger in lower for trigger in triggers):
        return None

    prefixes = (
        "chỉ đường đến phòng họp",
        "chỉ đường đến phòng",
        "chỉ đường đến",
        "chi duong den phong hop",
        "chi duong den phong",
        "chi duong den",
        "đường đến phòng họp",
        "đường đến phòng",
        "đường đến",
        "duong den phong hop",
        "duong den phong",
        "duong den",
        "map đến phòng họp",
        "map đến phòng",
        "map đến",
        "map den phong hop",
        "map den phong",
        "map den",
        "vị trí phòng họp",
        "vị trí phòng",
        "vi tri phong hop",
        "vi tri phong",
    )
    for prefix in sorted(prefixes, key=len, reverse=True):
        if lower.startswith(prefix):
            room_name = text[len(prefix) :].strip(" :,-")
            return room_name or None
    return None


def _looks_vietnamese(text: str) -> bool:
    lower = text.lower()
    vietnamese_chars = set("ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ")
    if any(ch in vietnamese_chars for ch in lower):
        return True
    vietnamese_words = (
        "chỉ đường",
        "chi duong",
        "đường đến",
        "duong den",
        "vị trí",
        "vi tri",
        "ở đâu",
        "o dau",
        "phòng",
        "phong",
        "tới",
        "toi",
        "đến",
        "den",
    )
    return any(word in lower for word in vietnamese_words)


async def _rewrite_direction_for_user_language(
    direction: str, user_content: str
) -> str:
    direction = direction.strip()
    if not direction or not _looks_vietnamese(user_content):
        return direction
    try:
        headers = {
            "Authorization": f"Bearer {settings.llm_api_key}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=20) as client:
            res = await client.post(
                _chat_completion_url(),
                headers=headers,
                json={
                    "model": settings.llm_model,
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "Bạn dịch/diễn đạt lại hướng dẫn đường đi sang tiếng Việt tự nhiên. "
                                "Giữ nguyên tên riêng, tên phòng, tên toà nhà, tầng, zone, landmark, "
                                "mã hiệu và URL. Không thêm thông tin mới."
                            ),
                        },
                        {
                            "role": "user",
                            "content": (
                                "User hỏi bằng tiếng Việt. Hãy chuyển hướng dẫn sau sang tiếng Việt:\n"
                                f"{direction}"
                            ),
                        },
                    ],
                    "temperature": 0,
                },
            )
        if res.status_code >= 400:
            log.warning("direction localization failed: %s", res.text)
            return direction
        msg = (res.json().get("choices") or [{}])[0].get("message") or {}
        localized = str(msg.get("content") or "").strip()
        return localized or direction
    except Exception as e:  # noqa: BLE001 - direction text should not block chat
        log.warning("direction localization failed: %s", e)
        return direction


async def _room_direction_reply(result: dict, user_content: str = "") -> str:
    if not result.get("ok"):
        return f"Mình chưa tìm thấy phòng này. {result.get('error') or ''}".strip()
    room = result.get("room") or {}
    name = room.get("name") or "phòng này"
    details = [
        str(room.get(key) or "").strip()
        for key in ("office", "building", "floor", "zone")
        if str(room.get(key) or "").strip()
    ]
    lines = [f"Đây là chỉ đường đến {name}."]
    if details:
        lines.append(f"Vị trí: {', '.join(details)}.")
    direction = str(room.get("direction") or "").strip()
    if direction:
        direction = await _rewrite_direction_for_user_language(direction, user_content)
        lines.append(f"Hướng dẫn: {direction}")
    map_link = str(room.get("map_link") or "").strip()
    if map_link:
        lines.append(f"[Mở map]({map_link})")
        lines.append(f"![Map đến {name}]({map_link})")
    else:
        lines.append("Phòng này chưa có map_link trong metadata.")
    return "\n".join(lines)


async def _tool_check_room_availability(
    request: Request,
    args: dict,
    user_profile_id: str | None,
) -> dict:
    if not settings.supabase_enabled:
        return {"ok": False, "error": "Availability checking requires Supabase."}
    date = str(args.get("date") or "").strip()
    start_time = str(args.get("start_time") or "").strip()
    end_time = str(args.get("end_time") or "").strip()
    location = str(args.get("location") or "").strip().lower()
    # User chọn nhu cầu phòng trực tiếp (small/medium/large); giữ fallback cho
    # trường hợp model vẫn truyền con số capacity.
    requested_capacity_size = _normalize_capacity_size(
        args.get("capacity_size")
    ) or _capacity_size_for_people(args.get("capacity"))
    try:
        start_idx, end_idx = _chat_slot_range(start_time, end_time)
        requested_day = date_cls.fromisoformat(date)
    except Exception:
        return {"ok": False, "error": "date/start_time/end_time không hợp lệ."}

    from .supabase_client import get_supabase

    sb = get_supabase()
    profile = _read_user_profile(user_profile_id) if user_profile_id else None
    rows = _rows_for_chat_availability(sb, requested_capacity_size, location, profile)

    room_ids = [r["id"] for r in rows if r.get("id")]
    today = datetime.now(ZoneInfo(settings.timezone)).date()
    if requested_day < today:
        return {"ok": False, "error": "Không thể kiểm tra/ngỏ ý đặt phòng trong quá khứ."}
    if requested_day.weekday() >= 5:
        return {
            "ok": False,
            "error": "Chỉ hỗ trợ đặt phòng vào ngày làm việc (Thứ 2 đến Thứ 6).",
        }
    day_list = [
        (today + timedelta(days=i)).isoformat()
        for i in range(settings.availability_days)
    ]
    if date not in day_list:
        day_list.append(date)
        day_list.sort()
    try:
        cache = await _ensure_availability_cache_fresh(request, sb, room_ids, day_list)
    except HTTPException as e:
        if e.status_code != 503:
            return {"ok": False, "error": str(e.detail)}
        log.warning(
            "chat availability cache unavailable; falling back to live Graph: %s",
            e.detail,
        )
        return await _tool_check_room_availability_live(
            request, rows, date, start_time, end_time
        )
    except Exception as e:  # noqa: BLE001
        log.warning(
            "chat availability cache check failed; falling back to live Graph: %s",
            e,
        )
        return await _tool_check_room_availability_live(
            request, rows, date, start_time, end_time
        )

    if rows and not any((room.get("id"), date) in cache for room in rows):
        log.info(
            "chat availability cache missing requested date; falling back to live Graph"
        )
        return await _tool_check_room_availability_live(
            request, rows, date, start_time, end_time
        )

    available = []
    for room in rows:
        booking_type = _room_bookable_for_range(cache.get((room["id"], date)), start_idx, end_idx)
        if booking_type:
            available.append({**room, "_booking_type": booking_type})

    split_suggestions: list[dict] = []
    alternate_suggestions: list[dict] = []
    if not available:
        split_suggestions = _split_room_suggestions(
            rows, cache, date, start_idx, end_idx, profile
        )
        if not split_suggestions:
            alternate_suggestions = _alternate_time_suggestions(
                rows, cache, day_list, date, start_idx, end_idx, profile
            )

    return {
        "ok": True,
        "date": date,
        "start_time": start_time,
        "end_time": end_time,
        "user_context": _profile_payload(profile),
        "requested_capacity_size": requested_capacity_size,
        "count": len(available),
        "rooms": [_room_result(room) for room in available[:CHAT_MAX_OPTIONS]],
        "truncated": len(available) > CHAT_MAX_OPTIONS,
        "split_suggestions": split_suggestions,
        "alternate_suggestions": alternate_suggestions,
    }


async def _tool_check_room_availability_live(
    request: Request,
    rooms: list[dict],
    date: str,
    start_time: str,
    end_time: str,
) -> dict:
    """Check the requested interval through Graph when cache is unavailable."""
    if not rooms:
        return {
            "ok": True,
            "date": date,
            "start_time": start_time,
            "end_time": end_time,
            "count": 0,
            "rooms": [],
            "truncated": False,
            "source": "graph_live",
        }

    try:
        token, _ = await auth.resolve_token(request)
        start_iso = f"{date}T{start_time}:00"
        end_iso = f"{date}T{end_time}:00"
        by_email = {
            str(room.get("email") or "").strip().lower(): room
            for room in rooms
            if room.get("email")
        }
        available = []
        emails = list(by_email)
        for i in range(0, len(emails), availability.SCHEDULE_BATCH):
            batch = emails[i : i + availability.SCHEDULE_BATCH]
            views = await graph.get_schedule(
                token,
                batch,
                start_iso,
                end_iso,
                settings.timezone,
                settings.availability_slot_minutes,
            )
            for email, view in views.items():
                room = by_email.get(str(email or "").strip().lower())
                if not room:
                    continue
                if view and all(ch == "0" for ch in view):
                    available.append(
                        {
                            "name": room.get("name"),
                            "email": room.get("email"),
                            "building": room.get("building"),
                            "floor": room.get("floor"),
                            "zone": room.get("zone"),
                            "capacity": room.get("capacity"),
                            "capacity_size": _effective_capacity_size(room),
                        }
                    )
    except httpx.HTTPStatusError as e:
        return {"ok": False, "error": e.response.text, "source": "graph_live"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e), "source": "graph_live"}

    return {
        "ok": True,
        "date": date,
        "start_time": start_time,
        "end_time": end_time,
        "count": len(available),
        "rooms": available[:CHAT_MAX_OPTIONS],
        "truncated": len(available) > CHAT_MAX_OPTIONS,
        "source": "graph_live",
    }


async def _tool_book_room(
    request: Request,
    args: dict,
    graph_token: str,
    user_profile_id: str | None,
    auth_user_id: str | None,
) -> dict:
    _ = (graph_token, auth_user_id)
    profile = _read_user_profile(user_profile_id) if user_profile_id else None
    # The bot must not pick instant vs scheduled itself: a date is "scheduled"
    # only when it falls beyond the live-availability window
    # (today .. today + availability_days - 1). Anything inside the window is
    # instant. Compute it from the date so the LLM's booking_type is overridden.
    booking_date = str(args.get("date") or "").strip()
    booking_type = str(args.get("booking_type") or "instant").strip()
    if booking_type not in {"instant", "schedule", "scheduled"}:
        booking_type = "instant"
    try:
        target_day = date_cls.fromisoformat(booking_date)
        today = datetime.now(ZoneInfo(settings.timezone)).date()
        horizon_end = today + timedelta(days=settings.availability_days - 1)
        booking_type = "scheduled" if target_day > horizon_end else "instant"
    except ValueError:
        pass
    # Auto-fill the subject when the user didn't name the meeting:
    # "<Domain>'s Meeting" for instant, "<Domain>'s Scheduled Meeting" otherwise.
    subject = str(args.get("subject") or "").strip()
    if not subject:
        domain = (_profile_payload(profile) or {}).get("email_username") or ""
        kind = "Meeting" if booking_type == "instant" else "Scheduled Meeting"
        subject = f"{domain}'s {kind}" if domain else kind
    payload = BookingRequest(
        room_email=str(args.get("room_email") or "").strip(),
        room_name=(args.get("room_name") or None),
        date=str(args.get("date") or "").strip(),
        start_time=str(args.get("start_time") or "").strip(),
        end_time=str(args.get("end_time") or "").strip(),
        booking_type=booking_type,
        subject=subject,
        attendees=args.get("attendees") or [],
        body=args.get("body") or None,
        method="chatbot",
    )
    if payload.end_time <= payload.start_time:
        return {"ok": False, "error": "Giờ kết thúc phải sau giờ bắt đầu."}
    try:
        payload = _resolve_booking_room_from_metadata(payload)
    except HTTPException as e:
        return {"ok": False, "error": str(e.detail)}

    # If the user previously opted in, book immediately without a confirmation card.
    if profile and profile.get("book_without_confirmation"):
        try:
            result = await create_booking(request, payload)
        except HTTPException as e:
            return {"ok": False, "error": str(e.detail)}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}
        return {
            "ok": True,
            "booked": True,
            "pending": result.get("status") == "pending",
            "booking": payload.model_dump(),
            "result": result,
        }

    return {
        "ok": True,
        "requires_confirmation": True,
        "confirmation_id": str(uuid4()),
        "booking": payload.model_dump(),
    }


async def _run_chat_tool(
    request: Request,
    name: str,
    args: dict,
    graph_token: str,
    user_profile_id: str | None,
    auth_user_id: str | None,
) -> dict:
    if name == "check_room_availability":
        return await _tool_check_room_availability(request, args, user_profile_id)
    if name == "get_room_directions":
        return await _tool_get_room_directions(args)
    if name == "book_room":
        return await _tool_book_room(
            request, args, graph_token, user_profile_id, auth_user_id
        )
    if name == "schedule_room":
        return await _tool_book_room(
            request,
            {**args, "booking_type": "scheduled"},
            graph_token,
            user_profile_id,
            auth_user_id,
        )
    return {"ok": False, "error": f"Unknown tool: {name}"}


async def _call_llm_with_tools(
    request: Request,
    history: list[dict],
    graph_token: str,
    user_profile_id: str | None,
    auth_user_id: str | None,
) -> tuple[str, list[dict]]:
    now = datetime.now(ZoneInfo(settings.timezone))
    profile = _read_user_profile(user_profile_id) if user_profile_id else None
    profile_payload = _profile_payload(profile) or {}
    profile_context = (
        "\n\nNgữ cảnh người dùng từ profile/app:\n"
        f"- Email: {profile_payload.get('email') or 'chưa rõ'}.\n"
        f"- Office: {profile_payload.get('office') or 'chưa rõ'}.\n"
        f"- Building: {profile_payload.get('building') or 'chưa rõ'}.\n"
        f"- Floor/chỗ ngồi: {profile_payload.get('floor') or 'chưa rõ'}.\n"
        f"- Preferred rooms: {', '.join(profile_payload.get('preferred_rooms') or []) or 'không có'}.\n"
        "- Khi gợi ý phòng, ưu tiên và giới hạn theo office trong profile nếu đã có office."
    )
    weekday_names = [
        "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7", "Chủ nhật",
    ]
    # Precompute calendar-week ranges so the model never does week math itself
    # (it tends to read "tuần sau" as today+7 instead of next Monday's week).
    today = now.date()
    this_monday = today - timedelta(days=today.weekday())
    this_sunday = this_monday + timedelta(days=6)
    next_monday = this_monday + timedelta(days=7)
    next_sunday = next_monday + timedelta(days=6)
    runtime_context = (
        f"\n\nNgữ cảnh thời gian hiện tại:\n"
        f"- Hôm nay là {today.isoformat()} ({weekday_names[now.weekday()]}).\n"
        f"- Thời gian hiện tại là {now.strftime('%H:%M')}.\n"
        f"- Timezone là {settings.timezone}.\n"
        "- Tuần bắt đầu từ Thứ 2 và kết thúc vào Chủ nhật.\n"
        f"- Tuần này: Thứ 2 {this_monday.isoformat()} đến Chủ nhật {this_sunday.isoformat()}.\n"
        f"- Tuần sau: Thứ 2 {next_monday.isoformat()} đến Chủ nhật {next_sunday.isoformat()}.\n"
        "- 'Tuần sau'/'tuần tới' là tuần lịch kế tiếp ở trên (bắt đầu Thứ 2 "
        f"{next_monday.isoformat()}), KHÔNG phải 7 ngày kể từ hôm nay. Khi user "
        "nói 'đầu tuần', 'thứ X tuần này/tuần sau', 'cuối tuần'... hãy lấy ngày "
        "tương ứng trong các dải ngày đã cho, không tự cộng trừ ngày.\n"
        "- Khi người dùng nói hôm nay/ngày mai/hôm qua hoặc thứ trong tuần, "
        "hãy quy đổi theo ngữ cảnh thời gian này trước khi gọi function.\n"
        "- Quy ước buổi trong ngày: sáng = 09:00-12:00, trưa = 12:00-13:00, "
        "chiều = 13:00-18:00. Khi user nói 'buổi sáng/trưa/chiều' mà không nói "
        "giờ cụ thể, dùng khoảng giờ tương ứng này."
    )
    messages = [
        {"role": "system", "content": CHAT_SYSTEM_PROMPT + runtime_context + profile_context},
        *history,
    ]
    tool_results: list[dict] = []
    headers = {
        "Authorization": f"Bearer {settings.llm_api_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=60) as client:
        reasoning_parts: list[str] = []
        for _ in range(3):
            res = await client.post(
                _chat_completion_url(),
                headers=headers,
                json={
                    "model": settings.llm_model,
                    "messages": messages,
                    "tools": CHAT_TOOLS,
                    "tool_choice": "auto",
                    "temperature": 0.2,
                },
            )
            if res.status_code >= 400:
                raise HTTPException(res.status_code, res.text)
            msg = (res.json().get("choices") or [{}])[0].get("message") or {}
            tool_calls = msg.get("tool_calls") or []
            if not tool_calls:
                return _assistant_content_with_reasoning(msg, reasoning_parts).strip(), tool_results

            reasoning = _llm_reasoning_text(msg)
            if reasoning:
                reasoning_parts.append(reasoning)
            messages.append(msg)
            for call in tool_calls:
                fn = call.get("function") or {}
                name = fn.get("name") or ""
                raw_args = fn.get("arguments") or "{}"
                try:
                    args = json.loads(raw_args)
                except json.JSONDecodeError:
                    args = {}
                result = await _run_chat_tool(
                    request, name, args, graph_token, user_profile_id, auth_user_id
                )
                tool_results.append({"name": name, "arguments": args, "result": result})
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.get("id"),
                        "content": json.dumps(result, ensure_ascii=False),
                    }
                )
    return (
        "Mình chưa xử lý xong yêu cầu này. Bạn thử nói rõ ngày, giờ và số người nhé.",
        tool_results,
    )


@app.get("/api/chat/threads")
def list_chat_threads(request: Request):
    sb = _require_supabase_chat()
    user_profile_id = _current_user_profile_id(request)
    rows = (
        sb.table("thread")
        .select("id, title, created_at, updated_at")
        .eq("user_id", user_profile_id)
        .order("updated_at", desc=True)
        .execute()
        .data
        or []
    )
    return {"threads": rows}


@app.get("/api/chat/threads/{thread_id}/messages")
def list_chat_messages(request: Request, thread_id: str):
    sb = _require_supabase_chat()
    user_profile_id = _current_user_profile_id(request)
    bot_profile_id = _bot_profile_id(sb)
    _assert_thread_owner(sb, thread_id, user_profile_id)
    rows = (
        sb.table("messages")
        .select("id, from_user_id, to_user_id, content, metadata, created_at")
        .eq("thread_id", thread_id)
        .order("created_at", desc=False)
        .execute()
        .data
        or []
    )
    return {
        "messages": [
            {
                "id": row["id"],
                "role": _message_role(row, bot_profile_id),
                "content": row.get("content") or "",
                "created_at": row.get("created_at"),
                "metadata": row.get("metadata") or {},
            }
            for row in rows
        ]
    }


@app.patch("/api/chat/threads/{thread_id}")
def rename_chat_thread(
    request: Request,
    thread_id: str,
    payload: ChatThreadRenameRequest,
):
    title = payload.title.strip()
    if not title:
        raise HTTPException(400, "Tên chat không được để trống.")

    sb = _require_supabase_chat()
    user_profile_id = _current_user_profile_id(request)
    _assert_thread_owner(sb, thread_id, user_profile_id)
    now = datetime.now(timezone.utc).isoformat()
    rows = (
        sb.table("thread")
        .update({"title": title, "updated_at": now})
        .eq("id", thread_id)
        .eq("user_id", user_profile_id)
        .execute()
        .data
        or []
    )
    if not rows:
        raise HTTPException(503, "Could not rename chat thread.")
    return {"thread": rows[0]}


@app.delete("/api/chat/threads/{thread_id}")
def delete_chat_thread(request: Request, thread_id: str):
    sb = _require_supabase_chat()
    user_profile_id = _current_user_profile_id(request)
    _assert_thread_owner(sb, thread_id, user_profile_id)
    sb.table("thread").delete().eq("id", thread_id).eq("user_id", user_profile_id).execute()
    return {"ok": True}


@app.post("/api/chat/messages")
async def send_chat_message(request: Request, payload: ChatSendRequest):
    content = payload.content.strip()
    if not content:
        raise HTTPException(400, "Tin nhắn không được để trống.")

    graph_token, auth_user_id, user_profile_id, _auth_email = await _booking_auth_context(
        request
    )
    if not user_profile_id:
        raise HTTPException(503, "Could not resolve user profile for chat.")

    sb = _require_supabase_chat()
    bot_profile_id = _bot_profile_id(sb)
    thread = (
        _assert_thread_owner(sb, payload.thread_id, user_profile_id)
        if payload.thread_id
        else _create_thread(sb, user_profile_id, content)
    )
    thread_id = str(thread["id"])
    user_msg = _insert_chat_message(
        sb, thread_id, user_profile_id, bot_profile_id, content
    )

    direction_room_name = _extract_room_direction_query(content)
    if direction_room_name:
        direction_result = await _tool_get_room_directions(
            {"room_name": direction_room_name}
        )
        assistant_msg = _insert_chat_message(
            sb,
            thread_id,
            bot_profile_id,
            user_profile_id,
            await _room_direction_reply(direction_result, content),
            {
                "tool_results": [
                    {
                        "name": "get_room_directions",
                        "arguments": {"room_name": direction_room_name},
                        "result": direction_result,
                    }
                ]
            },
        )
        return {
            "thread": {
                "id": thread_id,
                "title": thread.get("title"),
                "created_at": thread.get("created_at"),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
            "messages": [
                {
                    "id": user_msg["id"],
                    "role": "user",
                    "content": user_msg.get("content") or "",
                    "created_at": user_msg.get("created_at"),
                },
                {
                    "id": assistant_msg["id"],
                    "role": "assistant",
                    "content": assistant_msg.get("content") or "",
                    "created_at": assistant_msg.get("created_at"),
                    "metadata": assistant_msg.get("metadata") or {},
                },
            ],
        }

    history = _chat_messages_for_llm(sb, thread_id, bot_profile_id)
    reply, tool_results = await _call_llm_with_tools(
        request, history, graph_token, user_profile_id, auth_user_id
    )
    if not reply:
        reply = "Mình chưa có câu trả lời phù hợp. Bạn cho mình thêm ngày, giờ và số người nhé."
    assistant_msg = _insert_chat_message(
        sb,
        thread_id,
        bot_profile_id,
        user_profile_id,
        reply,
        {"tool_results": tool_results} if tool_results else {},
    )
    return {
        "thread": {
            "id": thread_id,
            "title": thread.get("title"),
            "created_at": thread.get("created_at"),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
        "messages": [
            {
                "id": user_msg["id"],
                "role": "user",
                "content": user_msg.get("content") or "",
                "created_at": user_msg.get("created_at"),
            },
            {
                "id": assistant_msg["id"],
                "role": "assistant",
                "content": assistant_msg.get("content") or "",
                "created_at": assistant_msg.get("created_at"),
                "metadata": assistant_msg.get("metadata") or {},
            },
        ],
    }


@app.post("/api/chat/bookings/action")
async def chat_booking_action(request: Request, payload: ChatBookingActionRequest):
    sb = _require_supabase_chat()
    user_profile_id = _current_user_profile_id(request)
    bot_profile_id = _bot_profile_id(sb)
    thread = _assert_thread_owner(sb, payload.thread_id, user_profile_id)

    metadata = {
        "booking_action": {
            "confirmation_id": payload.confirmation_id,
            "action": payload.action,
        }
    }
    if payload.action in {"reject", "expire"}:
        if payload.action == "expire":
            content = "Yêu cầu đặt phòng đã hết hạn. Bạn hãy gửi lại yêu cầu nếu vẫn muốn đặt phòng này."
            metadata["booking_action"]["status"] = "expired"
        else:
            content = "Đã huỷ yêu cầu đặt phòng này."
        assistant_msg = _insert_chat_message(
            sb,
            str(thread["id"]),
            bot_profile_id,
            user_profile_id,
            content,
            metadata,
        )
        return {"ok": True, "message": _chat_message_response(assistant_msg, "assistant")}

    if not payload.booking:
        raise HTTPException(400, "Thiếu thông tin đặt phòng.")

    # User opted in on the card: remember it so future chat bookings skip the card.
    if payload.book_without_confirmation:
        _set_book_without_confirmation(user_profile_id, True)

    payload.booking.method = "chatbot"
    try:
        result = await create_booking(request, payload.booking)
        if result.get("status") == "pending":
            content = (
                "Đã tạo scheduled booking. Hệ thống sẽ tự đặt phòng khi lịch mở.\n"
                f"- Phòng: {payload.booking.room_name or payload.booking.room_email}\n"
                f"- Ngày: {payload.booking.date}\n"
                f"- Giờ: {payload.booking.start_time}-{payload.booking.end_time}"
            )
        else:
            content = (
                "Đặt phòng thành công.\n"
                f"- Phòng: {payload.booking.room_name or payload.booking.room_email}\n"
                f"- Ngày: {payload.booking.date}\n"
                f"- Giờ: {payload.booking.start_time}-{payload.booking.end_time}"
            )
        if result.get("webLink"):
            content += f"\n- Link: {result['webLink']}"
        metadata["booking_action"]["status"] = "ok"
        metadata["booking_action"]["result"] = result
    except HTTPException as e:
        content = f"Đặt phòng thất bại: {e.detail}"
        metadata["booking_action"]["status"] = "failed"
        metadata["booking_action"]["error"] = str(e.detail)
    except Exception as e:  # noqa: BLE001
        content = f"Đặt phòng thất bại: {e}"
        metadata["booking_action"]["status"] = "failed"
        metadata["booking_action"]["error"] = str(e)

    assistant_msg = _insert_chat_message(
        sb,
        str(thread["id"]),
        bot_profile_id,
        user_profile_id,
        content,
        metadata,
    )
    return {
        "ok": metadata["booking_action"].get("status") == "ok",
        "message": _chat_message_response(assistant_msg, "assistant"),
    }


def _log_user_booking_activity(
    user_profile_id: str | None,
    payload: BookingRequest,
    status: Literal["ok", "failed", "pending"],
    error_message: str | None = None,
    auth_user_id: str | None = None,
    graph_event_id: str | None = None,
    web_link: str | None = None,
) -> None:
    if not user_profile_id or not settings.supabase_enabled:
        return
    try:
        from .supabase_client import get_supabase

        get_supabase().table("user_activity").insert(
            {
                "user_id": user_profile_id,
                "auth_user_id": auth_user_id,
                "room_email": payload.room_email,
                "room_name": payload.room_name,
                "date": payload.date,
                "start_time": payload.start_time,
                "end_time": payload.end_time,
                "booking_type": _booking_type_for_db(payload.booking_type),
                "method": payload.method,
                "subject": payload.subject,
                "attendees": payload.attendees,
                "body": payload.body,
                "status": status,
                "error_message": error_message,
                "graph_event_id": graph_event_id,
                "web_link": web_link,
            }
        ).execute()
    except Exception as e:  # noqa: BLE001 - booking log must not block booking flow
        log.warning("could not insert user_activity booking log: %s", e)


def _booking_type_for_db(booking_type: str) -> str:
    return "scheduled" if booking_type in {"schedule", "scheduled"} else "instant"


def _payload_is_scheduled(payload: BookingRequest) -> bool:
    return _booking_type_for_db(payload.booking_type) == "scheduled"


def _booking_duration_minutes(payload: BookingRequest) -> int | None:
    try:
        start_hour, start_minute = payload.start_time.split(":")
        end_hour, end_minute = payload.end_time.split(":")
        start = int(start_hour) * 60 + int(start_minute)
        end = int(end_hour) * 60 + int(end_minute)
        return end - start
    except (TypeError, ValueError):
        return None


def _scheduled_token_fernet() -> Fernet:
    raw_key = settings.scheduled_token_encryption_key.strip()
    if raw_key:
        return Fernet(raw_key.encode())
    derived = base64.urlsafe_b64encode(
        hashlib.sha256(settings.session_secret.encode()).digest()
    )
    return Fernet(derived)


def _encrypt_scheduled_graph_token(token: str | None) -> str | None:
    if not token:
        return None
    encrypted = _scheduled_token_fernet().encrypt(token.encode()).decode()
    return f"fernet:{encrypted}"


def _decrypt_scheduled_graph_token(value: object) -> str:
    token_value = str(value or "").strip()
    if not token_value:
        return ""
    if not token_value.startswith("fernet:"):
        raise RuntimeError("scheduled Graph token is not encrypted")
    try:
        return _scheduled_token_fernet().decrypt(
            token_value.removeprefix("fernet:").encode()
        ).decode()
    except InvalidToken as e:
        raise RuntimeError("could not decrypt scheduled Graph token") from e


def _set_active_booking(user_profile_id: str | None, active: bool) -> None:
    if not user_profile_id or not settings.supabase_enabled:
        return
    try:
        from .supabase_client import get_supabase

        get_supabase().table("user_profiles").update(
            {
                "active_booking": active,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        ).eq("id", user_profile_id).execute()
    except Exception as e:  # noqa: BLE001
        log.warning("could not update active_booking flag: %s", e)


def _set_book_without_confirmation(user_profile_id: str | None, value: bool) -> None:
    if not user_profile_id or not settings.supabase_enabled:
        return
    try:
        from .supabase_client import get_supabase

        get_supabase().table("user_profiles").update(
            {
                "book_without_confirmation": value,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        ).eq("id", user_profile_id).execute()
    except Exception as e:  # noqa: BLE001
        log.warning("could not update book_without_confirmation flag: %s", e)


def _user_has_active_booking(user_profile_id: str | None) -> bool:
    if not user_profile_id or not settings.supabase_enabled:
        return False
    try:
        from .supabase_client import get_supabase

        rows = (
            get_supabase()
            .table("user_profiles")
            .select("active_booking")
            .eq("id", user_profile_id)
            .limit(1)
            .execute()
            .data
            or []
        )
        return bool(rows and rows[0].get("active_booking"))
    except Exception as e:  # noqa: BLE001
        log.warning("could not read active_booking flag: %s", e)
        return False


def _activity_to_booking_request(row: dict) -> BookingRequest:
    return BookingRequest(
        room_email=str(row.get("room_email") or "").strip(),
        room_name=row.get("room_name"),
        date=str(row.get("date") or "").strip(),
        start_time=str(row.get("start_time") or "").strip(),
        end_time=str(row.get("end_time") or "").strip(),
        booking_type="scheduled",
        method=row.get("method") or "manual",
        subject=str(row.get("subject") or "").strip(),
        attendees=row.get("attendees") or [],
        body=row.get("body") or None,
    )


def _room_id_for_booking(sb, payload: BookingRequest) -> str | None:
    room_email = payload.room_email.strip().lower()
    rows = (
        sb.table("meeting_room_metadata")
        .select("id, email")
        .eq("in_use", True)
        .execute()
        .data
        or []
    )
    room = next(
        (r for r in rows if (r.get("email") or "").strip().lower() == room_email),
        None,
    )
    return str(room["id"]) if room and room.get("id") else None


def _scheduled_slot_has_conflict(user_profile_id: str, payload: BookingRequest) -> bool:
    start = _availability_slot_index(payload.start_time)
    end = _availability_slot_index(payload.end_time)
    if start is None or end is None or end <= start or not settings.supabase_enabled:
        return True
    try:
        from .supabase_client import get_supabase

        sb = get_supabase()
        room_id = _room_id_for_booking(sb, payload)
        if not room_id:
            return True
        rows = (
            sb.table("room_availability")
            .select("slots, slot_owner_ids")
            .eq("room_id", room_id)
            .eq("date", payload.date)
            .limit(1)
            .execute()
            .data
            or []
        )
        if not rows:
            return True
        slots = list(rows[0].get("slots") or [])
        slot_owner_ids = list(rows[0].get("slot_owner_ids") or [])
        if len(slots) != availability.SLOTS_PER_DAY:
            return True
        if len(slot_owner_ids) != availability.SLOTS_PER_DAY:
            slot_owner_ids = [None] * availability.SLOTS_PER_DAY
        for idx in range(start, min(end, availability.SLOTS_PER_DAY)):
            owner_id = slot_owner_ids[idx]
            if owner_id and str(owner_id) != user_profile_id:
                return True
            if slots[idx] not in (-1, 0):
                return True
        return False
    except Exception as e:  # noqa: BLE001
        log.warning("could not check scheduled slot conflict: %s", e)
        return True


def _create_pending_scheduled_booking(
    auth_user_id: str | None,
    user_profile_id: str | None,
    graph_access_token: str | None,
    payload: BookingRequest,
) -> dict:
    if not settings.supabase_enabled or not user_profile_id:
        raise HTTPException(503, "Scheduled booking requires Supabase configuration.")
    if not auth_user_id and not graph_access_token:
        raise HTTPException(400, "Scheduled booking requires a Graph access token.")
    if _user_has_active_booking(user_profile_id):
        raise HTTPException(
            409,
            "Bạn chỉ có thể có một scheduled booking đang active tại một thời điểm.",
        )
    if _scheduled_slot_has_conflict(user_profile_id, payload):
        raise HTTPException(409, "Slot này không còn khả dụng để scheduled booking.")

    try:
        from .supabase_client import get_supabase

        sb = get_supabase()
        row = (
            sb.table("user_activity")
            .insert(
                {
                    "user_id": user_profile_id,
                    "auth_user_id": auth_user_id,
                    "graph_access_token": (
                        _encrypt_scheduled_graph_token(graph_access_token)
                        if not auth_user_id
                        else None
                    ),
                    "room_email": payload.room_email,
                    "room_name": payload.room_name,
                    "date": payload.date,
                    "start_time": payload.start_time,
                    "end_time": payload.end_time,
                    "booking_type": "scheduled",
                    "method": payload.method,
                    "subject": payload.subject,
                    "attendees": payload.attendees,
                    "body": payload.body,
                    "status": "pending",
                }
            )
            .execute()
            .data[0]
        )
        _set_active_booking(user_profile_id, True)
        _mark_room_availability_owner(user_profile_id, payload)
        return {"ok": True, "id": str(row["id"]), "status": "pending"}
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        _set_active_booking(user_profile_id, False)
        raise HTTPException(500, f"Could not create scheduled booking: {e}")


def _mark_room_availability_owner(
    user_profile_id: str | None,
    payload: BookingRequest,
) -> None:
    """Persist the API-created booking owner per 15-min slot."""
    if not user_profile_id or not settings.supabase_enabled:
        return

    start = _availability_slot_index(payload.start_time)
    end = _availability_slot_index(payload.end_time)
    if start is None or end is None or end <= start:
        return

    try:
        from .supabase_client import get_supabase

        sb = get_supabase()
        room_rows = (
            sb.table("meeting_room_metadata")
            .select("id, email")
            .execute()
            .data
            or []
        )
        room_email = payload.room_email.strip().lower()
        room = next(
            (r for r in room_rows if (r.get("email") or "").strip().lower() == room_email),
            None,
        )
        if not room:
            log.warning(
                "could not mark room_availability owner: room not found for %s",
                payload.room_email,
            )
            return

        room_id = room["id"]
        rows = (
            sb.table("room_availability")
            .select("slots, slot_owner_ids")
            .eq("room_id", room_id)
            .eq("date", payload.date)
            .limit(1)
            .execute()
            .data
            or []
        )

        slots = list(rows[0].get("slots") or []) if rows else []
        if len(slots) != availability.SLOTS_PER_DAY:
            slots = [0] * availability.SLOTS_PER_DAY

        slot_owner_ids = list(rows[0].get("slot_owner_ids") or []) if rows else []
        if len(slot_owner_ids) != availability.SLOTS_PER_DAY:
            slot_owner_ids = [None] * availability.SLOTS_PER_DAY

        for idx in range(start, min(end, availability.SLOTS_PER_DAY)):
            slots[idx] = 1
            slot_owner_ids[idx] = user_profile_id

        sb.table("room_availability").upsert(
            {
                "room_id": room_id,
                "date": payload.date,
                "slots": slots,
                "slot_owner_ids": slot_owner_ids,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
            on_conflict="room_id,date",
        ).execute()
    except Exception as e:  # noqa: BLE001 - owner cache must not block booking
        log.warning("could not mark room_availability owner: %s", e)


def _release_room_availability_owner(
    user_profile_id: str | None,
    room_email: str,
    date: str,
    start_time: str,
    end_time: str,
) -> None:
    """Free up the slots this user previously owned (reverse of _mark_...)."""
    if not user_profile_id or not settings.supabase_enabled:
        return

    start = _availability_slot_index(start_time)
    end = _availability_slot_index(end_time)
    if start is None or end is None or end <= start:
        return

    try:
        from .supabase_client import get_supabase

        sb = get_supabase()
        room_rows = (
            sb.table("meeting_room_metadata").select("id, email").execute().data or []
        )
        target = room_email.strip().lower()
        room = next(
            (r for r in room_rows if (r.get("email") or "").strip().lower() == target),
            None,
        )
        if not room:
            return
        room_id = room["id"]
        rows = (
            sb.table("room_availability")
            .select("slots, slot_owner_ids")
            .eq("room_id", room_id)
            .eq("date", date)
            .limit(1)
            .execute()
            .data
            or []
        )
        if not rows:
            return
        slots = list(rows[0].get("slots") or [])
        slot_owner_ids = list(rows[0].get("slot_owner_ids") or [])
        if len(slots) != availability.SLOTS_PER_DAY:
            return
        if len(slot_owner_ids) != availability.SLOTS_PER_DAY:
            slot_owner_ids = [None] * availability.SLOTS_PER_DAY

        for idx in range(start, min(end, availability.SLOTS_PER_DAY)):
            # Only release slots this user actually owns.
            if str(slot_owner_ids[idx] or "") == user_profile_id:
                slots[idx] = 0
                slot_owner_ids[idx] = None

        sb.table("room_availability").upsert(
            {
                "room_id": room_id,
                "date": date,
                "slots": slots,
                "slot_owner_ids": slot_owner_ids,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
            on_conflict="room_id,date",
        ).execute()
    except Exception as e:  # noqa: BLE001 - availability cache must not block the edit
        log.warning("could not release room_availability owner: %s", e)


@app.get("/api/bookings")
async def list_my_bookings(request: Request):
    """Return the caller's own booking history.

    The owner id (user_profiles.id) is derived server-side from the verified
    auth token via `_booking_auth_context` — the client never supplies it — so a
    user can only ever read their own rows and cannot peek at someone else's data.
    """
    _token, _auth_user_id, user_profile_id, _email = await _booking_auth_context(request)
    if not user_profile_id or not settings.supabase_enabled:
        return {"bookings": []}

    from .supabase_client import get_supabase

    rows = (
        get_supabase()
        .table("user_activity")
        .select(
            "id, room_email, room_name, date, start_time, end_time, "
            "booking_type, method, subject, attendees, body, status, web_link, created_at"
        )
        .eq("user_id", user_profile_id)
        .order("created_at", desc=True)
        .limit(200)
        .execute()
        .data
        or []
    )
    return {"bookings": rows}


@app.post("/api/bookings")
async def create_booking(request: Request, payload: BookingRequest):
    token, auth_user_id, user_profile_id, _auth_email = await _booking_auth_context(
        request
    )

    payload = _resolve_booking_room_from_metadata(payload)
    payload.subject = payload.subject.strip() or "Meeting"
    if payload.end_time <= payload.start_time:
        _log_user_booking_activity(user_profile_id, payload, "failed", "invalid_time_range")
        raise HTTPException(400, "Giờ kết thúc phải sau giờ bắt đầu")
    if _payload_is_scheduled(payload):
        duration = _booking_duration_minutes(payload)
        if duration is None:
            _log_user_booking_activity(user_profile_id, payload, "failed", "invalid_time_range")
            raise HTTPException(400, "Thời gian booking không hợp lệ")
        if duration > SCHEDULE_MAX_DURATION_MINUTES:
            _log_user_booking_activity(
                user_profile_id,
                payload,
                "failed",
                "scheduled_duration_too_long",
            )
            raise HTTPException(400, "Scheduled booking chỉ được đặt tối đa 3 tiếng.")
        return _create_pending_scheduled_booking(auth_user_id, user_profile_id, token, payload)

    start_iso = f"{payload.date}T{payload.start_time}:00"
    end_iso = f"{payload.date}T{payload.end_time}:00"
    try:
        ev = await graph.create_event(
            token,
            payload.subject,
            start_iso,
            end_iso,
            settings.timezone,
            payload.room_email,
            payload.room_name,
            payload.attendees,
            payload.body,
        )
    except httpx.HTTPStatusError as e:
        _log_user_booking_activity(
            user_profile_id, payload, "failed", e.response.text, auth_user_id
        )
        raise HTTPException(e.response.status_code, e.response.text)
    except Exception as e:
        _log_user_booking_activity(user_profile_id, payload, "failed", str(e), auth_user_id)
        raise

    _log_user_booking_activity(
        user_profile_id,
        payload,
        "ok",
        auth_user_id=auth_user_id,
        graph_event_id=ev.get("id"),
        web_link=ev.get("webLink"),
    )
    _mark_room_availability_owner(user_profile_id, payload)

    # Mirror booking metadata into Supabase when available (Supabase path only).
    if auth_user_id and settings.supabase_enabled:
        try:
            from .supabase_client import get_supabase

            get_supabase().table("bookings").insert(
                {
                    "user_id": auth_user_id,
                    "room_email": payload.room_email,
                    "room_name": payload.room_name,
                    "date": payload.date,
                    "start_time": payload.start_time,
                    "end_time": payload.end_time,
                    "subject": payload.subject,
                    "graph_event_id": ev.get("id"),
                    "web_link": ev.get("webLink"),
                }
            ).execute()
        except Exception:
            pass

    return {"ok": True, **ev}


def _fetch_own_booking(user_profile_id: str, booking_id: str) -> dict:
    """Load a booking row owned by this user, or raise 404. Ownership is enforced
    server-side via user_id so a user can never touch someone else's booking."""
    from .supabase_client import get_supabase

    rows = (
        get_supabase()
        .table("user_activity")
        .select(
            "id, room_email, room_name, date, start_time, end_time, booking_type, "
            "method, subject, attendees, body, status, graph_event_id, web_link"
        )
        .eq("id", booking_id)
        .eq("user_id", user_profile_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        raise HTTPException(404, "Không tìm thấy booking.")
    return rows[0]


@app.patch("/api/bookings/{booking_id}")
async def update_booking(request: Request, booking_id: str, payload: UpdateBookingRequest):
    """Edit a booking.

    Instant bookings (already on the calendar) are updated for real via the Graph
    API. Scheduled bookings are still pending — nothing has been booked yet — so we
    only update the stored request row and re-mark the availability cache.
    """
    token, _auth_user_id, user_profile_id, _email = await _booking_auth_context(request)
    if not user_profile_id or not settings.supabase_enabled:
        raise HTTPException(503, "Booking storage is not configured.")

    row = _fetch_own_booking(user_profile_id, booking_id)
    if row.get("status") == "failed":
        raise HTTPException(400, "Không thể sửa booking đã thất bại.")

    # Resolve the new values, falling back to the existing ones.
    new_date = (payload.date or row["date"]).strip()
    new_start = (payload.start_time or row["start_time"]).strip()
    new_end = (payload.end_time or row["end_time"]).strip()
    new_subject = (
        payload.subject.strip() if payload.subject is not None else (row.get("subject") or "")
    ) or "Meeting"
    new_body = payload.body if payload.body is not None else row.get("body")
    new_attendees = (
        [a.strip() for a in payload.attendees if a and a.strip()]
        if payload.attendees is not None
        else (row.get("attendees") or [])
    )

    if new_end <= new_start:
        raise HTTPException(400, "Giờ kết thúc phải sau giờ bắt đầu")

    from .supabase_client import get_supabase

    sb = get_supabase()
    is_scheduled = _booking_type_for_db(row.get("booking_type") or "") == "scheduled"
    slot_changed = (
        new_date != row["date"]
        or new_start != row["start_time"]
        or new_end != row["end_time"]
    )

    if is_scheduled:
        if row.get("status") != "pending":
            raise HTTPException(400, "Scheduled booking này không còn ở trạng thái pending.")
        if slot_changed:
            probe = _activity_to_booking_request(
                {**row, "date": new_date, "start_time": new_start, "end_time": new_end}
            )
            if _scheduled_slot_has_conflict(user_profile_id, probe):
                raise HTTPException(409, "Slot mới không còn khả dụng để scheduled booking.")
            _release_room_availability_owner(
                user_profile_id,
                row["room_email"],
                row["date"],
                row["start_time"],
                row["end_time"],
            )
            _mark_room_availability_owner(user_profile_id, probe)
    else:
        # Instant booking: push the change to the real calendar event.
        event_id = (row.get("graph_event_id") or "").strip()
        if not event_id:
            raise HTTPException(
                400,
                "Booking này không có event id trên lịch nên không thể sửa.",
            )
        start_iso = f"{new_date}T{new_start}:00"
        end_iso = f"{new_date}T{new_end}:00"
        try:
            await graph.update_event(
                token,
                event_id,
                settings.timezone,
                subject=new_subject,
                start_iso=start_iso,
                end_iso=end_iso,
                body_text=new_body,
                attendees=(new_attendees if payload.attendees is not None else None),
                room_email=row["room_email"],
                room_name=row.get("room_name"),
            )
        except httpx.HTTPStatusError as e:
            raise HTTPException(e.response.status_code, e.response.text)
        if slot_changed:
            _release_room_availability_owner(
                user_profile_id,
                row["room_email"],
                row["date"],
                row["start_time"],
                row["end_time"],
            )
            _mark_room_availability_owner(
                user_profile_id,
                _activity_to_booking_request(
                    {**row, "date": new_date, "start_time": new_start, "end_time": new_end}
                ),
            )

    try:
        updated = (
            sb.table("user_activity")
            .update(
                {
                    "date": new_date,
                    "start_time": new_start,
                    "end_time": new_end,
                    "subject": new_subject,
                    "attendees": new_attendees,
                    "body": new_body,
                }
            )
            .eq("id", booking_id)
            .eq("user_id", user_profile_id)
            .execute()
            .data[0]
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Could not update booking: {e}")

    return {"ok": True, "booking": updated}


@app.delete("/api/bookings/{booking_id}")
async def delete_booking(request: Request, booking_id: str):
    """Cancel a booking.

    Instant bookings are cancelled on the real calendar via Graph. The history row is
    kept and its status flipped to "canceled" rather than deleted, so the user keeps a
    record of it. Scheduled bookings are only pending — we cancel the stored request,
    free the user's active-booking slot, and release the availability cache.
    """
    token, _auth_user_id, user_profile_id, _email = await _booking_auth_context(request)
    if not user_profile_id or not settings.supabase_enabled:
        raise HTTPException(503, "Booking storage is not configured.")

    row = _fetch_own_booking(user_profile_id, booking_id)
    is_scheduled = _booking_type_for_db(row.get("booking_type") or "") == "scheduled"
    was_ok = row.get("status") == "ok"

    # Instant + actually booked → cancel the real calendar event first.
    if not is_scheduled and was_ok:
        event_id = (row.get("graph_event_id") or "").strip()
        if event_id:
            try:
                await graph.delete_event(token, event_id)
            except httpx.HTTPStatusError as e:
                raise HTTPException(e.response.status_code, e.response.text)

    from .supabase_client import get_supabase

    # Keep the history row — just mark it canceled instead of deleting it.
    try:
        get_supabase().table("user_activity").update(
            {"status": "canceled"}
        ).eq("id", booking_id).eq("user_id", user_profile_id).execute()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Could not cancel booking: {e}")

    # Release the slots this booking occupied in the availability cache.
    if row.get("status") in ("ok", "pending"):
        _release_room_availability_owner(
            user_profile_id,
            row["room_email"],
            row["date"],
            row["start_time"],
            row["end_time"],
        )
    # A cancelled scheduled booking frees the user's single active-booking slot.
    if is_scheduled and row.get("status") == "pending":
        _set_active_booking(user_profile_id, False)

    return {"ok": True}


async def process_scheduled_bookings() -> dict:
    """Book pending scheduled requests once their target date enters the live window."""
    if not settings.supabase_enabled:
        return {"ok": False, "processed": 0, "failed": 0, "reason": "supabase_disabled"}

    from .supabase_client import get_supabase

    tz = ZoneInfo(settings.timezone)
    today = datetime.now(tz).date()
    horizon_end = today + timedelta(days=settings.availability_days - 1)
    sb = get_supabase()
    rows = (
        sb.table("user_activity")
        .select(
            "id, user_id, auth_user_id, graph_access_token, room_email, room_name, date, start_time, "
            "end_time, method, subject, attendees, body"
        )
        .eq("booking_type", "scheduled")
        .eq("status", "pending")
        .lte("date", horizon_end.isoformat())
        .order("created_at")
        .execute()
        .data
        or []
    )

    processed = 0
    failed = 0
    for row in rows:
        activity_id = row.get("id")
        user_profile_id = str(row.get("user_id") or "")
        auth_user_id = str(row.get("auth_user_id") or "")
        payload = _activity_to_booking_request(row)
        now_iso = datetime.now(timezone.utc).isoformat()

        try:
            if not auth_user_id:
                token = _decrypt_scheduled_graph_token(row.get("graph_access_token"))
                if not token:
                    raise RuntimeError("missing graph access token")
            else:
                token = await auth.get_graph_token(auth_user_id)
            start_iso = f"{payload.date}T{payload.start_time}:00"
            end_iso = f"{payload.date}T{payload.end_time}:00"
            ev = await graph.create_event(
                token,
                payload.subject,
                start_iso,
                end_iso,
                settings.timezone,
                payload.room_email,
                payload.room_name,
                payload.attendees,
                payload.body,
            )
            sb.table("user_activity").update(
                {
                    "status": "ok",
                    "graph_event_id": ev.get("id"),
                    "web_link": ev.get("webLink"),
                    "processed_at": now_iso,
                    "error_message": None,
                }
            ).eq("id", activity_id).execute()
            _set_active_booking(user_profile_id, False)
            _mark_room_availability_owner(user_profile_id, payload)
            try:
                sb.table("bookings").insert(
                    {
                        "user_id": auth_user_id,
                        "room_email": payload.room_email,
                        "room_name": payload.room_name,
                        "date": payload.date,
                        "start_time": payload.start_time,
                        "end_time": payload.end_time,
                        "subject": payload.subject,
                        "graph_event_id": ev.get("id"),
                        "web_link": ev.get("webLink"),
                    }
                ).execute()
            except Exception as e:  # noqa: BLE001
                log.warning("could not mirror scheduled booking metadata: %s", e)
            processed += 1
        except Exception as e:  # noqa: BLE001 - keep processing the queue
            failed += 1
            sb.table("user_activity").update(
                {
                    "status": "failed",
                    "error_message": str(e),
                    "processed_at": now_iso,
                }
            ).eq("id", activity_id).execute()
            _set_active_booking(user_profile_id, False)
            log.warning("scheduled booking %s failed: %s", activity_id, e)

    return {"ok": True, "processed": processed, "failed": failed}


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/health")
def health_root():
    """Health check required by GreenNode AgentBase Runtime (must return 200)."""
    return {"status": "ok"}
