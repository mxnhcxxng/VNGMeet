"""Ad-hoc performance harness for ONE scheduled booking.

Reproduces the exact prepare -> fire -> finalize path from ``app.bookings`` but
records a high-resolution timestamp at every milestone and prints an offset
table. Offsets are measured relative to a simulated ``fire_instant`` (the whole
second boundary we busy-wait to), exactly like the production midnight run, so
"+X.Xms" here means the same thing as the "POST sent +X.Xms" line in the logs.

Motivation: at midnight we race other bookers for a freshly-opened room. If we
lose the room at, say, 00:00:00.690, we need to know how much of that 690 ms is
busy-wait jitter, how much is the Graph POST round-trip, and how much (if any)
is DB work on the critical path. This script breaks it down for a real booking
without waiting for midnight.

USAGE
-----
    cd backend
    python measure_scheduled_booking.py <activity_id> [options]

    # safe measurement (default): does everything EXCEPT create the event.
    python measure_scheduled_booking.py 05206d74-f98f-44c4-bddc-8855b70c5668

    # real run: actually creates the Outlook event -> books the room and emails
    # attendees. Irreversible. Also flips the user_activity row to ok/failed.
    python measure_scheduled_booking.py 05206d74-... --real

    # measure network jitter of the warm round-trip with N samples (dry only):
    python measure_scheduled_booking.py 05206d74-... --samples 5

<activity_id> is the user_activity.id (same id the fire log prints as
"scheduled booking <id> POST sent ..."). Run from the backend/ directory with
the app deps installed (python -m venv venv && pip install -r requirements.txt)
so the harness shares the app's .env, timezone and Supabase config.
"""

from __future__ import annotations

import argparse
import asyncio
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from app import auth, booking_schedule, graph
from app.app_context import settings
from app.bookings import (
    _activity_to_booking_request,
    _decrypt_scheduled_graph_token,
    _finalize_booking_result,
    _new_graph_client,
    _warm_graph_connections,
)
from app.graph import _event_headers
from app.supabase_client import get_supabase

TZ = ZoneInfo(settings.timezone)


@dataclass
class Timeline:
    """Collects (label, wall_clock, perf_counter, writes_db) marks and prints them."""

    phase_start_perf: float = field(default_factory=time.perf_counter)
    fire_instant: datetime | None = None
    marks: list[tuple[str, datetime, float, bool]] = field(default_factory=list)

    def mark(self, label: str, *, db: bool = False) -> None:
        self.marks.append((label, datetime.now(TZ), time.perf_counter(), db))

    def report(self) -> None:
        print("\n" + "=" * 92)
        print(f"{'MILESTONE':<44}{'wall clock':<16}{'Δprev':>9}{'off@fire':>11}{'  DB'}")
        print("-" * 92)
        prev = None
        for label, wall, perf, db in self.marks:
            delta = "" if prev is None else f"{(perf - prev) * 1000:>7.1f}ms"
            if self.fire_instant is not None:
                off = f"{(wall - self.fire_instant).total_seconds() * 1000:>+8.1f}ms"
            else:
                off = " " * 9
            flag = "  ✍︎ write" if db else ""
            print(f"{label:<44}{wall.strftime('%H:%M:%S.%f')[:-3]:<16}{delta:>9}{off:>11}{flag}")
            prev = perf
        print("=" * 92)


