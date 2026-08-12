"""Room Scout notification routes and background processor."""

from __future__ import annotations

import base64
import html
from datetime import date as date_cls, datetime, timedelta, timezone
from pathlib import Path
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from . import auth, availability, graph
from .app_context import log, settings
from .bookings import (
    _log_user_booking_activity,
    _mark_room_availability_owner,
    _release_room_availability_owner,
    SCOUT_SYNC_OFFSETS_SECONDS,
    background_token_for_create,
    poll_booking_room_response,
    resolve_background_graph_token,
)
from .chat import _effective_capacity_size
from .models import BookingRequest
from .profiles import _booking_auth_context, _read_user_profile
from .room_resources import _read_availability_cache, _require_auth

router = APIRouter()

# After booking a scout room we poll the room's accept/decline response with
# bookings.poll_booking_room_response. That poll is shared with every other booking
# path now; the scout is just the one caller that AWAITS it, because its next step
# (notify the user, or move on to the next candidate room) depends on the answer —
# which is also why it stays on the short SCOUT_SYNC_OFFSETS_SECONDS burst instead
# of the 90-second schedule the detached re-check uses.


class RoomScoutRequest(BaseModel):
    scout_date: date_cls | None = None
    duration_minutes: int = Field(ge=15, le=480)
    capacity_size: Literal["small", "medium", "large"] | None = None
    capacity_sizes: list[Literal["small", "medium", "large"]] = Field(
        default_factory=list, max_length=3
    )
    scout_start_time: str | None = None  # "HH:MM"
    scout_end_time: str | None = None  # "HH:MM"
    ignore_lunch_break: bool = False
    office: str | None = None


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


