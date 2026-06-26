"""Booking routes and scheduled-booking background jobs."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import time
from datetime import date as date_cls, datetime, timedelta, timezone
from typing import Literal
from zoneinfo import ZoneInfo

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, HTTPException, Request

from . import auth, availability, booking_schedule, graph
from .app_context import (
    SCHEDULE_MAX_DURATION_MINUTES,
    _live_availability_horizon_end,
    log,
    settings,
)
from .chat import _resolve_booking_room_from_metadata
from .models import BookingRequest, UpdateBookingRequest
from .profiles import _booking_auth_context
from .room_resources import _availability_slot_index

router = APIRouter()

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


def _update_pending_scheduled_graph_token(
    graph_access_token: str,
    *,
    user_profile_id: str | None = None,
    auth_user_id: str | None = None,
) -> None:
    """Store the latest login token on this user's pending scheduled bookings."""
    if not settings.supabase_enabled or not graph_access_token:
        return
    encrypted_token = _encrypt_scheduled_graph_token(graph_access_token)
    try:
        from .supabase_client import get_supabase

        sb = get_supabase()
        if auth_user_id:
            (
                sb.table("user_activity")
                .update({"graph_access_token": encrypted_token})
                .eq("booking_type", "scheduled")
                .eq("status", "pending")
                .eq("auth_user_id", auth_user_id)
                .execute()
            )
        if user_profile_id:
            (
                sb.table("user_activity")
                .update({"graph_access_token": encrypted_token})
                .eq("booking_type", "scheduled")
                .eq("status", "pending")
                .eq("user_id", user_profile_id)
                .execute()
            )
    except Exception as e:  # noqa: BLE001 - token mirroring must not block login
        log.warning("could not update pending scheduled booking token: %s", e)


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
                    "graph_access_token": _encrypt_scheduled_graph_token(
                        graph_access_token
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

        # A schedule day is seeded entirely with -1 and never refreshed from Graph
        # (it's beyond the live-availability window). Releasing a slot there must
        # restore the seeded -1 baseline, not 0 — otherwise a cancelled scheduled
        # booking would leave the slot looking like a live/instant-free slot and the
        # day would stop being detected as a schedule day. Instant days restore to 0.
        restore_value = -1 if any(s == -1 for s in slots) else 0

        for idx in range(start, min(end, availability.SLOTS_PER_DAY)):
            # Only release slots this user actually owns.
            if str(slot_owner_ids[idx] or "") == user_profile_id:
                slots[idx] = restore_value
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


@router.get("/api/bookings")
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

    # Optional sort by column. The client sends a UI column key; map it to the
    # underlying DB column. Anything unknown falls back to created_at DESC.
    sort_map = {
        "date": "date",
        "room": "room_name",
        "time": "start_time",
        "subject": "subject",
        "type": "booking_type",
        "method": "method",
        "status": "status",
    }
    sort_col = sort_map.get(request.query_params.get("sort", ""), "created_at")
    desc = request.query_params.get("order", "desc").lower() != "asc"

    query = (
        get_supabase()
        .table("user_activity")
        .select(
            "id, room_email, room_name, date, start_time, end_time, "
            "booking_type, method, subject, attendees, body, status, web_link, created_at"
        )
        .eq("user_id", user_profile_id)
        .order(sort_col, desc=desc)
    )
    # Tie-break on created_at so rows with equal sort values stay in a stable order.
    if sort_col != "created_at":
        query = query.order("created_at", desc=True)

    rows = query.limit(200).execute().data or []
    return {"bookings": rows}


@router.post("/api/bookings")
async def create_booking(request: Request, payload: BookingRequest):
    token, auth_user_id, user_profile_id, _auth_email = await _booking_auth_context(
        request
    )

    payload = _resolve_booking_room_from_metadata(payload)
    payload.subject = payload.subject.strip() or "Meeting"
    if payload.end_time <= payload.start_time:
        _log_user_booking_activity(user_profile_id, payload, "failed", "invalid_time_range")
        raise HTTPException(400, "Giờ kết thúc phải sau giờ bắt đầu")
    try:
        target_day = date_cls.fromisoformat(payload.date)
    except ValueError:
        _log_user_booking_activity(user_profile_id, payload, "failed", "invalid_date")
        raise HTTPException(400, "Ngày đặt phòng không hợp lệ")
    today = datetime.now(ZoneInfo(settings.timezone)).date()
    max_booking_day = today + timedelta(days=settings.max_booking_advance_days)
    if target_day > max_booking_day:
        _log_user_booking_activity(user_profile_id, payload, "failed", "beyond_max_advance")
        raise HTTPException(
            400,
            f"Do giới hạn hệ thống, chỉ đặt được phòng tối đa "
            f"{settings.max_booking_advance_days} ngày từ hôm nay "
            f"(đến hết ngày {max_booking_day.isoformat()}).",
        )
    payload.booking_type = (
        "scheduled"
        if target_day > _live_availability_horizon_end(today)
        else "instant"
    )
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


@router.patch("/api/bookings/{booking_id}")
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
    event_id = (row.get("graph_event_id") or "").strip()
    # A scheduled booking is only "pending" until the background job places it on
    # the calendar (status -> "ok", graph_event_id set). Decide how to edit by
    # whether the booking actually exists on the calendar yet, NOT by booking_type:
    # a scheduled booking that has since been placed must be edited for real via
    # Graph, exactly like an instant booking.
    is_pending_scheduled = (
        _booking_type_for_db(row.get("booking_type") or "") == "scheduled"
        and row.get("status") == "pending"
        and not event_id
    )
    slot_changed = (
        new_date != row["date"]
        or new_start != row["start_time"]
        or new_end != row["end_time"]
    )

    if is_pending_scheduled:
        # Still pending — nothing on the calendar yet. Update the stored request only.
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
        # Already on the calendar (instant booking, or a scheduled booking that has
        # since been placed): push the change to the real calendar event via Graph.
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


@router.delete("/api/bookings/{booking_id}")
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
    event_id = (row.get("graph_event_id") or "").strip()

    # Actually on the calendar → cancel the real event first. This covers instant
    # bookings AND scheduled bookings that have since been placed (status "ok" +
    # graph_event_id), so canceling never leaves a phantom event behind.
    if was_ok and event_id:
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


# --------------------------------------------------------------------------- #
# Scheduled-booking midnight race: prep (warm) -> fire (00:00:00.000) -> catch-up
# --------------------------------------------------------------------------- #
# Populated by prepare_scheduled_bookings() ~30s before midnight and drained by
# fire_scheduled_bookings() at the stroke of midnight. Keeping the heavy work
# (DB read, token refresh, TLS handshake) off the 00:00:00 critical path is what
# lets the booking POST land within a few ms of midnight instead of ~0.7s late.
_PREPARED_BOOKINGS: list[dict] = []
_PREPARED_FOR_DATE: str | None = None
_GRAPH_WARM_CLIENT: httpx.AsyncClient | None = None


def _new_graph_client(pool_size: int) -> httpx.AsyncClient:
    """A keep-alive client for the fire path. Prefers HTTP/2 (one warm connection
    multiplexes every booking); falls back to an HTTP/1.1 pool if h2 is absent."""
    limits = httpx.Limits(
        max_keepalive_connections=max(pool_size, 10),
        max_connections=max(pool_size * 2, 20),
        keepalive_expiry=300,
    )
    try:
        client = httpx.AsyncClient(http2=True, timeout=30, limits=limits)
        log.warning("scheduled-booking fire client: HTTP/2 enabled")
        return client
    except ImportError:
        log.warning("scheduled-booking fire client: h2 missing, using HTTP/1.1 pool")
        return httpx.AsyncClient(http2=False, timeout=30, limits=limits)


async def _warm_graph_connections(client: httpx.AsyncClient, count: int) -> None:
    """Open the TLS/TCP connection(s) to Graph ahead of time so midnight only pays
    for the POST itself. An unauthenticated GET returns 401 but still warms the pool."""
    url = f"{graph.GRAPH_BASE}/"

    async def ping() -> None:
        try:
            await client.get(url)
        except Exception:  # noqa: BLE001 - warming is best-effort
            pass

    await asyncio.gather(*(ping() for _ in range(max(count, 1))))


async def _reset_prepared_state() -> None:
    """Drop any staged batch and close the warm client."""
    global _PREPARED_BOOKINGS, _PREPARED_FOR_DATE, _GRAPH_WARM_CLIENT
    if _GRAPH_WARM_CLIENT is not None:
        try:
            await _GRAPH_WARM_CLIENT.aclose()
        except Exception:  # noqa: BLE001
            pass
    _GRAPH_WARM_CLIENT = None
    _PREPARED_BOOKINGS = []
    _PREPARED_FOR_DATE = None


async def prepare_scheduled_bookings() -> int:
    """Stage the upcoming midnight's bookings: read pending rows, warm each user's
    Graph token, pre-build the event body, and warm the HTTPS connection pool."""
    global _PREPARED_BOOKINGS, _PREPARED_FOR_DATE, _GRAPH_WARM_CLIENT
    await _reset_prepared_state()
    if not settings.supabase_enabled:
        return 0

    from .supabase_client import get_supabase

    tz = ZoneInfo(settings.timezone)
    now = datetime.now(tz)
    # Prep runs shortly before the fire time; bookings execute on the calendar day the
    # fire instant falls on, so the horizon must be computed for that day or we miss the
    # rows that only become eligible then. At the default 00:00:00 fire time this is
    # "tomorrow"; for a test time later in the day it resolves to today.
    fire_date = booking_schedule.next_fire_instant(now).date()
    horizon_end = _live_availability_horizon_end(fire_date)
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

    if not rows:
        _PREPARED_FOR_DATE = fire_date.isoformat()
        log.warning(
            "prepare_scheduled_bookings: nothing to stage for %s (horizon_end=%s)",
            _PREPARED_FOR_DATE,
            horizon_end.isoformat(),
        )
        return 0

    async def _stage_one(row: dict) -> dict:
        """Resolve token + build payload for one booking (runs concurrently)."""
        item: dict = {
            "activity_id": row.get("id"),
            "user_profile_id": str(row.get("user_id") or ""),
            "auth_user_id": str(row.get("auth_user_id") or ""),
            "payload": None,
            "token": None,
            "body": None,
            "error": None,
        }
        try:
            payload = _activity_to_booking_request(row)
            item["payload"] = payload
            if item["auth_user_id"]:
                token = await auth.get_graph_token(item["auth_user_id"])
            else:
                token = _decrypt_scheduled_graph_token(row.get("graph_access_token"))
            if not token:
                raise RuntimeError("missing graph access token")
            item["token"] = token
            item["body"] = graph.build_event_body(
                payload.subject,
                f"{payload.date}T{payload.start_time}:00",
                f"{payload.date}T{payload.end_time}:00",
                settings.timezone,
                payload.room_email,
                payload.room_name,
                payload.attendees,
                payload.body,
            )
        except Exception as e:  # noqa: BLE001 - staging failures surface at fire time
            item["error"] = str(e)
            log.warning("prepare scheduled booking %s failed: %s", item["activity_id"], e)
        return item

    prepared = list(await asyncio.gather(*(_stage_one(row) for row in rows)))

    # Warm a dedicated client + connections so midnight only pays the POST round-trip.
    client = _new_graph_client(len(prepared))
    await _warm_graph_connections(client, len(prepared))

    _GRAPH_WARM_CLIENT = client
    _PREPARED_BOOKINGS = prepared
    _PREPARED_FOR_DATE = fire_date.isoformat()
    ready = sum(1 for p in prepared if not p["error"])
    log.warning(
        "prepare_scheduled_bookings: staged %s booking(s) (%s ready) for %s (horizon_end=%s)",
        len(prepared),
        ready,
        _PREPARED_FOR_DATE,
        horizon_end.isoformat(),
    )
    return ready


def _finalize_booking_result(result: dict) -> bool:
    """Persist one fired booking's outcome to Supabase (off the midnight hot path)."""
    from .supabase_client import get_supabase

    sb = get_supabase()
    item = result["item"]
    activity_id = item["activity_id"]
    user_profile_id = item["user_profile_id"]
    payload = item.get("payload")
    now_iso = datetime.now(timezone.utc).isoformat()

    if result["ok"]:
        ev = result["event"]
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
        if payload is not None:
            _mark_room_availability_owner(user_profile_id, payload)
            try:
                sb.table("bookings").insert(
                    {
                        "user_id": item["auth_user_id"] or None,
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
        return True

    sb.table("user_activity").update(
        {
            "status": "failed",
            "error_message": result.get("error"),
            "processed_at": now_iso,
        }
    ).eq("id", activity_id).execute()
    _set_active_booking(user_profile_id, False)
    return False


async def fire_scheduled_bookings() -> dict:
    """At 00:00:00.000, POST every pre-staged booking over the warm client, then
    persist results. Falls back to the inline path if no batch was staged."""
    tz = ZoneInfo(settings.timezone)
    prepared = _PREPARED_BOOKINGS
    client = _GRAPH_WARM_CLIENT
    prepared_for = _PREPARED_FOR_DATE

    # Busy-wait to the exact fire instant. The fire job is scheduled a few seconds
    # early; coarse-sleep to ~30ms before, then 1ms steps for precision.
    now = datetime.now(tz)
    fire_at = booking_schedule.next_fire_instant(now)
    wait = (fire_at - now).total_seconds()
    target = fire_at if 0 < wait <= 120 else None  # None => already at/past fire time: fire now
    if target is not None:
        coarse = (target - datetime.now(tz)).total_seconds() - 0.03
        if coarse > 0:
            await asyncio.sleep(coarse)
        while datetime.now(tz) < target:
            await asyncio.sleep(0.001)
    fire_instant = target or datetime.now(tz)

    today_iso = datetime.now(tz).date().isoformat()
    if not prepared or client is None or prepared_for != today_iso:
        log.warning(
            "fire_scheduled_bookings: no staged batch for %s (prepared_for=%s) "
            "-> falling back to inline processing",
            today_iso,
            prepared_for,
        )
        await _reset_prepared_state()
        return await process_scheduled_bookings()

    async def fire_one(item: dict) -> dict:
        if item.get("error") or not item.get("body"):
            return {"item": item, "ok": False, "error": item.get("error") or "not staged"}
        t_send = datetime.now(tz)
        p0 = time.perf_counter()
        offset_ms = (t_send - fire_instant).total_seconds() * 1000
        try:
            ev = await graph.post_event(client, item["token"], item["body"], settings.timezone)
            dur_ms = (time.perf_counter() - p0) * 1000
            log.warning(
                "scheduled booking %s POST sent +%.1fms, ok in %.0fms (room=%s)",
                item["activity_id"],
                offset_ms,
                dur_ms,
                item["payload"].room_email,
            )
            return {"item": item, "ok": True, "event": ev, "offset_ms": offset_ms, "dur_ms": dur_ms}
        except Exception as e:  # noqa: BLE001 - keep firing the rest of the batch
            dur_ms = (time.perf_counter() - p0) * 1000
            log.warning(
                "scheduled booking %s POST sent +%.1fms, FAILED in %.0fms: %s",
                item["activity_id"],
                offset_ms,
                dur_ms,
                e,
            )
            return {"item": item, "ok": False, "error": str(e), "offset_ms": offset_ms, "dur_ms": dur_ms}

    log.warning(
        "fire_scheduled_bookings: firing %s booking(s) at %s",
        len(prepared),
        fire_instant.isoformat(),
    )
    batch0 = time.perf_counter()
    results = await asyncio.gather(*(fire_one(it) for it in prepared))
    batch_ms = (time.perf_counter() - batch0) * 1000

    processed = sum(1 for r in results if _finalize_booking_result(r))
    failed = len(results) - processed
    await _reset_prepared_state()

    offsets = [r["offset_ms"] for r in results if "offset_ms" in r]
    log.warning(
        "fire_scheduled_bookings finished: processed=%s failed=%s "
        "(first POST +%.1fms, last POST +%.1fms, batch=%.0fms)",
        processed,
        failed,
        min(offsets) if offsets else 0.0,
        max(offsets) if offsets else 0.0,
        batch_ms,
    )
    return {"ok": True, "processed": processed, "failed": failed}


async def process_scheduled_bookings() -> dict:
    """Book pending scheduled requests once their target date enters the live window."""
    if not settings.supabase_enabled:
        return {"ok": False, "processed": 0, "failed": 0, "reason": "supabase_disabled"}

    from .supabase_client import get_supabase

    tz = ZoneInfo(settings.timezone)
    today = datetime.now(tz).date()
    # The final cache day remains scheduled. Process it only after it rolls into
    # the first (availability_days - 1) live/instant days.
    horizon_end = _live_availability_horizon_end(today)
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
    log.warning(
        "process_scheduled_bookings started (today=%s, horizon_end=%s, bookings=%s)",
        today.isoformat(),
        horizon_end.isoformat(),
        len(rows),
    )

    async def process_one(row: dict) -> bool:
        """Process one booking independently so all Graph requests can overlap."""
        activity_id = row.get("id")
        user_profile_id = str(row.get("user_id") or "")
        auth_user_id = str(row.get("auth_user_id") or "")
        payload = _activity_to_booking_request(row)
        now_iso = datetime.now(timezone.utc).isoformat()
        log.warning(
            "processing scheduled booking %s (date=%s, start=%s, end=%s, room=%s)",
            activity_id,
            payload.date,
            payload.start_time,
            payload.end_time,
            payload.room_email,
        )

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
            log.warning("scheduled booking %s processed successfully", activity_id)
            return True
        except Exception as e:  # noqa: BLE001 - keep processing the queue
            sb.table("user_activity").update(
                {
                    "status": "failed",
                    "error_message": str(e),
                    "processed_at": now_iso,
                }
            ).eq("id", activity_id).execute()
            _set_active_booking(user_profile_id, False)
            log.warning("scheduled booking %s failed: %s", activity_id, e)
            return False

    # Start every eligible booking in the same event-loop turn. Network requests to
    # Microsoft Graph then run concurrently instead of waiting for the previous
    # booking to finish.
    log.warning("dispatching %s scheduled bookings concurrently", len(rows))
    results = await asyncio.gather(*(process_one(row) for row in rows))
    processed = sum(results)
    failed = len(results) - processed

    log.warning(
        "process_scheduled_bookings finished (processed=%s, failed=%s)",
        processed,
        failed,
    )
    return {"ok": True, "processed": processed, "failed": failed}
