"""FastAPI backend: meeting-room availability grid.

Two auth paths (see auth.py): paste a Graph access token (works without admin),
or sign in via Supabase's Azure OAuth provider once SUPABASE_* is configured.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
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
        claims = auth.verify_jwt(bearer[len("Bearer ") :])
        return JSONResponse(
            {
                "authenticated": True,
                "username": claims.get("email"),
                "graphLinked": auth.has_refresh_token(claims["sub"]),
            }
        )
    sid = auth.session_id(request)
    token = auth.get_manual_token(sid)
    if not token:
        return JSONResponse({"authenticated": False})
    name = auth._decode_jwt_claim(token, "upn", "preferred_username", "name")
    return JSONResponse({"authenticated": True, "username": name or "Graph token"})


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
                status = int(view[ti]) if ti < len(view) and view[ti].isdigit() else 0
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
    bearer = auth._bearer(request)
    if bearer:
        auth.verify_jwt(bearer)  # raises 401 on invalid/missing secret
        return
    if auth.get_manual_token(auth.session_id(request)):
        return
    raise HTTPException(401, "Not authenticated")


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
        .select("room_id, date, slots, updated_at")
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
    _require_auth(request)
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

    # Precompute, for each display time label, the underlying 15-min slot indices.
    base_idx = [int(t[:2]) * 4 + int(t[3:5]) // (60 // 4) for t in times]
    # (hour*4 + minute//15) — minute is 0/30 for 30-min slots, both land cleanly.

    out_rooms = []
    for r in rooms_list:
        grid = [[0] * days for _ in times]
        for di, day in enumerate(day_list):
            row = cache.get((r["id"], day))
            slots = row.get("slots") if row else None
            if not slots:
                continue
            for ti, start in enumerate(base_idx):
                busy = any(
                    start + k < len(slots) and slots[start + k] == 1
                    for k in range(sub_per_slot)
                )
                grid[ti][di] = 1 if busy else 0
        out_rooms.append({**r, "grid": grid})

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
    subject: str
    attendees: list[str] = []
    body: str | None = None


@app.post("/api/bookings")
async def create_booking(request: Request, payload: BookingRequest):
    token, user_id = await auth.resolve_token(request)

    if not payload.subject.strip():
        raise HTTPException(400, "Tiêu đề cuộc họp không được để trống")
    if payload.end_time <= payload.start_time:
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
        raise HTTPException(e.response.status_code, e.response.text)

    # Mirror booking metadata into Supabase when available (Supabase path only).
    if user_id and settings.supabase_enabled:
        try:
            from .supabase_client import get_supabase

            get_supabase().table("bookings").insert(
                {
                    "user_id": user_id,
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
