"""Booking routes and scheduled-booking background jobs."""

from __future__ import annotations

import asyncio
import base64
import gc
import hashlib
import json
import sys
import threading
import time
from datetime import date as date_cls, datetime, timedelta, timezone
from typing import Literal
from zoneinfo import ZoneInfo

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request

from . import auth, availability, booking_schedule, graph
from .app_context import (
    SCHEDULE_MAX_DURATION_MINUTES,
    _live_availability_horizon_end,
    log,
    settings,
)
from .chat import _resolve_booking_room_from_metadata
from .models import BookingRequest, UpdateBookingRequest
from .profiles import (
    _booking_auth_context,
    _read_user_profile,
    _request_identity,
)
from .room_resources import (
    _availability_slot_index,
    _profile_email_by_id,
    _room_metadata,
    _sync_calendar_after_response,
)

router = APIRouter()

# Booking statuses that still represent a live reservation: the room is (or may yet
# be) held, so the row can be cancelled/edited and counts as "upcoming". "ongoing"
# is a meeting in progress — still cancellable, unlike the terminal "finished".
# See availability._reconcile_room_usage for the full lifecycle.
ACTIVE_BOOKING_STATUSES = ("ok", "pending", "success", "ongoing")

# Terminal statuses: the reservation is over, nothing left to change on it.
CLOSED_BOOKING_STATUSES = ("failed", "canceled", "finished")

# --------------------------------------------------------------------------- #
# TEMPORARY — Mini App backwards compatibility
# --------------------------------------------------------------------------- #
# The Zalo Mini App live in production predates the room-usage lifecycle and only
# knows ok/pending/success/failed/canceled. Its status chip is a lookup with a
# `?? STATUS_META.pending` fallback, so an unknown status renders as "Đang chờ" —
# a finished meeting would read as still waiting for the room. A Mini App release
# has to clear Zalo's review before it can ship, so the backend cannot assume the
# client moved with it.
#
# Both new statuses mean "the room was secured and the booking is real", which is
# exactly what `success` meant to the old client, so collapsing them restores the
# pre-change behaviour precisely: a used-in-full meeting used to sit at `success`
# forever. canceled/failed are untouched — the old client already renders those.
#
# Scope: display only, Mini App callers only (identified by the signed session
# JWT, not by Origin). The DB and the web app keep the real status.
#
# REMOVE THIS, together with the commented-out `ongoing`/`finished` entries in
# miniapp/src/{types.ts,pages/history.tsx,components/meeting-detail.tsx,
# services/i18n.ts}, once the Mini App build that understands them is live.
LEGACY_MINIAPP_STATUS = {"ongoing": "success", "finished": "success"}


def _apply_legacy_miniapp_status(rows: list[dict]) -> None:
    """Rewrite new statuses to their pre-lifecycle equivalent, in place."""
    for row in rows:
        legacy = LEGACY_MINIAPP_STATUS.get(row.get("status"))
        if legacy:
            row["status"] = legacy


