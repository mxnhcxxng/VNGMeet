"""Zalo Bot Platform integration (bot.zaloplatforms.com).

The Zalo Bot is a text-only channel (no buttons/keyboards/native command menu),
separate from the Zalo Mini App. This module:

- Receives updates via webhook (verified with X-Bot-Api-Secret-Token).
- Handles slash-commands deterministically (control flow, no LLM):
  /start /help /whoami /new /recent /switch.
- Forwards any other text to the SAME chat agent the Mini App uses, by minting a
  VNGMeet session JWT for the linked account and replaying it through
  `send_chat_message` with a synthetic request. No changes to chat.py required.
- Links a Zalo Bot conversation (chat_id) to a VNG account via a one-time pairing
  code the user redeems from the (already phone-authenticated) Mini App.

Auth states per conversation:
  S0 = chưa link (no auth_user_id) · S1 = linked + Graph token OK ·
  S2 = linked but Microsoft session expired (refresh token dead).
"""

from __future__ import annotations

import hmac
import re
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, BackgroundTasks, Body, HTTPException, Request
from starlette.requests import Request as StarletteRequest

from . import auth
from .app_context import log, settings
from .models import ChatSendRequest

router = APIRouter()

BOT_API_TIMEOUT = 30
ZALO_MAX_TEXT = 2000
EVENT_TEXT = "message.text.received"
RECENT_LIMIT = 10
KNOWN_COMMANDS = {"start", "help", "whoami", "new", "recent", "switch"}

FOOTER = "↩️ /new · /recent · /switch <số> · /help"

MSG_START = (
    "👋 Xin chào! Đây là trợ lý VNGMeet.\n"
    "• Gõ nội dung bất kỳ để chat với trợ lý.\n"
    "• /new tạo đoạn chat mới, /recent xem lại, /switch <số> để chuyển.\n"
    "• /whoami kiểm tra tài khoản. /help xem tất cả lệnh."
)
MSG_HELP = (
    "🤖 Các lệnh:\n"
    "/new [tiêu đề] – tạo đoạn chat mới\n"
    "/recent        – danh sách đoạn chat\n"
    "/switch <số>   – chuyển đoạn chat\n"
    "/whoami        – tài khoản & đoạn chat hiện tại\n"
    "/help          – menu này\n"
    "💬 Gõ nội dung (không bắt đầu bằng \"/\") để chat với trợ lý."
)
MSG_UNKNOWN = "❓ Lệnh không tồn tại. Gõ /help để xem các lệnh."
MSG_SWITCH_INVALID = "⚠️ Số không hợp lệ. Gõ /recent để xem danh sách rồi /switch <số>."
MSG_RECENT_EMPTY = "📭 Chưa có đoạn chat nào. Gõ /new để tạo mới."
MSG_GENERIC_ERROR = "⚠️ Có lỗi xảy ra, bạn thử lại sau nhé."


# --------------------------------------------------------------------------- #
# Small utils
# --------------------------------------------------------------------------- #
def _now() -> datetime:
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now().isoformat()


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


_THINK_BLOCK_RE = re.compile(r"(?is)<think\b[^>]*>.*?</think>")
_THINK_TAG_RE = re.compile(r"(?is)</?think\b[^>]*>")


def _strip_think(text: str) -> str:
    """Remove <think>…</think> reasoning blocks before sending to Zalo.

    The agent may prefix replies with a reasoning block (see chat.py
    _assistant_content_with_reasoning); the Mini App hides it, so the bot must
    strip it too. Also drops any stray/unclosed think tag as a fallback.
    """
    if not text:
        return text
    cleaned = _THINK_BLOCK_RE.sub("", text)
    cleaned = _THINK_TAG_RE.sub("", cleaned)
    return cleaned.strip()


# Zalo Bot chỉ hiển thị text thuần (không markdown), nên phải "phẳng hoá" reply.
_IMG_MD_RE = re.compile(r"!\[[^\]]*\]\((https?://[^)\s]+)\)")
_LINK_MD_RE = re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+)\)")
_TABLE_SEP_RE = re.compile(r"^\|?[\s:\-|]*-[\s:\-|]*\|?$")


def _md_to_plain(text: str) -> str:
    """Convert Markdown to plain text for Zalo (no markdown rendering).

    Handles headings, **bold**/__bold__/`code`, [text](url) → "text (url)", and
    tables (drop the |---| separator row, keep cells joined by ' | '). Images are
    expected to be removed beforehand (sent via sendPhoto).
    """
    if not text:
        return text
    out = text
    out = re.sub(r"(?m)^\s{0,3}#{1,6}\s*", "", out)          # headings
    out = re.sub(r"\*\*(.+?)\*\*", r"\1", out, flags=re.S)    # **bold**
    out = re.sub(r"__(.+?)__", r"\1", out, flags=re.S)        # __bold__
    out = re.sub(r"(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])", r"\1", out)  # *italic*
    out = re.sub(r"`([^`]+)`", r"\1", out)                    # `code`
    out = _LINK_MD_RE.sub(r"\1 (\2)", out)                    # [text](http url) -> text (url)
    out = re.sub(r"\[([^\]]+)\]\([^)\s]*\)", r"\1", out)      # [text](relative) -> text
    lines: list[str] = []
    for line in out.split("\n"):
        stripped = line.strip()
        if "|" in stripped and _TABLE_SEP_RE.match(stripped):
            continue  # markdown table separator row
        if "|" in line:
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            line = " | ".join(c for c in cells if c != "")
        line = re.sub(r"^\s*[-*]\s+", "• ", line)             # bullets
        lines.append(line)
    out = "\n".join(lines)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()


def _prepare_reply(text: str) -> tuple[str, list[str]]:
    """Strip reasoning, pull out image URLs (for sendPhoto), flatten Markdown.

    Returns (plain_text, image_urls). The original hyperlink to a map is kept as
    text too, so if sendPhoto fails the user still has the link.
    """
    text = _strip_think(text)
    images: list[str] = []
    for url in _IMG_MD_RE.findall(text):
        if url not in images:
            images.append(url)
    text = _IMG_MD_RE.sub("", text)     # remove ![..](url); resend as photos
    text = _md_to_plain(text)
    return text, images


def _parse_int(value: str) -> int | None:
    value = (value or "").strip()
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _sb():
    if not settings.supabase_enabled:
        raise HTTPException(503, "Bot requires Supabase configuration.")
    from .supabase_client import get_supabase

    return get_supabase()


# --------------------------------------------------------------------------- #
# Link + pairing store
# --------------------------------------------------------------------------- #
def _get_link(sb, chat_id: str) -> dict | None:
    rows = (
        sb.table("bot_links").select("*").eq("chat_id", chat_id).limit(1).execute().data
        or []
    )
    return rows[0] if rows else None


def _upsert_link(sb, chat_id: str, **fields) -> None:
    payload = {"chat_id": chat_id, "updated_at": _now_iso(), **fields}
    sb.table("bot_links").upsert(payload, on_conflict="chat_id").execute()


def _set_current_thread(sb, chat_id: str, thread_id: str | None) -> None:
    sb.table("bot_links").update(
        {"current_thread_id": thread_id, "updated_at": _now_iso()}
    ).eq("chat_id", chat_id).execute()


def _create_pairing(sb, chat_id: str, from_id: str | None) -> str:
    code = secrets.token_urlsafe(9)
    expires = _now() + timedelta(seconds=settings.bot_pairing_ttl_seconds)
    sb.table("bot_pairings").insert(
        {
            "code": code,
            "chat_id": chat_id,
            "from_id": from_id,
            "expires_at": expires.isoformat(),
        }
    ).execute()
    return code


