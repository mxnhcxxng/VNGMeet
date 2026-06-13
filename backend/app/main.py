"""FastAPI backend: meeting-room availability grid.

Two auth paths (see auth.py): paste a Graph access token (works without admin),
or sign in via Supabase's Azure OAuth provider once SUPABASE_* is configured.
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import httpx
from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.middleware.sessions import SessionMiddleware

from . import auth, availability, graph
from .config import get_settings

log = logging.getLogger("vngmeet")
settings = get_settings()
AVAILABILITY_CACHE_TTL = timedelta(minutes=5)
_AVAILABILITY_REFRESH_LOCK = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start the availability refresh scheduler when app-only creds are present."""
    scheduler = None
    if (
        settings.supabase_enabled
        and settings.graph_app_enabled
        and not settings.availability_refresh_disabled
    ):
        from apscheduler.schedulers.asyncio import AsyncIOScheduler
        from apscheduler.triggers.cron import CronTrigger

        scheduler = AsyncIOScheduler(timezone=settings.timezone)
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
        # Prime the cache shortly after boot so the grid isn't empty on first load.
        scheduler.add_job(_safe_refresh, "date", run_date=None)
        scheduler.start()
        log.info(
            "Availability scheduler started (cron minute=%s).",
            settings.availability_refresh_minutes,
        )
    else:
        log.warning(
            "Availability scheduler NOT started "
            "(supabase_enabled=%s, graph_app_enabled=%s, disabled=%s). "
            "Cache will refresh on demand from the requesting user's delegated token.",
            settings.supabase_enabled,
            settings.graph_app_enabled,
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


app = FastAPI(title="VNG Meet — Meeting Room Availability", lifespan=lifespan)

app.add_middleware(SessionMiddleware, secret_key=settings.session_secret, same_site="lax")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
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
    }


