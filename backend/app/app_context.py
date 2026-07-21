"""Shared runtime settings for the FastAPI backend."""

from __future__ import annotations

import logging
from datetime import date as date_cls, timedelta

from .config import get_settings

log = logging.getLogger("vngmeet")
# Without this the logger inherits the root's default WARNING level and has no
# handler, so every log.info(...) is silently dropped (only warnings/errors reach
# stderr via the last-resort handler). Attach a stdout handler at INFO so app logs
# are actually captured by the runtime (AgentBase reads stdout).
if not log.handlers:
    _log_handler = logging.StreamHandler()
    _log_handler.setFormatter(logging.Formatter("%(levelname)s:%(name)s: %(message)s"))
    log.addHandler(_log_handler)
log.setLevel(logging.INFO)
log.propagate = False

settings = get_settings()
# Hard-fallback threshold, NOT the freshness target. The background job (app-only
# cron or the 1-min graph_token_pool job) owns keeping the cache fresh; a request
# only refreshes inline when rows are missing or older than this — i.e. the job
# has been dead for a while — so users normally never wait on Graph.
AVAILABILITY_CACHE_TTL = timedelta(minutes=5)
SCHEDULE_MAX_DURATION_MINUTES = 3 * 60


def _live_availability_horizon_end(today: date_cls) -> date_cls:
    """Last instant-booking day; the final cache day remains scheduled."""
    return today + timedelta(days=max(0, settings.availability_days - 2))