def _log_user_booking_activity(
    user_profile_id: str | None,
    payload: BookingRequest,
    status: Literal["ok", "failed", "pending"],
    error_message: str | None = None,
    auth_user_id: str | None = None,
    graph_event_id: str | None = None,
    web_link: str | None = None,
) -> str | None:
    """Insert a booking-history row. Returns the new row id (or None). Room Scout
    relies on the id to re-check the pending booking's room response later."""
    if not user_profile_id or not settings.supabase_enabled:
        return None
    try:
        from .supabase_client import get_supabase

        res = get_supabase().table("user_activity").insert(
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
        return str(res.data[0]["id"]) if res.data else None
    except Exception as e:  # noqa: BLE001 - booking log must not block booking flow
        log.warning("could not insert user_activity booking log: %s", e)
        return None


def _booking_type_for_db(booking_type: str) -> str:
    if booking_type == "scout":
        return "scout"
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


def _pooled_email_for(
    user_profile_id: str | None, auth_user_id: str | None
) -> str | None:
    """Best-effort email của user để fallback token pool khớp theo email khi pool
    row được key bằng id khác với id ta đang có. Không bao giờ khớp user khác."""
    if not settings.supabase_enabled:
        return None
    try:
        from .supabase_client import get_supabase

        sb = get_supabase()
        for column, value in (("id", user_profile_id), ("auth_user_id", auth_user_id)):
            if not value:
                continue
            rows = (
                sb.table("user_profiles")
                .select("email")
                .eq(column, value)
                .limit(1)
                .execute()
                .data
                or []
            )
            if rows and rows[0].get("email"):
                return rows[0]["email"]
    except Exception as e:  # noqa: BLE001 - fallback lookup must never break the job
        log.warning("could not look up email for pool fallback: %s", e)
    return None


def _pooled_token_for(
    auth_user_id: str | None, user_profile_id: str | None
) -> str | None:
    """Token Graph ACTIVE của CHÍNH user này trong ``graph_token_pool``, hoặc None.

    Tra lần lượt theo auth_user_id → user_profiles.id → email. Pool row của luồng
    OAuth được key bằng auth_user_id, của luồng dán token bằng user_profiles.id —
    nên bước tra theo email là thứ nối hai key đó lại khi row nền chỉ có một trong
    hai. KHÔNG BAO GIỜ khớp sang user khác.
    """
    from .token_pool import get_active_token

    return (
        (get_active_token(auth_user_id, None) if auth_user_id else None)
        or (get_active_token(user_profile_id, None) if user_profile_id else None)
        or get_active_token(None, _pooled_email_for(user_profile_id, auth_user_id))
    )


async def resolve_background_graph_token(
    auth_user_id: str | None,
    stored_encrypted: object,
    *,
    user_profile_id: str | None = None,
) -> str:
    """Graph token cho tác vụ chạy nền (scheduled booking / room scout).

    Token được lấy TẠI LÚC CHẠY, không dùng lại token có ở lúc tạo tác vụ:
      1) OAuth refresh qua ``get_graph_token(auth_user_id)`` — mint token mới từ
         refresh token của chính user.
      2) Token ACTIVE của CHÍNH user này trong token pool (auth_user_id → profile
         id → email). KHÔNG BAO GIỜ mượn token của user khác.
      3) Token đã mã hoá lưu trên row lúc tạo tác vụ. Chỉ luồng dán token mới có —
         luồng OAuth cố tình để rỗng (xem ``background_token_for_create``).

    Ném lại 401/RuntimeError khi không còn token nào dùng được — để job đánh dấu
    booking/scout đó lỗi thay vì âm thầm bỏ qua.
    """
    auth_user_id = str(auth_user_id or "").strip() or None
    user_profile_id = str(user_profile_id or "").strip() or None
    if auth_user_id:
        try:
            return await auth.get_graph_token(auth_user_id)
        except HTTPException as e:
            # 401 = user CHƯA link Microsoft (vd profile Zalo đăng nhập bằng SĐT
            # rồi dán Graph token) hoặc refresh token đã bị thu hồi.
            if e.status_code != 401:
                raise
            pooled = _pooled_token_for(auth_user_id, user_profile_id)
            if pooled:
                return pooled
            stored = _decrypt_scheduled_graph_token(stored_encrypted)
            if stored:
                return stored
            raise
    # Row của luồng dán token (không có auth_user_id). Vẫn ưu tiên pool: nếu sau đó
    # user có đăng nhập Microsoft thì pool giữ token còn hạn của chính họ, trong khi
    # token dán trên row đã chết từ lâu.
    pooled = _pooled_token_for(None, user_profile_id)
    if pooled:
        return pooled
    stored = _decrypt_scheduled_graph_token(stored_encrypted)
    if not stored:
        raise RuntimeError("missing graph access token")
    return stored


def background_token_for_create(
    graph_access_token: str | None, auth_user_id: str | None
) -> str | None:
    """Giá trị cột ``graph_access_token`` khi TẠO tác vụ nền (scheduled booking /
    room scout).

    Luồng OAuth Microsoft: None. Tới lúc tác vụ chạy,
    ``resolve_background_graph_token`` tự mint token mới từ refresh token / token
    pool của chính user, nên đóng băng access token của hôm nay lên row chỉ là lưu
    thêm một secret mà lúc cần thì đã hết hạn.

    Luồng dán token: bản mã hoá của token đó — đây là credential DUY NHẤT job sẽ có.
    """
    if auth_user_id:
        return None
    return _encrypt_scheduled_graph_token(graph_access_token)


def _update_pending_scheduled_graph_token(
    graph_access_token: str,
    *,
    user_profile_id: str | None = None,
) -> None:
    """Đẩy token vừa dán lên các scheduled booking đang pending của luồng DÁN TOKEN.

    Chỉ chạm tới row không có ``auth_user_id`` — row của luồng OAuth cố tình để
    trống cột này và tự lấy token lúc chạy (xem ``background_token_for_create``).
    """
    if not settings.supabase_enabled or not graph_access_token or not user_profile_id:
        return
    try:
        from .supabase_client import get_supabase

        (
            get_supabase()
            .table("user_activity")
            .update({"graph_access_token": _encrypt_scheduled_graph_token(graph_access_token)})
            .eq("booking_type", "scheduled")
            .eq("status", "pending")
            .eq("user_id", user_profile_id)
            .is_("auth_user_id", "null")
            .execute()
        )
    except Exception as e:  # noqa: BLE001 - token mirroring must not block login
        log.warning("could not update pending scheduled booking token: %s", e)


def clear_pending_scheduled_graph_token(auth_user_id: str | None) -> None:
    """Xoá token đã đóng băng trên các tác vụ nền đang chờ của một user OAuth.

    Gọi khi user đăng nhập Microsoft: từ nay tác vụ tự lấy token lúc chạy, nên bản
    sao trên row vừa thừa vừa là secret chết. Best-effort, không được chặn login.
    """
    auth_user_id = str(auth_user_id or "").strip()
    if not settings.supabase_enabled or not auth_user_id:
        return
    try:
        from .supabase_client import get_supabase

        sb = get_supabase()
        (
            sb.table("user_activity")
            .update({"graph_access_token": None})
            .eq("booking_type", "scheduled")
            .eq("status", "pending")
            .eq("auth_user_id", auth_user_id)
            .execute()
        )
        (
            sb.table("room_scouts")
            .update({"graph_access_token": None})
            .eq("status", "active")
            .eq("auth_user_id", auth_user_id)
            .execute()
        )
    except Exception as e:  # noqa: BLE001 - cleanup must not block login
        log.warning("could not clear pending background task token: %s", e)


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

    # The booking isn't sent until the next fire instant (midnight the target
    # day opens); block if the token won't survive until then. Covers the
    # chat-bot flow too — there is no modal there. Mirrors BookingModal.tsx.
    from .token_guard import ensure_token_survives_until

    now_local = datetime.now(ZoneInfo(settings.timezone))
    ensure_token_survives_until(
        graph_access_token,
        booking_schedule.next_fire_instant(now_local),
        blocked_action="Không thể tạo lịch đặt phòng (scheduled booking)",
        auth_user_id=auth_user_id,
    )

    try:
        from .supabase_client import get_supabase

        sb = get_supabase()
        row = (
            sb.table("user_activity")
            .insert(
                {
                    "user_id": user_profile_id,
                    "auth_user_id": auth_user_id,
                    # Luồng OAuth để rỗng: lúc booking chạy sẽ tự lấy token của
                    # chính user từ refresh token / token pool.
                    "graph_access_token": background_token_for_create(
                        graph_access_token, auth_user_id
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
async def list_my_bookings(request: Request, background_tasks: BackgroundTasks):
    """Return the caller's own booking history.

    The owner id (user_profiles.id) is derived server-side from the verified
    auth token via `_booking_auth_context` — the client never supplies it — so a
    user can only ever read their own rows and cannot peek at someone else's data.
    """
    # Đọc lịch sử chỉ cần DANH TÍNH, không bắt buộc Graph token. Trước đây dùng
    # _booking_auth_context → get_graph_token → 401 cho user Zalo chưa liên kết
    # Microsoft, khiến Mini App tưởng hết phiên và đăng nhập lại (loop). Vẫn thử
    # lấy token để self-heal (best-effort); không có thì bỏ qua, vẫn trả lịch sử.
    token: str | None = None
    try:
        token, _auth_user_id, user_profile_id, _email = await _booking_auth_context(
            request
        )
    except HTTPException:
        _auth_user_id, _email = _request_identity(request)
        profile = _read_user_profile(None, (_email or "").strip().lower())
        user_profile_id = profile.get("id") if profile else None
    if not user_profile_id or not settings.supabase_enabled:
        return {"bookings": []}

    # Self-heal AFTER responding: pull the user's calendar so bookings they deleted
    # directly in Outlook flip to "canceled" here too, even if they never opened the
    # browse grid. Runs post-response so the history list never waits on Graph; the
    # next poll shows the reconciled statuses. Throttled (shared with the grid) so
    # it's at most one Graph call per minute.
    if token and availability.should_sync_calendar(user_profile_id):
        background_tasks.add_task(
            _sync_calendar_after_response, token, user_profile_id, _email
        )

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

    # Bổ sung metadata phòng (ảnh / vị trí / office / map) cho mỗi dòng để Mini App
    # dựng card lịch sử + màn "Chi tiết lịch họp" mà không phải gọi thêm API. Web
    # bỏ qua các field thừa này nên không ảnh hưởng.
    meta_by_email = _room_metadata()
    for r in rows:
        meta = meta_by_email.get((r.get("room_email") or "").strip().lower())
        r["location"] = _format_room_location(meta)
        r["image"] = (meta or {}).get("thumbnail_link")
        r["office"] = (meta or {}).get("office")
        r["map"] = (meta or {}).get("map_link")
    # TEMPORARY: see LEGACY_MINIAPP_STATUS. The live Mini App build cannot render
    # ongoing/finished yet, so it keeps seeing the pre-lifecycle statuses.
    if auth.is_zalo_session_request(request):
        _apply_legacy_miniapp_status(rows)
    return {"bookings": rows}


def _format_room_location(meta: dict | None) -> str:
    """Ghép location hiển thị từ metadata phòng, vd 'Tầng 3 - Toà V1'.

    Ưu tiên floor + building; thiếu thì fallback về zone / office. Trả "" nếu
    không có gì để hiện (frontend sẽ chỉ ẩn dòng location, không ẩn cả card)."""
    if not meta:
        return ""
    parts: list[str] = []
    floor = str(meta.get("floor") or "").strip()
    building = str(meta.get("building") or "").strip()
    if floor:
        parts.append(f"Tầng {floor}")
    if building:
        parts.append(f"Toà {building}")
    if parts:
        return " - ".join(parts)
    return str(meta.get("zone") or meta.get("office") or "").strip()


@router.get("/api/bookings/upcoming")
async def upcoming_booking(request: Request):
    """Lịch 'sắp tới' cho màn Home của Mini App: user_activity thành công (đã đặt
    được phòng) và gần nhất trong tương lai. Trả {"event": null} nếu không có —
    frontend sẽ ẩn hẳn section 'Lịch sắp tới'.

    - success = status ∈ {"ok", "success", "ongoing"} (instant/scheduled dùng "ok",
      room scout dùng "success", "ongoing" là cuộc đang diễn ra). Bỏ
      "pending"/"failed"/"canceled"/"finished".
    - "trong tương lai" = còn diễn ra: date ở tương lai, hoặc hôm nay nhưng chưa
      kết thúc (end_time > giờ hiện tại) nên cuộc họp đang diễn ra vẫn hiện.
    - Ảnh nền + location lấy từ meeting_room_metadata (thumbnail_link, floor/building).
    """
    # Chỉ cần danh tính user (KHÔNG cần Graph token). Trước đây dùng
    # _booking_auth_context → gọi get_graph_token → 401 "Microsoft not linked"
    # cho user Zalo chưa có token Microsoft, khiến Mini App xoá session và
    # authen lại bằng mã SĐT đã dùng ("code has already been used"). Ở đây chỉ
    # đọc user_profiles theo email trong session JWT.
    _auth_user_id, email = _request_identity(request)
    if not settings.supabase_enabled:
        return {"event": None}
    profile = _read_user_profile(None, (email or "").strip().lower())
    user_profile_id = profile.get("id") if profile else None
    if not user_profile_id:
        return {"event": None}

    from .supabase_client import get_supabase

    tz = ZoneInfo(settings.timezone)
    now = datetime.now(tz)
    today = now.date().isoformat()
    now_hm = now.strftime("%H:%M")

    rows = (
        get_supabase()
        .table("user_activity")
        .select(
            "room_email, room_name, date, start_time, end_time, "
            "booking_type, method, subject, status, attendees, body"
        )
        .eq("user_id", user_profile_id)
        .in_("status", ["ok", "success", "ongoing"])
        .gte("date", today)
        .order("date", desc=False)
        .order("start_time", desc=False)
        .limit(50)
        .execute()
        .data
        or []
    )

    # Chọn row sắp tới gần nhất: bỏ những cuộc đã kết thúc trong hôm nay.
    event_row = None
    for r in rows:
        r_date = str(r.get("date") or "")
        end_hm = str(r.get("end_time") or "")[:5]
        if r_date > today or (r_date == today and end_hm > now_hm):
            event_row = r
            break

    if not event_row:
        return {"event": None}

    meta = _room_metadata().get((event_row.get("room_email") or "").strip().lower())
    return {
        "event": {
            "room_name": event_row.get("room_name"),
            "room_email": event_row.get("room_email"),
            "date": event_row.get("date"),
            "start_time": str(event_row.get("start_time") or "")[:5],
            "end_time": str(event_row.get("end_time") or "")[:5],
            "subject": event_row.get("subject"),
            "location": _format_room_location(meta),
            "image": (meta or {}).get("thumbnail_link"),
            # Cho màn "Chi tiết lịch họp" của Mini App: office (subtitle), map ảnh
            # (map_link), danh sách người tham dự và mô tả cuộc họp (body).
            "office": (meta or {}).get("office"),
            "map": (meta or {}).get("map_link"),
            "attendees": event_row.get("attendees") or [],
            "body": event_row.get("body"),
        }
    }


# --------------------------------------------------------------------------- #
# Post-booking room-response re-check
# --------------------------------------------------------------------------- #
# An instant booking is logged as "pending": the event is on the organizer's
# calendar, but the room mailbox processes the invite asynchronously. The only
# code that reads the room's answer is availability.sync_my_calendar, and that
# only ever runs off its OWN owner's requests (grid load, history list, the bot's
# list_bookings) — so a booking made from the Zalo bot, after which the user never
# opens the app, sat at "Chờ phản hồi" indefinitely. The daily response catch-up
# does not cover it either: that job only looks at scheduled bookings on "ok".
#
# The WEB app used to cover this from the browser: ChatPanel.syncAfterBooking
# re-fetched the grid with sync=force at 15/45/90s, and each of those forced a
# sync_my_calendar (see room_resources.availability_grid). Driving it from a client
# meant it only ever ran for someone sitting in the web chat — the Zalo bot has no
# browser to run the timers, and the Mini App chat never got an equivalent. Those
# timers are gone; this is the same three checks, server-side, for every path.
#
# Offsets are measured from the moment the invite went to Microsoft. There is no
# t=0 check on purpose: the room mailbox cannot have answered an invite that was
# sent milliseconds ago, and Graph has not necessarily published the new event to
# calendarView yet either, so that pass could only ever come back "pending".
# Anything still unanswered after the third check stays "pending" and is picked up
# by the owner's next app request, exactly as before.
POST_BOOK_SYNC_OFFSETS_SECONDS = (15, 45, 90)

# Room Scout AWAITS its three checks inside the per-minute cron, so it cannot sit
# on the schedule above — one scout would eat the whole tick. It keeps the tight
# burst it has always used, and re-checks anything still pending next cycle anyway.
SCOUT_SYNC_OFFSETS_SECONDS = (0, 4, 8)


async def poll_booking_room_response(
    token: str,
    user_profile_id: str | None,
    email: str | None,
    activity_id: str,
    sb=None,
    offsets: tuple[int, ...] = POST_BOOK_SYNC_OFFSETS_SECONDS,
) -> str:
    """Confirmation state of booking `activity_id`: 'success' (room accepted),
    'failed' (declined), or 'pending' (no answer within the poll window).

    Syncs the organizer's calendar at each of `offsets` seconds after the booking —
    sync_my_calendar reconciles the booking row (accept -> success, decline ->
    failed + delete the orphaned event) — re-reading the row after each pass and
    stopping as soon as the room has answered.
    """
    if sb is None:
        from .supabase_client import get_supabase

        sb = get_supabase()
    elapsed = 0
    for offset in offsets:
        if offset > elapsed:
            await asyncio.sleep(offset - elapsed)
            elapsed = offset
        try:
            await availability.sync_my_calendar(token, user_profile_id, email)
        except Exception as e:  # noqa: BLE001 - a sync hiccup shouldn't abort the poll
            log.warning("post-booking sync_my_calendar failed: %s", e)
        rows = (
            sb.table("user_activity")
            .select("status")
            .eq("id", activity_id)
            .limit(1)
            .execute()
            .data
            or []
        )
        status = rows[0].get("status") if rows else None
        if status in ("success", "failed"):
            return status
    return "pending"


# Strong references to in-flight re-checks. asyncio only keeps a weak reference to
# a running task, so a fire-and-forget poll can be garbage-collected mid-sleep.
# Entries are discarded on completion, so the set stays bounded by concurrency.
_room_response_tasks: set[asyncio.Task] = set()


def schedule_room_response_recheck(
    token: str,
    user_profile_id: str | None,
    email: str | None,
    activity_id: str | None,
) -> None:
    """Fire-and-forget the post-booking poll so the caller answers immediately.

    Detached rather than hung off BackgroundTasks because the callers that need it
    most have no BackgroundTasks to hang it on: the chat tool and the Zalo bot both
    reach create_booking from inside a background task of their own. Best-effort
    throughout — a booking that is already written must never fail on the re-check.
    """
    if not activity_id or not token or not settings.supabase_enabled:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:  # no event loop (sync caller) -> nothing to detach onto
        return
    task = loop.create_task(
        _recheck_room_response(token, user_profile_id, email, activity_id)
    )
    _room_response_tasks.add(task)
    task.add_done_callback(_room_response_tasks.discard)


async def _recheck_room_response(
    token: str,
    user_profile_id: str | None,
    email: str | None,
    activity_id: str,
) -> None:
    try:
        status = await poll_booking_room_response(
            token, user_profile_id, email, activity_id
        )
        log.info("post-booking room response for %s: %s", activity_id, status)
    except Exception as e:  # noqa: BLE001 - a detached re-check must never raise
        log.warning("post-booking re-check failed for %s: %s", activity_id, e)


@router.post("/api/bookings")
async def create_booking(request: Request, payload: BookingRequest):
    try:
        token, auth_user_id, user_profile_id, _auth_email = await _booking_auth_context(
            request
        )
    except HTTPException as e:
        # get_graph_token() trả 401 khi user CHƯA liên kết Microsoft (không có
        # refresh token) hoặc refresh thất bại. Với Mini App Zalo, đây KHÔNG phải
        # session Zalo hết hạn — nếu để nguyên 401, client coi là hết phiên, xoá
        # session và bắt đăng nhập lại bằng SĐT (loop "đang xác thực..."). Đổi
        # sang 403 để client hiện đúng thông báo "cần liên kết Microsoft".
        detail = str(e.detail or "")
        if e.status_code == 401 and "Microsoft" in detail:
            raise HTTPException(
                403,
                "Tài khoản chưa liên kết Microsoft nên chưa thể đặt phòng. "
                "Vui lòng liên kết Microsoft rồi thử lại.",
            )
        raise

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

    # Start as "pending" (yellow): the event exists, but the room mailbox processes
    # the invite asynchronously. The calendar sync promotes this to "success" once
    # the room accepts, or to "failed" (room_declined) if it declines. ("ok" is not
    # part of this path — only a fired scheduled booking passes through it.)
    activity_id = _log_user_booking_activity(
        user_profile_id,
        payload,
        "pending",
        auth_user_id=auth_user_id,
        graph_event_id=ev.get("id"),
        web_link=ev.get("webLink"),
    )
    _mark_room_availability_owner(user_profile_id, payload)

    # Read the room's answer on the same 15/45/90s schedule the web chat drives from
    # the browser, for the callers that have no browser. Detached, so this returns
    # now and the Zalo bot's reply is not held for a minute and a half.
    schedule_room_response_recheck(token, user_profile_id, _auth_email, activity_id)

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
    if row.get("status") == "finished":
        raise HTTPException(400, "Không thể sửa booking đã kết thúc.")

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
    is_active = row.get("status") in ACTIVE_BOOKING_STATUSES
    event_id = (row.get("graph_event_id") or "").strip()

    # Actually on the calendar → cancel the real event first. A real event exists
    # whenever graph_event_id is set and the booking is still active — this covers
    # instant bookings (which now start "pending" until the room responds) AND
    # scheduled bookings already placed, so canceling never leaves a phantom event.
    if is_active and event_id:
        try:
            await graph.delete_event(token, event_id)
        except httpx.HTTPStatusError as e:
            raise HTTPException(e.response.status_code, e.response.text)

    from .supabase_client import get_supabase

    # Keep the history row — just mark it canceled instead of deleting it. The note
    # records who ended it, so this is never confused with a room auto-release.
    try:
        get_supabase().table("user_activity").update(
            {"status": "canceled", "note": "canceled_by_user"}
        ).eq("id", booking_id).eq("user_id", user_profile_id).execute()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Could not cancel booking: {e}")

    # Release the slots this booking occupied in the availability cache.
    if is_active:
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
# Populated by prepare_scheduled_bookings() ~30s before midnight. Keeping the heavy
# work (DB read, token refresh, TLS handshake, JSON serialisation) off the 00:00:00
# critical path is what lets the booking POST leave within a few ms of the target.
#
# WHY A DEDICATED THREAD
# ----------------------
# Everything else in this process shares one asyncio event loop, and every Supabase
# call uses the *synchronous* supabase-py client — so any of the minutely jobs can
# block that loop for a second or more. When that happened across midnight the fire
# job's busy-wait never got scheduled, APScheduler ran it inside its misfire grace
# instead, `wait` came out negative, and the POST left at ~00:00:02 — losing the room.
#
# So prep hands the staged batch to its own OS thread with its own event loop and
# its own httpx client. A blocked main loop can no longer delay the send: the only
# coupling left is the GIL, which blocking socket I/O releases and which we shorten
# via sys.setswitchinterval() for the last couple of seconds.
_PREPARED_BOOKINGS: list[dict] = []
_PREPARED_FOR_DATE: str | None = None

_FIRE_THREAD: threading.Thread | None = None
_FIRE_ABORT = threading.Event()   # tells a live fire thread to stand down
_FIRE_LOCK = threading.Lock()


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
    """Drop any staged batch and stand down a fire thread that is still counting."""
    global _PREPARED_BOOKINGS, _PREPARED_FOR_DATE, _FIRE_THREAD
    thread = _FIRE_THREAD
    if thread is not None and thread.is_alive():
        _FIRE_ABORT.set()
        # Never block the caller for long: the thread checks the flag between
        # sleeps and closes its own client.
        await asyncio.to_thread(thread.join, 2.0)
    _FIRE_THREAD = None
    _PREPARED_BOOKINGS = []
    _PREPARED_FOR_DATE = None


async def prepare_scheduled_bookings() -> int:
    """Stage the upcoming midnight's bookings: read pending rows, warm each user's
    Graph token, pre-serialise the exact request bytes, then hand the batch to a
    dedicated fire thread that counts down to the send moment on its own."""
    global _PREPARED_BOOKINGS, _PREPARED_FOR_DATE
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
            "content": None,
            "headers": None,
            "error": None,
        }
        try:
            payload = _activity_to_booking_request(row)
            item["payload"] = payload
            token = await resolve_background_graph_token(
                item["auth_user_id"],
                row.get("graph_access_token"),
                user_profile_id=item["user_profile_id"],
            )
            if not token:
                raise RuntimeError("missing graph access token")
            item["token"] = token
            body = graph.build_event_body(
                payload.subject,
                f"{payload.date}T{payload.start_time}:00",
                f"{payload.date}T{payload.end_time}:00",
                settings.timezone,
                payload.room_email,
                payload.room_name,
                payload.attendees,
                payload.body,
            )
            item["body"] = body
            # Serialise here, not at fire time: at the send moment the only work
            # left should be handing already-encoded bytes to a warm socket.
            item["content"] = json.dumps(body, separators=(",", ":")).encode()
            item["headers"] = graph._event_headers(token, settings.timezone)
        except Exception as e:  # noqa: BLE001 - staging failures surface at fire time
            item["error"] = str(e)
            log.warning("prepare scheduled booking %s failed: %s", item["activity_id"], e)
        return item

    prepared = list(await asyncio.gather(*(_stage_one(row) for row in rows)))

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

    # Hand the batch to its own thread. It warms the connections, counts down and
    # sends without ever touching this event loop.
    _start_fire_thread(prepared, booking_schedule.next_fire_instant(now))
    return ready


# --------------------------------------------------------------------------- #
# The fire thread
# --------------------------------------------------------------------------- #


def _start_fire_thread(prepared: list[dict], fire_at: datetime) -> None:
    """Spawn the countdown thread for one staged batch (idempotent per prep run)."""
    global _FIRE_THREAD
    with _FIRE_LOCK:
        if _FIRE_THREAD is not None and _FIRE_THREAD.is_alive():
            log.warning("_start_fire_thread: a fire thread is already running; skipping")
            return
        _FIRE_ABORT.clear()
        _FIRE_THREAD = threading.Thread(
            target=_fire_thread_main,
            args=(prepared, fire_at),
            name="scheduled-booking-fire",
            daemon=True,
        )
        _FIRE_THREAD.start()
    log.warning(
        "fire thread started for %s booking(s); slot opens %s, send_lead=%dms",
        len(prepared),
        fire_at.isoformat(),
        booking_schedule.SEND_LEAD_MS,
    )


def _fire_thread_main(prepared: list[dict], fire_at: datetime) -> None:
    """Thread entry point: own event loop, own httpx client, own countdown."""
    try:
        asyncio.run(_fire_thread_async(prepared, fire_at))
    except Exception as e:  # noqa: BLE001 - a dead thread must not kill the process
        log.exception("fire thread crashed: %s", e)


def _sleep_until(target_ts: float) -> bool:
    """Block this thread until `target_ts` (Unix seconds), landing within ~50us.

    Coarse-sleeps in 1s chunks so an abort is noticed quickly, then spins for the
    final SPIN_WINDOW_SECONDS because sleep() routinely overshoots by 1-15ms and
    that overshoot is exactly what we are trying to eliminate. Returns False if
    the batch was aborted while waiting.
    """
    spin = booking_schedule.SPIN_WINDOW_SECONDS
    while True:
        remaining = target_ts - time.time()
        if remaining <= spin:
            break
        if _FIRE_ABORT.is_set():
            return False
        time.sleep(min(remaining - spin, 1.0))
    while time.time() < target_ts:
        pass
    return not _FIRE_ABORT.is_set()


async def _fire_thread_async(prepared: list[dict], fire_at: datetime) -> None:
    tz = ZoneInfo(settings.timezone)
    fire_ts = fire_at.timestamp()
    send_ts = fire_ts - max(0, booking_schedule.SEND_LEAD_MS) / 1000.0
    live = [it for it in prepared if not it.get("error") and it.get("content")]
    if not live:
        log.warning("fire thread: nothing sendable in the staged batch; standing down")
        await asyncio.gather(
            *(asyncio.to_thread(
                _finalize_booking_result,
                {"item": it, "ok": False, "error": it.get("error") or "not staged"},
            ) for it in prepared),
            return_exceptions=True,
        )
        return

    client = _new_graph_client(len(live))
    switch_interval = sys.getswitchinterval()
    gc_was_enabled = gc.isenabled()
    try:
        await _warm_graph_connections(client, len(live))

        # Re-ping shortly before the send: an idle keep-alive connection can be
        # dropped by Graph's load balancer in the 30s since prep, and paying a TLS
        # handshake at 00:00:00 is exactly the ~300ms we cannot afford.
        # Blocking sleeps are deliberate: this loop is private to the thread and has
        # nothing else to run, and going through to_thread would add a cross-thread
        # loop wake-up right at the moment we are trying to be precise.
        if not _sleep_until(send_ts - booking_schedule.REWARM_LEAD_SECONDS):
            log.warning("fire thread aborted before re-warm")
            return
        await _warm_graph_connections(client, len(live))

        # Build the httpx.Request objects now so the send moment does no URL
        # parsing, header merging or encoding.
        url = f"{graph.GRAPH_BASE}/me/events"
        requests = [
            client.build_request(
                "POST", url, headers=it["headers"], content=it["content"]
            )
            for it in live
        ]

        # Last two seconds: keep the GIL turning over fast and stop a gen-2
        # collection from stalling the send.
        sys.setswitchinterval(0.0005)
        gc.collect()
        gc.freeze()
        gc.disable()

        if not _sleep_until(send_ts):
            log.warning("fire thread aborted at the send moment")
            return

        async def fire_one(item: dict, request: httpx.Request) -> dict:
            t_send = datetime.now(tz)
            p0 = time.perf_counter()
            offset_ms = (t_send.timestamp() - fire_ts) * 1000
            try:
                resp = await client.send(request)
                resp.raise_for_status()
                ev = graph._event_result(resp.json())
                dur_ms = (time.perf_counter() - p0) * 1000
                log.warning(
                    "scheduled booking %s POST sent %+.1fms (rel slot-open), ok in %.0fms (room=%s)",
                    item["activity_id"],
                    offset_ms,
                    dur_ms,
                    item["payload"].room_email,
                )
                return {"item": item, "ok": True, "event": ev,
                        "offset_ms": offset_ms, "dur_ms": dur_ms}
            except Exception as e:  # noqa: BLE001 - keep firing the rest of the batch
                dur_ms = (time.perf_counter() - p0) * 1000
                log.warning(
                    "scheduled booking %s POST sent %+.1fms (rel slot-open), FAILED in %.0fms: %s",
                    item["activity_id"],
                    offset_ms,
                    dur_ms,
                    e,
                )
                return {"item": item, "ok": False, "error": str(e),
                        "offset_ms": offset_ms, "dur_ms": dur_ms}

        batch0 = time.perf_counter()
        if len(live) == 1:
            results = [await fire_one(live[0], requests[0])]
        else:
            results = list(
                await asyncio.gather(*(fire_one(i, r) for i, r in zip(live, requests)))
            )
        batch_ms = (time.perf_counter() - batch0) * 1000

        # Race is over — restore the runtime before touching the database.
        gc.enable()
        gc.unfreeze()
        sys.setswitchinterval(switch_interval)

        # Rows that never made it out still need their status flipped, or the user
        # is left with a pending booking forever.
        sent_ids = {id(it) for it in live}
        for item in prepared:
            if id(item) not in sent_ids:
                results.append(
                    {"item": item, "ok": False, "error": item.get("error") or "not staged"}
                )

        # Concurrent, and in worker threads: 4 sequential Supabase writes per booking
        # used to sit on the fire path and were most of the "finished at 00:00:02".
        finalized = await asyncio.gather(
            *(asyncio.to_thread(_finalize_booking_result, r) for r in results),
            return_exceptions=True,
        )
        for r, outcome in zip(results, finalized):
            if isinstance(outcome, BaseException):
                log.warning(
                    "could not persist scheduled booking %s: %s",
                    r["item"].get("activity_id"),
                    outcome,
                )
        processed = sum(1 for o in finalized if o is True)
        offsets = [r["offset_ms"] for r in results if "offset_ms" in r]
        log.warning(
            "fire thread finished: processed=%s failed=%s "
            "(first POST %+.1fms, last POST %+.1fms, batch=%.0fms)",
            processed,
            len(results) - processed,
            min(offsets) if offsets else 0.0,
            max(offsets) if offsets else 0.0,
            batch_ms,
        )
    finally:
        # An early return (abort) must not leave the process with GC off or every
        # object permanently frozen.
        gc.unfreeze()
        if gc_was_enabled and not gc.isenabled():
            gc.enable()
        sys.setswitchinterval(switch_interval)
        try:
            await client.aclose()
        except Exception:  # noqa: BLE001
            pass


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
    """Watchdog, scheduled FIRE_LEAD_SECONDS before the slot opens.

    The send itself is done by the thread that prepare_scheduled_bookings() armed
    30s earlier — deliberately NOT on this event loop, which any of the minutely
    Supabase jobs can block for a second or more. All this job does is confirm the
    thread is armed for tonight's batch. If prep never ran (backend restarted
    inside the last 30s) it falls back to the inline path so the bookings still go
    out, just without the sub-millisecond landing.
    """
    tz = ZoneInfo(settings.timezone)
    now = datetime.now(tz)
    fire_at = booking_schedule.next_fire_instant(now)  # slot-open instant (e.g. 00:00:00)
    fire_date = fire_at.date()
    thread = _FIRE_THREAD

    if thread is not None and thread.is_alive() and _PREPARED_FOR_DATE == fire_date.isoformat():
        log.warning(
            "fire_scheduled_bookings: fire thread armed for %s with %s booking(s), "
            "send_lead=%dms — event loop stays out of the way",
            fire_date.isoformat(),
            len(_PREPARED_BOOKINGS),
            booking_schedule.SEND_LEAD_MS,
        )
        return {"ok": True, "delegated": True, "count": len(_PREPARED_BOOKINGS)}

    log.warning(
        "fire_scheduled_bookings: no armed fire thread for %s (prepared_for=%s, "
        "alive=%s) -> falling back to inline processing",
        fire_date.isoformat(),
        _PREPARED_FOR_DATE,
        thread is not None and thread.is_alive(),
    )
    await _reset_prepared_state()

    # Still respect the send moment rather than firing FIRE_LEAD_SECONDS early.
    send_at = fire_at - timedelta(milliseconds=max(0, booking_schedule.SEND_LEAD_MS))
    wait = (send_at - datetime.now(tz)).total_seconds()
    if 0 < wait <= 120:
        coarse = wait - 0.03
        if coarse > 0:
            await asyncio.sleep(coarse)
        while datetime.now(tz) < send_at:
            await asyncio.sleep(0.001)

    # as_of must be the day the SLOT opens on, not datetime.now() — we are still on
    # the previous calendar day here, which would shrink the horizon by one day and
    # skip exactly the rows that just became eligible.
    return await process_scheduled_bookings(as_of=fire_date)


async def process_scheduled_bookings(as_of: date_cls | None = None) -> dict:
    """Book pending scheduled requests once their target date enters the live window.

    `as_of` overrides the calendar day used to compute the live-availability
    horizon; the fire-path fallback passes the slot-open day because it runs a few
    hundred milliseconds before midnight.
    """
    if not settings.supabase_enabled:
        return {"ok": False, "processed": 0, "failed": 0, "reason": "supabase_disabled"}

    from .supabase_client import get_supabase

    tz = ZoneInfo(settings.timezone)
    today = as_of or datetime.now(tz).date()
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
            token = await resolve_background_graph_token(
                auth_user_id,
                row.get("graph_access_token"),
                user_profile_id=user_profile_id,
            )
            if not token:
                raise RuntimeError("missing graph access token")
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


# How many organizers' calendars the response catch-up syncs at once. Each
# sync_my_calendar is a Graph calendarView call plus a room_availability upsert, and
# supabase-py is synchronous — a wide fan-out here would just queue on the GIL. This
# runs once a day with no user traffic, so a modest width is plenty.
RESPONSE_CATCHUP_CONCURRENCY = 3

# Gaps between this job's three checks. An instant booking gets its three checks
# from schedule_room_response_recheck, timed off the invite; a scheduled booking
# cannot use that path — it is sent from the midnight fire thread, whose event loop
# closes as soon as the batch is done, and the first check would land inside
# booking_schedule.BLACKOUT_TRAIL_SECONDS anyway. So the same three checks happen
# here instead, starting RESPONSE_CATCHUP_DELAY_SECONDS after FIRE_TIME. The gaps
# are wider than the instant schedule's because the invites went out minutes ago:
# a room that answers at all has almost certainly answered before check one.
RESPONSE_CATCHUP_GAPS_SECONDS = (30, 60)


async def catchup_scheduled_booking_responses(as_of: date_cls | None = None) -> dict:
    """Promote fired scheduled bookings past "ok" without waiting for their owner.

    A scheduled booking lands on the calendar at FIRE_TIME with status "ok" and then
    stops moving: the only code that reads the room's answer is
    availability.sync_my_calendar, which needs the ORGANIZER's delegated token and so
    only ever runs off that user's own requests. A booking fired at midnight
    therefore reads "Chờ phản hồi" until its owner next opens the app — overnight,
    all night, and forever for a Zalo user who never linked Microsoft.

    This mints each owner's own token the same way the midnight fire does
    (resolve_background_graph_token — never borrows another user's) and runs the
    existing sync for them, so the promotion path is the proven one: no guessing at
    the room's answer from free/busy. It only looks at scheduled bookings, because
    "ok" is written nowhere else.

    Runs three checks (RESPONSE_CATCHUP_GAPS_SECONDS apart), re-reading which rows
    are still on "ok" between them so each pass only syncs the owners who actually
    still need it — a slow room mailbox gets the same three chances an instant
    booking gets. Idempotent: an owner with nothing left to reconcile costs one
    Graph call, and a pass with nothing left to do exits early.
    """
    if not settings.supabase_enabled:
        return {"ok": False, "users": 0, "reason": "supabase_disabled"}

    from .supabase_client import get_supabase

    sb = get_supabase()
    tz = ZoneInfo(settings.timezone)
    today = as_of or datetime.now(tz).date()

    def owners_awaiting_response() -> dict[str, dict]:
        """Owners with at least one fired-but-unanswered scheduled booking.

        Re-read on every pass: rows the previous pass resolved drop out, so a later
        pass never re-syncs an owner who is already done.
        """
        rows = (
            sb.table("user_activity")
            .select("id, user_id, auth_user_id, graph_access_token, graph_event_id, date")
            .eq("booking_type", "scheduled")
            .eq("status", "ok")
            .gte("date", today.isoformat())
            .execute()
            .data
            or []
        )
        # One sync per OWNER, not per booking: sync_my_calendar reconciles every row
        # that user has in the availability window in a single pass.
        by_owner: dict[str, dict] = {}
        for row in rows:
            if not row.get("graph_event_id"):
                continue  # not on the calendar yet -> no response to read
            owner = str(row.get("user_id") or "").strip()
            if not owner:
                continue
            entry = by_owner.setdefault(
                owner, {"auth_user_id": None, "graph_access_token": None, "bookings": 0}
            )
            entry["bookings"] += 1
            # The paste-token flow stores its credential per row; keep the first
            # non-empty of each so the token resolver has every fallback available.
            if not entry["auth_user_id"] and row.get("auth_user_id"):
                entry["auth_user_id"] = str(row["auth_user_id"])
            if not entry["graph_access_token"] and row.get("graph_access_token"):
                entry["graph_access_token"] = row["graph_access_token"]
        return by_owner

    sem = asyncio.Semaphore(RESPONSE_CATCHUP_CONCURRENCY)

    async def sync_one(user_profile_id: str, entry: dict, email: str | None) -> bool:
        async with sem:
            try:
                token = await resolve_background_graph_token(
                    entry["auth_user_id"],
                    entry["graph_access_token"],
                    user_profile_id=user_profile_id,
                )
            except Exception as e:  # noqa: BLE001 - one owner must not stop the rest
                # Usually a user who never linked Microsoft, or a revoked refresh
                # token. Their rows stay "ok" until they open the app themselves.
                log.warning(
                    "response catch-up: no usable token for %s (%s booking(s)): %s",
                    user_profile_id, entry["bookings"], e,
                )
                return False
            try:
                summary = await availability.sync_my_calendar(
                    token, user_profile_id, email
                )
                log.info("response catch-up synced %s: %s", user_profile_id, summary)
                return True
            except Exception as e:  # noqa: BLE001
                log.warning("response catch-up sync failed for %s: %s", user_profile_id, e)
                return False

    passes = 1 + len(RESPONSE_CATCHUP_GAPS_SECONDS)
    users = synced = skipped = 0
    by_owner = owners_awaiting_response()
    for attempt in range(passes):
        if not by_owner:
            log.warning(
                "catchup_scheduled_booking_responses: nothing left to reconcile "
                "before check %s/%s",
                attempt + 1, passes,
            )
            break
        email_by_owner = _profile_email_by_id(sb, set(by_owner))
        log.warning(
            "catchup_scheduled_booking_responses check %s/%s: syncing %s owner(s) "
            "of %s fired booking(s)",
            attempt + 1, passes, len(by_owner),
            sum(e["bookings"] for e in by_owner.values()),
        )
        results = await asyncio.gather(
            *(
                sync_one(pid, entry, email_by_owner.get(pid))
                for pid, entry in by_owner.items()
            )
        )
        # Counters describe the LAST pass that had work: that is the state the job
        # actually left behind, and earlier passes are already in the log above.
        users = len(results)
        synced = sum(results)
        skipped = users - synced
        if attempt == passes - 1:
            break
        # Re-read BEFORE waiting, not after: sync_my_calendar has already written any
        # promotion it found, so this tells us whether a wait is worth anything at
        # all. Everyone answered on this pass -> finish now instead of holding the
        # job open for a gap it has no work to do on the far side of.
        by_owner = owners_awaiting_response()
        if by_owner:
            await asyncio.sleep(RESPONSE_CATCHUP_GAPS_SECONDS[attempt])

    summary = {"ok": True, "users": users, "synced": synced, "skipped": skipped}
    log.warning("catchup_scheduled_booking_responses finished: %s", summary)
    return summary