def _next_half_hour_slot(now_local: datetime) -> int:
    """Slot index of the next :00/:30 mark strictly after `now_local`.

    Auto-booking must never pick a window that has already started, so on the
    current day we scan only from the nearest upcoming half-hour boundary.
    """
    now_min = now_local.hour * 60 + now_local.minute
    nxt = ((now_min // 30) + 1) * 30
    return nxt // settings.availability_slot_minutes


def _scout_scan_window(
    tz: ZoneInfo, scout: dict, now_local: datetime | None = None
) -> tuple[int, int, int]:
    """Slot range to scan on the selected date for a free `duration` block.

    Returns (scan_start_idx, scan_end_idx, duration_slots). We scan the configured
    scout range [scout_start_time, scout_end_time) and can book any free block of
    the duration inside it. When `now_local` is given and the scout is for today,
    the scan start is clamped to the next :00/:30 mark after now so we never book
    a window in the past. If the range is missing we fall back to the full day.
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

    if now_local is not None and str(scout.get("scout_date") or "") == now_local.date().isoformat():
        start_idx = max(start_idx, _next_half_hour_slot(now_local))

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
    # Cùng quy tắc với scheduled booking: OAuth để rỗng (job tự lấy token của chính
    # user lúc chạy), luồng dán token giữ bản mã hoá vì đó là credential duy nhất.
    return background_token_for_create(token, auth_user_id)


def _scout_expiry(
    scout_date,
    *,
    end_minutes: int,
    duration_minutes: int,
    local_today,
    tz,
    auto_refresh: bool,
):
    """When the scout stops auto-booking.

    Direct Microsoft (auto-refreshing) sessions have no token-lifetime cap, so the
    scout runs until the last start time that still fits the requested duration
    inside the window — after that instant no full-duration booking can be placed,
    so there's nothing left to hunt for (e.g. a 2h scout over 13:00–18:00 stops at
    16:00). Manual pasted-token sessions keep the old cap: the encrypted Graph
    token expires, so the scout can't outlive midnight after its creation day (or
    the window end when scouting today, whichever is sooner)."""
    midnight = datetime.min.time()
    if auto_refresh:
        last_start = max(0, end_minutes - duration_minutes)
        return datetime.combine(scout_date, midnight, tzinfo=tz) + timedelta(minutes=last_start)
    scout_end = datetime.combine(local_today + timedelta(days=1), midnight, tzinfo=tz)
    if scout_date == local_today:
        window_end = datetime.combine(local_today, midnight, tzinfo=tz) + timedelta(
            minutes=end_minutes
        )
        scout_end = min(scout_end, window_end)
    return scout_end


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


def _earliest_free_block(
    slots: list,
    scan_start: int,
    scan_end: int,
    duration_slots: int,
    reserved: set[int] | None = None,
) -> int | None:
    """Start index of the earliest free block of `duration_slots` consecutive slots
    inside [scan_start, scan_end), or None. A slot counts as taken if it is busy in
    `slots` OR present in `reserved` (held by an earlier scout this cycle)."""
    run = 0
    for idx in range(scan_start, scan_end):
        free = slots[idx] == 0 and (reserved is None or idx not in reserved)
        if free:
            run += 1
            if run >= duration_slots:
                return idx - duration_slots + 1
        else:
            run = 0
    return None


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

    wanted_sizes = {
        str(size).strip().lower()
        for size in (scout.get("capacity_sizes") or [])
        if str(size).strip()
    }
    legacy_size = str(scout.get("capacity_size") or "").strip().lower()
    if legacy_size:
        wanted_sizes.add(legacy_size)
    if wanted_sizes:
        rooms = [r for r in rooms if _effective_capacity_size(r) in wanted_sizes]
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


# VNG Meet brand mark, sent as an inline CID attachment rather than an inline SVG
# or base64 data-URI: Outlook desktop strips both of those, but renders cid: images.
# The PNG asset ships in app/assets and is base64-encoded once at import time.
_VNG_MEET_LOGO_CID = "vngmeetlogo"
_VNG_MEET_LOGO_PATH = Path(__file__).resolve().parent / "assets" / "vng_meet_logo.png"
try:
    _VNG_MEET_LOGO_B64 = base64.b64encode(_VNG_MEET_LOGO_PATH.read_bytes()).decode()
except OSError:  # asset missing — fall back to text-only header
    _VNG_MEET_LOGO_B64 = ""

# Displayed at 28px (rendered from a 64px asset for crisp HiDPI), matching the
# wordmark size next to it.
_VNG_MEET_EMAIL_ICON = (
    f'<img src="cid:{_VNG_MEET_LOGO_CID}" width="28" height="28" alt="VNG Meet" '
    'style="display:block;border:0" />'
    if _VNG_MEET_LOGO_B64
    else ""
)


def _vng_meet_inline_images() -> list[dict]:
    """Inline image attachments for the Room Scout email (the brand logo)."""
    if not _VNG_MEET_LOGO_B64:
        return []
    return [
        {
            "content_id": _VNG_MEET_LOGO_CID,
            "content_bytes": _VNG_MEET_LOGO_B64,
            "content_type": "image/png",
        }
    ]


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
    sizes = [
        str(size).strip().lower()
        for size in (scout.get("capacity_sizes") or [])
        if str(size).strip()
    ]
    if not sizes and scout.get("capacity_size"):
        sizes = [str(scout["capacity_size"]).strip().lower()]
    size = ", ".join(sizes) or "any"
    book_url = html.escape(settings.public_url)
    return f"""
    <div style="font-family:Arial,sans-serif;color:#18181b;line-height:1.5">
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px">
        <tr>
          <td style="vertical-align:middle;padding-right:10px">{_VNG_MEET_EMAIL_ICON}</td>
          <td style="vertical-align:middle;font-size:20px;font-weight:700;color:#18181b">VNG Meet</td>
        </tr>
      </table>
      <h2 style="margin:0 0 12px">Available Rooms Found</h2>
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
      <p style="margin-top:16px"><a href="{book_url}" style="color:#F05A22">Open VNG Meet to book</a></p>
    </div>
    """


async def _room_scout_graph_token(row: dict) -> str:
    return await resolve_background_graph_token(
        row.get("auth_user_id"),
        row.get("graph_access_token"),
        user_profile_id=row.get("user_id"),
    )


def _scout_subject(email: str) -> str:
    """Default meeting subject for an auto-booked scout, mirroring instant booking
    (frontend uses "{name}'s Meeting"; backend falls back to "Meeting")."""
    local = str(email or "").split("@")[0].strip()
    return f"{local}'s Meeting" if local else "Meeting"


def _scout_rooms_in_browse_order(sb, scout: dict) -> list[dict]:
    """Candidate rooms filtered by office + capacity size, in the same order the
    browse grid shows them (in_use, no explicit sort)."""
    query = (
        sb.table("meeting_room_metadata")
        .select("id, name, email, capacity, capacity_size, building, floor, office")
        .eq("in_use", True)
    )
    office = str(scout.get("office") or "").strip()
    if office:
        query = query.eq("office", office)
    rooms = [r for r in (query.execute().data or []) if r.get("id") and r.get("email")]

    wanted_sizes = {
        str(size).strip().lower()
        for size in (scout.get("capacity_sizes") or [])
        if str(size).strip()
    }
    legacy_size = str(scout.get("capacity_size") or "").strip().lower()
    if legacy_size:
        wanted_sizes.add(legacy_size)
    if wanted_sizes:
        rooms = [r for r in rooms if _effective_capacity_size(r) in wanted_sizes]
    return rooms


async def process_room_scouts() -> dict:
    if not settings.supabase_enabled:
        raise RuntimeError("Supabase not configured; cannot process room scouts.")
    from .supabase_client import get_supabase

    sb = get_supabase()
    tz = ZoneInfo(settings.timezone)
    now = datetime.now(timezone.utc)
    now_local = datetime.now(tz)
    avail = settings.availability_slot_minutes

    # Auto-cancel scouts past their expiry (set at create time by `_scout_expiry`:
    # the last duration-fitting start for auto-refresh sessions, else the token-
    # capped midnight/window-end).
    sb.table("room_scouts").update(
        {"status": "canceled", "updated_at": now.isoformat()}
    ).eq("status", "active").lte("expires_at", now.isoformat()).execute()

    # First come, first served: process the oldest requests first so an earlier
    # scout gets first pick of a room contested by a later, overlapping scout.
    scouts = (
        sb.table("room_scouts")
        .select(
            "id, user_id, auth_user_id, email, duration_minutes, capacity_size, capacity_sizes, "
            "scout_date, scout_start_time, scout_end_time, ignore_lunch_break, office, "
            "graph_access_token, pending_activity_id, created_at"
        )
        .eq("status", "active")
        .gt("expires_at", now.isoformat())
        .order("created_at")
        .execute()
        .data
        or []
    )
    if not scouts:
        return {"checked": 0, "booked": 0, "pending": 0, "errors": 0}

    # room_id lookup by email — to resolve an in-flight booking's room and reserve it.
    room_id_by_email = {
        str(r["email"]).strip().lower(): r["id"]
        for r in (
            sb.table("meeting_room_metadata")
            .select("id, email")
            .eq("in_use", True)
            .execute()
            .data
            or []
        )
        if r.get("id") and r.get("email")
    }

    # Slots held by earlier scouts this run (their fresh or still-pending bookings),
    # so a later overlapping scout can't grab the same room+window. Keyed (room_id,
    # day). This only ever affects scouts whose windows actually overlap.
    reserved: dict[tuple[str, str], set[int]] = {}

    def _reserve(room_id, day, start_idx, end_idx):
        if room_id and start_idx is not None and end_idx is not None:
            reserved.setdefault((room_id, day), set()).update(range(start_idx, end_idx))

    def _unreserve(room_id, day, start_idx, end_idx):
        if room_id and start_idx is not None and end_idx is not None:
            reserved.get((room_id, day), set()).difference_update(range(start_idx, end_idx))

    lunch_slots = range((12 * 60) // avail, (13 * 60) // avail)
    booked = 0
    pending = 0
    errors = 0

    for scout in scouts:
        scout_id = scout["id"]
        scout_day = str(scout.get("scout_date") or "")
        user_profile_id = scout.get("user_id")
        checked_at = datetime.now(timezone.utc).isoformat()
        try:
            token = await _room_scout_graph_token(scout)

            # 1) Re-check an in-flight booking created on a previous cycle.
            pending_id = scout.get("pending_activity_id")
            if pending_id:
                rows = (
                    sb.table("user_activity")
                    .select("room_email, date, start_time, end_time, status")
                    .eq("id", pending_id)
                    .limit(1)
                    .execute()
                    .data
                    or []
                )
                act = rows[0] if rows else None
                if not act or act.get("status") == "canceled":
                    sb.table("room_scouts").update(
                        {"pending_activity_id": None, "updated_at": checked_at}
                    ).eq("id", scout_id).execute()
                else:
                    a_room_id = room_id_by_email.get(str(act.get("room_email") or "").strip().lower())
                    a_day = str(act.get("date"))
                    a_start_min = _time_to_minutes(act.get("start_time"))
                    a_end_min = _time_to_minutes(act.get("end_time"))
                    a_s = (a_start_min // avail) if a_start_min is not None else None
                    a_e = ((a_end_min + avail - 1) // avail) if a_end_min is not None else None
                    # Hold it up front so a later overlapping scout can't take it.
                    _reserve(a_room_id, a_day, a_s, a_e)
                    status = await poll_booking_room_response(
                        token, user_profile_id, scout["email"], pending_id, sb,
                        offsets=SCOUT_SYNC_OFFSETS_SECONDS,
                    )
                    if status == "success":
                        sb.table("room_scouts").update(
                            {"status": "success", "pending_activity_id": None,
                             "booked_room_email": act.get("room_email"),
                             "booked_start_time": act.get("start_time"),
                             "booked_end_time": act.get("end_time"),
                             "last_checked_at": checked_at, "updated_at": checked_at}
                        ).eq("id", scout_id).execute()
                        booked += 1
                        continue
                    if status == "pending":
                        sb.table("room_scouts").update(
                            {"last_checked_at": checked_at, "updated_at": checked_at}
                        ).eq("id", scout_id).execute()
                        pending += 1
                        continue
                    # declined: sync already deleted the event — free slots and retry.
                    _unreserve(a_room_id, a_day, a_s, a_e)
                    _release_room_availability_owner(
                        user_profile_id, act.get("room_email"), a_day,
                        act.get("start_time"), act.get("end_time"),
                    )
                    sb.table("room_scouts").update(
                        {"pending_activity_id": None}
                    ).eq("id", scout_id).execute()

            # 2) Try to book a room in browse order.
            scan_start, scan_end, duration_slots = _scout_scan_window(tz, scout, now_local)
            if scan_start + duration_slots > scan_end:
                sb.table("room_scouts").update(
                    {"last_checked_at": checked_at, "updated_at": checked_at}
                ).eq("id", scout_id).execute()
                continue

            rooms = _scout_rooms_in_browse_order(sb, scout)
            cache = _read_availability_cache(sb, [r["id"] for r in rooms], [scout_day]) if rooms else {}
            ignore_lunch = bool(scout.get("ignore_lunch_break"))
            outcome = None
            for room in rooms:
                row = cache.get((room["id"], scout_day))
                slots = list(row.get("slots") or []) if row else []
                if len(slots) != availability.SLOTS_PER_DAY:
                    continue
                if ignore_lunch:
                    for idx in lunch_slots:
                        slots[idx] = 0
                block = _earliest_free_block(
                    slots, scan_start, scan_end, duration_slots,
                    reserved.get((room["id"], scout_day)),
                )
                if block is None:
                    continue

                start_label = _minutes_to_label(block * avail)
                end_label = _minutes_to_label((block + duration_slots) * avail)
                payload = BookingRequest(
                    room_email=room["email"],
                    room_name=room.get("name"),
                    date=scout_day,
                    start_time=start_label,
                    end_time=end_label,
                    booking_type="scout",
                    method="manual",
                    subject=_scout_subject(scout["email"]),
                    attendees=[],
                    body=None,
                )
                ev = await graph.create_event(
                    token, payload.subject,
                    f"{scout_day}T{start_label}:00", f"{scout_day}T{end_label}:00",
                    settings.timezone, room["email"], room.get("name"), [], None,
                )
                activity_id = _log_user_booking_activity(
                    user_profile_id, payload, "pending",
                    auth_user_id=scout.get("auth_user_id"),
                    graph_event_id=ev.get("id"), web_link=ev.get("webLink"),
                )
                _mark_room_availability_owner(user_profile_id, payload)
                _reserve(room["id"], scout_day, block, block + duration_slots)
                if activity_id:
                    sb.table("room_scouts").update(
                        {"pending_activity_id": activity_id}
                    ).eq("id", scout_id).execute()

                status = (
                    await poll_booking_room_response(
                        token, user_profile_id, scout["email"], activity_id, sb,
                        offsets=SCOUT_SYNC_OFFSETS_SECONDS,
                    )
                    if activity_id
                    else "pending"
                )
                if status == "success":
                    sb.table("room_scouts").update(
                        {"status": "success", "pending_activity_id": None,
                         "booked_room_email": room["email"],
                         "booked_start_time": start_label,
                         "booked_end_time": end_label,
                         "last_checked_at": checked_at, "updated_at": checked_at}
                    ).eq("id", scout_id).execute()
                    booked += 1
                    outcome = "success"
                    break
                if status == "pending":
                    sb.table("room_scouts").update(
                        {"last_checked_at": checked_at, "updated_at": checked_at}
                    ).eq("id", scout_id).execute()
                    pending += 1
                    outcome = "pending"
                    break
                # declined: event already deleted by sync — free slots, try next room.
                _unreserve(room["id"], scout_day, block, block + duration_slots)
                _release_room_availability_owner(
                    user_profile_id, room["email"], scout_day, start_label, end_label
                )
                sb.table("room_scouts").update(
                    {"pending_activity_id": None}
                ).eq("id", scout_id).execute()

            if outcome is None:
                sb.table("room_scouts").update(
                    {"last_checked_at": checked_at, "updated_at": checked_at}
                ).eq("id", scout_id).execute()
        except Exception as e:  # noqa: BLE001 - one scout must not block others
            errors += 1
            log.warning("room scout failed for %s: %s", scout_id, e)
            sb.table("room_scouts").update(
                {"last_checked_at": checked_at, "updated_at": checked_at}
            ).eq("id", scout_id).execute()

    return {
        "checked": len(scouts),
        "booked": booked,
        "pending": pending,
        "errors": errors,
    }


@router.get("/api/room-scouts")
async def list_room_scouts(request: Request):
    token, _auth_user_id, user_profile_id, _email = await _booking_auth_context(request)
    can_send_mail = _token_has_mail_send(token)
    if not user_profile_id or not settings.supabase_enabled:
        return {"scouts": [], "can_send_mail": can_send_mail}
    from .supabase_client import get_supabase

    sb = get_supabase()
    rows = (
        sb
        .table("room_scouts")
        .select(
            "id, email, scout_date, duration_minutes, capacity_size, capacity_sizes, scout_start_time, scout_end_time, "
            "ignore_lunch_break, office, status, last_checked_at, last_notified_at, "
            "expires_at, created_at, booked_room_email, booked_start_time, booked_end_time, acknowledged_at"
        )
        .eq("user_id", user_profile_id)
        .order("created_at", desc=True)
        .limit(20)
        .execute()
        .data
        or []
    )
    _attach_booked_rooms(sb, rows)
    return {"scouts": rows, "can_send_mail": can_send_mail}


def _attach_booked_rooms(sb, rows: list[dict]) -> None:
    """Enrich success scouts with the booked room's display metadata so the tab
    can render the 'we found a room' screen without a second round-trip."""
    emails = {
        str(r.get("booked_room_email") or "").strip().lower()
        for r in rows
        if r.get("status") == "success" and r.get("booked_room_email")
    }
    emails.discard("")
    if not emails:
        return
    meta_rows = (
        sb.table("meeting_room_metadata")
        .select("name, email, building, floor, zone, capacity_size, thumbnail_link, map_link")
        .execute()
        .data
        or []
    )
    by_email = {
        str(m.get("email") or "").strip().lower(): m
        for m in meta_rows
        if m.get("email")
    }
    for r in rows:
        email = str(r.get("booked_room_email") or "").strip().lower()
        meta = by_email.get(email)
        if r.get("status") == "success" and meta:
            r["booked_room"] = {
                "name": meta.get("name"),
                "email": meta.get("email"),
                "building": meta.get("building"),
                "floor": meta.get("floor"),
                "zone": meta.get("zone"),
                "capacity_size": _effective_capacity_size(meta),
                "thumbnail_link": meta.get("thumbnail_link"),
                "map_link": meta.get("map_link"),
            }


@router.post("/api/room-scouts")
async def create_room_scout(request: Request, payload: RoomScoutRequest):
    token, auth_user_id, user_profile_id, email = await _booking_auth_context(request)
    if not settings.supabase_enabled or not user_profile_id or not email:
        raise HTTPException(503, "Room Scout requires Supabase and a user profile email.")
    # Scout now auto-books instead of emailing, so Mail.Send is no longer required
    # (booking uses Calendars.ReadWrite, already granted). Kept commented in case the
    # email-notification path is re-enabled later.
    # if not _token_has_mail_send(token):
    #     raise HTTPException(403, MAIL_SEND_REQUIRED_MESSAGE)
    from .supabase_client import get_supabase

    # Enforce at most one active scout per user (the UI and chat bot assume this).
    if (
        get_supabase()
        .table("room_scouts")
        .select("id")
        .eq("user_id", user_profile_id)
        .eq("status", "active")
        .limit(1)
        .execute()
        .data
    ):
        raise HTTPException(
            409,
            "Bạn đang có một phiên Săn phòng đang chạy. Hãy dừng phiên hiện tại trước khi tạo phiên mới.",
        )

    profile = _read_user_profile(user_profile_id, email) or {}
    office = (payload.office or profile.get("office") or "").strip() or None

    start_minutes = _time_to_minutes(payload.scout_start_time)
    end_minutes = _time_to_minutes(payload.scout_end_time)
    if start_minutes is None or end_minutes is None or end_minutes <= start_minutes:
        raise HTTPException(422, "Scout range must have a valid start and end time.")
    if end_minutes - start_minutes < payload.duration_minutes:
        raise HTTPException(422, "Scout range must be at least as long as the duration.")

    tz = ZoneInfo(settings.timezone)
    local_today = datetime.now(tz).date()
    scout_date = payload.scout_date or local_today
    max_scout_date = local_today + timedelta(days=14)
    if scout_date < local_today or scout_date > max_scout_date:
        raise HTTPException(
            422, "Scout date must be between today and 14 days from today."
        )
    now = datetime.now(timezone.utc).isoformat()
    # The selected date controls which availability row is checked. Expiry depends
    # on whether the session auto-refreshes (see `_scout_expiry`).
    auto_refresh = bool(auth_user_id) and auth.has_refresh_token(auth_user_id)
    scout_end_local = _scout_expiry(
        scout_date,
        end_minutes=end_minutes,
        duration_minutes=payload.duration_minutes,
        local_today=local_today,
        tz=tz,
        auto_refresh=auto_refresh,
    )
    # The scout keeps auto-booking until `scout_end_local`; block if the token
    # won't survive that long (covers the chat-bot flow too — there is no modal
    # there). Mirrors the frontend gate in RoomScout.tsx. No-op for auto-refresh
    # sessions.
    from .token_guard import ensure_token_survives_until

    ensure_token_survives_until(
        token,
        scout_end_local,
        blocked_action="Không thể bật Săn phòng (Room Scout)",
        auth_user_id=auth_user_id,
    )
    row = {
        "user_id": user_profile_id,
        "auth_user_id": auth_user_id,
        "email": email,
        "scout_date": scout_date.isoformat(),
        "duration_minutes": payload.duration_minutes,
        "capacity_size": payload.capacity_size,
        "capacity_sizes": list(dict.fromkeys(payload.capacity_sizes)),
        "scout_start_time": _minutes_to_label(start_minutes),
        "scout_end_time": _minutes_to_label(end_minutes),
        "ignore_lunch_break": payload.ignore_lunch_break,
        "office": office,
        "status": "active",
        "graph_access_token": _room_scout_token_for_create(token, auth_user_id),
        "expires_at": scout_end_local.astimezone(timezone.utc).isoformat(),
        "updated_at": now,
    }
    res = get_supabase().table("room_scouts").insert(row).execute()
    return {"ok": True, "scout": res.data[0] if res.data else row}


@router.patch("/api/room-scouts/{scout_id}")
async def update_room_scout(request: Request, scout_id: str, payload: RoomScoutRequest):
    _token, auth_user_id, user_profile_id, email = await _booking_auth_context(request)
    if not settings.supabase_enabled or not user_profile_id or not email:
        raise HTTPException(503, "Room Scout requires Supabase and a user profile email.")
    from .supabase_client import get_supabase

    sb = get_supabase()
    existing = (
        sb.table("room_scouts")
        .select("id, status")
        .eq("id", scout_id)
        .eq("user_id", user_profile_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not existing:
        raise HTTPException(404, "Room Scout not found.")
    if existing[0].get("status") != "active":
        raise HTTPException(409, "Chỉ có thể sửa phiên Săn phòng đang chạy.")

    profile = _read_user_profile(user_profile_id, email) or {}
    office = (payload.office or profile.get("office") or "").strip() or None

    start_minutes = _time_to_minutes(payload.scout_start_time)
    end_minutes = _time_to_minutes(payload.scout_end_time)
    if start_minutes is None or end_minutes is None or end_minutes <= start_minutes:
        raise HTTPException(422, "Scout range must have a valid start and end time.")
    if end_minutes - start_minutes < payload.duration_minutes:
        raise HTTPException(422, "Scout range must be at least as long as the duration.")

    tz = ZoneInfo(settings.timezone)
    local_today = datetime.now(tz).date()
    scout_date = payload.scout_date or local_today
    max_scout_date = local_today + timedelta(days=14)
    if scout_date < local_today or scout_date > max_scout_date:
        raise HTTPException(
            422, "Scout date must be between today and 14 days from today."
        )
    # Recompute the expiry exactly like create_room_scout.
    auto_refresh = bool(auth_user_id) and auth.has_refresh_token(auth_user_id)
    scout_end_local = _scout_expiry(
        scout_date,
        end_minutes=end_minutes,
        duration_minutes=payload.duration_minutes,
        local_today=local_today,
        tz=tz,
        auto_refresh=auto_refresh,
    )

    from .token_guard import ensure_token_survives_until

    ensure_token_survives_until(
        _token,
        scout_end_local,
        blocked_action="Không thể cập nhật phiên Săn phòng (Room Scout)",
        auth_user_id=auth_user_id,
    )

    now = datetime.now(timezone.utc).isoformat()
    update = {
        "scout_date": scout_date.isoformat(),
        "duration_minutes": payload.duration_minutes,
        "capacity_size": payload.capacity_size,
        "capacity_sizes": list(dict.fromkeys(payload.capacity_sizes)),
        "scout_start_time": _minutes_to_label(start_minutes),
        "scout_end_time": _minutes_to_label(end_minutes),
        "ignore_lunch_break": payload.ignore_lunch_break,
        "office": office,
        "expires_at": scout_end_local.astimezone(timezone.utc).isoformat(),
        # Params changed → let the next matching scan act on the new criteria.
        "last_notified_signature": None,
        "updated_at": now,
    }
    res = (
        sb.table("room_scouts")
        .update(update)
        .eq("id", scout_id)
        .eq("user_id", user_profile_id)
        .execute()
    )
    return {"ok": True, "scout": res.data[0] if res.data else update}


@router.delete("/api/room-scouts/{scout_id}")
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


@router.post("/api/room-scouts/{scout_id}/acknowledge")
async def acknowledge_room_scout(request: Request, scout_id: str):
    """Dismiss the success screen ("Great"): mark the auto-booked scout as seen so
    the tab returns to the default form instead of re-showing the success card."""
    _token, _auth_user_id, user_profile_id, _email = await _booking_auth_context(request)
    if not user_profile_id or not settings.supabase_enabled:
        raise HTTPException(503, "Room Scout requires Supabase.")
    from .supabase_client import get_supabase

    now = datetime.now(timezone.utc).isoformat()
    get_supabase().table("room_scouts").update(
        {"acknowledged_at": now, "updated_at": now}
    ).eq("id", scout_id).eq("user_id", user_profile_id).eq("status", "success").execute()
    return {"ok": True}


@router.post("/api/room-scouts/acknowledge-all")
async def acknowledge_all_room_scouts(request: Request):
    """Dismiss every pending success card at once ("Great"). Multiple auto-books
    can pile up unacknowledged; the UI only ever shows the newest, so tapping
    Great clears them all so the older ones don't resurface behind it."""
    _token, _auth_user_id, user_profile_id, _email = await _booking_auth_context(request)
    if not user_profile_id or not settings.supabase_enabled:
        raise HTTPException(503, "Room Scout requires Supabase.")
    from .supabase_client import get_supabase

    now = datetime.now(timezone.utc).isoformat()
    get_supabase().table("room_scouts").update(
        {"acknowledged_at": now, "updated_at": now}
    ).eq("user_id", user_profile_id).eq("status", "success").is_(
        "acknowledged_at", "null"
    ).execute()
    return {"ok": True}


@router.post("/api/room-scouts/process")
async def run_room_scouts_now(request: Request):
    _require_auth(request)
    try:
        summary = await process_room_scouts()
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    return {"ok": True, **summary}
