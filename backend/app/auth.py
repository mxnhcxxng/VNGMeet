"""Auth with two paths:

1. Manual Graph token (works today, no admin / no Supabase): the user pastes a
   Graph access token (e.g. from Graph Explorer); we keep it server-side keyed by
   an opaque session id stored in a signed cookie.

2. Supabase (Azure OAuth provider) — only active once SUPABASE_* is configured.
   The frontend signs in via Supabase, the backend verifies the session JWT and
   exchanges the stored Microsoft refresh token for a fresh Graph access token.

`resolve_token()` picks whichever path the request carries.
"""

from __future__ import annotations

import base64
import json
import re
import time
import uuid

import httpx
from fastapi import HTTPException, Request

from .config import get_settings

# --- manual-token path (session-scoped) ------------------------------------- #
# session_id -> Graph access token pasted by the user.
_MANUAL_TOKENS: dict[str, str] = {}
_MANUAL_CLAIMS: dict[str, dict] = {}

# --- supabase path ----------------------------------------------------------- #
# user_id -> (access_token, expires_at_epoch). Rebuildable from the refresh token.
_GRAPH_TOKEN_CACHE: dict[str, tuple[str, float]] = {}


def cache_graph_token(user_id: str, access_token: str, expires_in: int = 3600) -> None:
    """Seed the Graph token cache with a fresh token returned by OAuth."""
    _GRAPH_TOKEN_CACHE[user_id] = (
        access_token.strip(),
        time.time() + max(0, expires_in),
    )


def invalidate_graph_token(user_id: str) -> None:
    """Force the next Graph request to exchange the latest refresh token."""
    _GRAPH_TOKEN_CACHE.pop(user_id, None)