def _consume_pairing(sb, code: str) -> dict | None:
    rows = (
        sb.table("bot_pairings").select("*").eq("code", code).limit(1).execute().data
        or []
    )
    if not rows:
        return None
    row = rows[0]
    if row.get("used_at"):
        return None
    expires = _parse_iso(row.get("expires_at"))
    if not expires or expires < _now():
        return None
    sb.table("bot_pairings").update({"used_at": _now_iso()}).eq("code", code).execute()
    return row


def _miniapp_link_with(param: str, value: str) -> str:
    """Append a query param to BOT_MINIAPP_LINK, preserving its path/query/fragment.

    Robust to both forms of the configured link:
      - https://zalo.me/s/<id>/                       -> ...?bot_pair=<code>
      - https://zalo.me/s/<id>/?env=DEVELOPMENT&...    -> ...&bot_pair=<code>
    Falls back to public_url (web frontend) if BOT_MINIAPP_LINK is unset — in
    which case linking won't work until it's configured to open the Mini App.
    """
    base = (settings.bot_miniapp_link or settings.public_url or "").strip()
    parts = urlsplit(base)
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != param]
    query.append((param, value))
    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)
    )


def _pair_link(code: str) -> str:
    return _miniapp_link_with("bot_pair", code)


def _reauth_link() -> str:
    return _miniapp_link_with("bot_reauth", "1")


# --------------------------------------------------------------------------- #
# Auth state + synthetic request bridge to the chat agent
# --------------------------------------------------------------------------- #
def _pool_graph_token() -> tuple[str, int] | None:
    """Newest active delegated Graph token from graph_token_pool → (token, expires_in).

    This deployment authenticates via pasted Graph tokens (pool), not per-user
    Microsoft OAuth (provider_tokens is empty). Bot users have no token of their
    own, so the agent acts with a shared pool token. Returns None if none usable.
    """
    if not settings.supabase_enabled:
        return None
    from .bookings import _decrypt_scheduled_graph_token

    sb = _sb()
    now = _now()
    rows = (
        sb.table("graph_token_pool")
        .select("owner_key, token_encrypted, expires_at")
        .eq("status", "active")
        .gt("expires_at", now.isoformat())
        .order("updated_at", desc=True)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        return None
    row = rows[0]
    try:
        token = _decrypt_scheduled_graph_token(row.get("token_encrypted"))
    except Exception as e:  # noqa: BLE001
        log.warning("bot: could not decrypt pool token %s: %s", row.get("owner_key"), e)
        return None
    if not token:
        return None
    exp = _parse_iso(row.get("expires_at"))
    expires_in = int((exp - now).total_seconds()) if exp else 0
    if expires_in <= 120:  # too close to expiry to be useful mid-turn
        return None
    return token, expires_in


async def _ensure_graph_token(sub: str) -> bool:
    """Make a valid Graph token available for `sub`, seeding the auth cache from
    the pool when the per-user provider_tokens path has nothing."""
    try:
        await auth.get_graph_token(sub)
        return True
    except Exception:  # noqa: BLE001 — provider_tokens empty / refresh failed
        pass
    pooled = _pool_graph_token()
    if not pooled:
        return False
    token, expires_in = pooled
    # get_graph_token() checks _GRAPH_TOKEN_CACHE first, so seeding it here makes
    # both this bot turn and the downstream send_chat_message use the pool token.
    auth.cache_graph_token(sub, token, expires_in)
    return True


async def _auth_state(link: dict | None) -> tuple[str, dict]:
    claims = (link or {}).get("claims") or {}
    sub = claims.get("sub")
    if not sub:
        return "S0", claims
    try:
        ok = await _ensure_graph_token(sub)
    except Exception as e:  # noqa: BLE001
        log.warning("bot graph-token probe failed for %s: %s", sub, e)
        return "S2", claims
    return ("S1", claims) if ok else ("S2", claims)


def _synthetic_request(bearer: str) -> Request:
    """A minimal Starlette Request carrying a Bearer token.

    The chat/booking code only reads `request.headers["Authorization"]` (bearer
    path) to resolve identity — no body/session access — so this is enough to
    replay the linked user's identity through the existing endpoints unchanged.
    """
    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/internal/bot",
        "raw_path": b"/internal/bot",
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"authorization", f"Bearer {bearer}".encode()),
            (b"content-type", b"application/json"),
        ],
        "client": ("127.0.0.1", 0),
        "server": ("127.0.0.1", 80),
    }

    async def _receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    return StarletteRequest(scope, _receive)


