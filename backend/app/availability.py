"""Background availability cache.

A scheduled job reads each in-use room's free/busy from Microsoft Graph using a
DELEGATED token borrowed from the graph_token_pool (needs only the
user-consentable Calendars.Read.Shared — no app-only admin consent) and stores it
in the `room_availability` Supabase table. The browse grid then reads from that
cache instead of calling Graph live (see /api/availability in main.py).

Cache layout (room_availability):
  room_id  uuid  -> meeting_room_metadata.id
  date     date  -> today .. today + (availability_days - 1)
  slots    smallint[96]  -> one 15-min slot per element, index = hour*4 + minute//15
                           value 0 = free, 1 = busy
  slot_owner_ids uuid[96] -> nullable user_profiles.id for API-created bookings
  updated_at timestamptz
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import date as date_cls, datetime, time as time_cls, timedelta
from zoneinfo import ZoneInfo

import httpx

from . import graph
from .config import get_settings

log = logging.getLogger("vngmeet.availability")

SLOTS_PER_DAY = 96  # 24h / 15min

# Per-user throttle so polling the grid / opening booking history doesn't hammer
# /me/calendarView. Shared by every caller of sync_my_calendar so a grid load and
# a history load within the window trigger at most one Graph round-trip.
_CALENDAR_SYNC_TTL = 60.0
_last_calendar_sync: dict[str, float] = {}


def should_sync_calendar(profile_id: str | None, force: bool = False) -> bool:
    """True at most once per _CALENDAR_SYNC_TTL per user; records the attempt.

    force=True bypasses the throttle (used by the post-booking refresh that must
    pick up a just-created booking's room response) while still recording the time.
    """
    if not profile_id:
        return False
    now = time.time()
    if not force and now - _last_calendar_sync.get(profile_id, 0.0) < _CALENDAR_SYNC_TTL:
        return False
    _last_calendar_sync[profile_id] = now
    return True


# --------------------------------------------------------------------------- #
# Room-usage lifecycle
# --------------------------------------------------------------------------- #
# Once the room mailbox accepts an invite (status "success") the room's OWN
# free/busy — which this module already refreshes every minute — is the only
# signal that says what happened next. Outlook flips the room's *response* to
# "declined" both when it auto-releases an un-checked-in booking and when someone
# checks out early, so the response alone cannot tell those apart. The release
# time can: what distinguishes the cases is WHEN the room first stops holding the
# slot, relative to the meeting's own start.
#
#   released before start                     -> canceled  (canceled_outlook)
#   released within AUTO_RELEASE_MINUTES      -> canceled  (canceled_outlook)
#   released on the first check past that     -> canceled  (room_auto_canceled)
#   released later, still before end_time     -> finished  ("finished_at HH:MM")
#   still held at end_time                    -> finished  ("finished_at <end>")
#
# Statuses this reconcile owns. A row leaves the set for good once it lands on a
# terminal status, so the per-minute scan stays small.
USAGE_STATUSES = ("success", "ongoing")

# How long Outlook lets an un-checked-in booking hold the room before releasing it.
AUTO_RELEASE_MINUTES = 15

# Slack after the auto-release mark in which a release still reads as
# "the room let it go", not "the meeting ended early". Wide enough that a dropped
# cron tick (this job has a hard one-minute budget) doesn't reclassify a no-show
# as an early finish.
AUTO_RELEASE_DETECT_MINUTES = 5

# Same propagation guard the calendar sync uses: a booking whose event Graph has
# not published to the room's free/busy yet must not read as released. Measured
# from max(created_at, processed_at) — processed_at is stamped both when a
# scheduled booking fires and when the calendar sync promotes a row to `success`,
# so the grace always covers the moment this reconcile took the row over.
USAGE_GRACE_MINUTES = 5

# How far back to sweep rows that never reached a terminal status (server restart,
# a missed tick, or the midnight scheduled-booking blackout). Older rows are left
# alone — room_availability is pruned daily, so there is nothing left to verify
# them against and rewriting months of history on the first run would be worse
# than leaving it.
USAGE_SWEEP_DAYS = 7


def _av_char_to_status(ch: str, *, scheduled_day: bool = False) -> int:
    """Map a Graph availabilityView digit to our 0=free / 1=busy encoding.

    availabilityView: 0=free, 1=tentative, 2=busy, 3=oof, 4=workingElsewhere.
    Anything other than free counts as busy for booking purposes. On the final
    cache day, Graph-free slots remain -1 so the day is still handled as a
    scheduled-booking day, while Graph-busy slots remain blocked as 1.
    """
    if ch == "0":
        return -1 if scheduled_day else 0
    return 1


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


def _read_existing_slot_meta(
    sb, room_ids: list[str], day_list: list
) -> dict[tuple[str, str], dict]:
    """Existing owner + attendee arrays per (room_id, date), for merge-on-refresh."""
    if not room_ids or not day_list:
        return {}
    rows = (
        sb.table("room_availability")
        .select("room_id, date, slot_owner_ids, slot_attendee_ids")
        .in_("room_id", room_ids)
        .gte("date", day_list[0].isoformat())
        .lte("date", day_list[-1].isoformat())
        .execute()
        .data
        or []
    )
    out: dict[tuple[str, str], dict] = {}
    for row in rows:
        owner_ids = list(row.get("slot_owner_ids") or [])
        if len(owner_ids) != SLOTS_PER_DAY:
            owner_ids = [None] * SLOTS_PER_DAY
        attendee_ids = list(row.get("slot_attendee_ids") or [])
        if len(attendee_ids) != SLOTS_PER_DAY:
            attendee_ids = [None] * SLOTS_PER_DAY
        out[(row["room_id"], str(row["date"]))] = {
            "owner": owner_ids,
            "attendees": attendee_ids,
        }
    return out


def _merge_owner_ids_with_slots(existing_owner_ids: list | None, slots: list[int]) -> list:
    """Keep owner on busy slots, clear it where the room is now free."""
    owner_ids = list(existing_owner_ids or [])
    if len(owner_ids) != SLOTS_PER_DAY:
        owner_ids = [None] * SLOTS_PER_DAY
    return [
        owner_ids[idx] if idx < len(slots) and slots[idx] != 0 else None
        for idx in range(SLOTS_PER_DAY)
    ]


def _merge_attendee_ids_with_slots(existing_attendee_ids: list | None, slots: list[int]) -> list:
    """Keep the attendee list on busy slots, clear it where the room is now free."""
    attendee_ids = list(existing_attendee_ids or [])
    if len(attendee_ids) != SLOTS_PER_DAY:
        attendee_ids = [None] * SLOTS_PER_DAY
    return [
        attendee_ids[idx] if idx < len(slots) and slots[idx] != 0 else None
        for idx in range(SLOTS_PER_DAY)
    ]


# getSchedule accepts many schedules per call; Graph recommends batching. The
# delegated /me path queries all in-use rooms at once in groups of this size.
SCHEDULE_BATCH = 20

# Rows per room_availability upsert. Each row carries three 96-element arrays, so
# rooms x availability_days in a single request is a multi-megabyte body that both
# stalls and occasionally times out. Chunks go up concurrently.
UPSERT_CHUNK = 250


async def refresh_availability_delegated(token: str) -> dict:
    """Refresh room_availability using a DELEGATED Graph token (signed-in user).

    Hits /me/calendar/getSchedule with the user's token, so it works without any
    app-only admin creds — the user just needs Calendars.Read.Shared to see the
    rooms' free/busy. Rooms are queried in batches (one getSchedule call per batch)
    and the returned availabilityView is sliced into per-day rows of 96 15-min
    slots. This is the only availability-refresh path.

    Runs on a one-minute cron, so it MUST finish inside a minute: APScheduler is
    configured with max_instances=1, and an overrun silently drops the next tick —
    which is what turned this job's real-world cadence into two minutes. Hence the
    concurrent batches, the shared HTTP connection, and the chunked upsert.

    Every Supabase call here goes through asyncio.to_thread: supabase-py is
    synchronous, and this job's payloads are large enough that running them inline
    would block the whole event loop — including the scheduled-booking countdown.
    """
    settings = get_settings()
    if not settings.supabase_enabled:
        raise RuntimeError("Supabase not configured; cannot refresh availability.")

    from .supabase_client import get_supabase

    t_start = time.perf_counter()
    tz = ZoneInfo(settings.timezone)
    today = datetime.now(tz).date()
    days = settings.availability_days
    day_list = [today + timedelta(days=i) for i in range(days)]

    rooms = await asyncio.to_thread(_in_use_rooms)
    if not rooms:
        log.warning("refresh_availability_delegated: no in_use rooms found")
        return {"rooms": 0, "rows": 0, "errors": 0}
    room_ids = [room["id"] for room in rooms]

    start_iso = f"{day_list[0].isoformat()}T00:00:00"
    end_iso = f"{(today + timedelta(days=days)).isoformat()}T00:00:00"

    by_email = {r["email"].lower(): r for r in rooms}
    emails = [r["email"] for r in rooms]
    sb = get_supabase()

    batches = [emails[i : i + SCHEDULE_BATCH] for i in range(0, len(emails), SCHEDULE_BATCH)]

    async def _fetch(client: httpx.AsyncClient, batch: list[str]) -> dict[str, str] | None:
        try:
            return await graph.get_schedule(
                token,
                batch,
                start_iso,
                end_iso,
                settings.timezone,
                settings.availability_slot_minutes,
                client=client,
            )
        except httpx.HTTPStatusError as e:
            log.warning(
                "getSchedule(delegated) failed for %s: %s %s",
                batch, e.response.status_code, e.response.text[:200],
            )
        except Exception as e:  # noqa: BLE001 - one batch must not kill the rest
            log.warning("getSchedule(delegated) error for %s: %s", batch, e)
        return None

    # The existing-meta read and every getSchedule batch are independent: overlap
    # them instead of paying for them one after another.
    async with httpx.AsyncClient(
        timeout=60,
        limits=httpx.Limits(max_keepalive_connections=len(batches) or 1,
                            max_connections=max(len(batches) * 2, 4)),
    ) as client:
        existing_meta, *view_sets = await asyncio.gather(
            asyncio.to_thread(_read_existing_slot_meta, sb, room_ids, day_list),
            *(_fetch(client, b) for b in batches),
        )
    t_fetched = time.perf_counter()

    upserts: list[dict] = []
    # This tick's room free/busy, keyed (room_id, date) — handed to the room-usage
    # reconcile so it verifies bookings against exactly what was just fetched.
    room_slots: dict[tuple[str, str], list[int]] = {}
    errors = 0
    now_iso = datetime.now(tz).isoformat()

    for batch, views in zip(batches, view_sets):
        if views is None:
            errors += len(batch)
            continue

        for email, view in views.items():
            room = by_email.get(email.lower())
            if not room:
                continue
            for di, day in enumerate(day_list):
                chunk = view[di * SLOTS_PER_DAY : (di + 1) * SLOTS_PER_DAY]
                scheduled_day = di == len(day_list) - 1
                slots = [
                    _av_char_to_status(c, scheduled_day=scheduled_day)
                    for c in chunk
                ]
                # Pad if Graph returned a short view (defensive; missing = free).
                if len(slots) < SLOTS_PER_DAY:
                    pad_value = -1 if scheduled_day else 0
                    slots += [pad_value] * (SLOTS_PER_DAY - len(slots))
                room_slots[(room["id"], day.isoformat())] = slots
                meta = existing_meta.get((room["id"], day.isoformat())) or {}
                slot_owner_ids = _merge_owner_ids_with_slots(meta.get("owner"), slots)
                slot_attendee_ids = _merge_attendee_ids_with_slots(meta.get("attendees"), slots)
                upserts.append(
                    {
                        "room_id": room["id"],
                        "date": day.isoformat(),
                        "slots": slots,
                        "slot_owner_ids": slot_owner_ids,
                        "slot_attendee_ids": slot_attendee_ids,
                        "updated_at": now_iso,
                    }
                )

    def _upsert(chunk: list[dict]) -> None:
        sb.table("room_availability").upsert(chunk, on_conflict="room_id,date").execute()

    def _prune() -> None:
        sb.table("room_availability").delete().lt("date", today.isoformat()).execute()

    chunks = [upserts[i : i + UPSERT_CHUNK] for i in range(0, len(upserts), UPSERT_CHUNK)]
    writes = await asyncio.gather(
        *(asyncio.to_thread(_upsert, c) for c in chunks),
        asyncio.to_thread(_prune),
        return_exceptions=True,
    )
    for outcome in writes:
        if isinstance(outcome, BaseException):
            errors += 1
            log.warning("room_availability write failed: %s", outcome)

    # Read the fresh room free/busy back into booking history: accepted bookings
    # become ongoing / finished / canceled here, once a minute, for every user.
    # Best-effort — the availability cache is this job's real contract.
    usage: dict[str, int] = {}
    try:
        usage = await asyncio.to_thread(
            _reconcile_room_usage,
            sb,
            tz,
            room_slots,
            {email: room["id"] for email, room in by_email.items()},
            (today - timedelta(days=USAGE_SWEEP_DAYS)).isoformat(),
            day_list[-1].isoformat(),
        )
    except Exception as e:  # noqa: BLE001 - history must not break the cache refresh
        log.warning("reconcile_room_usage skipped: %s", e)

    total_ms = (time.perf_counter() - t_start) * 1000
    summary = {
        "rooms": len(rooms),
        "rows": len(upserts),
        "errors": errors,
        "usage": usage,
        "fetch_ms": round((t_fetched - t_start) * 1000),
        "total_ms": round(total_ms),
    }
    # WARNING, not INFO: this job has a hard one-minute budget (max_instances=1
    # means an overrun eats the next tick), so a slow run needs to be visible.
    if total_ms > 30_000:
        log.warning(
            "refresh_availability_delegated SLOW (%.1fs of its 60s budget): %s",
            total_ms / 1000, summary,
        )
    else:
        log.info("refresh_availability_delegated done: %s", summary)
    return summary


def _parse_graph_local(dt_str: str | None) -> datetime | None:
    """Parse a Graph dateTime ("2026-06-25T09:00:00.0000000") as a naive datetime.

    The Prefer: outlook.timezone header makes Graph return local wall-clock times,
    so we drop the (over-long) fractional seconds and read it tz-naive — start/end
    share the same zone, which is all the slot math needs.
    """
    if not dt_str:
        return None
    s = dt_str.strip()
    if "." in s:
        head, _, frac = s.partition(".")
        s = f"{head}.{frac[:6]}"
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def _parse_iso_aware(s: str | None) -> datetime | None:
    """Parse a tz-aware ISO timestamp (e.g. Supabase created_at) or return None."""
    if not s:
        return None
    text = s.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _time_to_slot_index(time_value: str | None) -> int | None:
    """"HH:MM" -> 15-min slot index (hour*4 + minute//15), or None if unparseable."""
    if not time_value:
        return None
    try:
        hour, minute = (int(p) for p in time_value.split(":")[:2])
    except (TypeError, ValueError):
        return None
    idx = hour * 4 + minute // 15
    return idx if 0 <= idx < SLOTS_PER_DAY else None


def _end_time_to_slot_bound(time_value: str | None) -> int | None:
    """"HH:MM" -> EXCLUSIVE 15-min slot bound (first slot after the booking).

    Rounds up, so a booking ending 14:50 still counts the 14:45 slot as its own.
    "24:00" maps to SLOTS_PER_DAY (ran to midnight).
    """
    if not time_value:
        return None
    try:
        hour, minute = (int(p) for p in str(time_value).split(":")[:2])
    except (TypeError, ValueError):
        return None
    bound = hour * 4 + (minute + 14) // 15
    return bound if 1 <= bound <= SLOTS_PER_DAY else None


def _local_dt(day: date_cls, time_value: str, tz: ZoneInfo) -> datetime | None:
    """(date, "HH:MM") -> tz-aware local datetime; "24:00" rolls to next midnight."""
    try:
        hour, minute = (int(p) for p in str(time_value).split(":")[:2])
    except (TypeError, ValueError):
        return None
    if hour == 24 and minute == 0:
        return datetime.combine(day + timedelta(days=1), time_cls(0, 0), tzinfo=tz)
    if not (0 <= hour < 24 and 0 <= minute < 60):
        return None
    return datetime.combine(day, time_cls(hour, minute), tzinfo=tz)


def _reconcile_room_usage(
    sb,
    tz: ZoneInfo,
    room_slots: dict[tuple[str, str], list[int]],
    room_id_by_email: dict[str, str],
    sweep_from: str,
    window_end: str,
) -> dict:
    """Drive accepted bookings through the room-usage lifecycle from room free/busy.

    Runs inside the one-minute availability job, against the slot arrays that job
    just wrote — so a room releasing a slot is picked up within a minute, for every
    user, instead of whenever the organizer next happens to open the app.

    `room_slots` is keyed (room_id, "YYYY-MM-DD") and holds this tick's freshly
    fetched arrays. A room missing from it was not polled this tick (its
    getSchedule batch failed, or the room is no longer in use), which is unknown —
    not "released" — so its rows are left untouched.

    Synchronous by design: supabase-py is blocking and the caller runs this in a
    worker thread.
    """
    now = datetime.now(tz)
    today = now.date()
    cutoff = now - timedelta(minutes=USAGE_GRACE_MINUTES)

    rows = (
        sb.table("user_activity")
        .select(
            "id, room_email, date, start_time, end_time, status, "
            "graph_event_id, created_at, processed_at"
        )
        .in_("status", list(USAGE_STATUSES))
        .gte("date", sweep_from)
        .lte("date", window_end)
        .execute()
        .data
        or []
    )

    # row id -> {"status", "note"}; note None means "leave the column alone".
    updates: dict[str, dict] = {}
    for r in rows:
        row_id = r.get("id")
        if not row_id or not r.get("graph_event_id"):
            continue  # nothing on the calendar to verify against
        date_str = str(r.get("date") or "")
        start_time = str(r.get("start_time") or "")[:5]
        end_time = str(r.get("end_time") or "")[:5]
        try:
            day = date_cls.fromisoformat(date_str)
        except ValueError:
            continue
        start_idx = _time_to_slot_index(start_time)
        end_bound = _end_time_to_slot_bound(end_time)
        start_dt = _local_dt(day, start_time, tz)
        end_dt = _local_dt(day, end_time, tz)
        if (
            start_idx is None
            or end_bound is None
            or end_bound <= start_idx
            or start_dt is None
            or end_dt is None
        ):
            continue

        # Past days: room_availability has been pruned, so nothing is left to check.
        # Close the row out and flag in the note that the outcome was inferred.
        if day < today:
            updates[row_id] = {
                "status": "finished",
                "note": f"finished_unverified {end_time}",
            }
            continue

        room_id = room_id_by_email.get((r.get("room_email") or "").strip().lower())
        slots = room_slots.get((room_id, date_str)) if room_id else None
        if slots is None:
            continue  # room not polled this tick -> unknown, never assume released
        # 1 = busy. 0 and -1 are both free (-1 marks the still-scheduled final day).
        held = any(slots[i] == 1 for i in range(start_idx, min(end_bound, len(slots))))

        if held:
            if now >= end_dt:
                # Ran to its end with the room still holding it: used in full.
                updates[row_id] = {"status": "finished", "note": f"finished_at {end_time}"}
            elif now >= start_dt and r.get("status") != "ongoing":
                updates[row_id] = {"status": "ongoing", "note": None}
            continue

        # The room no longer holds any of the booking's slots.
        stamps = [
            s
            for s in (
                _parse_iso_aware(r.get("created_at")),
                _parse_iso_aware(r.get("processed_at")),
            )
            if s is not None
        ]
        if stamps and max(stamps) > cutoff:
            continue  # too fresh to trust as released (Graph propagation lag)

        auto_release_at = start_dt + timedelta(minutes=AUTO_RELEASE_MINUTES)
        if now < auto_release_at:
            # Gone before Outlook could have auto-released it -> the meeting itself
            # was cancelled (in Outlook, or by whoever owned the event).
            updates[row_id] = {"status": "canceled", "note": "canceled_outlook"}
        elif now < auto_release_at + timedelta(minutes=AUTO_RELEASE_DETECT_MINUTES):
            # First check past the auto-release mark: nobody ever checked in.
            updates[row_id] = {"status": "canceled", "note": "room_auto_canceled"}
        elif now < end_dt:
            # Held past check-in, released before end_time -> checked out early.
            updates[row_id] = {
                "status": "finished",
                "note": f"finished_at {now.strftime('%H:%M')}",
            }
        elif r.get("status") == "ongoing":
            # Seen in use, then the event was gone by the time we looked again.
            updates[row_id] = {
                "status": "finished",
                "note": f"finished_unverified {end_time}",
            }
        else:
            # Never observed in use and gone by end_time: released at some point we
            # did not watch (missed ticks / downtime). Cancelled, moment unknown.
            updates[row_id] = {"status": "canceled", "note": "canceled_unverified"}

    # Group identical outcomes so a batch of rows costs one UPDATE, not one each.
    grouped: dict[tuple[str, str | None], list[str]] = {}
    for row_id, upd in updates.items():
        grouped.setdefault((upd["status"], upd["note"]), []).append(row_id)
    counts: dict[str, int] = {}
    for (status, note), ids in grouped.items():
        payload: dict = {"status": status}
        if note is not None:
            payload["note"] = note
        sb.table("user_activity").update(payload).in_("id", ids).execute()
        counts[status] = counts.get(status, 0) + len(ids)
    if counts:
        log.info("reconcile_room_usage applied: %s", counts)
    return counts


def _profile_ids_by_email(sb, emails: set[str]) -> dict[str, str]:
    """Map lowercased email -> user_profiles.id for the emails that exist."""
    wanted = {e for e in emails if e}
    if not wanted:
        return {}
    rows = (
        sb.table("user_profiles")
        .select("id, email")
        .in_("email", list(wanted))
        .execute()
        .data
        or []
    )
    return {
        (row["email"] or "").strip().lower(): str(row["id"])
        for row in rows
        if row.get("id") and row.get("email")
    }


def _event_room_attendee(ev: dict) -> dict | None:
    """The event's type="resource" attendee (the booked room), or None."""
    for att in ev.get("attendees") or []:
        if (att.get("type") or "").lower() == "resource":
            return att
    return None


def _event_room_email(ev: dict) -> str | None:
    """The room mailbox for an event = its type="resource" attendee."""
    att = _event_room_attendee(ev)
    if not att:
        return None
    return ((att.get("emailAddress") or {}).get("address") or "").strip().lower() or None


async def sync_my_calendar(
    token: str,
    user_profile_id: str | None = None,
    me_email: str | None = None,
) -> dict:
    """Attribute room slots to their real owner + attendees from /me/calendarView.

    Pulls the signed-in user's events (organized or invited) over the availability
    window and merges, ADDITIVELY, into room_availability:
      - slots[idx]   -> 1 (busy) for slots the event covers
      - slot_owner_ids[idx]    -> the event organizer's profile id
      - slot_attendee_ids[idx] -> union of invited attendees' profile ids

    It also RECONCILES the requesting user's footprint: on live (instant) days, any
    slot where this user is recorded as owner/attendee but has no matching event in
    the fresh calendarView is treated as cancelled-in-Outlook and cleared (owner
    slot freed entirely; attendee-only slot just drops the user). The schedule day
    is left untouched so pending app bookings (not yet on Outlook) are not wiped.

    This lets an attendee's grid show events they were invited to (not just
    self-booked), corrects the "booked in Outlook shows as someone else" case, and
    removes meetings the user cancelled directly in Outlook. Needs user_profile_id
    to know whose footprint to reconcile.
    """
    settings = get_settings()
    if not settings.supabase_enabled:
        return {"events": 0, "rows": 0}
    from .supabase_client import get_supabase

    tz = ZoneInfo(settings.timezone)
    today = datetime.now(tz).date()
    days = settings.availability_days
    day_ceil = today + timedelta(days=days)
    start_iso = f"{today.isoformat()}T00:00:00"
    end_iso = f"{day_ceil.isoformat()}T00:00:00"

    try:
        events = await graph.get_calendar_view(token, start_iso, end_iso, settings.timezone)
    except httpx.HTTPStatusError as e:
        log.warning(
            "sync_my_calendar: calendarView failed: %s %s",
            e.response.status_code, e.response.text[:200],
        )
        return {"events": 0, "rows": 0}
    except Exception as e:  # noqa: BLE001 - calendar sync must not break the grid
        log.warning("sync_my_calendar: calendarView error: %s", e)
        return {"events": 0, "rows": 0}

    rooms = _in_use_rooms()
    room_id_by_email = {r["email"].strip().lower(): r["id"] for r in rooms}
    if not room_id_by_email:
        return {"events": len(events or []), "rows": 0}
    # NB: do not early-return on empty events — an empty calendarView means the user
    # cancelled everything, which reconciliation below must free, not skip.

    sb = get_supabase()

    # Resolve every organizer/attendee email to a profile id in one query.
    all_emails: set[str] = set()
    for ev in events:
        org = (((ev.get("organizer") or {}).get("emailAddress") or {}).get("address") or "").strip().lower()
        if org:
            all_emails.add(org)
        for att in ev.get("attendees") or []:
            if (att.get("type") or "").lower() == "resource":
                continue
            addr = ((att.get("emailAddress") or {}).get("address") or "").strip().lower()
            if addr:
                all_emails.add(addr)
    profile_id_by_email = _profile_ids_by_email(sb, all_emails)

    me = str(user_profile_id) if user_profile_id else None

    # Per (room_id, date): owner_by_idx{idx:pid}, attendees_by_idx{idx:{pid}}, slots{idx}.
    # mine_*_now: where THIS user currently is owner / attendee, for reconciliation.
    edits: dict[tuple[str, str], dict] = {}
    mine_owner_now: set[tuple[str, str, int]] = set()
    mine_attendee_now: set[tuple[str, str, int]] = set()
    # Slots the user organizes where the room mailbox ACCEPTED the invite (booking
    # confirmed -> promote pending to ok). mine_owner_now is the superset that also
    # includes still-awaiting rooms (response none/notResponded -> stay pending).
    mine_accepted_now: set[tuple[str, str, int]] = set()
    # Slots the user organizes but where the room DECLINED: the event exists on the
    # calendar yet the room was never secured, so it must not show as booked and the
    # booking row should read as failed, not ok.
    mine_declined_now: set[tuple[str, str, int]] = set()
    # Full meeting detail per (room_id, date) for events this user is part of, with
    # explicit start/end so two back-to-back bookings (1-2, 2-3) stay distinct and
    # the read-only view / date dots have subject/attendees/body.
    fresh_meetings: dict[tuple[str, str], list[dict]] = {}
    for ev in events:
        room_att = _event_room_attendee(ev)
        if not room_att:
            continue
        room_email = ((room_att.get("emailAddress") or {}).get("address") or "").strip().lower()
        room_id = room_id_by_email.get(room_email)
        if not room_id:
            continue
        start_dt = _parse_graph_local((ev.get("start") or {}).get("dateTime"))
        end_dt = _parse_graph_local((ev.get("end") or {}).get("dateTime"))
        if not start_dt or not end_dt or end_dt <= start_dt:
            continue

        # Room response: "accepted" -> confirmed; "declined" -> rejected; anything
        # else ("none"/"notResponded"/"tentativelyAccepted") -> still awaiting.
        room_response = ((room_att.get("status") or {}).get("response") or "").lower()
        room_declined = room_response == "declined"
        room_accepted = room_response == "accepted"

        org_email = (((ev.get("organizer") or {}).get("emailAddress") or {}).get("address") or "").strip().lower()
        owner_pid = profile_id_by_email.get(org_email)
        attendee_pids = {
            profile_id_by_email[addr]
            for att in (ev.get("attendees") or [])
            if (att.get("type") or "").lower() != "resource"
            and (addr := ((att.get("emailAddress") or {}).get("address") or "").strip().lower())
            in profile_id_by_email
        }

        # Store full meeting detail (non-declined), split per covered day in window.
        if not room_declined:
            subject = (ev.get("subject") or "").strip()
            body = (ev.get("bodyPreview") or "").strip()
            attendee_emails = sorted(
                {
                    addr
                    for att in (ev.get("attendees") or [])
                    if (att.get("type") or "").lower() != "resource"
                    and (addr := ((att.get("emailAddress") or {}).get("address") or "").strip().lower())
                }
            )
            event_id = ev.get("id") or ""
            span_start = start_dt
            while span_start < end_dt:
                d = span_start.date()
                next_midnight = datetime.combine(d + timedelta(days=1), datetime.min.time())
                span_end = min(end_dt, next_midnight)
                if today <= d < day_ceil:
                    end_hhmm = span_end.strftime("%H:%M")
                    if end_hhmm == "00:00":
                        end_hhmm = "24:00"  # ran to midnight
                    fresh_meetings.setdefault((room_id, d.isoformat()), []).append(
                        {
                            "id": event_id,
                            "start": span_start.strftime("%H:%M"),
                            "end": end_hhmm,
                            "owner": org_email or None,
                            "attendees": attendee_emails,
                            "subject": subject,
                            "body": body,
                        }
                    )
                span_start = next_midnight

        # Walk the event in 15-min steps, bucketed by local date.
        cur = start_dt.replace(minute=(start_dt.minute // 15) * 15, second=0, microsecond=0)
        while cur < end_dt:
            d = cur.date()
            if today <= d < day_ceil:
                idx = cur.hour * 4 + cur.minute // 15
                if 0 <= idx < SLOTS_PER_DAY:
                    date_str = d.isoformat()
                    if room_declined:
                        # Don't occupy/own the slot; just remember it's a declined
                        # booking of mine so its history row can be marked failed.
                        if owner_pid == me:
                            mine_declined_now.add((room_id, date_str, idx))
                    else:
                        e = edits.setdefault(
                            (room_id, date_str),
                            {"slots": set(), "owner_by_idx": {}, "attendees_by_idx": {}},
                        )
                        e["slots"].add(idx)
                        if owner_pid:
                            e["owner_by_idx"][idx] = owner_pid  # organizer authoritative, per slot
                            if owner_pid == me:
                                mine_owner_now.add((room_id, date_str, idx))
                                if room_accepted:
                                    mine_accepted_now.add((room_id, date_str, idx))
                        if attendee_pids:
                            e["attendees_by_idx"].setdefault(idx, set()).update(attendee_pids)
                            if me in attendee_pids:
                                mine_attendee_now.add((room_id, date_str, idx))
            cur += timedelta(minutes=15)

    # Load every in-use room's rows in the window: needed both to apply edits and
    # to find this user's stale footprint (cancelled-in-Outlook) to reconcile.
    all_room_ids = [r["id"] for r in rooms]
    window_dates = [(today + timedelta(days=i)).isoformat() for i in range(days)]
    existing_rows = (
        sb.table("room_availability")
        .select("room_id, date, slots, slot_owner_ids, slot_attendee_ids, meetings")
        .in_("room_id", all_room_ids)
        .gte("date", window_dates[0])
        .lte("date", window_dates[-1])
        .execute()
        .data
        or []
    )

    def _norm(row: dict | None) -> dict:
        slots = list((row or {}).get("slots") or [])
        if len(slots) != SLOTS_PER_DAY:
            slots = [0] * SLOTS_PER_DAY
        owner_ids = list((row or {}).get("slot_owner_ids") or [])
        if len(owner_ids) != SLOTS_PER_DAY:
            owner_ids = [None] * SLOTS_PER_DAY
        attendee_ids = list((row or {}).get("slot_attendee_ids") or [])
        if len(attendee_ids) != SLOTS_PER_DAY:
            attendee_ids = [None] * SLOTS_PER_DAY
        meetings = list((row or {}).get("meetings") or [])
        return {
            "slots": slots,
            "owner": owner_ids,
            "attendees": attendee_ids,
            "meetings": meetings,
            "dirty": False,
        }

    working: dict[tuple[str, str], dict] = {
        (r["room_id"], str(r["date"])): _norm(r) for r in existing_rows
    }

    # 1) Reconcile: drop this user's footprint where the event no longer exists.
    #    Only on instant days; schedule day (any -1) holds pending app bookings.
    if me:
        for (room_id, date), w in working.items():
            slots, owner_ids, attendee_ids = w["slots"], w["owner"], w["attendees"]
            if any(s == -1 for s in slots):
                continue  # schedule day: leave pending bookings alone
            for idx in range(SLOTS_PER_DAY):
                if (
                    owner_ids[idx]
                    and str(owner_ids[idx]) == me
                    and (room_id, date, idx) not in mine_owner_now
                ):
                    # User organized this slot but it's gone from their calendar
                    # -> cancelled in Outlook. Free the slot entirely.
                    owner_ids[idx] = None
                    attendee_ids[idx] = None
                    slots[idx] = 0
                    w["dirty"] = True
                elif (
                    attendee_ids[idx]
                    and me in attendee_ids[idx]
                    and (room_id, date, idx) not in mine_attendee_now
                ):
                    # User was only invited and that invite is gone -> drop them,
                    # leave the slot (organizer / others may still hold it).
                    remaining = [a for a in attendee_ids[idx] if a != me]
                    attendee_ids[idx] = remaining or None
                    w["dirty"] = True

    # 2) Apply the fresh events additively on top.
    for (room_id, date), e in edits.items():
        w = working.get((room_id, date))
        if w is None:
            w = _norm(None)
            working[(room_id, date)] = w
        slots, owner_ids, attendee_ids = w["slots"], w["owner"], w["attendees"]
        for idx in e["slots"]:
            slots[idx] = 1  # the user has an event here -> busy
        for idx, pid in e["owner_by_idx"].items():
            owner_ids[idx] = pid
        for idx, pids in e["attendees_by_idx"].items():
            merged = set(attendee_ids[idx] or [])
            merged.update(pids)
            attendee_ids[idx] = sorted(merged)
        w["dirty"] = True

    # 2b) Replace THIS user's meeting entries with the fresh set, keeping meetings
    #     contributed by other users' syncs. This adds new, updates changed, and
    #     drops cancelled meetings of the user in one pass.
    if me_email:
        me_lower = me_email.strip().lower()
        for key in set(working.keys()) | set(fresh_meetings.keys()):
            w = working.get(key)
            if w is None:
                w = _norm(None)
                working[key] = w
            existing = w.get("meetings") or []
            kept = [
                m
                for m in existing
                if (m.get("owner") or "") != me_lower
                and me_lower not in (m.get("attendees") or [])
            ]
            new_list = kept + fresh_meetings.get(key, [])
            if new_list != existing:
                w["meetings"] = new_list
                w["dirty"] = True

    now_iso = datetime.now(tz).isoformat()
    upserts = [
        {
            "room_id": room_id,
            "date": date,
            "slots": w["slots"],
            "slot_owner_ids": w["owner"],
            "slot_attendee_ids": w["attendees"],
            "meetings": w.get("meetings") or [],
            "updated_at": now_iso,
        }
        for (room_id, date), w in working.items()
        if w["dirty"]
    ]
    if upserts:
        sb.table("room_availability").upsert(
            upserts, on_conflict="room_id,date"
        ).execute()

    # 3) Reconcile booking-history rows against the live calendar, by start slot.
    #    This step only decides whether the room EVER granted the booking:
    #      - room accepted      -> promote pending/ok to success
    #      - room still awaiting -> keep pending / keep ok (never downgrade)
    #      - room declined       -> failed (room_declined)
    #      - event gone          -> canceled (grace-gated; see below)
    #    Everything that happens to a booking AFTER the room accepted it (used,
    #    checked out early, auto-released, cancelled in Outlook) is deliberately NOT
    #    decided here: a `success` row's status belongs to _reconcile_room_usage,
    #    which watches the room's own free/busy every minute. This function only runs
    #    when its user opens the app, and by then Outlook reports an auto-released or
    #    checked-out room the same way it reports a genuine rejection ("declined") —
    #    which is exactly how normal room usage used to land in history as `failed`.
    #    Declined `success` rows still get their orphaned event cleaned up below.
    #    Only rows with a real graph_event_id are touched, so scheduled bookings that
    #    haven't fired yet (pending, no event) are left alone. Using the slot (not
    #    graph_event_id matching) avoids id-encoding mismatches. Rooms not in_use
    #    can't be verified -> skipped.
    promoted = canceled = declined = 0
    if me:
        try:
            rows = (
                sb.table("user_activity")
                .select("id, room_email, date, start_time, status, graph_event_id, created_at, processed_at")
                .eq("user_id", me)
                .in_("status", ["ok", "pending", "success", "ongoing"])
                .gte("date", window_dates[0])
                .lte("date", window_dates[-1])
                .execute()
                .data
                or []
            )
            # Grace period: a just-created/just-fired event may not be in calendarView
            # yet (Graph propagation lag). processed_at covers rows advanced long after
            # created_at — a scheduled booking that fired into a real event only at
            # midnight, or a row promoted to success by this very function. The
            # grace gates ONLY the "canceled" transition (the destructive one); accept
            # / decline outcomes are sticky and may apply immediately.
            cutoff = datetime.now(tz) - timedelta(minutes=5)
            success_ids: list[str] = []
            cancel_ids: list[str] = []
            declined_ids: list[str] = []
            declined_event_ids: list[str] = []
            for r in rows:
                if not r.get("graph_event_id"):
                    continue  # scheduled booking not yet fired -> no real event
                room_id = room_id_by_email.get((r.get("room_email") or "").strip().lower())
                start_idx = _time_to_slot_index(r.get("start_time"))
                if not room_id or start_idx is None:
                    continue  # can't verify -> leave as-is
                key = (room_id, str(r.get("date")), start_idx)
                cur = r.get("status")
                # A row the room already accepted is owned by the room-usage
                # reconcile from here on; this pass must not restate its outcome.
                settled = cur in ("success", "ongoing")
                if key in mine_owner_now:
                    # Alive (accepted or awaiting). Promote pending/ok->success on
                    # accept; never downgrade a confirmed success.
                    if key in mine_accepted_now and cur in ("pending", "ok"):
                        success_ids.append(r["id"])
                elif key in mine_declined_now:
                    # Always clean up the orphaned event (see the delete loop below),
                    # but only call it a failure while the room had yet to accept.
                    declined_event_ids.append(r["graph_event_id"])
                    if not settled:
                        declined_ids.append(r["id"])
                elif not settled:
                    # Event no longer on the calendar -> canceled, unless too fresh.
                    stamps = [
                        s
                        for s in (
                            _parse_iso_aware(r.get("created_at")),
                            _parse_iso_aware(r.get("processed_at")),
                        )
                        if s is not None
                    ]
                    if stamps and max(stamps) > cutoff:
                        continue  # too fresh to trust as deleted (propagation lag)
                    cancel_ids.append(r["id"])
            if success_ids:
                # Stamp the promotion. processed_at is this row's "backend last
                # advanced it" marker, and it is what gives _reconcile_room_usage
                # its propagation grace: the moment a row becomes `success` that
                # reconcile starts judging it by the room's getSchedule free/busy,
                # which is a different Graph surface from the calendarView that
                # just reported the accept. Without this stamp a row promoted long
                # after it was created — a Room Scout booking re-checked cycle
                # after cycle — would be graded on the very next minute tick with
                # no grace at all, and one lagging free/busy read would cancel a
                # perfectly good booking.
                sb.table("user_activity").update(
                    {"status": "success", "processed_at": now_iso}
                ).in_("id", success_ids).execute()
                promoted = len(success_ids)
            if cancel_ids:
                sb.table("user_activity").update(
                    {"status": "canceled", "note": "canceled_outlook"}
                ).in_("id", cancel_ids).execute()
                canceled = len(cancel_ids)
            # A declined room leaves an orphaned event (now with no room) sitting on
            # the organizer's Outlook calendar. Cancel it for real via Graph so the
            # user isn't left with dead meetings to clean up. This runs for released
            # rooms too (an accepted booking that was auto-released or checked out
            # reads as "declined" here), even though those rows' statuses belong to
            # the room-usage reconcile. Best-effort per event — a Graph hiccup must
            # not block the status flip, and delete_event already treats 404 as OK.
            for ev_id in declined_event_ids:
                try:
                    await graph.delete_event(token, ev_id)
                except Exception as e:  # noqa: BLE001 - status flip must still apply
                    log.warning(
                        "sync_my_calendar: could not delete declined event %s: %s",
                        ev_id, e,
                    )
            if declined_ids:
                # Declined before the room ever accepted -> the booking really failed.
                sb.table("user_activity").update(
                    {"status": "failed", "error_message": "room_declined"}
                ).in_("id", declined_ids).execute()
                declined = len(declined_ids)
        except Exception as e:  # noqa: BLE001 - history cleanup must not break the grid
            log.warning("sync_my_calendar: booking reconcile skipped: %s", e)

    summary = {
        "events": len(events),
        "rows": len(upserts),
        "promoted": promoted,
        "canceled": canceled,
        "declined": declined,
    }
    log.info("sync_my_calendar done: %s", summary)
    return summary
