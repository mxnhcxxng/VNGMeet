"""Zalo Mini App Open API webhook.

Handles the **"Revoke and Remove User Data"** event that Zalo fires when a user
withdraws consent for the Mini App:

  - Integration:    https://docs.zaloplatforms.com/docs/MA/openApis/open/webhook/intergration-webhook
  - Event schema:   https://docs.zaloplatforms.com/docs/MA/openApis/open/webhook/eventRevokeAndRemoveUserData
  - Verify signature: https://docs.zaloplatforms.com/docs/MA/openApis/open/webhook/verifysignature

Configure the URL (POST) at https://mini.zalo.me/developers → app → Open APIs:

    https://<backend-host>/api/zalo/webhook

Zalo POSTs JSON and signs it with the header `X-ZEvent-Signature`. The signature
is SHA256(content + secret_key) where `content` is every top-level field value
concatenated in alphabetical key order (objects JSON-stringified). We use the
Mini App's `secret_key` (ZALO_APP_SECRET_KEY) as the signing secret — the same
secret already used to exchange the phone token in auth.py.

On `user.revoke.consent` we locate the user by the Zalo app-scoped `userId`
(stored on user_profiles.zalo_user_id at login) and remove the data that Zalo
gave us — i.e. the Zalo *linkage*, not the VNGMeet account.

Scope note: the Zalo Mini App is only an authentication channel. The underlying
VNGMeet account (email, bookings, chat, Microsoft link) is fully usable on the
web and is NOT Zalo-derived, so revoking Mini App consent must NOT delete it.
What we obtained through Zalo and therefore drop here:
  - `bot_links`            — the Zalo Bot conversation linkage (Zalo chat/from ids,
                             display name, phone in claims)
  - `user_profiles.zalo_user_id` — the Zalo identifier we stored for this mapping
"""

from __future__ import annotations

import hashlib
import hmac
import json

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request

from .app_context import log, settings

router = APIRouter()

REVOKE_EVENT = "user.revoke.consent"


# --------------------------------------------------------------------------- #
# Signature verification
# --------------------------------------------------------------------------- #
def _js_value(value: object) -> str:
    """Serialize one field value the way Zalo's reference JS does.

    In their sample, `typeof value == "object"` (true for objects, arrays AND
    null) is JSON.stringified; everything else is coerced by string
    concatenation. We mirror that exactly so the recomputed content matches:
      - dict / list -> JSON.stringify with no spaces
      - None        -> "null"  (typeof null === "object")
      - bool        -> "true" / "false"
      - int / float -> plain number string
      - str         -> as-is
    """
    if value is None:
        return "null"
    if isinstance(value, bool):  # before int: bool is a subclass of int
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    if isinstance(value, float) and value.is_integer():
        return str(int(value))  # 1670553442564.0 -> "1670553442564"
    return str(value)


def _expected_signature(payload: dict, secret: str) -> str:
    content = "".join(_js_value(payload[k]) for k in sorted(payload.keys()))
    return hashlib.sha256(f"{content}{secret}".encode("utf-8")).hexdigest()


def verify_zalo_signature(payload: dict, signature: str, secret: str) -> bool:
    """Constant-time check of the `X-ZEvent-Signature` header against the body."""
    if not signature or not secret:
        return False
    expected = _expected_signature(payload, secret)
    return hmac.compare_digest(expected, signature.strip().lower())


# --------------------------------------------------------------------------- #
# Unlink Zalo (remove only the Zalo-derived linkage/identifiers)
# --------------------------------------------------------------------------- #
def _delete_where(sb, table: str, column: str, value) -> int:
    """Best-effort delete; returns rows removed (0 on error, logged)."""
    try:
        res = sb.table(table).delete().eq(column, value).execute()
        return len(res.data or [])
    except Exception as e:  # noqa: BLE001
        log.warning("zalo unlink: delete %s.%s failed: %s", table, column, e)
        return 0


