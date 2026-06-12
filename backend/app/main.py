"""FastAPI backend: meeting-room availability grid.

Two auth paths (see auth.py): paste a Graph access token (works without admin),
or sign in via Supabase's Azure OAuth provider once SUPABASE_* is configured.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo

import httpx
from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
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
            CronTrigger(minute=settings.availability_refresh_minutes),
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
    for key in ("email", "upn", "preferred_username", "unique_name"):
        value = claims.get(key)
        if isinstance(value, str) and "@" in value:
            return value.strip().lower()
    return None


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
    name = auth._decode_jwt_claim(access_token, "upn", "preferred_username", "name")
    return JSONResponse({"ok": True, "username": name or "Graph token"})


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
        _upsert_user_profile(claims)
        return JSONResponse(
            {
                "authenticated": True,
                "username": claims.get("email"),
                "email": _profile_email(claims),
                "graphLinked": auth.has_refresh_token(claims["sub"]),
            }
        )
    sid = auth.session_id(request)
    token = auth.get_manual_token(sid)
    if not token:
        return JSONResponse({"authenticated": False})
    claims = auth.decode_jwt_claims(token)
    _upsert_user_profile(claims)
    name = auth._decode_jwt_claim(token, "upn", "preferred_username", "name")
    return JSONResponse(
        {
            "authenticated": True,
            "username": name or "Graph token",
            "email": _profile_email(claims),
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
            .select("email, office, building, floor, zone, capacity")
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
                "zone": m.get("zone"),
                "office": m.get("office"),
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
            .select("id, name, email, building, floor, zone, capacity, office")
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