def decode_jwt_claims(token: str) -> dict:
    """Best-effort read of JWT claims without verifying the signature."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)  # pad base64
        data = json.loads(base64.urlsafe_b64decode(payload))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _decode_jwt_claim(token: str, *claims: str) -> str | None:
    """Best-effort read of a claim from a JWT without verifying the signature."""
    data = decode_jwt_claims(token)
    for c in claims:
        if data.get(c):
            return data[c]
    return None


# --------------------------------------------------------------------------- #
# Session id (for the manual-token path)
# --------------------------------------------------------------------------- #
def session_id(request: Request) -> str:
    sid = request.session.get("sid")
    if not sid:
        sid = uuid.uuid4().hex
        request.session["sid"] = sid
    return sid


def set_manual_token(sid: str, access_token: str, claims: dict | None = None) -> None:
    _MANUAL_TOKENS[sid] = access_token.strip()
    if claims is not None:
        _MANUAL_CLAIMS[sid] = claims


def get_manual_token(sid: str) -> str | None:
    return _MANUAL_TOKENS.get(sid)


def get_manual_claims(sid: str) -> dict:
    token = get_manual_token(sid)
    if not token:
        return {}
    return _MANUAL_CLAIMS.get(sid) or decode_jwt_claims(token)


def logout(sid: str) -> None:
    _MANUAL_TOKENS.pop(sid, None)
    _MANUAL_CLAIMS.pop(sid, None)


def normalize_vn_phone(value: str | None) -> str | None:
    """Normalize a Graph `mobilePhone` to local VN format, trimming the +84 prefix.

    Graph values are inconsistent — the country code may or may not include the
    trunk 0, e.g. "(+84) 0339758256", "+84 912 345 678", "84912345678",
    "0912345678" -> "0339758256" / "0912345678". Returns None when there's
    nothing usable to store.
    """
    if not isinstance(value, str):
        return None
    digits = re.sub(r"\D", "", value)  # drop spaces, dashes, parens, the leading +
    if digits.startswith("84"):
        digits = digits[2:]  # strip the +84 country code
    if digits and not digits.startswith("0"):
        digits = "0" + digits  # restore the trunk 0 if the country code ate it
    return digits or None


async def verify_manual_graph_token(access_token: str) -> dict:
    """Validate a pasted Graph token by calling Microsoft Graph /me."""
    token = access_token.strip()
    if not token:
        raise HTTPException(400, "access_token rỗng")

    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=20) as client:
        try:
            resp = await client.get("https://graph.microsoft.com/v1.0/me", headers=headers)
        except httpx.HTTPError as e:
            raise HTTPException(401, f"Không xác thực được Graph token: {e}") from e

    if resp.status_code != 200:
        raise HTTPException(401, "Graph token không hợp lệ hoặc đã hết hạn.")

    user = resp.json()
    email = user.get("mail") or user.get("userPrincipalName")
    claims = {
        "name": user.get("displayName"),
        "email": email,
        "preferred_username": user.get("userPrincipalName") or email,
        "upn": user.get("userPrincipalName"),
        "graph_user_id": user.get("id"),
        "phone": normalize_vn_phone(user.get("mobilePhone")),
    }
    return {key: value for key, value in claims.items() if value}


# --------------------------------------------------------------------------- #
# Supabase session (JWT) verification
# --------------------------------------------------------------------------- #
def verify_jwt(token: str) -> dict:
    import jwt  # imported lazily so the manual path works even if unused

    s = get_settings()
    if not s.supabase_jwt_secret:
        raise HTTPException(500, "Server missing SUPABASE_JWT_SECRET. Check .env")
    try:
        return jwt.decode(
            token,
            s.supabase_jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
        )
    except jwt.PyJWTError as e:
        raise HTTPException(401, f"Invalid session: {e}")


def _bearer(request: Request) -> str | None:
    header = request.headers.get("Authorization", "")
    return header[len("Bearer ") :] if header.startswith("Bearer ") else None


# --------------------------------------------------------------------------- #
# Supabase: provider (Graph) refresh-token storage
# --------------------------------------------------------------------------- #
def store_refresh_token(user_id: str, refresh_token: str) -> None:
    from .supabase_client import get_supabase

    get_supabase().table("provider_tokens").upsert(
        {"user_id": user_id, "refresh_token": refresh_token}
    ).execute()


def has_refresh_token(user_id: str) -> bool:
    from .supabase_client import get_supabase

    res = (
        get_supabase()
        .table("provider_tokens")
        .select("user_id")
        .eq("user_id", user_id)
        .execute()
    )
    return bool(res.data)


def _load_refresh_token(user_id: str) -> str | None:
    from .supabase_client import get_supabase

    res = (
        get_supabase()
        .table("provider_tokens")
        .select("refresh_token")
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    return res.data[0]["refresh_token"] if res.data else None


async def get_graph_token(user_id: str) -> str:
    """Return a valid Graph access token for a Supabase user, refreshing as needed."""
    cached = _GRAPH_TOKEN_CACHE.get(user_id)
    if cached and cached[1] - 60 > time.time():
        return cached[0]

    refresh_token = _load_refresh_token(user_id)
    if not refresh_token:
        raise HTTPException(401, "Microsoft account not linked. Sign in again.")

    s = get_settings()
    data = {
        "client_id": s.client_id,
        "client_secret": s.client_secret,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "scope": " ".join(s.scopes),
    }
    async with httpx.AsyncClient() as client:
        resp = await client.post(s.token_endpoint, data=data)
    if resp.status_code != 200:
        raise HTTPException(401, f"Could not refresh Microsoft token: {resp.text}")
    payload = resp.json()

    access_token = payload["access_token"]
    expires_in = int(payload.get("expires_in", 3600))
    _GRAPH_TOKEN_CACHE[user_id] = (access_token, time.time() + expires_in)

    new_refresh = payload.get("refresh_token")
    if new_refresh and new_refresh != refresh_token:
        store_refresh_token(user_id, new_refresh)

    # Feed the fresh token to the background availability pool. Only reached on
    # an actual exchange (~once/hour/user thanks to the cache above), and
    # save_token itself is best-effort, so this never slows or breaks auth.
    from .token_pool import save_token

    save_token(
        user_id,
        access_token,
        user_email=_decode_jwt_claim(access_token, "upn", "unique_name", "email"),
        expires_in=expires_in,
    )

    return access_token


# --------------------------------------------------------------------------- #
# Unified resolution used by the API endpoints
# --------------------------------------------------------------------------- #
async def resolve_token(request: Request) -> tuple[str, str | None]:
    """Return (graph_access_token, supabase_user_id|None) for the request.

    Prefers a Supabase bearer token if present; otherwise falls back to the
    session-scoped manual Graph token. Raises 401 if neither is available.
    """
    bearer = _bearer(request)
    if bearer:
        claims = verify_jwt(bearer)
        user_id = claims["sub"]
        return await get_graph_token(user_id), user_id

    token = get_manual_token(session_id(request))
    if not token:
        raise HTTPException(401, "Not authenticated")
    return token, None
