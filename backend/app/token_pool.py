"""Pool of encrypted delegated Graph tokens for the background availability job.

Every successful sign-in / refresh-token exchange drops the user's current Graph
access token (Fernet-encrypted, with its expiry) into the `graph_token_pool`
table. A scheduler job then borrows the freshest ACTIVE token once a minute to
refresh the shared room_availability cache, so no user request has to pay for
the Graph round-trips. Tokens that Graph rejects are flipped to `invalid`
(revoked / password change / missing scope) and the job moves on to the next
candidate; expired rows are flipped to `expired` for observability.

The pool alone is NOT enough to keep the cache warm, because it only ever holds
Graph *access* tokens (~80 minutes) and `save_token` is only ever reached from a
user request or a sign-in. Once everyone stops using the app, every row ages out
within the hour and the cache freezes until the next sign-in. So when the pool
runs dry the job mints its own token from `provider_tokens` — the long-lived
Microsoft *refresh* tokens stored for every OAuth user — and that exchange
re-seeds the pool, which is what makes the refresh loop self-sustaining
overnight.
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
# Re-mint a pooled token once it has less than this left. Graph access tokens live
# ~80 minutes, so this renews each user roughly hourly — comfortably before expiry
# rather than after it, which is what keeps a row from ever reaching `expired`.
_RENEW_MARGIN = timedelta(minutes=15)


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

        row = {
            "owner_key": str(owner_key),
            "token_encrypted": _encrypt_scheduled_graph_token(access_token),
            "expires_at": expires_at.isoformat(),
            "status": "active",
            "last_error": None,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        # Only write user_email when we actually have one. Omitting the column
        # from the upsert leaves any existing value untouched on conflict
        # (PostgREST only SETs the columns present in the payload), so the
        # hourly get_graph_token() refresh — whose email is decoded best-effort
        # from the opaque Graph access token and is often empty — no longer
        # wipes the address stored at login. The email-keyed pool lookups
        # (get_active_token / get_active_token_exp) depend on it staying put.
        email = (user_email or "").strip().lower()
        if email:
            row["user_email"] = email

        get_supabase().table("graph_token_pool").upsert(
            row, on_conflict="owner_key"
        ).execute()
    except Exception as e:  # noqa: BLE001 - never block auth on pool bookkeeping
        log.warning("could not save token to pool for %s: %s", owner_key, e)


def get_active_token(owner_key: str | None = None, email: str | None = None) -> str | None:
    """Trả access token Graph còn ACTIVE của CHÍNH user này từ pool, hoặc None.

    Dùng cho luồng đặt phòng khi user chưa có refresh token nhưng pool vẫn còn
    access token active (vd vừa đăng nhập web). Tra theo owner_key trước, rồi tới
    email — CHỈ khớp đúng user đó, KHÔNG bao giờ mượn token của user khác.
    """
    settings = get_settings()
    if not settings.supabase_enabled or (not owner_key and not email):
        return None
    try:
        from .bookings import _decrypt_scheduled_graph_token
        from .supabase_client import get_supabase

        sb = get_supabase()
        cutoff = (datetime.now(timezone.utc) + _EXPIRY_MARGIN).isoformat()

        def _fetch(column: str, value: str | None) -> str | None:
            if not value:
                return None
            rows = (
                sb.table("graph_token_pool")
                .select("token_encrypted, expires_at")
                .eq(column, value)
                .eq("status", "active")
                .gt("expires_at", cutoff)
                .order("expires_at", desc=True)
                .limit(1)
                .execute()
                .data
                or []
            )
            if not rows:
                return None
            try:
                return _decrypt_scheduled_graph_token(rows[0].get("token_encrypted")) or None
            except RuntimeError:
                return None

        return _fetch("owner_key", str(owner_key) if owner_key else None) or _fetch(
            "user_email", (email or "").strip().lower() or None
        )
    except Exception as e:  # noqa: BLE001 - pool read must never break booking
        log.warning("could not read pooled token (owner=%s email=%s): %s", owner_key, email, e)
        return None


def get_active_token_exp(owner_key: str | None = None, email: str | None = None) -> int | None:
    """Trả hạn (epoch giây) của token Graph ACTIVE mới nhất của CHÍNH user này.

    Dùng cho card "Token hết hạn sau" ở Mini App: token thực sự gate booking là
    token Graph trong pool (~24h), KHÔNG phải session JWT Zalo (30 ngày). Tra theo
    owner_key trước rồi email — chỉ khớp đúng user, không đọc token của user khác.
    Không cần giải mã token (chỉ đọc expires_at). Trả None nếu không có.
    """
    settings = get_settings()
    if not settings.supabase_enabled or (not owner_key and not email):
        return None
    try:
        from .supabase_client import get_supabase

        sb = get_supabase()
        cutoff = datetime.now(timezone.utc).isoformat()

        def _fetch(column: str, value: str | None) -> int | None:
            if not value:
                return None
            rows = (
                sb.table("graph_token_pool")
                .select("expires_at")
                .eq(column, value)
                .eq("status", "active")
                .gt("expires_at", cutoff)
                .order("expires_at", desc=True)
                .limit(1)
                .execute()
                .data
                or []
            )
            if not rows:
                return None
            try:
                return int(datetime.fromisoformat(rows[0]["expires_at"]).timestamp())
            except (KeyError, ValueError, TypeError):
                return None

        return _fetch("owner_key", str(owner_key) if owner_key else None) or _fetch(
            "user_email", (email or "").strip().lower() or None
        )
    except Exception as e:  # noqa: BLE001 - pool read must never break /me
        log.warning("could not read pooled token exp (owner=%s email=%s): %s", owner_key, email, e)
        return None


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


async def renew_pool_tokens() -> int:
    """Re-mint every OAuth user's pooled Graph token BEFORE it lapses.

    `refresh_availability_from_pool` only ever needs one working token, so on its
    own it lets every other user's row expire — and an expired row means
    /api/auth/me has no expiry to show and the booking fallback
    (`get_active_token`) finds nothing for that user. This walks `provider_tokens`
    and renews anyone whose pooled token is missing, not `active`, or inside
    `_RENEW_MARGIN`, so a row should never be observed `expired` again.

    Returns how many users were renewed. Best-effort per user: one failure (revoked
    grant, network) never stops the rest.
    """
    settings = get_settings()
    if not settings.supabase_enabled:
        return 0
    try:
        from .auth import get_graph_token, invalidate_graph_token
        from .supabase_client import get_supabase

        sb = get_supabase()
        user_ids = [
            str(r["user_id"])
            for r in (sb.table("provider_tokens").select("user_id").execute().data or [])
            if r.get("user_id")
        ]
        if not user_ids:
            return 0

        # One read for the whole pool state, so the common case (nothing due) costs
        # two queries and zero Azure round-trips.
        pooled = {
            str(r["owner_key"]): r
            for r in (
                sb.table("graph_token_pool")
                .select("owner_key, status, expires_at")
                .in_("owner_key", user_ids)
                .execute()
                .data
                or []
            )
        }
    except Exception as e:  # noqa: BLE001 - a bookkeeping job must never crash the scheduler
        log.warning("renew_pool_tokens: could not read state: %s", e)
        return 0

    deadline = datetime.now(timezone.utc) + _RENEW_MARGIN
    renewed = 0
    for user_id in user_ids:
        row = pooled.get(user_id)
        if row and row.get("status") == "active":
            try:
                if datetime.fromisoformat(row["expires_at"]) > deadline:
                    continue  # still comfortably valid
            except (KeyError, ValueError, TypeError):
                pass  # unreadable expiry -> treat as due
        try:
            # get_graph_token short-circuits on its in-process cache while the token
            # has >60s left, which at _RENEW_MARGIN it always does — so it would hand
            # back the same near-dead token and save_token would just rewrite the old
            # expiry. Drop the cache entry to force a real exchange with Azure.
            invalidate_graph_token(user_id)
            await get_graph_token(user_id)  # exchanges, then save_token()s the result
            renewed += 1
        except Exception as e:  # noqa: BLE001 - revoked grant, network, rotated away
            log.warning("renew_pool_tokens: could not renew %s: %s", user_id, e)

    if renewed:
        log.info("renew_pool_tokens: renewed %d/%d pooled token(s)", renewed, len(user_ids))
    return renewed


def _token_email(access_token: str) -> str | None:
    """Best-effort sign-in name out of a Graph access token, for the pool's
    `user_email` column (which the email-keyed pool lookups match on)."""
    from .auth import decode_jwt_claims

    claims = decode_jwt_claims(access_token)
    for c in ("upn", "unique_name", "email"):
        if claims.get(c):
            return str(claims[c])
    return None


async def _mint_from_provider_tokens(skip: set[str]) -> str | None:
    """Mint a fresh delegated Graph token from a stored Microsoft refresh token.

    The last-resort path for the availability job when `graph_token_pool` has no
    usable access token left (everyone idle for ~80 minutes). `provider_tokens`
    holds a long-lived refresh token per OAuth user, so the job can mint its own
    token instead of waiting for someone to sign in. `get_graph_token` also feeds
    the result back through `save_token`, so a successful mint re-seeds the pool
    and the next run takes the cheap path again.

    `skip` holds owner_keys already tried this run, so a pool row that Graph just
    rejected isn't immediately retried through its refresh token.
    """
    try:
        from .auth import get_graph_token
        from .supabase_client import get_supabase

        rows = (
            get_supabase()
            .table("provider_tokens")
            .select("user_id")
            .order("updated_at", desc=True)
            .limit(_MAX_CANDIDATES + len(skip))
            .execute()
            .data
            or []
        )
    except Exception as e:  # noqa: BLE001
        log.warning("could not read provider_tokens: %s", e)
        return None

    tried = 0
    for row in rows:
        user_id = str(row.get("user_id") or "")
        if not user_id or user_id in skip:
            continue
        if tried >= _MAX_CANDIDATES:
            break
        tried += 1
        try:
            # Exchanges the refresh token at Azure (or returns the process-local
            # cache) and upserts the result into the pool via save_token.
            token = await get_graph_token(user_id)
        except Exception as e:  # noqa: BLE001 - revoked / rotated-away / network
            log.warning("could not mint pool token from provider_tokens for %s: %s", user_id, e)
            continue
        if token:
            # get_graph_token only calls save_token on an actual Azure exchange —
            # a hit on its in-process cache would leave the pool row `expired` and
            # send every later run down this fallback again. Re-seed explicitly so
            # the next run takes the cheap pool path.
            save_token(user_id, token, user_email=_token_email(token))
            log.info("minted a fresh Graph token from provider_tokens (user %s)", user_id)
            return token
    return None


async def refresh_availability_from_pool() -> dict | None:
    """Refresh room_availability using the freshest active pool token.

    Tries up to _MAX_CANDIDATES tokens newest-first. A token Graph rejects is
    marked invalid and the next one is tried. When no pool token works, falls
    back to minting one from `provider_tokens` (see `_mint_from_provider_tokens`)
    so the cache keeps refreshing while nobody is using the app. Returns the
    refresh summary, or None when even that fails.
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

    # owner_keys tried from the pool this run, so the provider_tokens fallback
    # doesn't immediately re-try a user Graph just rejected.
    tried: set[str] = set()

    for row in rows:
        owner_key = row["owner_key"]
        tried.add(str(owner_key))
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

    # Pool empty (everyone idle > token lifetime) or every candidate rejected.
    # Mint our own token from a stored Microsoft refresh token rather than let the
    # cache freeze until the next sign-in.
    if rows:
        log.info(
            "refresh_availability_from_pool: all %d pool candidates failed; "
            "falling back to provider_tokens",
            len(rows),
        )
    minted = await _mint_from_provider_tokens(tried)
    if not minted:
        log.warning(
            "refresh_availability_from_pool: no usable token in graph_token_pool "
            "nor provider_tokens; cache will age until a user signs in again."
        )
        return None

    summary = await availability.refresh_availability_delegated(minted)
    if summary.get("rows", 0) == 0 and summary.get("errors", 0) > 0:
        log.warning(
            "refresh_availability_from_pool: minted token failed getSchedule "
            "(likely missing Calendars.Read.Shared): %s", summary
        )
        return None
    log.info("availability refreshed from a minted provider token: %s", summary)
    return summary
