"""Admin dashboard (/admin): system health, bookings, users, chatbot & Room Scout.

Only profiles with `user_profiles.role = 'admin'` may call these endpoints.
Everything is computed from tables the app already writes — no extra tracking:

- health:   room_availability.updated_at, graph_token_pool, user_activity status
- bookings: user_activity (status, note = who cancelled, error_message)
- usage:    user_profiles, user_activity / thread / room_scouts (who did something)
- chatbot:  thread, messages.feedback
- scout:    room_scouts (status, expires_at vs updated_at = who cancelled)

Fetching and computing are split: `_load_*` read Supabase, `compute_*` are pure
functions over plain row dicts so they can be checked without a database.
Results are cached for a minute per filter so refreshing the page stays cheap.
"""

from __future__ import annotations

import re
import threading
import time
from collections import Counter, defaultdict
from datetime import date as date_cls, datetime, timedelta, timezone
from typing import Callable, Iterable, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query, Request

from .app_context import log, settings
from .profiles import _read_user_profile, _request_identity

router = APIRouter()

# user_activity.status values that mean the room really got booked.
SUCCESS_STATUSES = {"ok", "success", "ongoing", "finished"}
# A booking that went through and was cancelled later still counts as a booking.
BOOKED_STATUSES = SUCCESS_STATUSES | {"canceled"}
BOOKING_TYPES = ("instant", "scheduled", "scout")
# Written to user_activity.error_message when the room mailbox declines the
# invite (availability.py) — the room said no, not a system error.
ROOM_DECLINED = "room_declined"
# user_activity.note on a cancelled row -> who cancelled it. Anything else
# (canceled_unverified, or rows from before notes existed) is "unknown".
CANCEL_REASONS = {
    "canceled_by_user": "user",
    "canceled_outlook": "outlook",
    "room_auto_canceled": "auto",
}
CANCEL_KINDS = ("user", "outlook", "auto", "unknown")
RETENTION_MONTHS = 6
RECENT_ROWS = 10
SHAME_ROWS = 10
# Thread intents written by chat.py (TOOL_INTENT); "none" = thread with no intent yet.
# One period drives the whole page; charts split it by a granularity that makes
# sense for its length (see allowed_granularities).
GRANULARITIES = ("hour", "day", "week", "month", "year")
MAX_PERIOD_DAYS = 731
MAX_BUCKETS = 120
CHAT_INTENTS = ("book", "schedule", "scout", "update", "delete", "info", "none")

AVAILABILITY_WARN_MIN = 15
AVAILABILITY_DOWN_MIN = 30
TOKEN_POOL_WARN = 3
FAILURE_WARN_RATE = 0.1
# A pending booking whose start time passed this long ago never fired.
STUCK_PENDING_GRACE = timedelta(minutes=5)

_CACHE_TTL_SECONDS = 60
_PAGE = 1000
_MAX_ROWS = 50_000
_cache: dict[tuple, tuple[float, dict]] = {}
_cache_lock = threading.Lock()

Level = Literal["ok", "warn", "down"]


# --------------------------------------------------------------------------- #
# Access
# --------------------------------------------------------------------------- #
def _require_admin(request: Request) -> None:
    if not settings.supabase_enabled:
        raise HTTPException(503, "Supabase is not configured.")
    _, email = _request_identity(request)
    profile = _read_user_profile(None, email) if email else None
    if (profile or {}).get("role") != "admin":
        raise HTTPException(403, "Admin only.")


# --------------------------------------------------------------------------- #
# Time helpers
# --------------------------------------------------------------------------- #
_FRACTION_RE = re.compile(r"\.(\d+)")


def parse_ts(value: str | None) -> datetime | None:
    """Parse a PostgREST timestamptz (variable fraction digits, 'Z' or offset)."""
    if not value:
        return None
    text = value.replace("Z", "+00:00").replace(" ", "T", 1)
    text = _FRACTION_RE.sub(lambda m: "." + m.group(1)[:6].ljust(6, "0"), text, count=1)
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _week_start(day: date_cls) -> date_cls:
    return day - timedelta(days=day.weekday())


def _local_date(ts: datetime | None, tz: ZoneInfo) -> date_cls | None:
    return ts.astimezone(tz).date() if ts else None


