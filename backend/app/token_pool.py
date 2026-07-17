"""Pool of encrypted delegated Graph tokens for the background availability job.

Every successful sign-in / refresh-token exchange drops the user's current Graph
access token (Fernet-encrypted, with its expiry) into the `graph_token_pool`
table. A scheduler job then borrows the freshest ACTIVE token once a minute to
refresh the shared room_availability cache, so no user request has to pay for
the Graph round-trips. Tokens that Graph rejects are flipped to `invalid`
(revoked / password change / missing scope) and the job moves on to the next
candidate; expired rows are flipped to `expired` for observability.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import httpx

from .config import get_settings

log = logging.getLogger("vngmeet.token_pool")

# Skip tokens about to lapse mid-refresh (a full refresh takes a few seconds).
_EXPIRY_MARGIN = timedelta(minutes=2)
# How many pool candidates one job run tries before giving up.
_MAX_CANDIDATES = 3


def save_token(
    owner_key: str,
    access_token: str,
    *,
    user_email: str | None = None,
    expires_in: int | None = None,
) -> None:
    """Encrypt and upsert a delegated Graph token into the pool. Best-effort:
    a pool write must never break the auth flow that produced the token."""
    settings = get_settings()
    if not settings.supabase_enabled or not owner_key or not access_token:
        return
    try:
        # Lazy imports: bookings/auth both import heavy modules; the pool only
        # needs their small helpers and must not create import cycles.
        from .auth import decode_jwt_claims
        from .bookings import _encrypt_scheduled_graph_token
        from .supabase_client import get_supabase

        exp = decode_jwt_claims(access_token).get("exp")
        if isinstance(exp, (int, float)):
            expires_at = datetime.fromtimestamp(int(exp), tz=timezone.utc)
        elif expires_in is not None:
            expires_at = datetime.now(timezone.utc) + timedelta(seconds=max(0, expires_in))
        else:
            return  # no way to know the expiry -> useless for the pool
        if expires_at <= datetime.now(timezone.utc) + _EXPIRY_MARGIN:
            return

        get_supabase().table("graph_token_pool").upsert(
            {
                "owner_key": str(owner_key),
                "user_email": (user_email or "").strip().lower() or None,
                "token_encrypted": _encrypt_scheduled_graph_token(access_token),
                "expires_at": expires_at.isoformat(),
                "status": "active",
                "last_error": None,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
            on_conflict="owner_key",
        ).execute()
    except Exception as e:  # noqa: BLE001 - never block auth on pool bookkeeping
        log.warning("could not save token to pool for %s: %s", owner_key, e)


def _mark(sb, owner_key: str, status: str, error: str | None = None) -> None:
    try:
        sb.table("graph_token_pool").update(
            {
                "status": status,
                "last_error": (error or "")[:500] or None,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        ).eq("owner_key", owner_key).execute()
    except Exception as e:  # noqa: BLE001
        log.warning("could not mark pool token %s as %s: %s", owner_key, status, e)


async def _probe(token: str) -> bool:
    """Cheap validity check before spending a full refresh on the token."""
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get("https://graph.microsoft.com/v1.0/me", headers=headers)
        return resp.status_code == 200
    except httpx.HTTPError:
        # Network hiccup, not a token verdict — treat as unusable this run but
        # don't invalidate the row.
        return False


async def refresh_availability_from_pool() -> dict | None:
    """Refresh room_availability using the freshest active pool token.

    Tries up to _MAX_CANDIDATES tokens newest-first. A token Graph rejects is
    marked invalid and the next one is tried. Returns the refresh summary, or
    None when no usable token exists (logged — the cache then ages until a user
    signs in again and reseeds the pool).
    """
    settings = get_settings()
    if not settings.supabase_enabled:
        return None
    from . import availability
    from .bookings import _decrypt_scheduled_graph_token
    from .supabase_client import get_supabase

    sb = get_supabase()
    now = datetime.now(timezone.utc)

    # Flip aged-out rows to `expired` so the pool state is readable at a glance.
    try:
        sb.table("graph_token_pool").update(
            {"status": "expired", "updated_at": now.isoformat()}
        ).eq("status", "active").lte("expires_at", now.isoformat()).execute()
    except Exception as e:  # noqa: BLE001
        log.warning("could not expire stale pool tokens: %s", e)

    try:
        rows = (
            sb.table("graph_token_pool")
            .select("owner_key, user_email, token_encrypted, expires_at")
            .eq("status", "active")
            .gt("expires_at", (now + _EXPIRY_MARGIN).isoformat())
            .order("updated_at", desc=True)
            .limit(_MAX_CANDIDATES)
            .execute()
            .data
            or []
        )
    except Exception as e:  # noqa: BLE001
        log.warning("could not read graph_token_pool: %s", e)
        return None

    if not rows:
        log.warning(
            "refresh_availability_from_pool: no active token in pool; "
            "cache will age until a user signs in again."
        )
        return None

    for row in rows:
        owner_key = row["owner_key"]
        try:
            token = _decrypt_scheduled_graph_token(row.get("token_encrypted"))
        except RuntimeError as e:
            _mark(sb, owner_key, "invalid", f"decrypt failed: {e}")
            continue
        if not token:
            _mark(sb, owner_key, "invalid", "empty token")
            continue

        if not await _probe(token):
            _mark(sb, owner_key, "invalid", "Graph /me rejected the token")
            log.info("pool token of %s rejected by Graph; trying next", owner_key)
            continue

        summary = await availability.refresh_availability_delegated(token)
        if summary.get("rows", 0) == 0 and summary.get("errors", 0) > 0:
            # /me accepted the token but every getSchedule batch failed — most
            # likely a missing Calendars.Read.Shared scope on this token.
            _mark(sb, owner_key, "invalid", "getSchedule rejected all batches")
            log.warning("pool token of %s failed getSchedule; trying next", owner_key)
            continue

        try:
            sb.table("graph_token_pool").update(
                {"last_used_at": datetime.now(timezone.utc).isoformat()}
            ).eq("owner_key", owner_key).execute()
        except Exception as e:  # noqa: BLE001
            log.warning("could not stamp last_used_at for %s: %s", owner_key, e)
        log.info("availability refreshed from pool (owner %s): %s", owner_key, summary)
        return summary

    log.warning("refresh_availability_from_pool: all %d candidates failed", len(rows))
    return None
