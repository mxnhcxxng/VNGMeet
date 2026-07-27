"""Room listing, schedule, and availability-cache routes/helpers."""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request

from . import auth, availability, graph, token_pool
from .app_context import AVAILABILITY_CACHE_TTL, log, settings
from .profiles import _read_user_profile, _request_identity

router = APIRouter()
_AVAILABILITY_REFRESH_LOCK = None
ROOM_LAYOUT_COUNTS_BY_OFFICE = {
    # Hardcoded for the browse loading grid. Update these when room metadata
    # changes so the skeleton column count stays stable before availability loads.
    "campus": 32,
    "sala": 4,
    "tnr": 10,
}

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
                "thumbnail_link, direction, map_link"
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


@router.get("/api/rooms")
async def rooms(request: Request):
    token, _ = await auth.resolve_token(request)
    try:
        return _enrich_rooms(await graph.list_rooms(token))
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, e.response.text)


@router.get("/api/room-layout")
async def room_layout(request: Request):
    _require_auth(request)
    return {"roomCountsByOffice": ROOM_LAYOUT_COUNTS_BY_OFFICE}


def _time_labels() -> list[str]:
    labels = []
    cur = settings.business_start_hour * 60
    end = settings.business_end_hour * 60
    while cur < end:
        labels.append(f"{cur // 60:02d}:{cur % 60:02d}")
        cur += settings.slot_minutes
    return labels