def _local_start(day: str | None, start_time: str | None, tz: ZoneInfo) -> datetime | None:
    if not day or not start_time:
        return None
    try:
        hh, mm = start_time.split(":")[:2]
        return datetime.combine(date_cls.fromisoformat(day), datetime.min.time()).replace(
            hour=int(hh), minute=int(mm), tzinfo=tz
        )
    except ValueError:
        return None


def _rate(part: int, whole: int) -> float | None:
    return round(part / whole, 4) if whole else None


# --------------------------------------------------------------------------- #
# Pure computations
# --------------------------------------------------------------------------- #
def booking_outcome(row: dict) -> str:
    """success | canceled | failed | declined | pending for one user_activity row."""
    status = row.get("status")
    if status in SUCCESS_STATUSES:
        return "success"
    if status == "failed":
        return "declined" if row.get("error_message") == ROOM_DECLINED else "failed"
    return status or "unknown"


def cancel_kind(row: dict) -> str:
    return CANCEL_REASONS.get(row.get("note") or "", "unknown")


def scout_outcome(row: dict) -> str:
    """success | canceled_user | canceled_auto | active.

    Expiry also writes status "canceled" (room_scouts.py), so a cancel stamped at
    or after `expires_at` is the system's; one before it is the user stopping.
    Legacy "expired" / "failed" rows count as system cancels.
    """
    status = row.get("status")
    if status == "success":
        return "success"
    if status == "active":
        return "active"
    if status == "canceled":
        updated, expires = parse_ts(row.get("updated_at")), parse_ts(row.get("expires_at"))
        return "canceled_auto" if updated and expires and updated >= expires else "canceled_user"
    return "canceled_auto"


def compute_health(
    *,
    now: datetime,
    tz: ZoneInfo,
    availability_updated_at: str | None,
    token_rows: list[dict],
    activity_24h: list[dict],
    pending_rows: list[dict],
    profiles: dict[str, dict],
) -> dict:
    updated = parse_ts(availability_updated_at)
    age = round((now - updated).total_seconds() / 60, 1) if updated else None
    if age is None or age > AVAILABILITY_DOWN_MIN:
        availability_level: Level = "down"
    elif age > AVAILABILITY_WARN_MIN:
        availability_level = "warn"
    else:
        availability_level = "ok"

    by_status = Counter(row.get("status") for row in token_rows)
    errored = [row for row in token_rows if row.get("last_error")]
    errored.sort(key=lambda r: r.get("updated_at") or "", reverse=True)
    active = by_status.get("active", 0)
    pool_level: Level = "down" if active == 0 else "warn" if active < TOKEN_POOL_WARN else "ok"

    # A room declining the invite is the room's answer, not a system error.
    failed = sum(1 for row in activity_24h if booking_outcome(row) == "failed")
    total = len(activity_24h)
    failure_rate = _rate(failed, total)
    failure_level: Level = (
        "ok" if not failed else "down" if (failure_rate or 0) >= FAILURE_WARN_RATE else "warn"
    )

    stuck = []
    for row in pending_rows:
        start = _local_start(row.get("date"), row.get("start_time"), tz)
        if start and start < now - STUCK_PENDING_GRACE:
            stuck.append(_activity_view(row, profiles))
    stuck.sort(key=lambda r: r["createdAt"] or "", reverse=True)

    return {
        "availability": {"updatedAt": availability_updated_at, "ageMinutes": age, "level": availability_level},
        "tokenPool": {
            "active": active,
            "expired": by_status.get("expired", 0),
            "invalid": by_status.get("invalid", 0),
            "lastError": (
                {"error": errored[0]["last_error"], "at": errored[0].get("updated_at")} if errored else None
            ),
            "level": pool_level,
        },
        "failures24h": {"failed": failed, "total": total, "rate": failure_rate, "level": failure_level},
        "stuckPending": {"count": len(stuck), "rows": stuck[:RECENT_ROWS], "level": "down" if stuck else "ok"},
    }


def _activity_view(row: dict, profiles: dict[str, dict]) -> dict:
    return {
        "id": row.get("id"),
        "createdAt": row.get("created_at"),
        "email": (profiles.get(row.get("user_id") or "") or {}).get("email"),
        "room": row.get("room_name") or row.get("room_email"),
        "date": row.get("date"),
        "startTime": row.get("start_time"),
        "bookingType": row.get("booking_type"),
        "method": row.get("method"),
        "status": row.get("status"),
        "error": (row.get("error_message") or "")[:300] or None,
    }


