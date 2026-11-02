"""Admin dashboard (/admin): system health, usage, room demand, chatbot & Room Scout.

Only profiles with `user_profiles.role = 'admin'` may call these endpoints.
Everything is computed from tables the app already writes — no extra tracking:

- health:   room_availability.updated_at, graph_token_pool, user_activity status
- usage:    user_profiles, user_activity / thread / room_scouts (who did something)
- rooms:    user_activity per room, room_availability slots (today .. +14 days only:
            past days are deleted by availability.py, so there's no history yet)
- chatbot:  thread, messages.feedback, room_scouts

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
BOOKING_TYPES = ("instant", "scheduled", "scout")
SPARK_WEEKS = 8
TOP_ROOMS = 10
RECENT_ROWS = 10
# Working hours shown on the heatmap: 08:00 .. 17:59.
HEAT_HOURS = list(range(8, 18))
SLOTS_PER_HOUR = 4

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

    failed = sum(1 for row in activity_24h if row.get("status") == "failed")
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


def compute_overview(
    *,
    now: datetime,
    tz: ZoneInfo,
    days: int,
    office: str | None,
    profiles: dict[str, dict],
    rooms: list[dict],
    activity: list[dict],
    first_booking_by_user: dict[str, datetime],
    threads: list[dict],
    scouts: list[dict],
    feedback_messages: list[dict],
    bot_links: int,
    revocations: list[dict],
) -> dict:
    """Everything on the dashboard except health and the heatmap.

    `activity` / `threads` / `scouts` must cover at least the previous range and
    SPARK_WEEKS weeks back; this function does all the windowing.
    """
    today = now.astimezone(tz).date()
    range_start = today - timedelta(days=days - 1)
    prev_start = range_start - timedelta(days=days)
    this_week = _week_start(today)
    weeks = [this_week - timedelta(weeks=i) for i in range(SPARK_WEEKS - 1, -1, -1)]

    room_office = {(r.get("email") or "").lower(): r.get("office") for r in rooms}

    def user_ok(user_id: str | None) -> bool:
        return not office or (profiles.get(user_id or "") or {}).get("office") == office

    def room_ok(room_email: str | None) -> bool:
        return not office or room_office.get((room_email or "").lower()) == office

    def day_of(row: dict) -> date_cls | None:
        return _local_date(parse_ts(row.get("created_at")), tz)

    activity = [r for r in activity if room_ok(r.get("room_email"))]
    threads = [r for r in threads if user_ok(r.get("user_id"))]
    scouts = [r for r in scouts if not office or r.get("office") == office]

    def in_range(day: date_cls | None, start: date_cls, end: date_cls) -> bool:
        return day is not None and start <= day <= end

    cur = [r for r in activity if in_range(day_of(r), range_start, today)]
    prev = [r for r in activity if in_range(day_of(r), prev_start, range_start - timedelta(days=1))]

    def booked(rows: Iterable[dict]) -> list[dict]:
        return [r for r in rows if r.get("status") in SUCCESS_STATUSES]

    def success_rate(rows: list[dict]) -> float | None:
        ok = len(booked(rows))
        return _rate(ok, ok + sum(1 for r in rows if r.get("status") == "failed"))

    def active_users(start: date_cls, end: date_cls) -> int:
        ids = set()
        for rows in (activity, threads, scouts):
            for r in rows:
                if r.get("user_id") and in_range(day_of(r), start, end) and user_ok(r.get("user_id")):
                    ids.add(r["user_id"])
        return len(ids)

    def chat_to_booking(start: date_cls, end: date_cls) -> float | None:
        convs = sum(1 for r in threads if in_range(day_of(r), start, end))
        chat_bookings = sum(
            1 for r in booked(activity) if r.get("method") == "chatbot" and in_range(day_of(r), start, end)
        )
        return _rate(chat_bookings, convs)

    # Weekly sparklines (Mon..Sun, last SPARK_WEEKS weeks; the current week is partial).
    week_rows: dict[date_cls, list[dict]] = defaultdict(list)
    for r in activity:
        d = day_of(r)
        if d and d >= weeks[0]:
            week_rows[_week_start(d)].append(r)

    def week_end(week: date_cls) -> date_cls:
        return min(week + timedelta(days=6), today)

    kpis = {
        "activeUsers": {
            "value": active_users(range_start, today),
            "prev": active_users(prev_start, range_start - timedelta(days=1)),
            "series": [active_users(w, week_end(w)) for w in weeks],
        },
        "bookings": {
            "value": len(booked(cur)),
            "prev": len(booked(prev)),
            "series": [len(booked(week_rows.get(w, []))) for w in weeks],
        },
        "successRate": {
            "value": success_rate(cur),
            "prev": success_rate(prev),
            "series": [success_rate(week_rows.get(w, [])) for w in weeks],
        },
        "chatToBooking": {
            "value": chat_to_booking(range_start, today),
            "prev": chat_to_booking(prev_start, range_start - timedelta(days=1)),
            "series": [chat_to_booking(w, week_end(w)) for w in weeks],
        },
    }

    # Bookings per day, stacked by type (successful bookings only).
    per_day: dict[date_cls, Counter] = {range_start + timedelta(days=i): Counter() for i in range(days)}
    for r in booked(cur):
        d = day_of(r)
        if d in per_day:
            per_day[d][r.get("booking_type") or "instant"] += 1
    bookings_by_day = [
        {"date": d.isoformat(), **{t: c.get(t, 0) for t in BOOKING_TYPES}} for d, c in sorted(per_day.items())
    ]

    status_counts = Counter()
    for r in cur:
        s = r.get("status")
        status_counts["success" if s in SUCCESS_STATUSES else s or "unknown"] += 1
    methods = Counter(r.get("method") or "manual" for r in booked(cur))

    # Rooms: most and least booked among rooms in use.
    per_room = Counter((r.get("room_email") or "").lower() for r in booked(cur))
    room_rows = [
        {"name": r.get("name") or r.get("email"), "office": r.get("office"), "count": per_room.get((r.get("email") or "").lower(), 0)}
        for r in rooms
        if r.get("in_use", True) and (not office or r.get("office") == office)
    ]
    top_rooms = sorted((r for r in room_rows if r["count"]), key=lambda r: (-r["count"], r["name"] or ""))[:TOP_ROOMS]
    least_rooms = sorted(room_rows, key=lambda r: (r["count"], r["name"] or ""))[:TOP_ROOMS]

    # Users.
    scoped_profiles = [p for p in profiles.values() if not office or p.get("office") == office]
    new_by_week = Counter()
    for p in scoped_profiles:
        d = _local_date(parse_ts(p.get("created_at")), tz)
        if d and d >= weeks[0]:
            new_by_week[_week_start(d)] += 1

    # Retention: users whose first successful booking was in week W — how many
    # booked again in W+1. Only full weeks with a finished follow-up week.
    booked_weeks: dict[str, set[date_cls]] = defaultdict(set)
    for r in booked(activity):
        d = day_of(r)
        if d and r.get("user_id"):
            booked_weeks[r["user_id"]].add(_week_start(d))
    cohorts: dict[date_cls, list[str]] = defaultdict(list)
    for user_id, first in first_booking_by_user.items():
        if not user_ok(user_id):
            continue
        week = _week_start(first.astimezone(tz).date())
        cohorts[week].append(user_id)
    retention = []
    for w in weeks[:-1]:
        members = cohorts.get(w, [])
        nxt = w + timedelta(weeks=1)
        retention.append(
            {
                "week": w.isoformat(),
                "cohort": len(members),
                "returned": sum(1 for u in members if nxt in booked_weeks.get(u, set())),
                "partial": nxt == this_week,
            }
        )

    by_office = Counter((p.get("office") or "") for p in profiles.values())

    # Chatbot.
    convs_in_range = sum(1 for r in threads if in_range(day_of(r), range_start, today))
    chat_bookings = sum(1 for r in booked(cur) if r.get("method") == "chatbot")
    fb = [m for m in feedback_messages if user_ok(m.get("to_user_id")) and in_range(day_of(m), range_start, today)]
    negatives = sorted((m for m in fb if m.get("feedback") == "negative"), key=lambda m: m.get("created_at") or "", reverse=True)

    # Room Scout.
    scouts_cur = [r for r in scouts if in_range(day_of(r), range_start, today)]
    scout_status = Counter(r.get("status") for r in scouts_cur)
    finished = sum(scout_status.get(s, 0) for s in ("success", "expired", "failed"))
    size_demand, size_unmet, hour_demand = Counter(), Counter(), Counter()
    for r in scouts_cur:
        sizes = r.get("capacity_sizes") or ([r["capacity_size"]] if r.get("capacity_size") else ["any"])
        for size in sizes:
            size_demand[size] += 1
            if r.get("status") in ("expired", "failed"):
                size_unmet[size] += 1
        start = r.get("scout_start_time") or ""
        if ":" in start:
            hour_demand[int(start.split(":")[0])] += 1

    return {
        "range": {"days": days, "start": range_start.isoformat(), "end": today.isoformat()},
        "kpis": kpis,
        "weeks": [w.isoformat() for w in weeks],
        "bookingsByDay": bookings_by_day,
        "statusCounts": {k: status_counts.get(k, 0) for k in ("success", "failed", "canceled", "pending")},
        "methods": {"manual": methods.get("manual", 0), "chatbot": methods.get("chatbot", 0)},
        "topRooms": top_rooms,
        "leastRooms": least_rooms,
        "users": {
            "total": len(scoped_profiles),
            "newByWeek": [new_by_week[w] for w in weeks],
            "retention": retention,
            "byOffice": [{"office": o or None, "count": c} for o, c in by_office.most_common()],
            "zaloLinked": sum(1 for p in scoped_profiles if p.get("zalo_user_id")),
            "botLinks": bot_links,
            "revocations": sum(1 for r in revocations if in_range(_local_date(parse_ts(r.get("received_at")), tz), range_start, today)),
        },
        "chatbot": {
            "conversations": convs_in_range,
            "chatbotBookings": chat_bookings,
            "rate": _rate(chat_bookings, convs_in_range),
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
            "byStatus": dict(scout_status),
            "successRate": _rate(scout_status.get("success", 0), finished),
            "demandBySize": [{"size": s, "count": c, "unmet": size_unmet.get(s, 0)} for s, c in size_demand.most_common()],
            "demandByHour": [{"hour": h, "count": hour_demand.get(h, 0)} for h in range(7, 21)],
        },
        "recentFailures": [
            _activity_view(r, profiles)
            for r in sorted(
                (r for r in cur if r.get("status") == "failed"), key=lambda r: r.get("created_at") or "", reverse=True
            )[:RECENT_ROWS]
        ],
        "offices": sorted({r.get("office") for r in rooms if r.get("office")}),
    }


_THINK_RE = re.compile(r"<think>.*?(</think>|$)", re.S)


def _strip_think(text: str) -> str:
    return _THINK_RE.sub("", text).strip()


def compute_heatmap(
    *, availability: list[dict], rooms: list[dict], office: str | None, size: str | None
) -> dict:
    """Busy share per (date, working hour) and per room, over the cached window."""
    meta = {
        r["id"]: r
        for r in rooms
        if r.get("in_use", True)
        and (not office or r.get("office") == office)
        and (not size or r.get("capacity_size") == size)
    }
    cells: dict[str, list[list[int]]] = {}
    per_room: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for row in availability:
        room = meta.get(row.get("room_id"))
        slots = row.get("slots") or []
        if not room or len(slots) < 96:
            continue
        day = cells.setdefault(row["date"], [[0, 0] for _ in HEAT_HOURS])
        for i, hour in enumerate(HEAT_HOURS):
            hour_slots = slots[hour * SLOTS_PER_HOUR : (hour + 1) * SLOTS_PER_HOUR]
            busy = sum(1 for s in hour_slots if s)
            day[i][0] += busy
            day[i][1] += len(hour_slots)
            per_room[room["id"]][0] += busy
            per_room[room["id"]][1] += len(hour_slots)

    days = []
    for d in sorted(cells):
        parsed = date_cls.fromisoformat(d)
        if parsed.weekday() >= 5:
            continue  # weekends are empty by design and would dilute the scale
        days.append({"date": d, "weekday": parsed.weekday(), "cells": [_rate(b, t) for b, t in cells[d]]})

    room_rows = sorted(
        (
            {
                "name": meta[rid].get("name"),
                "office": meta[rid].get("office"),
                "size": meta[rid].get("capacity_size"),
                "busy": _rate(b, t),
            }
            for rid, (b, t) in per_room.items()
        ),
        key=lambda r: -(r["busy"] or 0),
    )
    return {"hours": HEAT_HOURS, "days": days, "rooms": room_rows, "roomCount": len(meta)}


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
    rows = _fetch_all(
        lambda: _sb().table("user_profiles").select("id, email, office, zalo_user_id, created_at").order("created_at")
    )
    return {r["id"]: r for r in rows}


def _load_rooms() -> list[dict]:
    return _fetch_all(
        lambda: _sb().table("meeting_room_metadata").select("id, name, email, office, capacity_size, in_use").order("name")
    )


_ACTIVITY_COLUMNS = (
    "id, user_id, room_email, room_name, date, start_time, booking_type, method, status, error_message, created_at"
)


def _cutoff_iso(now: datetime, days: int) -> str:
    return (now - timedelta(days=days)).isoformat()


def _cached(key: tuple, build: Callable[[], dict]) -> dict:
    with _cache_lock:
        hit = _cache.get(key)
        if hit and time.monotonic() - hit[0] < _CACHE_TTL_SECONDS:
            return hit[1]
    payload = build()
    with _cache_lock:
        _cache[key] = (time.monotonic(), payload)
    return payload


def _build_overview(days: int, office: str | None) -> dict:
    tz = ZoneInfo(settings.timezone)
    now = datetime.now(timezone.utc)
    # Enough history for the previous range and the weekly sparklines.
    lookback = max(days * 2, SPARK_WEEKS * 7 + 7) + 1
    since = _cutoff_iso(now, lookback)
    sb = _sb()

    profiles = _load_profiles()
    rooms = _load_rooms()
    activity = _fetch_all(
        lambda: sb.table("user_activity").select(_ACTIVITY_COLUMNS).gte("created_at", since).order("created_at")
    )
    first_booking: dict[str, datetime] = {}
    for r in _fetch_all(
        lambda: sb.table("user_activity")
        .select("user_id, created_at")
        .in_("status", sorted(SUCCESS_STATUSES))
        .order("created_at")
    ):
        ts = parse_ts(r.get("created_at"))
        if r.get("user_id") and ts and r["user_id"] not in first_booking:
            first_booking[r["user_id"]] = ts
    threads = _fetch_all(
        lambda: sb.table("thread").select("id, user_id, created_at").gte("created_at", since).order("created_at")
    )
    scouts = _fetch_all(
        lambda: sb.table("room_scouts")
        .select("id, user_id, office, status, capacity_size, capacity_sizes, scout_start_time, created_at")
        .gte("created_at", since)
        .order("created_at")
    )
    feedback = _fetch_all(
        lambda: sb.table("messages")
        .select("id, to_user_id, content, feedback, created_at")
        .not_.is_("feedback", "null")
        .gte("created_at", _cutoff_iso(now, days + 1))
        .order("created_at")
    )
    bot_links = sb.table("bot_links").select("chat_id", count="exact").limit(1).execute().count or 0
    revocations = _fetch_all(
        lambda: sb.table("zalo_data_revocations").select("received_at").gte("received_at", _cutoff_iso(now, days + 1))
    )

    availability_row = (
        sb.table("room_availability").select("updated_at").order("updated_at", desc=True).limit(1).execute().data
    )
    tokens = _fetch_all(lambda: sb.table("graph_token_pool").select("status, last_error, updated_at"))
    since_24h = _cutoff_iso(now, 1)
    activity_24h = [r for r in activity if (r.get("created_at") or "") >= since_24h]
    pending = _fetch_all(
        lambda: sb.table("user_activity").select(_ACTIVITY_COLUMNS).eq("status", "pending").order("created_at")
    )

    overview = compute_overview(
        now=now,
        tz=tz,
        days=days,
        office=office,
        profiles=profiles,
        rooms=rooms,
        activity=activity,
        first_booking_by_user=first_booking,
        threads=threads,
        scouts=scouts,
        feedback_messages=feedback,
        bot_links=bot_links,
        revocations=revocations,
    )
    # Health is system-wide: never filtered by office.
    overview["health"] = compute_health(
        now=now,
        tz=tz,
        availability_updated_at=(availability_row or [{}])[0].get("updated_at"),
        token_rows=tokens,
        activity_24h=[r for r in activity_24h if parse_ts(r.get("created_at"))],
        pending_rows=pending,
        profiles=profiles,
    )
    overview["generatedAt"] = now.isoformat()
    return overview


def _build_heatmap(office: str | None, size: str | None) -> dict:
    rooms = _load_rooms()
    availability = _fetch_all(
        lambda: _sb().table("room_availability").select("room_id, date, slots").order("date").order("room_id")
    )
    return compute_heatmap(availability=availability, rooms=rooms, office=office, size=size)


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
    days: int = Query(7, ge=1, le=90),
    office: str | None = Query(None, max_length=64),
):
    _require_admin(request)
    office = office or None
    try:
        return _cached(("overview", days, office), lambda: _build_overview(days, office))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 - surface a clean 502 to the page
        log.exception("admin overview failed")
        raise HTTPException(502, f"Could not load dashboard data: {e}") from e


@router.get("/api/admin/heatmap")
def admin_heatmap(
    request: Request,
    office: str | None = Query(None, max_length=64),
    size: Literal["small", "medium", "large"] | None = None,
):
    _require_admin(request)
    office = office or None
    try:
        return _cached(("heatmap", office, size), lambda: _build_heatmap(office, size))
    except Exception as e:  # noqa: BLE001
        log.exception("admin heatmap failed")
        raise HTTPException(502, f"Could not load heatmap: {e}") from e