def _linked_request(link: dict) -> Request:
    bearer = auth.mint_zalo_session(link["claims"])
    return _synthetic_request(bearer)


async def _forward_to_agent(sb, link: dict, text: str) -> tuple[str, list[str]]:
    from .chat import send_chat_message

    req = _linked_request(link)
    payload = ChatSendRequest(content=text, thread_id=link.get("current_thread_id"))
    result = await send_chat_message(req, payload)
    thread = result.get("thread") or {}
    tid = thread.get("id")
    if tid and str(tid) != str(link.get("current_thread_id") or ""):
        _set_current_thread(sb, link["chat_id"], str(tid))
    reply = ""
    for message in result.get("messages") or []:
        if message.get("role") == "assistant":
            reply = message.get("content") or ""
    return _prepare_reply(reply)


def _list_threads(link: dict) -> list[dict]:
    from .chat import list_chat_threads

    return list_chat_threads(_linked_request(link)).get("threads") or []


def _create_named_thread(link: dict, title: str) -> dict:
    from .chat import _create_thread, _current_user_profile_id, _require_supabase_chat

    req = _linked_request(link)
    sb = _require_supabase_chat()
    user_profile_id = _current_user_profile_id(req)
    return _create_thread(sb, user_profile_id, title)


async def _current_thread_title(link: dict) -> str:
    tid = link.get("current_thread_id")
    if not tid:
        return "(chưa có — gõ nội dung để bắt đầu)"
    for thread in _list_threads(link):
        if str(thread.get("id")) == str(tid):
            return thread.get("title") or "(không tên)"
    return "(không tìm thấy)"


# --------------------------------------------------------------------------- #
# Zalo Bot API client
# --------------------------------------------------------------------------- #
async def _bot_api(method: str, payload: dict) -> httpx.Response | None:
    url = f"{settings.zalo_bot_api_base}/{method}"
    try:
        async with httpx.AsyncClient(timeout=BOT_API_TIMEOUT) as client:
            resp = await client.post(url, json=payload)
    except httpx.HTTPError as e:
        log.warning("Zalo bot %s request error: %s", method, e)
        return None
    if resp.status_code >= 400:
        log.warning("Zalo bot %s failed: %s %s", method, resp.status_code, resp.text[:300])
    return resp


def _chunk_text(text: str, limit: int = ZALO_MAX_TEXT) -> list[str]:
    text = text or ""
    if len(text) <= limit:
        return [text] if text else []
    chunks: list[str] = []
    remaining = text
    while len(remaining) > limit:
        cut = remaining.rfind("\n", 0, limit)
        if cut <= 0:
            cut = remaining.rfind(" ", 0, limit)
        if cut <= 0:
            cut = limit
        chunks.append(remaining[:cut].rstrip())
        remaining = remaining[cut:].lstrip()
    if remaining:
        chunks.append(remaining)
    return chunks


async def _send(chat_id: str, text: str) -> None:
    for chunk in _chunk_text(text):
        await _bot_api("sendMessage", {"chat_id": chat_id, "text": chunk})


async def _send_photo(chat_id: str, url: str, caption: str | None = None) -> None:
    payload = {"chat_id": chat_id, "photo": url}
    if caption:
        payload["caption"] = caption[:ZALO_MAX_TEXT]
    await _bot_api("sendPhoto", payload)


async def _typing(chat_id: str) -> None:
    await _bot_api("sendChatAction", {"chat_id": chat_id, "action": "typing"})


# --------------------------------------------------------------------------- #
# State-dependent messages (need pairing/reauth deep-links)
# --------------------------------------------------------------------------- #
def _msg_not_linked(sb, chat_id: str, from_id: str | None) -> str:
    code = _create_pairing(sb, chat_id, from_id)
    return (
        "🔒 Bạn chưa liên kết tài khoản VNG.\n"
        "Mở mini app để liên kết rồi quay lại chat nhé:\n"
        f"👉 {_pair_link(code)}"
    )


def _msg_session_expired() -> str:
    return (
        "⏰ Phiên đăng nhập đã hết hạn.\n"
        "Mở mini app đăng nhập lại để tiếp tục:\n"
        f"👉 {_reauth_link()}"
    )


# --------------------------------------------------------------------------- #
# Command handlers
# --------------------------------------------------------------------------- #
def _parse_command(text: str) -> tuple[str | None, str]:
    """Detect a slash-command ONLY when '/' is the first non-space char.

    So "2/3/2002" or "hỏi về /etc/hosts" are treated as normal chat, not commands.
    """
    stripped = (text or "").lstrip()
    if not stripped.startswith("/"):
        return None, ""
    parts = stripped[1:].split(maxsplit=1)
    if not parts:
        return None, ""
    cmd = parts[0].lower().split("@", 1)[0]  # tolerate /help@botname
    arg = parts[1].strip() if len(parts) > 1 else ""
    return cmd, arg


async def _cmd_whoami(sb, link: dict, chat_id: str, from_id: str | None) -> None:
    state, claims = await _auth_state(link)
    if state == "S0":
        await _send(chat_id, _msg_not_linked(sb, chat_id, from_id))
        return
    if state == "S2":
        await _send(chat_id, _msg_session_expired())
        return
    name = claims.get("name") or claims.get("email") or "(không rõ)"
    title = await _current_thread_title(link)
    await _send(chat_id, f"👤 Tài khoản: {name}\n💬 Đoạn chat hiện tại: {title}")


async def _cmd_new(sb, link: dict, chat_id: str, arg: str) -> None:
    title = (arg or "").strip()
    if title:
        thread = _create_named_thread(link, title)
        _set_current_thread(sb, chat_id, str(thread["id"]))
        await _send(
            chat_id,
            f"✅ Đã tạo đoạn chat mới: {thread.get('title')}.\nGõ nội dung để bắt đầu.",
        )
        return
    _set_current_thread(sb, chat_id, None)
    await _send(chat_id, "✅ Đã tạo đoạn chat mới.\nGõ nội dung để bắt đầu.")


async def _cmd_recent(link: dict, chat_id: str) -> None:
    threads = _list_threads(link)
    if not threads:
        await _send(chat_id, MSG_RECENT_EMPTY)
        return
    current = str(link.get("current_thread_id") or "")
    lines = []
    for idx, thread in enumerate(threads[:RECENT_LIMIT], 1):
        title = thread.get("title") or "(không tên)"
        mark = " ⬅️" if str(thread.get("id")) == current else ""
        lines.append(f"{idx}. {title}{mark}")
    await _send(chat_id, "📋 Đoạn chat gần đây:\n" + "\n".join(lines) + f"\n{FOOTER}")


async def _cmd_switch(sb, link: dict, chat_id: str, arg: str) -> None:
    n = _parse_int(arg)
    if n is None or n < 1:
        await _send(chat_id, MSG_SWITCH_INVALID)
        return
    threads = _list_threads(link)[:RECENT_LIMIT]
    if n > len(threads):
        await _send(chat_id, MSG_SWITCH_INVALID)
        return
    thread = threads[n - 1]
    _set_current_thread(sb, chat_id, str(thread["id"]))
    await _send(chat_id, f"🔄 Đã chuyển sang: {thread.get('title') or '(không tên)'}\n{FOOTER}")