@router.get("/api/schedule")
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
        .select("room_id, date, slots, slot_owner_ids, slot_attendee_ids, meetings, updated_at")
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
    """HARD-FALLBACK inline refresh — normally a no-op.

    Freshness is owned by the background job (app-only cron, or the 1-minute
    graph_token_pool job), so the read path just serves whatever the cache
    holds. Only when rows are missing or older than AVAILABILITY_CACHE_TTL
    (job dead: no usable pool token, first deploy, scheduler down) does the
    request borrow the user's own Graph token to rebuild the table inline —
    and that token is saved to the pool so the background job can take over.
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
        token, user_id = await auth.resolve_token(request)
        if user_id:
            # Reseed the pool so the next background run stops falling through
            # to this inline path. (Manual tokens are saved at paste time.)
            token_pool.save_token(user_id, token)
        summary = await availability.refresh_availability_delegated(token)
        log.info("availability cache refreshed on-demand (fallback): %s", summary)

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


def _profile_id_by_email(sb, email: str) -> str | None:
    """user_profiles.id for a single lowercased email, or None."""
    if not email:
        return None
    try:
        rows = (
            sb.table("user_profiles")
            .select("id")
            .eq("email", email)
            .limit(1)
            .execute()
            .data
            or []
        )
        return str(rows[0]["id"]) if rows and rows[0].get("id") else None
    except Exception as e:  # noqa: BLE001 - best-effort identity lookup
        log.warning("could not read user profile id for %s: %s", email, e)
        return None


def _my_meetings_for_room(
    cache: dict,
    room_id: str,
    day_list: list[str],
    me_email: str,
) -> list[dict]:
    """The current user's meetings in this room (organizer OR attendee), read from
    the cached `meetings` jsonb (explicit per-event start/end, so adjacent bookings
    stay distinct). Powers the read-only "Booked by …" view, block boundaries, and
    the date-picker dots. Each item: {date, start, end, role, bookedBy, subject,
    attendees, body}.
    """
    if not me_email:
        return []
    me = me_email.strip().lower()
    out: list[dict] = []
    for day in day_list:
        row = cache.get((room_id, day))
        if not row:
            continue
        for m in row.get("meetings") or []:
            owner = (m.get("owner") or "").strip().lower()
            attendees = [a.strip().lower() for a in (m.get("attendees") or [])]
            is_owner = owner == me
            if not is_owner and me not in attendees:
                continue
            out.append(
                {
                    "date": day,
                    "start": m.get("start"),
                    "end": m.get("end"),
                    "role": "owner" if is_owner else "attendee",
                    "bookedBy": m.get("owner"),
                    "subject": m.get("subject") or "",
                    "attendees": m.get("attendees") or [],
                    "body": m.get("body") or "",
                }
            )
    return out


async def _sync_calendar_after_response(
    token: str,
    user_profile_id: str | None,
    me_email: str | None,
) -> None:
    """Personal-calendar sync, run by BackgroundTasks after the grid was sent."""
    try:
        summary = await availability.sync_my_calendar(token, user_profile_id, me_email)
        log.info("calendar synced in background: %s", summary)
    except Exception as e:  # noqa: BLE001 - background sync must never raise
        log.warning("background calendar sync failed: %s", e)


@router.get("/api/availability")
async def availability_grid(
    request: Request,
    background_tasks: BackgroundTasks,
    days: int = Query(14, ge=1, le=31),
    emails: str = Query(
        "",
        description="Comma-separated room emails; empty = all in-use rooms",
    ),
):
    """Browse-grid data served from the room_availability cache.

    Same response shape as /api/schedule so the frontend grid is a drop-in swap.
    The cache stores full-day 15-min slots; here we fold them into the displayed
    business-hours window at slot_minutes granularity. The cache is kept fresh by
    the background job (see graph_token_pool); a request only refreshes inline as
    a hard fallback when the cache is empty or very old. The user's personal
    calendar sync runs AFTER the response is sent — the grid never waits on it,
    and the next poll picks up the attributed slots.
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

    # Attribute the signed-in user's real events (organized or invited, incl. ones
    # made directly in Outlook) into the shared cache — AFTER the response, so the
    # grid never waits on Graph. The frontend re-polls (≤2 min, and at 15/45/90s
    # after a booking) and picks up the attributed slots on the next fetch.
    current_user_profile_id = _profile_id_by_email(sb, current_user_email)
    # The post-booking refresh sends sync=force to bypass the throttle so a freshly
    # created "pending" booking gets its room response (ok/failed) on the next poll.
    force_sync = request.query_params.get("sync") == "force"
    if availability.should_sync_calendar(current_user_profile_id, force=force_sync):
        try:
            # resolve_token needs the request context, so resolve now (normally a
            # cache hit) and hand the token to the post-response task.
            token, _ = await auth.resolve_token(request)
            background_tasks.add_task(
                _sync_calendar_after_response,
                token,
                current_user_profile_id,
                current_user_email,
            )
        except Exception as e:  # noqa: BLE001 - calendar sync must not block the grid
            log.warning("calendar sync scheduling skipped: %s", e)

    owner_profile_ids = {
        str(owner_id)
        for row in cache.values()
        for owner_id in (row.get("slot_owner_ids") or [])
        if owner_id
    }
    owner_email_by_profile_id = _profile_email_by_id(sb, owner_profile_ids)

    # Slots backed by one of the user's still-pending bookings (instant awaiting the
    # room's response, or a scheduled booking not yet placed). These render yellow on
    # the grid instead of the green "confirmed mine" so the user sees it's not locked
    # in yet. Keyed by (room_id, date, 15-min slot index).
    pending_slots: set[tuple[str, str, int]] = set()
    if current_user_profile_id:
        try:
            email_to_id = {r["email"].strip().lower(): r["id"] for r in rooms_list}
            prows = (
                sb.table("user_activity")
                .select("room_email, date, start_time, end_time")
                .eq("user_id", current_user_profile_id)
                .eq("status", "pending")
                .gte("date", day_list[0])
                .lte("date", day_list[-1])
                .execute()
                .data
                or []
            )
            for pr in prows:
                rid = email_to_id.get((pr.get("room_email") or "").strip().lower())
                s = _availability_slot_index(pr.get("start_time"))
                e = _availability_slot_index(pr.get("end_time"))
                if not rid or s is None or e is None:
                    continue
                pdate = str(pr.get("date"))
                for idx in range(s, min(e, availability.SLOTS_PER_DAY)):
                    pending_slots.add((rid, pdate, idx))
        except Exception as e:  # noqa: BLE001 - pending overlay is best-effort
            log.warning("could not read pending bookings for grid overlay: %s", e)

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
            slot_attendee_ids = row.get("slot_attendee_ids") if row else []
            # Any day containing -1 is not treated as a normal instant day. The
            # final cache day intentionally keeps Graph-free slots at -1 while
            # Graph-busy slots are 1, so bookings there remain scheduled but
            # existing admin bookings stay blocked.
            # The grid uses a distinct status band:
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
                is_owner = bool(owner_email and owner_email == current_user_email)
                # A slot is also "yours" if you were invited to its event (attendee).
                is_attendee = bool(
                    current_user_profile_id
                    and any(
                        start + k < len(slot_attendee_ids)
                        and current_user_profile_id in (slot_attendee_ids[start + k] or [])
                        for k in range(sub_per_slot)
                    )
                )
                # Owner (I booked it) outranks attendee (I'm only invited).
                # My own booking still pending (room not confirmed / not placed):
                # 6 instant / 7 schedule. Invited-only meeting: 8 instant / 9 schedule.
                is_pending = is_owner and any(
                    (r["id"], day, start + k) in pending_slots
                    for k in range(sub_per_slot)
                )
                if schedule_day:
                    busy = any(
                        start + k < len(slots) and slots[start + k] == 1
                        for k in range(sub_per_slot)
                    )
                    if is_owner:
                        final_value = 7 if is_pending else 5
                    elif is_attendee:
                        final_value = 9
                    elif owner_profile_id:
                        final_value = 4
                    elif busy:
                        final_value = 1
                    else:
                        final_value = 3
                else:
                    busy = any(
                        start + k < len(slots) and slots[start + k] != 0
                        for k in range(sub_per_slot)
                    )
                    if is_owner:
                        final_value = 6 if is_pending else 2
                    elif is_attendee:
                        final_value = 8
                    else:
                        final_value = 1 if owner_profile_id or busy else 0
                api_grid[ti][di] = final_value
        out_rooms.append(
            {
                **r,
                "grid": api_grid,
                "meetings": _my_meetings_for_room(
                    cache, r["id"], day_list, current_user_email
                ),
            }
        )

    return {
        "timezone": settings.timezone,
        "slotMinutes": settings.slot_minutes,
        "days": day_list,
        "times": times,
        "rooms": out_rooms,
    }