def _minutes(hhmm: str | None) -> int | None:
    try:
        h, m = (hhmm or "").split(":")[:2]
        return int(h) * 60 + int(m)
    except ValueError:
        return None


def _hours_covered(start: str | None, end: str | None) -> list[int]:
    """Clock hours a [start, end) window touches: 09:30–11:00 → [9, 10].
    Without a usable end, just the start hour."""
    s, e = _minutes(start), _minutes(end)
    if s is None:
        return []
    if e is None or e <= s:
        return [s // 60]
    return list(range(s // 60, (e - 1) // 60 + 1))


def _month_start(day: date_cls) -> date_cls:
    return day.replace(day=1)


def _bucket_start(day: date_cls, granularity: str) -> date_cls:
    if granularity == "week":
        return _week_start(day)
    if granularity == "month":
        return _month_start(day)
    if granularity == "year":
        return date_cls(day.year, 1, 1)
    return day


def allowed_granularities(span_days: int) -> list[str]:
    """Granularities that give a readable chart for a period this long."""
    out = []
    if span_days <= 3:
        out.append("hour")
    if span_days <= 92:
        out.append("day")
    if 14 <= span_days:
        out.append("week")
    if 60 <= span_days:
        out.append("month")
    if 365 <= span_days:
        out.append("year")
    return out or ["day"]


def default_granularity(span_days: int) -> str:
    if span_days == 1:
        return "hour"
    return "day" if span_days <= 31 else "week" if span_days <= 92 else "month"


def _period_buckets(start: date_cls, end: date_cls, granularity: str) -> list[date_cls]:
    """Bucket starts covering [start, end]; the first may begin before `start`
    (a week or month already under way) and is clipped when counting."""
    out, b = [], _bucket_start(start, granularity)
    while b <= end:
        out.append(b)
        if granularity == "day":
            b += timedelta(days=1)
        elif granularity == "week":
            b += timedelta(weeks=1)
        elif granularity == "month":
            b = _add_months(b, 1)
        else:
            b = date_cls(b.year + 1, 1, 1)
    return out


def _bucket_key(ts: datetime, tz: ZoneInfo, granularity: str) -> str:
    """The bucket a timestamp falls in, as the string the API returns:
    "YYYY-MM-DDTHH:00" for hours, the bucket's first day otherwise."""
    local = ts.astimezone(tz)
    if granularity == "hour":
        return local.strftime("%Y-%m-%dT%H:00")
    return _bucket_start(local.date(), granularity).isoformat()


def _period_bucket_keys(
    start: date_cls, end: date_cls, granularity: str, until: datetime | None = None
) -> list[str]:
    """Bucket keys covering [start, end]. Hours after `until` (local "now") are
    left out, so today's chart stops at the current hour."""
    if granularity != "hour":
        return [b.isoformat() for b in _period_buckets(start, end, granularity)]
    keys, d = [], start
    while d <= end:
        for h in range(24):
            if until is not None and (d, h) > (until.date(), until.hour):
                return keys
            keys.append(f"{d.isoformat()}T{h:02d}:00")
        d += timedelta(days=1)
    return keys


def _add_months(month: date_cls, n: int) -> date_cls:
    index = month.year * 12 + month.month - 1 + n
    return date_cls(index // 12, index % 12 + 1, 1)


def compute_overview(
    *,
    now: datetime,
    tz: ZoneInfo,
    start: date_cls,
    end: date_cls,
    granularity: str,
    office: str | None,
    profiles: dict[str, dict],
    rooms: list[dict],
    activity: list[dict],
    history: list[dict],
    threads: list[dict],
    scouts: list[dict],
    feedback_messages: list[dict],
) -> dict:
    """Everything on the dashboard except health.

    The period is [start, end] (local dates); it is compared with the period of
    the same length right before it. `activity` / `threads` / `scouts` /
    `feedback_messages` must cover both. `history` (every non-pending
    user_activity row, all time, light columns) feeds monthly retention, which
    always covers the last RETENTION_MONTHS months whatever the period.
    This function does all the windowing.
    """
    today = now.astimezone(tz).date()
    range_start, range_end = start, end
    span = (end - start).days + 1
    prev_end = start - timedelta(days=1)
    prev_start = start - timedelta(days=span)
    buckets = _period_bucket_keys(start, end, granularity, until=now.astimezone(tz))
    this_month = _month_start(today)

    room_office = {(r.get("email") or "").lower(): r.get("office") for r in rooms}

    def user_ok(user_id: str | None) -> bool:
        return not office or (profiles.get(user_id or "") or {}).get("office") == office

    def room_ok(room_email: str | None) -> bool:
        return not office or room_office.get((room_email or "").lower()) == office

    def day_of(row: dict) -> date_cls | None:
        return _local_date(parse_ts(row.get("created_at")), tz)

    def key_of(row: dict) -> str | None:
        ts = parse_ts(row.get("created_at"))
        return _bucket_key(ts, tz, granularity) if ts else None

    activity = [r for r in activity if room_ok(r.get("room_email"))]
    history = [r for r in history if room_ok(r.get("room_email"))]
    threads = [r for r in threads if user_ok(r.get("user_id"))]
    scouts = [r for r in scouts if not office or r.get("office") == office]

    def in_range(day: date_cls | None, start: date_cls, end: date_cls) -> bool:
        return day is not None and start <= day <= end

    cur = [r for r in activity if in_range(day_of(r), range_start, range_end)]
    prev = [r for r in activity if in_range(day_of(r), prev_start, prev_end)]

    def booked(rows: Iterable[dict]) -> list[dict]:
        return [r for r in rows if r.get("status") in BOOKED_STATUSES]

    def success_rate(rows: list[dict]) -> float | None:
        # Cancelled bookings went through, so they count as successes; room
        # declines are left out on both sides (see booking_outcome).
        ok = len(booked(rows))
        return _rate(ok, ok + sum(1 for r in rows if booking_outcome(r) == "failed"))

    def active_users(start: date_cls, end: date_cls) -> int:
        ids = set()
        for rows in (activity, threads, scouts):
            for r in rows:
                if r.get("user_id") and in_range(day_of(r), start, end) and user_ok(r.get("user_id")):
                    ids.add(r["user_id"])
        return len(ids)

    def scout_rate(rows: list[dict]) -> float | None:
        outcomes = Counter(scout_outcome(r) for r in rows)
        return _rate(outcomes.get("success", 0), len(rows) - outcomes.get("active", 0))

    # Sparklines: one point per bucket (rows are already limited to the period,
    # so a week or month that started before it only counts its in-period part).
    by_bucket: dict[str, list[dict]] = defaultdict(list)
    scouts_by_bucket: dict[str, list[dict]] = defaultdict(list)
    users_by_bucket: dict[str, set[str]] = defaultdict(set)
    for r in cur:
        by_bucket[key_of(r) or ""].append(r)
    scouts_in = [r for r in scouts if in_range(day_of(r), range_start, range_end)]
    for r in scouts_in:
        scouts_by_bucket[key_of(r) or ""].append(r)
    for rows in (activity, threads, scouts):
        for r in rows:
            if r.get("user_id") and user_ok(r.get("user_id")) and in_range(day_of(r), range_start, range_end):
                users_by_bucket[key_of(r) or ""].add(r["user_id"])

    kpis = {
        "activeUsers": {
            "value": active_users(range_start, range_end),
            "prev": active_users(prev_start, prev_end),
            "series": [len(users_by_bucket.get(b, ())) for b in buckets],
        },
        "bookings": {
            "value": len(booked(cur)),
            "prev": len(booked(prev)),
            "series": [len(booked(by_bucket.get(b, []))) for b in buckets],
        },
        "successRate": {
            "value": success_rate(cur),
            "prev": success_rate(prev),
            "series": [success_rate(by_bucket.get(b, [])) for b in buckets],
        },
        "scoutSuccess": {
            "value": scout_rate(scouts_in),
            "prev": scout_rate([r for r in scouts if in_range(day_of(r), prev_start, prev_end)]),
            "series": [scout_rate(scouts_by_bucket.get(b, [])) for b in buckets],
        },
    }

    # Bookings in the range: what happened to them, and per day (successes above
    # the axis by type, cancellations below it by who cancelled).
    outcomes = Counter(booking_outcome(r) for r in cur)
    cancels = Counter(cancel_kind(r) for r in cur if booking_outcome(r) == "canceled")
    declined_scout = sum(1 for r in cur if booking_outcome(r) == "declined" and r.get("booking_type") == "scout")

    # Hall of shame: who books and then lets Outlook auto-release the room
    # (no check-in) most often in the range.
    auto_by_user: Counter = Counter()
    booked_by_user: Counter = Counter()
    for r in booked(cur):
        user_id = r.get("user_id")
        if not user_id:
            continue
        booked_by_user[user_id] += 1
        if booking_outcome(r) == "canceled" and cancel_kind(r) == "auto":
            auto_by_user[user_id] += 1
    shame = sorted(
        auto_by_user.items(),
        key=lambda item: (-item[1], -(item[1] / booked_by_user[item[0]]), item[0]),
    )[:SHAME_ROWS]
    hall_of_shame = [
        {
            "email": (profiles.get(user_id) or {}).get("email"),
            "autoCanceled": count,
            "booked": booked_by_user[user_id],
            "rate": _rate(count, booked_by_user[user_id]),
        }
        for user_id, count in shame
    ]

    # Users.
    scoped_profiles = [p for p in profiles.values() if not office or p.get("office") == office]

    # Monthly cohorts: users grouped by the month of their first booking; cell k
    # is the share of the cohort that booked in month M+k (k=0 is 100%).
    booked_months: dict[str, set[date_cls]] = defaultdict(set)
    first_month: dict[str, date_cls] = {}
    for r in sorted(booked(history), key=lambda r: r.get("created_at") or ""):
        user_id, d = r.get("user_id"), day_of(r)
        if not user_id or not d or not user_ok(user_id):
            continue
        month = _month_start(d)
        booked_months[user_id].add(month)
        first_month.setdefault(user_id, month)
    cohorts: dict[date_cls, list[str]] = defaultdict(list)
    for user_id, month in first_month.items():
        cohorts[month].append(user_id)
    retention = []
    for i in range(RETENTION_MONTHS - 1, -1, -1):
        month = _add_months(this_month, -i)
        members = cohorts.get(month, [])
        cells = []
        for k in range(1, RETENTION_MONTHS):
            target = _add_months(month, k)
            if target > this_month:
                cells.append(None)
                continue
            returned = sum(1 for u in members if target in booked_months[u])
            cells.append({"returned": returned, "rate": _rate(returned, len(members)), "partial": target == this_month})
        done = [c for c in cells if c and not c["partial"]]
        retention.append(
            {
                "month": month.isoformat(),
                "cohort": len(members),
                "cells": cells,
                # Mean over the finished months only; a running month would drag it down.
                "avg": _rate(sum(c["returned"] for c in done), len(members) * len(done)),
            }
        )
    # All users: per column, cohorts pooled (weighted by size), finished months only.
    all_cells = []
    for k in range(RETENTION_MONTHS - 1):
        pool = [(r["cells"][k]["returned"], r["cohort"]) for r in retention
                if r["cohort"] and r["cells"][k] and not r["cells"][k]["partial"]]
        returned, size = sum(p[0] for p in pool), sum(p[1] for p in pool)
        all_cells.append({"returned": returned, "users": size, "rate": _rate(returned, size)} if pool else None)
    pooled = [c for c in all_cells if c]
    retention_all = {
        "cohort": sum(r["cohort"] for r in retention),
        "cells": all_cells,
        "avg": _rate(sum(c["returned"] for c in pooled), sum(c["users"] for c in pooled)),
    }

    # Chatbot.
    convs_in_range = sum(1 for r in threads if in_range(day_of(r), range_start, range_end))
    chat_bookings = sum(1 for r in booked(cur) if r.get("method") == "chatbot")
    fb = [m for m in feedback_messages if user_ok(m.get("to_user_id")) and in_range(day_of(m), range_start, range_end)]
    intents = Counter(
        (r.get("intent") if r.get("intent") in CHAT_INTENTS else "none")
        for r in threads
        if in_range(day_of(r), range_start, range_end)
    )
    negatives = sorted((m for m in fb if m.get("feedback") == "negative"), key=lambda m: m.get("created_at") or "", reverse=True)

    # Room Scout: every scout that ended without a room counts against it.
    scouts_cur = scouts_in
    scout_outcomes = Counter(scout_outcome(r) for r in scouts_cur)
    scout_finished = len(scouts_cur) - scout_outcomes.get("active", 0)
    size_demand, size_unmet, hour_demand = Counter(), Counter(), Counter()
    for r in scouts_cur:
        outcome = scout_outcome(r)
        sizes = r.get("capacity_sizes") or ([r["capacity_size"]] if r.get("capacity_size") else ["any"])
        for size in sizes:
            size_demand[size] += 1
            if outcome in ("canceled_user", "canceled_auto"):
                size_unmet[size] += 1
        for hour in _hours_covered(r.get("scout_start_time"), r.get("scout_end_time")):
            hour_demand[hour] += 1
    # Rooms that declined a scout's booking before it finally got one.
    found = [r for r in scouts_cur if scout_outcome(r) == "success"]
    declines = [len(r.get("declined_attempts") or []) for r in found]

    # Trend charts: the period split by the chosen granularity.
    counters = {b: Counter() for b in buckets}
    for r in cur:
        c = counters.get(key_of(r) or "")
        if c is None:
            continue
        outcome = booking_outcome(r)
        if outcome == "success":
            c[r.get("booking_type") or "instant"] += 1
        elif outcome == "canceled":
            kind = cancel_kind(r)
            c[f"cancel_{kind}"] += 1
            # Cancels with a known cause still went through: the overview chart
            # adds them back onto their booking type. "unknown" counts as a fail.
            if kind != "unknown":
                c[f"canceled_type_{r.get('booking_type') or 'instant'}"] += 1
        elif outcome == "declined":
            c["declined"] += 1
    for p in scoped_profiles:
        if in_range(day_of(p), range_start, range_end) and key_of(p) in counters:
            counters[key_of(p)]["new_users"] += 1  # type: ignore[index]
    for r in scouts_cur:
        outcome = scout_outcome(r)
        if outcome != "active" and key_of(r) in counters:
            counters[key_of(r)][f"scout_{outcome}"] += 1  # type: ignore[index]
    trend = [
        {
            "start": b,
            "success": {t: counters[b].get(t, 0) for t in BOOKING_TYPES},
            "canceled": {k: counters[b].get(f"cancel_{k}", 0) for k in CANCEL_KINDS},
            # Cancelled by user / Outlook / auto, split by booking type ("unknown" excluded).
            "canceledByType": {t: counters[b].get(f"canceled_type_{t}", 0) for t in BOOKING_TYPES},
            "declined": counters[b].get("declined", 0),
            "newUsers": counters[b].get("new_users", 0),
            "scouts": {
                "success": counters[b].get("scout_success", 0),
                "canceledUser": counters[b].get("scout_canceled_user", 0),
                "canceledAuto": counters[b].get("scout_canceled_auto", 0),
            },
        }
        for b in buckets
    ]

    return {
        "range": {
            "start": range_start.isoformat(),
            "end": range_end.isoformat(),
            "days": span,
            "prevStart": prev_start.isoformat(),
            "prevEnd": prev_end.isoformat(),
            "granularity": granularity,
            "granularities": allowed_granularities(span),
            # The last bucket is still filling up when the period reaches today.
            "lastPartial": range_end >= today,
        },
        "kpis": kpis,
        "buckets": buckets,
        "bookingOutcomes": {
            "success": outcomes.get("success", 0),
            "canceled": {"total": outcomes.get("canceled", 0), **{k: cancels.get(k, 0) for k in CANCEL_KINDS}},
            "failed": outcomes.get("failed", 0),
            "declined": outcomes.get("declined", 0),
            "declinedScout": declined_scout,
        },
        "trend": trend,
        "hallOfShame": hall_of_shame,
        "users": {
            "total": len(scoped_profiles),
            "retention": retention,
            "retentionAll": retention_all,
        },
        "chatbot": {
            "conversations": convs_in_range,
            "chatbotBookings": chat_bookings,
            "rate": _rate(chat_bookings, convs_in_range),
            "intents": [{"intent": i, "count": intents.get(i, 0)} for i in CHAT_INTENTS],
            "feedback": {
                "positive": sum(1 for m in fb if m.get("feedback") == "positive"),
                "negative": len(negatives),
            },
            "recentNegative": [
                {
                    "at": m.get("created_at"),
                    "email": (profiles.get(m.get("to_user_id") or "") or {}).get("email"),
                    "content": _strip_think(m.get("content") or "")[:400],
                }
                for m in negatives[:RECENT_ROWS]
            ],
        },
        "scouts": {
            "total": len(scouts_cur),
            "outcomes": {k: scout_outcomes.get(k, 0) for k in ("success", "canceled_user", "canceled_auto", "active")},
            "successRate": _rate(scout_outcomes.get("success", 0), scout_finished),
            "declinesBeforeFound": {
                "avg": round(sum(declines) / len(declines), 2) if declines else None,
                "max": max(declines, default=0),
                "withDeclines": sum(1 for n in declines if n),
                "found": len(found),
            },
            "demandBySize": [{"size": s, "count": c, "unmet": size_unmet.get(s, 0)} for s, c in size_demand.most_common()],
            "demandByHour": [{"hour": h, "count": hour_demand.get(h, 0)} for h in range(7, 21)],
        },
        "recentFailures": [
            _activity_view(r, profiles)
            for r in sorted(
                (r for r in cur if booking_outcome(r) == "failed"),
                key=lambda r: r.get("created_at") or "",
                reverse=True,
            )[:RECENT_ROWS]
        ],
        "offices": sorted({r.get("office") for r in rooms if r.get("office")}),
    }


_THINK_RE = re.compile(r"<think>.*?(</think>|$)", re.S)


def _strip_think(text: str) -> str:
    return _THINK_RE.sub("", text).strip()


# --------------------------------------------------------------------------- #
# Supabase reads
# --------------------------------------------------------------------------- #
def _sb():
    from .supabase_client import get_supabase

    return get_supabase()


def _fetch_all(build: Callable[[], object]) -> list[dict]:
    """Page through a PostgREST select (it caps a response at 1000 rows)."""
    rows: list[dict] = []
    start = 0
    while True:
        batch = build().range(start, start + _PAGE - 1).execute().data or []  # type: ignore[attr-defined]
        rows.extend(batch)
        if len(batch) < _PAGE or len(rows) >= _MAX_ROWS:
            return rows
        start += _PAGE


def _load_profiles() -> dict[str, dict]:
    rows = _fetch_all(lambda: _sb().table("user_profiles").select("id, email, office, created_at").order("created_at"))
    return {r["id"]: r for r in rows}


def _load_rooms() -> list[dict]:
    return _fetch_all(lambda: _sb().table("meeting_room_metadata").select("email, office").order("email"))


_ACTIVITY_COLUMNS = (
    "id, user_id, room_email, room_name, date, start_time, booking_type, method, status, "
    "error_message, note, created_at"
)


def _cached(key: tuple, build: Callable[[], dict]) -> dict:
    with _cache_lock:
        hit = _cache.get(key)
        if hit and time.monotonic() - hit[0] < _CACHE_TTL_SECONDS:
            return hit[1]
    payload = build()
    with _cache_lock:
        _cache[key] = (time.monotonic(), payload)
    return payload


def _local_midnight_iso(day: date_cls, tz: ZoneInfo) -> str:
    return datetime(day.year, day.month, day.day, tzinfo=tz).isoformat()


def _build_overview(start: date_cls, end: date_cls, granularity: str, office: str | None) -> dict:
    tz = ZoneInfo(settings.timezone)
    now = datetime.now(timezone.utc)
    # The period plus the equally long one before it, for the comparison.
    span = (end - start).days + 1
    since = _local_midnight_iso(start - timedelta(days=span), tz)
    until = _local_midnight_iso(end + timedelta(days=1), tz)
    sb = _sb()

    profiles = _load_profiles()
    rooms = _load_rooms()
    activity = _fetch_all(
        lambda: sb.table("user_activity")
        .select(_ACTIVITY_COLUMNS)
        .gte("created_at", since)
        .lt("created_at", until)
        .order("created_at")
    )
    # All time, light columns: a user's first booking (their cohort) and the
    # last RETENTION_MONTHS months both reach past the period.
    history = _fetch_all(
        lambda: sb.table("user_activity")
        .select("user_id, room_email, booking_type, status, note, error_message, created_at")
        .neq("status", "pending")
        .order("created_at")
    )
    threads = _fetch_all(
        lambda: sb.table("thread")
        .select("id, user_id, intent, created_at")
        .gte("created_at", since)
        .lt("created_at", until)
        .order("created_at")
    )
    scouts = _fetch_all(
        lambda: sb.table("room_scouts")
        .select(
            "id, user_id, office, status, capacity_size, capacity_sizes, scout_start_time, scout_end_time, "
            "expires_at, updated_at, declined_attempts, created_at"
        )
        .gte("created_at", since)
        .lt("created_at", until)
        .order("created_at")
    )
    feedback = _fetch_all(
        lambda: sb.table("messages")
        .select("id, to_user_id, content, feedback, created_at")
        .not_.is_("feedback", "null")
        .gte("created_at", _local_midnight_iso(start, tz))
        .lt("created_at", until)
        .order("created_at")
    )

    availability_row = (
        sb.table("room_availability").select("updated_at").order("updated_at", desc=True).limit(1).execute().data
    )
    tokens = _fetch_all(lambda: sb.table("graph_token_pool").select("status, last_error, updated_at"))
    # Health is "right now", whatever the period: its own 24h read.
    since_24h = now - timedelta(days=1)
    activity_24h = _fetch_all(
        lambda: sb.table("user_activity")
        .select(_ACTIVITY_COLUMNS)
        .gte("created_at", since_24h.isoformat())
        .order("created_at")
    )
    pending = _fetch_all(
        lambda: sb.table("user_activity").select(_ACTIVITY_COLUMNS).eq("status", "pending").order("created_at")
    )

    overview = compute_overview(
        now=now,
        tz=tz,
        start=start,
        end=end,
        granularity=granularity,
        office=office,
        profiles=profiles,
        rooms=rooms,
        activity=activity,
        history=history,
        threads=threads,
        scouts=scouts,
        feedback_messages=feedback,
    )
    # Health is system-wide: never filtered by office.
    overview["health"] = compute_health(
        now=now,
        tz=tz,
        availability_updated_at=(availability_row or [{}])[0].get("updated_at"),
        token_rows=tokens,
        activity_24h=activity_24h,
        pending_rows=pending,
        profiles=profiles,
    )
    overview["generatedAt"] = now.isoformat()
    return overview


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@router.get("/api/admin/me")
def admin_me(request: Request):
    """Lets the page tell 'not signed in' (401) from 'not an admin' (403)."""
    _require_admin(request)
    return {"isAdmin": True}


@router.get("/api/admin/overview")
def admin_overview(
    request: Request,
    date_from: date_cls | None = Query(None, alias="from"),
    date_to: date_cls | None = Query(None, alias="to"),
    gran: str | None = Query(None, pattern="^(hour|day|week|month|year)$"),
    office: str | None = Query(None, max_length=64),
):
    """Dashboard for the period [from, to] (local dates, default: the last 30
    days), split into `gran` buckets (default: picked from the period length)."""
    _require_admin(request)
    office = office or None
    today = datetime.now(ZoneInfo(settings.timezone)).date()
    end = min(date_to or today, today)
    start = date_from or end - timedelta(days=29)
    if start > end:
        raise HTTPException(400, "`from` must be on or before `to`")
    span = (end - start).days + 1
    if span > MAX_PERIOD_DAYS:
        raise HTTPException(400, f"Period is limited to {MAX_PERIOD_DAYS} days")
    granularity = gran or default_granularity(span)
    if granularity not in allowed_granularities(span):
        raise HTTPException(400, f"`{granularity}` does not fit a {span}-day period")
    if len(_period_bucket_keys(start, end, granularity)) > MAX_BUCKETS:
        raise HTTPException(400, f"Too many {granularity} buckets for this period; pick a coarser one")
    key = ("overview", start, end, granularity, office)
    try:
        return _cached(key, lambda: _build_overview(start, end, granularity, office))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 - surface a clean 502 to the page
        log.exception("admin overview failed")
        raise HTTPException(502, f"Could not load dashboard data: {e}") from e
