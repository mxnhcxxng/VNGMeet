"""Delegated OAuth2 (authorization code flow) using MSAL.

Token caches are kept server-side, keyed by an opaque session id that lives in a
signed cookie. This avoids stuffing refresh tokens into the browser cookie.
"""

from __future__ import annotations

import msal

from .config import get_settings

import base64
import json

# session_id -> serialized MSAL token cache (JSON string)
_CACHE_STORE: dict[str, str] = {}
# session_id -> auth "flow" dict produced by initiate_auth_code_flow (PKCE state, etc.)
_FLOW_STORE: dict[str, dict] = {}
# session_id -> manually pasted Graph access token (e.g. from Graph Explorer)
_MANUAL_TOKENS: dict[str, str] = {}


def _load_cache(session_id: str) -> msal.SerializableTokenCache:
    cache = msal.SerializableTokenCache()
    blob = _CACHE_STORE.get(session_id)
    if blob:
        cache.deserialize(blob)
    return cache


def _save_cache(session_id: str, cache: msal.SerializableTokenCache) -> None:
    if cache.has_state_changed:
        _CACHE_STORE[session_id] = cache.serialize()


def _build_app(cache: msal.SerializableTokenCache) -> msal.ConfidentialClientApplication:
    s = get_settings()
    return msal.ConfidentialClientApplication(
        client_id=s.client_id,
        client_credential=s.client_secret,
        authority=s.authority,
        token_cache=cache,
    )


def build_auth_url(session_id: str) -> str:
    """Start an auth-code flow and return the URL to redirect the user to."""
    s = get_settings()
    cache = _load_cache(session_id)
    app = _build_app(cache)
    flow = app.initiate_auth_code_flow(scopes=s.scopes, redirect_uri=s.redirect_uri)
    _FLOW_STORE[session_id] = flow
    return flow["auth_uri"]


def complete_login(session_id: str, query_params: dict) -> dict:
    """Exchange the auth-code (in query_params) for tokens. Returns the token result."""
    flow = _FLOW_STORE.pop(session_id, None)
    if not flow:
        raise ValueError("No auth flow in progress for this session.")
    cache = _load_cache(session_id)
    app = _build_app(cache)
    result = app.acquire_token_by_auth_code_flow(flow, query_params)
    _save_cache(session_id, cache)
    if "access_token" not in result:
        raise ValueError(result.get("error_description", "Login failed"))
    return result


def set_manual_token(session_id: str, access_token: str) -> None:
    """Store a Graph access token pasted by the user (test mode, no refresh)."""
    _MANUAL_TOKENS[session_id] = access_token.strip()


def _decode_jwt_claim(token: str, *claims: str) -> str | None:
    """Best-effort read of a claim from a JWT without verifying the signature."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)  # pad base64
        data = json.loads(base64.urlsafe_b64decode(payload))
        for c in claims:
            if data.get(c):
                return data[c]
    except Exception:
        pass
    return None


def get_access_token(session_id: str) -> str | None:
    """Return a valid access token for the session, refreshing silently if needed."""
    manual = _MANUAL_TOKENS.get(session_id)
    if manual:
        return manual
    s = get_settings()
    cache = _load_cache(session_id)
    app = _build_app(cache)
    accounts = app.get_accounts()
    if not accounts:
        return None
    result = app.acquire_token_silent(scopes=s.scopes, account=accounts[0])
    _save_cache(session_id, cache)
    if result and "access_token" in result:
        return result["access_token"]
    return None


def get_account_name(session_id: str) -> str | None:
    manual = _MANUAL_TOKENS.get(session_id)
    if manual:
        return _decode_jwt_claim(manual, "upn", "preferred_username", "name") or "Graph token"
    cache = _load_cache(session_id)
    app = _build_app(cache)
    accounts = app.get_accounts()
    if accounts:
        return accounts[0].get("username")
    return None


def get_token_scopes(session_id: str) -> list[str]:
    """Return the scopes (scp claim) of the current access token, for diagnostics."""
    token = get_access_token(session_id)
    if not token:
        return []
    scp = _decode_jwt_claim(token, "scp")
    return scp.split(" ") if scp else []


def logout(session_id: str) -> None:
    _CACHE_STORE.pop(session_id, None)
    _FLOW_STORE.pop(session_id, None)
    _MANUAL_TOKENS.pop(session_id, None)
