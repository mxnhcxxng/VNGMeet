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
from .bookings import _decrypt_scheduled_graph_token, _encrypt_scheduled_graph_token
from .chat import _effective_capacity_size
from .profiles import _booking_auth_context, _read_user_profile
from .room_resources import _read_availability_cache, _require_auth

router = APIRouter()

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


def _scout_scan_window(tz: ZoneInfo, scout: dict) -> tuple[int, int, int]:
    """Slot range to scan on the selected date for a free `duration` block.

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
    # Auto-cancel scouts at midnight after the day they were created.
    sb.table("room_scouts").update(
        {"status": "canceled", "updated_at": now.isoformat()}
    ).eq("status", "active").lte("expires_at", now.isoformat()).execute()

    scouts = (
        sb.table("room_scouts")
        .select(
            "id, user_id, auth_user_id, email, duration_minutes, capacity_size, capacity_sizes, "
            "scout_date, scout_start_time, scout_end_time, ignore_lunch_break, office, "
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
        scout_day = str(scout.get("scout_date") or "")
        checked_at = datetime.now(timezone.utc).isoformat()
        try:
            rooms, start_time, end_time = _available_room_scout_matches(
                sb, scout, scout_day
            )
            total_matches += len(rooms)
            update = {"last_checked_at": checked_at, "updated_at": checked_at}
            if rooms:
                # Dedup on the configured range (not the now-clamped scan window),
                # so we don't re-email the same match set as the day advances.
                sig_start = scout.get("scout_start_time") or start_time
                sig_end = scout.get("scout_end_time") or end_time
                signature = _room_scout_signature(
                    scout_day, sig_start, sig_end, rooms
                )
                if signature != scout.get("last_notified_signature"):
                    token = await _room_scout_graph_token(scout)
                    await graph.send_mail(
                        token,
                        scout["email"],
                        f"Room Scout: {len(rooms)} room(s) available at {start_time}",
                        _room_scout_email_body(
                            scout, rooms, scout_day, start_time, end_time
                        ),
                        inline_images=_vng_meet_inline_images(),
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


@router.get("/api/room-scouts")
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
            "id, email, scout_date, duration_minutes, capacity_size, capacity_sizes, scout_start_time, scout_end_time, "
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


@router.post("/api/room-scouts")
async def create_room_scout(request: Request, payload: RoomScoutRequest):
    token, auth_user_id, user_profile_id, email = await _booking_auth_context(request)
    if not settings.supabase_enabled or not user_profile_id or not email:
        raise HTTPException(503, "Room Scout requires Supabase and a user profile email.")
    if not _token_has_mail_send(token):
        raise HTTPException(403, MAIL_SEND_REQUIRED_MESSAGE)
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
    # The selected date controls which availability row is checked. The job
    # itself only runs until midnight of the day it was created.
    scout_end_local = datetime.combine(
        local_today + timedelta(days=1), datetime.min.time(), tzinfo=tz
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


@router.post("/api/room-scouts/process")
async def run_room_scouts_now(request: Request):
    _require_auth(request)
    try:
        summary = await process_room_scouts()
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    return {"ok": True, **summary}
