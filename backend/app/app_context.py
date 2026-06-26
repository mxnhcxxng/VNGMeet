"""Shared runtime settings for the FastAPI backend."""

from __future__ import annotations

import logging
from datetime import date as date_cls, timedelta

from .config import get_settings

log = logging.getLogger("vngmeet")
settings = get_settings()
AVAILABILITY_CACHE_TTL = timedelta(minutes=1)
SCHEDULE_MAX_DURATION_MINUTES = 3 * 60


def _live_availability_horizon_end(today: date_cls) -> date_cls:
    """Last instant-booking day; the final cache day remains scheduled."""
    return today + timedelta(days=max(0, settings.availability_days - 2))
