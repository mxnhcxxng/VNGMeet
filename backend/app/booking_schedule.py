"""Config for WHEN scheduled bookings fire — easy to override for local testing.

In production the fire time is 00:00:00: a new day's rooms open at midnight and we
race other bookers. Editing this file lets you trigger the whole
prep -> fire -> catch-up pipeline at a convenient time WITHOUT waiting for midnight.

HOW TO TEST
-----------
  1. Set FIRE_TIME below, e.g. "01:15:00" (local time, in settings.timezone).
  2. Restart the backend (cron times are registered at startup, so a restart is
     required for the new time to take effect).
  3. Watch the logs around FIRE_TIME:
        prepare_scheduled_bookings: staged N booking(s) ...
        fire_scheduled_bookings: firing N booking(s) at ...
        scheduled booking <id> POST sent +X.Xms ...
  4. Revert FIRE_TIME to "00:00:00" before deploying to production.

The three jobs are all derived from FIRE_TIME:
  - prep job   : FIRE_TIME - PREP_LEAD_SECONDS    (stage payloads, warm tokens/conns)
  - fire job   : FIRE_TIME - FIRE_LEAD_SECONDS    (busy-waits to FIRE_TIME, then POSTs)
  - catch-up   : FIRE_TIME + CATCHUP_DELAY_SECONDS (idempotent safety net)

This file does NOT read or touch .env and contains no secrets.
"""

from __future__ import annotations

from datetime import datetime, timedelta

# Local wall-clock time (HH:MM:SS, in settings.timezone) when bookings should fire.
# Production default is midnight. Change ONLY for local testing, then revert.
FIRE_TIME = "00:00:00"

# How the helper jobs are offset from FIRE_TIME (in seconds).
PREP_LEAD_SECONDS = 30       # prep runs this long BEFORE FIRE_TIME
FIRE_LEAD_SECONDS = 3        # fire job is scheduled this long BEFORE FIRE_TIME, then busy-waits
CATCHUP_DELAY_SECONDS = 120  # catch-up runs this long AFTER FIRE_TIME

# Send the POST this many milliseconds BEFORE FIRE_TIME so our meeting-request
# LANDS in the room mailbox right as the slot opens. The room is grabbed by the
# order requests arrive in ITS mailbox, not by when our POST returns — and the
# request only reaches the room AFTER the whole send pipeline:
#
#   invite lands in room mailbox ≈ send + transit(~75ms) + event-create(~397ms) + transport
#
#   send_at = FIRE_TIME - SEND_LEAD_MS/1000
#
# So the lead should cover that whole pipeline (~450-500ms), not just network
# transit. Measured evidence (one sample): the room's RBA evaluates asynchronously
# ~8s later and checks the booking-window policy at THAT time, so landing the
# invite a little early appears safe. This is UNVERIFIED at real midnight under
# contention — sweep leads (0/150/300/450/600) at the 14-day edge and watch the
# room's accepted/declined + status.time to find the real safe ceiling before
# trusting a large value. 0 disables early sending (fire exactly at FIRE_TIME).
SEND_LEAD_MS = 100

_DEFAULT_HMS = (0, 0, 0)


def fire_time_hms() -> tuple[int, int, int]:
    """Parse FIRE_TIME -> (hour, minute, second); fall back to midnight if malformed."""
    try:
        parts = [int(p) for p in str(FIRE_TIME).strip().split(":")]
        while len(parts) < 3:
            parts.append(0)
        h, m, s = parts[0], parts[1], parts[2]
        if 0 <= h < 24 and 0 <= m < 60 and 0 <= s < 60:
            return h, m, s
    except Exception:  # noqa: BLE001 - never let a typo crash startup
        pass
    return _DEFAULT_HMS


def shifted_hms(delta_seconds: int) -> tuple[int, int, int]:
    """FIRE_TIME shifted by delta_seconds, wrapped within a 24h day -> (h, m, s)."""
    h, m, s = fire_time_hms()
    total = (h * 3600 + m * 60 + s + delta_seconds) % 86400
    return total // 3600, (total % 3600) // 60, total % 60


def next_fire_instant(now: datetime) -> datetime:
    """The upcoming FIRE_TIME instant at/after `now` (preserves `now`'s timezone)."""
    h, m, s = fire_time_hms()
    candidate = now.replace(hour=h, minute=m, second=s, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate
