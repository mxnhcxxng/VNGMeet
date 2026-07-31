"""Shared token-time gate for scheduled bookings and room scouts.

Both features run LATER than the request that creates them: a scheduled booking
fires at the next midnight, and a room scout keeps auto-booking until its window
ends. If the user's Microsoft Graph token expires before then, the task can't
complete — so we block at create time and hand back step-by-step refresh
guidance, mirroring step 4 of the in-app token modal (TokenExpiryProvider.tsx).

This is the server-side counterpart of the frontend `ensureTokenTime`
(TokenExpiryProvider.tsx) and is what gates the chat-bot flows, where there is
no modal to pop.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

from fastapi import HTTPException

from .auth import decode_jwt_claims, has_refresh_token

# Require the token to outlive the task by this margin — matches the frontend's
# TOKEN_BUFFER_SECONDS so both surfaces block at the same threshold.
TOKEN_BUFFER_SECONDS = 10 * 60

# Same link the in-app token modal points at (TokenExpiryProvider.tsx).
GRAPH_EXPLORER_URL = "https://developer.microsoft.com/en-us/graph/graph-explorer"


def token_seconds_left(token: str | None) -> int | None:
    """Best-effort seconds until the Graph token's `exp`. None when unknown
    (missing token / no `exp` claim) — in which case the gate never blocks."""
    if not token:
        return None
    exp = decode_jwt_claims(token).get("exp")
    if not isinstance(exp, (int, float)):
        return None
    return int(exp) - int(time.time())


def token_refresh_message(blocked_action: str) -> str:
    """User-facing guidance mirroring step 4 of the in-app token modal."""
    return (
        f"{blocked_action} vì phiên Microsoft (token) của bạn sắp hết hạn — "
        "token cần còn hiệu lực đến khi tác vụ này chạy xong.\n\n"
        "Cách làm mới token:\n"
        f"1. Mở [Microsoft Graph Explorer]({GRAPH_EXPLORER_URL})\n"
        "2. Đăng xuất tài khoản hiện tại\n"
        "3. Đăng nhập lại\n"
        "4. Sao chép token mới và cập nhật vào ứng dụng\n\n"
        "Token mới sẽ có thời hạn tối đa khoảng 24 giờ."
    )


def ensure_token_survives_until(
    token: str | None,
    target: datetime,
    *,
    blocked_action: str,
    auth_user_id: str | None = None,
) -> None:
    """Raise HTTPException(403) with refresh guidance when `token` won't stay
    valid until `target` (plus TOKEN_BUFFER_SECONDS). No-op when the expiry
    can't be determined, so unknown-expiry tokens are never blocked.

    Also a no-op for users who signed in directly with Microsoft — identified by
    a stored provider refresh token (`auth_user_id` present in `provider_tokens`).
    For them the scheduler mints a fresh Graph token from that refresh token when
    the task actually fires, so the *current* access token's expiry is irrelevant.
    Only the manual pasted-token path (no refresh token, no auto-refresh) can
    truly lapse before the task runs, so only it is gated."""
    if auth_user_id and has_refresh_token(auth_user_id):
        return
    remaining = token_seconds_left(token)
    if remaining is None:
        return
    needed = int((target - datetime.now(timezone.utc)).total_seconds())
    if remaining < needed + TOKEN_BUFFER_SECONDS:
        raise HTTPException(403, token_refresh_message(blocked_action))