# --------------------------------------------------------------------------- #
# "Phòng trống hôm nay" cho màn Home của Mini App
# --------------------------------------------------------------------------- #
FREE_DURATIONS_MINUTES = [30, 60, 90, 120, 150, 180]


def _numeric_floor(floor: str | None) -> int | None:
    """Số nguyên đầu tiên trong chuỗi floor (khớp numericFloor ở browse room)."""
    if not floor:
        return None
    m = re.search(r"-?\d+", str(floor))
    return int(m.group()) if m else None


def _location_rank(
    room_building: str | None,
    room_floor: str | None,
    user_building: str | None,
    user_floor: str | None,
) -> tuple[int, int, int]:
    """Độ 'gần user' theo toà + tầng — khớp locationRank ở browse room.
    Tuple nhỏ hơn = gần user hơn."""
    rb = (room_building or "").strip().lower()
    pb = (user_building or "").strip().lower()
    same_building = bool(rb and pb and rb == pb)
    uf = _numeric_floor(user_floor)
    rf = _numeric_floor(room_floor)
    has_floor = uf is not None and rf is not None
    same_floor = has_floor and rf == uf
    if same_building and same_floor:
        return (0, 0, 0)
    if not same_building and same_floor:
        return (1, 0, 0)
    if same_building and has_floor:
        return (2, abs(rf - uf), 1 if rf > uf else 0)
    if not same_building and has_floor:
        return (3, abs(rf - uf), 1 if rf > uf else 0)
    return (4, 2**31, 1)