def _read_user_profile(profile_id: str | None, email: str | None = None) -> dict | None:
    if not settings.supabase_enabled or not profile_id and not email:
        return None
    try:
        from .supabase_client import get_supabase

        query = (
            get_supabase()
            .table("user_profiles")
            .select("id, email, email_username, office, floor, building, preferred_rooms")
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
    claims = auth.decode_jwt_claims(token)
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
    claims = auth.decode_jwt_claims(token)
    return token, None, _upsert_user_profile(claims), _profile_email(claims)


@app.post("/api/auth/token")
def set_token(request: Request, access_token: str = Body(..., embed=True)):
    """Manual mode: paste a Graph access token (e.g. from Graph Explorer).

    Token does not auto-refresh — paste again when it expires (~1h). Works without
    admin consent / Supabase.
    """
    if not access_token or not access_token.strip():
        raise HTTPException(400, "access_token rỗng")
    sid = auth.session_id(request)
    auth.set_manual_token(sid, access_token)
    claims = auth.decode_jwt_claims(access_token)
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
    claims = auth.decode_jwt_claims(token)
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
        claims = auth.decode_jwt_claims(token)
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
            .select("email, office, building, floor, zone, capacity, capacity_size, thumbnail_link")
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
            .select("id, name, email, building, floor, zone, capacity, capacity_size, office, thumbnail_link")
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
                busy = any(
                    start + k < len(slots) and slots[start + k] != 0
                    for k in range(sub_per_slot)
                )
                is_your_booking = bool(owner_email and owner_email == current_user_email)
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
# Bookings
# --------------------------------------------------------------------------- #
class BookingRequest(BaseModel):
    room_email: str
    room_name: str | None = None
    date: str  # "2026-06-11"
    start_time: str  # "09:00"
    end_time: str  # "10:00"
    booking_type: Literal["instant", "schedule"] = "instant"
    method: Literal["manual", "chatbot"] = "manual"
    subject: str
    attendees: list[str] = []
    body: str | None = None


class ChatSendRequest(BaseModel):
    content: str
    thread_id: str | None = None


class ChatBookingActionRequest(BaseModel):
    thread_id: str
    confirmation_id: str
    action: Literal["accept", "reject"]
    booking: BookingRequest | None = None


class UserProfileUpdateRequest(BaseModel):
    office: str
    floor: str = ""
    building: str = ""
    preferred_rooms: list[str] = Field(default_factory=list)


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
        claims = auth.decode_jwt_claims(token)

    cleaned = _validate_profile_selection(payload.model_dump())

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
CHAT_SYSTEM_PROMPT = """Bạn là trợ lý đặt lịch cho app booking phòng họp.

Phạm vi hỗ trợ:
Chỉ trả lời các câu hỏi liên quan đến đặt lịch, kiểm tra lịch trống, đặt phòng họp, đổi lịch hoặc huỷ lịch.
Nếu người dùng hỏi ngoài phạm vi này, hãy trả lời ngắn gọn: “Mình chỉ hỗ trợ các yêu cầu liên quan đến đặt lịch và phòng họp.”

Nhiệm vụ chính:
- Hiểu nhu cầu đặt lịch của người dùng.
- Dùng API/function calling để kiểm tra phòng trống theo thời gian, số người, địa điểm hoặc yêu cầu cụ thể.
- Gợi ý các khung giờ và phòng có thể đặt.
- Xác nhận đủ thông tin trước khi chuẩn bị phiếu đặt phòng.
- Gọi API/function calling để tạo phiếu xác nhận đặt phòng; chỉ book thật sau khi người dùng bấm Đồng ý trên card.

Luồng xử lý:
1. Người dùng hỏi có phòng phù hợp không.
2. Kiểm tra thông tin đã có: ngày, giờ bắt đầu, giờ kết thúc hoặc thời lượng, số người, địa điểm/khu vực, yêu cầu thêm như màn hình, TV, máy chiếu, online meeting.
3. Nếu thiếu thông tin cần thiết, hỏi bổ sung ngắn gọn.
4. Khi đủ thông tin, gọi function kiểm tra lịch/phòng trống.
5. Trả về danh sách phòng và khung giờ có thể đặt.
6. Khi người dùng chọn phòng, kiểm tra lại các trường bắt buộc để đặt lịch.
7. Khi người dùng muốn đặt phòng, gọi function book_room để tạo card xác nhận với các thông tin đã điền.
8. Không nói đã đặt phòng sau khi gọi book_room; chỉ nói người dùng kiểm tra card và bấm Đồng ý hoặc Từ chối.
9. Báo kết quả đặt phòng thành công hoặc thất bại sau khi hệ thống nhận action từ card.

Nguyên tắc phản hồi:
- Trả lời ngắn gọn, rõ ràng, tập trung vào hành động tiếp theo.
- Không bịa phòng, giờ trống hoặc trạng thái booking nếu chưa có dữ liệu từ API.
- Nếu API không trả về phòng phù hợp, gợi ý người dùng đổi thời gian, địa điểm hoặc tiêu chí.
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
                    "capacity": {
                        "type": "integer",
                        "description": "Số người tham dự tối thiểu. Có thể bỏ trống nếu user chưa nói.",
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
                    "subject": {"type": "string", "description": "Tiêu đề cuộc họp."},
                    "attendees": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Email người tham dự, nếu có.",
                    },
                    "body": {"type": "string", "description": "Nội dung mô tả cuộc họp."},
                },
                "required": ["date", "start_time", "end_time", "subject"],
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
        claims = auth.decode_jwt_claims(token)
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


def _norm_room_lookup(value: object) -> str:
    return " ".join(str(value or "").strip().lower().split())


def _resolve_booking_room_from_metadata(payload: BookingRequest) -> BookingRequest:
    """Resolve the room email/name from meeting_room_metadata instead of trusting LLM."""
    if not settings.supabase_enabled:
        return payload

    room_name = _norm_room_lookup(payload.room_name)
    room_email = _norm_room_lookup(payload.room_email)
    if not room_name and not room_email:
        raise HTTPException(400, "Thiếu tên phòng hoặc email phòng.")

    from .supabase_client import get_supabase

    rows = (
        get_supabase()
        .table("meeting_room_metadata")
        .select("name, email")
        .eq("in_use", True)
        .execute()
        .data
        or []
    )

    def room_name_matches(row: dict) -> bool:
        name = _norm_room_lookup(row.get("name"))
        email = _norm_room_lookup(row.get("email"))
        return bool(room_name and room_name in {name, email})

    def room_email_matches(row: dict) -> bool:
        return bool(room_email and room_email == _norm_room_lookup(row.get("email")))

    match = next((row for row in rows if room_name_matches(row)), None)
    if not match:
        match = next((row for row in rows if room_email_matches(row)), None)
    if not match and room_name:
        candidates = [
            row
            for row in rows
            if room_name in _norm_room_lookup(row.get("name"))
            or _norm_room_lookup(row.get("name")) in room_name
        ]
        if len(candidates) == 1:
            match = candidates[0]

    if not match or not match.get("email"):
        raise HTTPException(
            400,
            "Không tìm thấy phòng trong meeting_room_metadata. "
            "Bạn chọn lại đúng tên phòng nhé.",
        )

    payload.room_email = str(match["email"]).strip()
    payload.room_name = str(match.get("name") or match["email"]).strip()
    return payload


async def _tool_check_room_availability(request: Request, args: dict) -> dict:
    if not settings.supabase_enabled:
        return {"ok": False, "error": "Availability checking requires Supabase."}
    date = str(args.get("date") or "").strip()
    start_time = str(args.get("start_time") or "").strip()
    end_time = str(args.get("end_time") or "").strip()
    capacity = args.get("capacity")
    location = str(args.get("location") or "").strip().lower()
    try:
        start_idx, end_idx = _chat_slot_range(start_time, end_time)
        datetime.fromisoformat(date)
    except Exception:
        return {"ok": False, "error": "date/start_time/end_time không hợp lệ."}

    from .supabase_client import get_supabase

    sb = get_supabase()
    query = (
        sb.table("meeting_room_metadata")
        .select("id, name, email, building, floor, zone, capacity, office")
        .eq("in_use", True)
    )
    rows = query.execute().data or []
    if isinstance(capacity, int) and capacity > 0:
        rows = [r for r in rows if (r.get("capacity") or 0) >= capacity]
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

    room_ids = [r["id"] for r in rows if r.get("id")]
    try:
        cache = await _ensure_availability_cache_fresh(request, sb, room_ids, [date])
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
        row = cache.get((room["id"], date))
        slots = row.get("slots") if row else []
        if len(slots) != availability.SLOTS_PER_DAY:
            continue
        if all(slots[idx] == 0 for idx in range(start_idx, min(end_idx, len(slots)))):
            available.append(
                {
                    "name": room.get("name"),
                    "email": room.get("email"),
                    "building": room.get("building"),
                    "floor": room.get("floor"),
                    "zone": room.get("zone"),
                    "capacity": room.get("capacity"),
                }
            )

    return {
        "ok": True,
        "date": date,
        "start_time": start_time,
        "end_time": end_time,
        "count": len(available),
        "rooms": available[:8],
        "truncated": len(available) > 8,
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
        "rooms": available[:8],
        "truncated": len(available) > 8,
        "source": "graph_live",
    }


async def _tool_book_room(
    request: Request,
    args: dict,
    graph_token: str,
    user_profile_id: str | None,
    auth_user_id: str | None,
) -> dict:
    _ = (request, graph_token, user_profile_id, auth_user_id)
    payload = BookingRequest(
        room_email=str(args.get("room_email") or "").strip(),
        room_name=(args.get("room_name") or None),
        date=str(args.get("date") or "").strip(),
        start_time=str(args.get("start_time") or "").strip(),
        end_time=str(args.get("end_time") or "").strip(),
        subject=str(args.get("subject") or "").strip(),
        attendees=args.get("attendees") or [],
        body=args.get("body") or None,
        method="chatbot",
    )
    if not payload.subject:
        return {"ok": False, "error": "Thiếu subject."}
    if payload.end_time <= payload.start_time:
        return {"ok": False, "error": "Giờ kết thúc phải sau giờ bắt đầu."}
    try:
        payload = _resolve_booking_room_from_metadata(payload)
    except HTTPException as e:
        return {"ok": False, "error": str(e.detail)}
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
        return await _tool_check_room_availability(request, args)
    if name == "book_room":
        return await _tool_book_room(
            request, args, graph_token, user_profile_id, auth_user_id
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
    runtime_context = (
        f"\n\nNgữ cảnh thời gian hiện tại:\n"
        f"- Hôm nay là {now.date().isoformat()}.\n"
        f"- Thời gian hiện tại là {now.strftime('%H:%M')}.\n"
        f"- Timezone là {settings.timezone}.\n"
        "- Khi người dùng nói hôm nay/ngày mai/hôm qua hoặc thứ trong tuần, "
        "hãy quy đổi theo ngữ cảnh thời gian này trước khi gọi function."
    )
    messages = [
        {"role": "system", "content": CHAT_SYSTEM_PROMPT + runtime_context},
        *history,
    ]
    tool_results: list[dict] = []
    headers = {
        "Authorization": f"Bearer {settings.llm_api_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=60) as client:
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
                return (msg.get("content") or "").strip(), tool_results

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
    if payload.action == "reject":
        assistant_msg = _insert_chat_message(
            sb,
            str(thread["id"]),
            bot_profile_id,
            user_profile_id,
            "Đã huỷ yêu cầu đặt phòng này.",
            metadata,
        )
        return {"ok": True, "message": _chat_message_response(assistant_msg, "assistant")}

    if not payload.booking:
        raise HTTPException(400, "Thiếu thông tin đặt phòng.")

    payload.booking.method = "chatbot"
    try:
        result = await create_booking(request, payload.booking)
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
    status: Literal["ok", "failed"],
    error_message: str | None = None,
) -> None:
    if not user_profile_id or not settings.supabase_enabled:
        return
    try:
        from .supabase_client import get_supabase

        get_supabase().table("user_activity").insert(
            {
                "user_id": user_profile_id,
                "room_email": payload.room_email,
                "room_name": payload.room_name,
                "date": payload.date,
                "start_time": payload.start_time,
                "end_time": payload.end_time,
                "booking_type": payload.booking_type,
                "method": payload.method,
                "status": status,
                "error_message": error_message,
            }
        ).execute()
    except Exception as e:  # noqa: BLE001 - booking log must not block booking flow
        log.warning("could not insert user_activity booking log: %s", e)


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


@app.post("/api/bookings")
async def create_booking(request: Request, payload: BookingRequest):
    token, auth_user_id, user_profile_id, _auth_email = await _booking_auth_context(
        request
    )

    payload = _resolve_booking_room_from_metadata(payload)
    if not payload.subject.strip():
        _log_user_booking_activity(user_profile_id, payload, "failed", "empty_subject")
        raise HTTPException(400, "Tiêu đề cuộc họp không được để trống")
    if payload.end_time <= payload.start_time:
        _log_user_booking_activity(user_profile_id, payload, "failed", "invalid_time_range")
        raise HTTPException(400, "Giờ kết thúc phải sau giờ bắt đầu")

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
        _log_user_booking_activity(user_profile_id, payload, "failed", e.response.text)
        raise HTTPException(e.response.status_code, e.response.text)
    except Exception as e:
        _log_user_booking_activity(user_profile_id, payload, "failed", str(e))
        raise

    _log_user_booking_activity(user_profile_id, payload, "ok")
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


@app.get("/api/health")
def health():
    return {"status": "ok"}