def _fetch_row(sb, activity_id: str) -> dict:
    rows = (
        sb.table("user_activity")
        .select(
            "id, user_id, auth_user_id, graph_access_token, room_email, room_name, "
            "date, start_time, end_time, method, subject, attendees, body, "
            "booking_type, status"
        )
        .eq("id", activity_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        raise SystemExit(f"No user_activity row with id={activity_id}")
    return rows[0]


async def _stage(tl: Timeline, sb, row: dict) -> dict:
    """PREP phase: identical work to prepare_scheduled_bookings._stage_one, timed."""
    item: dict = {
        "activity_id": row.get("id"),
        "user_profile_id": str(row.get("user_id") or ""),
        "auth_user_id": str(row.get("auth_user_id") or ""),
        "payload": None,
        "token": None,
        "body": None,
        "error": None,
    }
    payload = _activity_to_booking_request(row)
    item["payload"] = payload
    tl.mark("prep: build BookingRequest (in-mem)")

    if item["auth_user_id"]:
        item["token"] = await auth.get_graph_token(item["auth_user_id"])
        tl.mark("prep: get_graph_token (DB read + maybe refresh)")
    else:
        item["token"] = _decrypt_scheduled_graph_token(row.get("graph_access_token"))
        tl.mark("prep: decrypt stored token (in-mem)")
    if not item["token"]:
        raise SystemExit("missing graph access token for this booking")

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
    tl.mark("prep: build_event_body (in-mem)")
    return item


def _busy_wait_to(target: datetime) -> None:
    """The exact countdown from bookings._sleep_until: coarse sleep to
    SPIN_WINDOW_SECONDS out, then a tight spin so we land within tens of us.

    Blocking (not async) on purpose — in production this runs on the fire thread's
    private event loop, which has nothing else to do.
    """
    target_ts = target.timestamp()
    spin = booking_schedule.SPIN_WINDOW_SECONDS
    while True:
        remaining = target_ts - time.time()
        if remaining <= spin:
            break
        time.sleep(min(remaining - spin, 1.0))
    while time.time() < target_ts:
        pass


async def run(activity_id: str, *, real: bool, samples: int, warm: int) -> None:
    sb = get_supabase()
    tl = Timeline()

    # ---- PREP (production: FIRE - 30s) --------------------------------------
    tl.mark("prep: START")
    row = _fetch_row(sb, activity_id)
    tl.mark("prep: read user_activity row (DB read)")
    print(
        f"booking {activity_id}\n"
        f"  status={row.get('status')} type={row.get('booking_type')} "
        f"date={row.get('date')} {row.get('start_time')}-{row.get('end_time')} "
        f"room={row.get('room_email')}"
    )
    if row.get("status") != "pending":
        print(f"  ⚠️  status is '{row.get('status')}', not 'pending' — a real run may "
              f"duplicate the event. Dry-run is unaffected.")

    item = await _stage(tl, sb, row)

    client = _new_graph_client(1)
    tl.mark("prep: new HTTP/2 client")
    await _warm_graph_connections(client, warm)
    tl.mark(f"prep: warm {warm} connection(s) (TLS/TCP)")

    # ---- FIRE (production: 00:00:00.000 sharp) -------------------------------
    # Align to the next whole-second boundary and busy-wait to it, exactly like
    # production, so off@fire below is a faithful busy-wait-precision number.
    now = datetime.now(TZ)
    fire_instant = (now + timedelta(seconds=2)).replace(microsecond=0)
    tl.fire_instant = fire_instant
    print(f"\nsimulated fire_instant = {fire_instant.strftime('%H:%M:%S.%f')[:-3]} "
          f"(busy-waiting {(fire_instant - now).total_seconds():.2f}s)")
    _busy_wait_to(fire_instant)
    tl.mark("fire: reached fire_instant (post busy-wait)")

    async def one_shot() -> dict:
        p0 = time.perf_counter()
        if real:
            ev = await graph.post_event(client, item["token"], item["body"], settings.timezone)
            dur = (time.perf_counter() - p0) * 1000
            return {"ok": True, "event": ev, "dur_ms": dur}
        # dry-run: authenticated warm round-trip that creates NOTHING.
        resp = await client.get(
            f"{graph.GRAPH_BASE}/me/events?$top=1&$select=id",
            headers=_event_headers(item["token"], settings.timezone),
        )
        resp.raise_for_status()
        return {"ok": True, "event": None, "dur_ms": (time.perf_counter() - p0) * 1000}

    kind = "POST /me/events (REAL — books room)" if real else "GET /me/events?$top=1 (dry proxy)"
    first = await one_shot()
    tl.mark(f"fire: {kind} returned")
    print(f"\n  round-trip #1: {first['dur_ms']:.0f}ms")
    for i in range(2, samples + 1) if not real else ():
        s = await one_shot()
        print(f"  round-trip #{i}: {s['dur_ms']:.0f}ms")

    # ---- FINALIZE (production: off the hot path, after the room is won) ------
    result = {"item": item, "ok": first["ok"], "event": first.get("event")}
    if real:
        ok = _finalize_booking_result(result)  # 4 sequential DB writes
        tl.mark("finalize: user_activity.update status (DB write)", db=True)
        tl.mark("finalize: user_profiles.update active_booking (DB write)", db=True)
        tl.mark("finalize: room_availability.upsert owner (DB read+write)", db=True)
        tl.mark("finalize: bookings.insert mirror (DB write)", db=True)
        print(f"\n  _finalize_booking_result -> {'ok' if ok else 'failed'}")
    else:
        # Don't mutate state in dry-run; measure one representative DB round-trip
        # so you can estimate the 4 sequential finalize writes (~4 × this).
        p0 = time.perf_counter()
        sb.table("user_activity").select("id").eq("id", activity_id).limit(1).execute()
        rtt = (time.perf_counter() - p0) * 1000
        tl.mark("finalize: 1 DB round-trip sample (no write)", db=True)
        print(f"\n  DB round-trip ≈ {rtt:.0f}ms; finalize does 4 sequential writes "
              f"(~{4 * rtt:.0f}ms) AFTER the room is won — off the race critical path.")

    await client.aclose()
    tl.mark("teardown: close client")
    tl.report()

    print(
        "\nCritical-path budget (what decides winning the room):\n"
        "  off@fire at 'fire: ... returned'  =  busy-wait start delay  +  Graph round-trip\n"
        "  The room is grabbed when Graph commits the POST; DB writes happen after and\n"
        "  do NOT count against the race."
    )


def main() -> None:
    ap = argparse.ArgumentParser(description="Measure one scheduled booking's pipeline timing.")
    ap.add_argument("activity_id", help="user_activity.id of the scheduled booking")
    ap.add_argument("--real", action="store_true",
                    help="actually create the event (books the room, emails attendees, writes DB)")
    ap.add_argument("--samples", type=int, default=1,
                    help="dry-run only: number of warm round-trips to sample for jitter")
    ap.add_argument("--warm", type=int, default=1, help="connections to pre-warm (default 1)")
    args = ap.parse_args()

    if not settings.supabase_enabled:
        raise SystemExit("supabase not configured — check backend/.env")
    asyncio.run(run(args.activity_id, real=args.real, samples=args.samples, warm=args.warm))


if __name__ == "__main__":
    main()
