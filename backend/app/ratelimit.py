"""Lightweight in-process rate limiter (defense-in-depth).

Sliding-window counters kept in memory, keyed by an arbitrary string — usually
the client IP for unauthenticated endpoints, or the user id for authenticated
ones. This is PER-PROCESS: with multiple workers each keeps its own counters, so
the effective limit is roughly (configured limit × worker count). It is a cheap
first line against brute force / abuse and cost blow-ups, NOT a replacement for
an edge/WAF limiter. It always fails OPEN — any internal error never blocks a
legitimate request.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

from .config import get_settings

# key -> timestamps (monotonic seconds) of recent hits within the window.
_HITS: dict[str, deque] = defaultdict(deque)
# Hard cap on tracked keys so a flood of distinct keys can't grow memory
# unbounded; empty deques are pruned opportunistically when the cap is hit.
_MAX_KEYS = 10_000


def client_ip(request: Request) -> str:
    """Best-effort client IP.

    Behind a trusted proxy take the left-most X-Forwarded-For hop; otherwise the
    socket peer. When trust_forwarded_for is on the header is client-settable and
    can be spoofed to evade per-IP limits — acceptable for a defense-in-depth
    layer, and the authenticated endpoints key by user id instead of IP.
    """
    try:
        if get_settings().trust_forwarded_for:
            xff = request.headers.get("x-forwarded-for", "")
            if xff:
                first = xff.split(",")[0].strip()
                if first:
                    return first
        client = request.client
        return client.host if client else "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"


def _too_many(key: str, limit: int, window: float) -> bool:
    now = time.monotonic()
    dq = _HITS[key]
    cutoff = now - window
    while dq and dq[0] < cutoff:
        dq.popleft()
    if len(dq) >= limit:
        return True
    dq.append(now)
    if len(_HITS) > _MAX_KEYS:
        for k in list(_HITS.keys()):
            if not _HITS[k]:
                _HITS.pop(k, None)
    return False


def allowed(bucket: str, key: str, limit: int, window_seconds: float) -> bool:
    """Return False when `key` has exceeded `limit` hits within the window for
    this `bucket`. No-op (always True) when disabled; fails open on error."""
    try:
        if not get_settings().rate_limit_enabled or not key:
            return True
        return not _too_many(f"{bucket}:{key}", limit, window_seconds)
    except Exception:  # noqa: BLE001 — never block legit traffic on a limiter bug
        return True


def enforce(
    bucket: str,
    key: str,
    limit: int,
    window_seconds: float,
    *,
    detail: str = "Bạn thao tác hơi nhanh, vui lòng thử lại sau giây lát.",
) -> None:
    """Raise HTTP 429 when `key` exceeded `limit` hits within `window_seconds`
    for this `bucket`. No-op when disabled; fails open on internal error."""
    if not allowed(bucket, key, limit, window_seconds):
        raise HTTPException(429, detail)