async def _dispatch_command(
    sb, link: dict, chat_id: str, from_id: str | None, cmd: str, arg: str
) -> None:
    if cmd not in KNOWN_COMMANDS:
        await _send(chat_id, MSG_UNKNOWN)
        return
    if cmd == "start":
        await _send(chat_id, MSG_START)
        return
    if cmd == "help":
        await _send(chat_id, MSG_HELP)
        return
    if cmd == "whoami":
        await _cmd_whoami(sb, link, chat_id, from_id)
        return

    # Gated commands (/new /recent /switch) require a linked, non-expired session.
    state, _claims = await _auth_state(link)
    if state == "S0":
        await _send(chat_id, _msg_not_linked(sb, chat_id, from_id))
        return
    if state == "S2":
        await _send(chat_id, _msg_session_expired())
        return
    if cmd == "new":
        await _cmd_new(sb, link, chat_id, arg)
    elif cmd == "recent":
        await _cmd_recent(link, chat_id)
    elif cmd == "switch":
        await _cmd_switch(sb, link, chat_id, arg)


async def _dispatch_chat(sb, link: dict, chat_id: str, from_id: str | None, text: str) -> None:
    state, _claims = await _auth_state(link)
    if state == "S0":
        await _send(chat_id, _msg_not_linked(sb, chat_id, from_id))
        return
    if state == "S2":
        await _send(chat_id, _msg_session_expired())
        return
    await _typing(chat_id)
    link = _get_link(sb, chat_id) or link  # re-read: current_thread_id may have changed
    try:
        reply, images = await _forward_to_agent(sb, link, text)
    except HTTPException as e:
        if e.status_code == 401:
            await _send(chat_id, _msg_session_expired())
            return
        raise
    if reply:
        await _send(chat_id, reply)
    elif not images:
        await _send(chat_id, "Mình chưa có câu trả lời phù hợp, bạn thử lại nhé.")
    # Map/ảnh: gửi thẳng cho user qua sendPhoto (Zalo không render markdown image).
    for url in images:
        await _send_photo(chat_id, url)


# --------------------------------------------------------------------------- #
# Update handling
# --------------------------------------------------------------------------- #
async def _handle_update(update: dict) -> None:
    # Webhook thực tế đẩy {event_name, message, ...} ở TOP-LEVEL (không bọc trong
    # `result` như doc mô tả). Hỗ trợ cả 2 dạng cho chắc.
    body = update.get("result") if isinstance(update.get("result"), dict) else update
    if body.get("event_name") != EVENT_TEXT:
        log.info("bot update skipped: non-text event=%s", body.get("event_name"))
        return  # images/stickers/voice/etc. not supported by this bot yet
    message = body.get("message") or {}
    chat = message.get("chat") or {}
    sender = message.get("from") or {}
    chat_id = str(chat.get("id") or "")
    from_id = str(sender.get("id") or "") or None
    text = (message.get("text") or "").strip()
    if not chat_id or not text:
        log.info("bot update skipped: chat_id=%r text_empty=%s", chat_id, not text)
        return
    log.info("bot handling: chat_id=%s text=%r", chat_id, text[:80])

    sb = _sb()
    link = _get_link(sb, chat_id)
    if link is None:
        _upsert_link(
            sb, chat_id, from_id=from_id, display_name=sender.get("display_name")
        )
        link = _get_link(sb, chat_id)

    cmd, arg = _parse_command(text)
    try:
        if cmd:
            await _dispatch_command(sb, link, chat_id, from_id, cmd, arg)
        else:
            await _dispatch_chat(sb, link, chat_id, from_id, text)
    except HTTPException as e:
        log.warning("bot handler HTTPException (%s): %s", e.status_code, e.detail)
        await _send(chat_id, MSG_GENERIC_ERROR)
    except Exception as e:  # noqa: BLE001
        log.exception("bot handler error: %s", e)
        await _send(chat_id, MSG_GENERIC_ERROR)