def _earliest_free_start(
    slots: list[int],
    window_start_min: int,
    window_end_min: int,
    duration_min: int,
    slot_min: int,
    step_min: int = 30,
) -> int | None:
    """Phút bắt đầu (từ 00:00) SỚM NHẤT mà phòng trống liên tục đủ `duration_min`
    và kết thúc trước `window_end_min`. Ứng viên cách nhau `step_min` (mốc 30p).
    Slot coi là trống khi giá trị ∈ {0, -1}. None nếu không có khối trống nào."""
    latest_start = window_end_min - duration_min
    start = window_start_min
    while start <= latest_start:
        s_idx = start // slot_min
        e_idx = (start + duration_min) // slot_min
        if all(
            0 <= k < len(slots) and slots[k] in (0, -1) for k in range(s_idx, e_idx)
        ):
            return start
        start += step_min
    return None


def _hhmm(total_min: int) -> str:
    return f"{total_min // 60:02d}:{total_min % 60:02d}"


@router.get("/api/rooms/free-today")
async def free_rooms_today(request: Request):
    """Phòng trống cho màn Home.

    Từ mốc 30/00 phút sắp tới gần nhất đến 18:00, phòng nào còn trống liên tục
    30p / 1h / ... / 3h thì hiện. Sort theo giờ bắt đầu tăng dần, rồi tới phòng
    gần user nhất (theo toà + tầng, giống browse room). Qua 18:00 thì tính cho
    ngày hôm sau (bắt đầu từ giờ làm việc). Mỗi mốc thời lượng tối đa 4 phòng.

    Trả sẵn cả 6 mốc trong 1 response để client đổi tab không phải gọi lại — chỉ
    đọc bảng room_availability (client gọi khi mở app / bấm làm mới)."""
    _auth_user_id, email = _request_identity(request)
    email = (email or "").strip().lower()
    if not settings.supabase_enabled:
        raise HTTPException(503, "Availability cache requires Supabase configuration.")

    from .supabase_client import get_supabase

    sb = get_supabase()
    profile = _read_user_profile(None, email) or {}
    user_building = str(profile.get("building") or "")
    user_floor = str(profile.get("floor") or "")
    user_office = str(profile.get("office") or "").strip()

    tz = ZoneInfo(settings.timezone)
    now = datetime.now(tz)
    end_min = settings.business_end_hour * 60  # 18:00

    # Mốc 30/00 phút sắp tới gần nhất (làm tròn LÊN).
    past = now.minute % 30
    if past == 0 and now.second == 0 and now.microsecond == 0:
        boundary = now.replace(second=0, microsecond=0)
    else:
        boundary = now.replace(second=0, microsecond=0) + timedelta(minutes=30 - past)

    # Giờ đóng cửa hôm nay (vd 18:00).
    close_dt = now.replace(
        hour=settings.business_end_hour, minute=0, second=0, microsecond=0
    )
    # So sánh nguyên mốc thời gian (boundary) với giờ đóng cửa — dùng datetime chứ
    # KHÔNG dùng boundary.hour, vì khi làm tròn lên vắt qua nửa đêm (vd 23:47 →
    # 00:00 hôm sau) thì boundary.hour = 0, so với 18 sẽ sai và hiện nhầm "hôm nay".
    if boundary >= close_dt:
        # Đã hết giờ đặt hôm nay → hiện "Phòng trống ngày mai", bắt đầu từ giờ làm việc.
        target_date = now.date() + timedelta(days=1)
        window_start_min = settings.business_start_hour * 60
        is_tomorrow = True
    else:
        target_date = now.date()
        window_start_min = max(
            boundary.hour * 60 + boundary.minute, settings.business_start_hour * 60
        )
        is_tomorrow = False

    day = target_date.isoformat()

    rooms_list = [
        r
        for r in (
            sb.table("meeting_room_metadata")
            .select(
                "id, name, email, building, floor, zone, capacity, "
                "capacity_size, office, thumbnail_link, direction"
            )
            .eq("in_use", True)
            .execute()
            .data
            or []
        )
        if r.get("id")
    ]
    # Chỉ gợi ý phòng cùng office với user (giống suggest phòng bên chat). Nếu
    # profile chưa có office thì không lọc (hiện tất cả) để tránh trả rỗng.
    if user_office:
        rooms_list = [
            r for r in rooms_list if str(r.get("office") or "").strip() == user_office
        ]
    room_ids = [r["id"] for r in rooms_list]
    # CHỈ đọc bảng room_availability (do background job giữ tươi). KHÔNG gọi
    # _ensure_availability_cache_fresh vì nó cần Graph token của user để refresh
    # inline → user Zalo (chưa link Microsoft) sẽ bị 401 → Mini App xoá session
    # và authen lại bằng mã SĐT đã dùng. Cache trống thì trả danh sách rỗng.
    cache = _read_availability_cache(sb, room_ids, [day])
    slot_min = settings.availability_slot_minutes

    by_duration: dict[str, list[dict]] = {}
    for duration in FREE_DURATIONS_MINUTES:
        entries: list[dict] = []
        for r in rooms_list:
            row = cache.get((r["id"], day))
            slots = (row or {}).get("slots") or []
            if len(slots) < availability.SLOTS_PER_DAY:
                continue
            start_min = _earliest_free_start(
                slots, window_start_min, end_min, duration, slot_min
            )
            if start_min is None:
                continue
            entries.append(
                {
                    "room": r,
                    "start_min": start_min,
                    "loc": _location_rank(
                        r.get("building"), r.get("floor"), user_building, user_floor
                    ),
                }
            )
        # Sort: giờ bắt đầu ↑ → gần user nhất → tên phòng.
        entries.sort(
            key=lambda e: (
                e["start_min"],
                e["loc"],
                (e["room"].get("name") or "").lower(),
            )
        )
        by_duration[str(duration)] = [
            {
                "name": e["room"].get("name"),
                "email": e["room"].get("email"),
                "building": e["room"].get("building"),
                "floor": e["room"].get("floor"),
                "capacity": e["room"].get("capacity"),
                "capacity_size": e["room"].get("capacity_size"),
                "image": e["room"].get("thumbnail_link"),
                "start_time": _hhmm(e["start_min"]),
                "end_time": _hhmm(e["start_min"] + duration),
            }
            for e in entries[:4]
        ]

    return {
        "day": day,
        "isTomorrow": is_tomorrow,
        "durations": FREE_DURATIONS_MINUTES,
        "byDuration": by_duration,
    }