def unlink_zalo_user(zalo_user_id: str) -> dict:
    """Sever the Zalo linkage for the user identified by `zalo_user_id`.

    The Mini App is only an auth channel, so this does NOT touch the VNGMeet
    account (profile, bookings, chat, Microsoft token) — those live independently
    and stay usable on the web. It removes only what Zalo gave us:

      - `bot_links` rows (the Zalo Bot conversation link + its claims), matched
        via the session `sub` (= auth_user_id when Microsoft is linked, else
        user_profiles.id — see mint_zalo_session).
      - the stored `user_profiles.zalo_user_id` identifier itself.
    """
    from .supabase_client import get_supabase

    sb = get_supabase()
    profiles = (
        sb.table("user_profiles")
        .select("id, auth_user_id")
        .eq("zalo_user_id", zalo_user_id)
        .execute()
        .data
        or []
    )

    counts: dict[str, int] = {}

    def _add(table: str, n: int) -> None:
        counts[table] = counts.get(table, 0) + n

    for profile in profiles:
        profile_id = profile.get("id")
        auth_user_id = profile.get("auth_user_id")

        # Drop the Zalo Bot linkage keyed on the session sub.
        for sub in {v for v in (auth_user_id, profile_id) if v}:
            _add("bot_links", _delete_where(sb, "bot_links", "auth_user_id", sub))

        # Forget the Zalo identifier mapping (keep the rest of the profile).
        if profile_id:
            try:
                sb.table("user_profiles").update({"zalo_user_id": None}).eq(
                    "id", str(profile_id)
                ).execute()
                _add("user_profiles_unlinked", 1)
            except Exception as e:  # noqa: BLE001
                log.warning("zalo unlink: clear zalo_user_id failed: %s", e)

    return {"matched_profiles": len(profiles), "deleted": counts}


def _record_revocation(payload: dict, result: dict, purged: bool) -> None:
    """Write a compliance audit row. Never raises."""
    try:
        from .supabase_client import get_supabase

        get_supabase().table("zalo_data_revocations").insert(
            {
                "event": str(payload.get("event") or ""),
                "app_id": _as_str(payload.get("appId")),
                "zalo_user_id": str(payload.get("userId") or ""),
                "event_timestamp": _as_int(payload.get("timestamp")),
                "matched_profiles": result.get("matched_profiles", 0),
                "purged": purged,
                "detail": result.get("deleted") or {},
            }
        ).execute()
    except Exception as e:  # noqa: BLE001
        log.warning("zalo purge: audit insert failed: %s", e)


def _as_str(v) -> str | None:
    return str(v) if v is not None else None


def _as_int(v) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _handle_revoke_safe(payload: dict) -> None:
    """Background entry point: purge + audit. Swallows all errors (already 200'd)."""
    user_id = str(payload.get("userId") or "").strip()
    try:
        if not settings.supabase_enabled:
            log.warning(
                "zalo revoke for userId=%s but Supabase disabled — nothing to unlink",
                user_id,
            )
            _record_revocation(payload, {"matched_profiles": 0, "deleted": {}}, purged=False)
            return
        result = unlink_zalo_user(user_id)
        log.warning(
            "zalo revoke processed: userId=%s matched=%d removed=%s",
            user_id,
            result["matched_profiles"],
            result["deleted"],
        )
        _record_revocation(payload, result, purged=True)
    except Exception as e:  # noqa: BLE001
        log.exception("zalo revoke handling failed for userId=%s: %s", user_id, e)
        _record_revocation(payload, {"matched_profiles": 0, "deleted": {}}, purged=False)


# --------------------------------------------------------------------------- #
# Webhook endpoint
# --------------------------------------------------------------------------- #
@router.get("/api/zalo/webhook")
def zalo_webhook_health():
    """Lightweight reachability check for the configured webhook URL."""
    return {"ok": True, "service": "zalo-miniapp-webhook"}


@router.post("/api/zalo/webhook")
async def zalo_webhook(request: Request, background_tasks: BackgroundTasks):
    if not settings.zalo_app_secret_key:
        log.warning("zalo webhook hit but ZALO_APP_SECRET_KEY not configured")
        raise HTTPException(503, "Zalo Mini App webhook not configured.")

    raw = await request.body()
    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError("payload is not a JSON object")
    except Exception as e:  # noqa: BLE001
        log.warning("zalo webhook: invalid JSON body")
        raise HTTPException(400, "Invalid JSON payload.") from e

    signature = request.headers.get("X-ZEvent-Signature", "")
    if not verify_zalo_signature(payload, signature, settings.zalo_app_secret_key):
        log.warning(
            "zalo webhook rejected: bad signature (event=%s, sig_len=%d)",
            payload.get("event"),
            len(signature),
        )
        raise HTTPException(401, "Invalid signature.")

    event = payload.get("event")
    log.info("zalo webhook received: event=%s", event)

    if event == REVOKE_EVENT:
        user_id = str(payload.get("userId") or "").strip()
        if not user_id:
            log.warning("zalo revoke event missing userId — acknowledged")
            return {"ok": True}
        # Ack fast (stay under Zalo's timeout); purge runs after the 200 is sent.
        background_tasks.add_task(_handle_revoke_safe, payload)
    else:
        log.info("zalo webhook: unhandled event %r — acknowledged", event)

    return {"ok": True}