async def _handle_update_safe(update: dict) -> None:
    try:
        await _handle_update(update)
    except Exception as e:  # noqa: BLE001 — background task must never crash silently
        log.exception("bot update failed: %s", e)


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@router.post("/api/bot/webhook")
async def bot_webhook(request: Request, background_tasks: BackgroundTasks):
    if not settings.zalo_bot_enabled:
        log.warning("bot webhook hit but ZALO_BOT_* not configured")
        raise HTTPException(503, "Zalo bot not configured.")
    secret = request.headers.get("X-Bot-Api-Secret-Token", "")
    if not hmac.compare_digest(secret, settings.zalo_bot_secret_token):
        log.warning("bot webhook rejected: secret token mismatch (got %d chars)", len(secret))
        raise HTTPException(401, "Invalid secret token.")
    try:
        update = await request.json()
    except Exception as e:  # noqa: BLE001
        log.warning("bot webhook: invalid JSON body")
        raise HTTPException(400, "Invalid JSON payload.") from e
    # Diagnostic: dump the raw payload shape once so we can see exactly what Zalo
    # sends (event_name / message structure). Trim to keep logs readable.
    import json as _json

    log.info("bot webhook raw: %s", _json.dumps(update, ensure_ascii=False)[:800])
    # Ack fast so the webhook stays under Zalo's timeout; the LLM turn can be slow.
    # BackgroundTasks (not bare create_task) so Starlette holds the reference and
    # the handler reliably runs after the 200 is sent — a fire-and-forget task can
    # be garbage-collected before it writes to the DB.
    background_tasks.add_task(_handle_update_safe, update)
    return {"ok": True}


@router.post("/api/bot/link")
async def bot_link(request: Request, code: str = Body(..., embed=True)):
    """Redeem a pairing code from the (authenticated) Mini App to link the bot.

    Requires the Mini App's Bearer session; binds the bot conversation named by
    the pairing code to this VNG account.
    """
    from .profiles import _claims_from_bearer

    claims = _claims_from_bearer(request)
    sub = claims.get("sub")
    if not sub:
        raise HTTPException(401, "Không xác định được tài khoản.")

    sb = _sb()
    pairing = _consume_pairing(sb, code.strip())
    if not pairing:
        raise HTTPException(400, "Mã liên kết không hợp lệ hoặc đã hết hạn.")

    # Minimal claims needed to re-mint a session JWT for the bot later. Exclude
    # iss/aud/iat/exp so mint_zalo_session stamps fresh ones. `profile_id` is
    # REQUIRED: the Zalo session path in _upsert_user_profile resolves the user
    # straight from profile_id (Zalo sessions have no email-like claim), so
    # without it the bot's replayed requests would 503.
    stored = {
        key: claims[key]
        for key in (
            "sub",
            "profile_id",
            "email",
            "name",
            "preferred_username",
            "upn",
            "phone",
            "graph_user_id",
        )
        if claims.get(key)
    }
    if not stored.get("profile_id"):
        raise HTTPException(400, "Session thiếu profile_id — không thể liên kết bot.")
    _upsert_link(
        sb,
        pairing["chat_id"],
        from_id=pairing.get("from_id"),
        auth_user_id=sub,
        claims=stored,
    )

    name = stored.get("name") or stored.get("email") or "bạn"
    if settings.zalo_bot_enabled:
        try:
            await _send(
                pairing["chat_id"],
                f"✅ Đã liên kết tài khoản {name}. Giờ bạn có thể chat với trợ lý ngay tại đây!",
            )
        except Exception as e:  # noqa: BLE001 — linking still succeeded
            log.warning("bot link notify failed: %s", e)
    return {"ok": True}