@router.get("/api/rooms/directory")
async def rooms_directory(request: Request):
    """Danh sách phòng cho màn "Chỉ đường" của Mini App.

    Đọc thẳng meeting_room_metadata (KHÔNG cần Graph token, giống free-today) nên
    user Zalo chưa link Microsoft vẫn xem được. Trả kèm chỉ đường (direction) và
    ảnh sơ đồ (map_link) để dựng màn chi tiết. Client tự nhóm theo office (Campus /
    TNR — Sala không có chỉ đường nên client bỏ tab đó) rồi theo chữ cái đầu."""
    _request_identity(request)
    if not settings.supabase_enabled:
        raise HTTPException(503, "Room directory requires Supabase configuration.")

    from .supabase_client import get_supabase

    sb = get_supabase()
    rows = (
        sb.table("meeting_room_metadata")
        .select(
            "name, email, building, floor, zone, capacity, capacity_size, "
            "office, thumbnail_link, direction, map_link"
        )
        .eq("in_use", True)
        .execute()
        .data
        or []
    )
    rooms = [
        {
            "name": r.get("name"),
            "email": r.get("email"),
            "building": r.get("building"),
            "floor": r.get("floor"),
            "capacity": r.get("capacity"),
            "capacity_size": r.get("capacity_size"),
            "office": r.get("office"),
            "image": r.get("thumbnail_link"),
            "direction": r.get("direction"),
            "map": r.get("map_link"),
        }
        for r in rows
        if r.get("name")
    ]
    return {"rooms": rooms}


@router.post("/api/availability/refresh")
async def availability_refresh(request: Request):
    """Force an immediate cache refresh into the room_availability table.

    Refreshes using the requesting user's DELEGATED token via
    /me/calendar/getSchedule (needs only Calendars.Read.Shared) — the same
    delegated path the background scheduler uses via the token pool.
    """
    try:
        token, _ = await auth.resolve_token(request)
        summary = await availability.refresh_availability_delegated(token)
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, e.response.text)
    return {"ok": True, **summary}
