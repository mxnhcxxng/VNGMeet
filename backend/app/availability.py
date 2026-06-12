"""Background availability cache.

A scheduled job (every 15 min, aligned to the quarter hour) reads each in-use
room's free/busy from Microsoft Graph app-only and stores it in the
`room_availability` Supabase table. The browse grid then reads from that cache
instead of calling Graph live (see /api/availability in main.py).

Cache layout (room_availability):
  room_id  uuid  -> meeting_room_metadata.id
  date     date  -> today .. today + (availability_days - 1)
  slots    smallint[96]  -> one 15-min slot per element, index = hour*4 + minute//15
                           value 0 = free, 1 = busy
  slot_owner_ids uuid[96] -> nullable user_profiles.id for API-created bookings
  updated_at timestamptz
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import httpx

from . import graph
from .config import get_settings

log = logging.getLogger("vngmeet.availability")

SLOTS_PER_DAY = 96  # 24h / 15min


def _av_char_to_status(ch: str) -> int:
    """Map a Graph availabilityView digit to our 0=free / 1=busy encoding.

    availabilityView: 0=free, 1=tentative, 2=busy, 3=oof, 4=workingElsewhere.
    Anything other than free counts as busy for booking purposes.
    """
    return 0 if ch == "0" else 1


def _in_use_rooms() -> list[dict]:
    """Rooms flagged in_use=true, with the fields the job needs."""
    from .supabase_client import get_supabase

    rows = (
        get_supabase()
        .table("meeting_room_metadata")
        .select("id, email")
        .eq("in_use", True)
        .execute()
        .data
    )
    return [r for r in (rows or []) if r.get("id") and r.get("email")]


def _read_existing_owner_ids(sb, room_ids: list[str], day_list: list) -> dict[tuple[str, str], list]:
    if not room_ids or not day_list:
        return {}
    rows = (
        sb.table("room_availability")
        .select("room_id, date, slot_owner_ids")
        .in_("room_id", room_ids)
        .gte("date", day_list[0].isoformat())
        .lte("date", day_list[-1].isoformat())
        .execute()
        .data
        or []
    )
    out: dict[tuple[str, str], list] = {}
    for row in rows:
        owner_ids = list(row.get("slot_owner_ids") or [])
        if len(owner_ids) != SLOTS_PER_DAY:
            owner_ids = [None] * SLOTS_PER_DAY
        out[(row["room_id"], str(row["date"]))] = owner_ids
    return out


def _merge_owner_ids_with_slots(existing_owner_ids: list | None, slots: list[int]) -> list:
    owner_ids = list(existing_owner_ids or [])
    if len(owner_ids) != SLOTS_PER_DAY:
        owner_ids = [None] * SLOTS_PER_DAY
    return [
        owner_ids[idx] if idx < len(slots) and slots[idx] != 0 else None
        for idx in range(SLOTS_PER_DAY)
    ]


async def refresh_availability() -> dict:
    """Refresh the room_availability cache for all in-use rooms. Returns a summary.

    One getSchedule call per room covers the whole window at 15-min granularity;
    the returned availabilityView string is sliced into per-day rows of 96 slots.
    """
    settings = get_settings()
    if not settings.supabase_enabled:
        raise RuntimeError("Supabase not configured; cannot refresh availability.")
    if not settings.graph_app_enabled:
        raise RuntimeError(
            "Graph app-only creds not configured (need real tenant_id + client "
            "id/secret + Calendars.Read application permission)."
        )

    from .supabase_client import get_supabase

    tz = ZoneInfo(settings.timezone)
    today = datetime.now(tz).date()
    days = settings.availability_days
    day_list = [today + timedelta(days=i) for i in range(days)]

    rooms = _in_use_rooms()
    if not rooms:
        log.warning("refresh_availability: no in_use rooms found")
        return {"rooms": 0, "rows": 0, "errors": 0}
    room_ids = [room["id"] for room in rooms]

    start_iso = f"{day_list[0].isoformat()}T00:00:00"
    end_iso = f"{(today + timedelta(days=days)).isoformat()}T00:00:00"

    token = await graph.get_app_token()
    sb = get_supabase()
    existing_owner_ids = _read_existing_owner_ids(sb, room_ids, day_list)

    upserts: list[dict] = []
    errors = 0
    now_iso = datetime.now(tz).isoformat()
    for room in rooms:
        email = room["email"]
        try:
            views = await graph.get_schedule_app(
                token,
                email,
                [email],
                start_iso,
                end_iso,
                settings.timezone,
                settings.availability_slot_minutes,
            )
        except httpx.HTTPStatusError as e:
            errors += 1
            log.warning("getSchedule failed for %s: %s %s", email, e.response.status_code, e.response.text[:200])
            continue
        except Exception as e:  # noqa: BLE001 - one room must not kill the batch
            errors += 1
            log.warning("getSchedule error for %s: %s", email, e)
            continue

        view = views.get(email, "")
        for di, day in enumerate(day_list):
            chunk = view[di * SLOTS_PER_DAY : (di + 1) * SLOTS_PER_DAY]
            slots = [_av_char_to_status(c) for c in chunk]
            # Pad if Graph returned a short view (defensive; treat missing as free).
            if len(slots) < SLOTS_PER_DAY:
                slots += [0] * (SLOTS_PER_DAY - len(slots))
            slot_owner_ids = _merge_owner_ids_with_slots(
                existing_owner_ids.get((room["id"], day.isoformat())),
                slots,
            )
            upserts.append(
                {
                    "room_id": room["id"],
                    "date": day.isoformat(),
                    "slots": slots,
                    "slot_owner_ids": slot_owner_ids,
                    "updated_at": now_iso,
                }
            )

    if upserts:
        sb.table("room_availability").upsert(
            upserts, on_conflict="room_id,date"
        ).execute()
    # Drop rows that have aged out of the window so the table stays bounded.
    sb.table("room_availability").delete().lt("date", today.isoformat()).execute()

    summary = {"rooms": len(rooms), "rows": len(upserts), "errors": errors}
    log.info("refresh_availability done: %s", summary)
    return summary


# getSchedule accepts many schedules per call; Graph recommends batching. The
# delegated /me path queries all in-use rooms at once in groups of this size.
SCHEDULE_BATCH = 20


async def refresh_availability_delegated(token: str) -> dict:
    """Refresh room_availability using a DELEGATED Graph token (signed-in user).

    Unlike refresh_availability() (app-only, no signed-in user), this hits
    /me/calendar/getSchedule with the requesting user's token, so it works
    without app-only admin creds — the user just needs Calendars.Read.Shared to
    see the rooms' free/busy. Rooms are queried in batches (one getSchedule call
    per batch) and the returned availabilityView is sliced into per-day rows of
    96 15-min slots, identical to the app-only path.
    """
    settings = get_settings()
    if not settings.supabase_enabled:
        raise RuntimeError("Supabase not configured; cannot refresh availability.")

    from .supabase_client import get_supabase

    tz = ZoneInfo(settings.timezone)
    today = datetime.now(tz).date()
    days = settings.availability_days
    day_list = [today + timedelta(days=i) for i in range(days)]

    rooms = _in_use_rooms()
    if not rooms:
        log.warning("refresh_availability_delegated: no in_use rooms found")
        return {"rooms": 0, "rows": 0, "errors": 0}
    room_ids = [room["id"] for room in rooms]

    start_iso = f"{day_list[0].isoformat()}T00:00:00"
    end_iso = f"{(today + timedelta(days=days)).isoformat()}T00:00:00"

    by_email = {r["email"].lower(): r for r in rooms}
    emails = [r["email"] for r in rooms]
    sb = get_supabase()
    existing_owner_ids = _read_existing_owner_ids(sb, room_ids, day_list)

    upserts: list[dict] = []
    errors = 0
    now_iso = datetime.now(tz).isoformat()

    for i in range(0, len(emails), SCHEDULE_BATCH):
        batch = emails[i : i + SCHEDULE_BATCH]
        try:
            views = await graph.get_schedule(
                token,
                batch,
                start_iso,
                end_iso,
                settings.timezone,
                settings.availability_slot_minutes,
            )
        except httpx.HTTPStatusError as e:
            errors += len(batch)
            log.warning(
                "getSchedule(delegated) failed for %s: %s %s",
                batch, e.response.status_code, e.response.text[:200],
            )
            continue
        except Exception as e:  # noqa: BLE001 - one batch must not kill the rest
            errors += len(batch)
            log.warning("getSchedule(delegated) error for %s: %s", batch, e)
            continue

        for email, view in views.items():
            room = by_email.get(email.lower())
            if not room:
                continue
            for di, day in enumerate(day_list):
                chunk = view[di * SLOTS_PER_DAY : (di + 1) * SLOTS_PER_DAY]
                slots = [_av_char_to_status(c) for c in chunk]
                # Pad if Graph returned a short view (defensive; missing = free).
                if len(slots) < SLOTS_PER_DAY:
                    slots += [0] * (SLOTS_PER_DAY - len(slots))
                slot_owner_ids = _merge_owner_ids_with_slots(
                    existing_owner_ids.get((room["id"], day.isoformat())),
                    slots,
                )
                upserts.append(
                    {
                        "room_id": room["id"],
                        "date": day.isoformat(),
                        "slots": slots,
                        "slot_owner_ids": slot_owner_ids,
                        "updated_at": now_iso,
                    }
                )

    if upserts:
        sb.table("room_availability").upsert(
            upserts, on_conflict="room_id,date"
        ).execute()
    sb.table("room_availability").delete().lt("date", today.isoformat()).execute()

    summary = {"rooms": len(rooms), "rows": len(upserts), "errors": errors}
    log.info("refresh_availability_delegated done: %s", summary)
    return summary
