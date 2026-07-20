"""Auth and user profile routes/helpers."""

from __future__ import annotations

import time
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import JSONResponse

from . import auth, token_pool
from .app_context import log, settings
from .models import UserProfileUpdateRequest

router = APIRouter()


def _update_pending_scheduled_graph_token(*args, **kwargs) -> None:
    from .bookings import _update_pending_scheduled_graph_token as update

    update(*args, **kwargs)

def _profile_email(claims: dict) -> str | None:
    for key in ("email", "upn", "preferred_username", "unique_name", "name"):
        value = claims.get(key)
        if isinstance(value, str) and "@" in value:
            return value.strip().lower()
    return None


def _profile_display_name(claims: dict) -> str:
    return (
        _profile_email(claims)
        or next(
            (
                value.strip()
                for key in ("name", "preferred_username", "upn", "email", "unique_name")
                if isinstance((value := claims.get(key)), str) and value.strip()
            ),
            "Graph token",
        )
    )


def _profile_auth_user_id(claims: dict) -> str | None:
    value = claims.get("sub")
    if not isinstance(value, str):
        return None
    try:
        UUID(value)
    except ValueError:
        return None
    return value


def _upsert_user_profile(claims: dict) -> str | None:
    """Mirror the signed-in user into public.user_profiles."""
    # Session Zalo (login bằng SĐT): profile đã được tra lúc login và nhét sẵn
    # `profile_id` vào JWT → dùng THẲNG id đó, bỏ qua toàn bộ bước upsert theo
    # email. Bước upsert kia không dùng được cho Zalo: session không có email @,
    # và `auth_user_id` có thể = profile.id (không tồn tại trong auth.users) →
    # vi phạm khoá ngoại → exception → trả None → 503.
    pid = claims.get("profile_id")
    if isinstance(pid, str) and pid.strip():
        return pid.strip()

    user_id = _profile_auth_user_id(claims)
    email = _profile_email(claims)
    if not email:
        log.warning("could not upsert user profile: token has no email-like claim")
        return None
    if not settings.supabase_enabled:
        log.warning("could not upsert user profile: Supabase service role not configured")
        return None
    try:
        from .supabase_client import get_supabase

        now = datetime.now(timezone.utc).isoformat()
        payload = {
            "email": email,
            "last_seen_at": now,
            "updated_at": now,
        }
        if user_id:
            payload["auth_user_id"] = user_id
        phone = claims.get("phone")
        if isinstance(phone, str) and phone.strip():
            payload["phone"] = phone.strip()
        supabase = get_supabase()
        res = (
            supabase.table("user_profiles")
            .upsert(payload, on_conflict="email")
            .execute()
        )
        if res.data and res.data[0].get("id"):
            return str(res.data[0]["id"])

        res = (
            supabase.table("user_profiles")
            .select("id")
            .eq("email", email)
            .limit(1)
            .execute()
        )
        return str(res.data[0]["id"]) if res.data else None
    except Exception as e:  # noqa: BLE001 - profile mirroring must not block login
        log.warning("could not upsert user profile: %s", e)
        return None


def _profile_is_complete(profile: dict | None) -> bool:
    if not profile:
        return False
    office = str(profile.get("office") or "").strip()
    return bool(office)


def _profile_field_options() -> dict[str, list[dict]]:
    if not settings.supabase_enabled:
        raise HTTPException(503, "User profile options require Supabase configuration.")
    try:
        from .supabase_client import get_supabase

        rows = (
            get_supabase()
            .table("user_profile_field_options")
            .select("field, value, label, parent_field, parent_value, display_order")
            .eq("enabled", True)
            .order("display_order")
            .execute()
            .data
            or []
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Could not load user profile options: {e}")

    options = {"office": [], "floor": [], "building": [], "preferredRooms": []}
    for row in rows:
        field = row.get("field")
        if field not in options:
            continue
        options[field].append(
            {
                "value": row.get("value") or "",
                "label": row.get("label") or row.get("value") or "",
                "parentField": row.get("parent_field"),
                "parentValue": row.get("parent_value"),
            }
        )

    try:
        from .supabase_client import get_supabase

        room_rows = (
            get_supabase()
            .table("meeting_room_metadata")
            .select("name, email, office")
            .eq("in_use", True)
            .order("name")
            .execute()
            .data
            or []
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Could not load room options: {e}")

    for row in room_rows:
        email = (row.get("email") or "").strip().lower()
        if not email:
            continue
        options["preferredRooms"].append(
            {
                "value": email,
                "label": row.get("name") or email,
                "parentField": "office",
                "parentValue": row.get("office"),
            }
        )
    return options


def _validate_profile_selection(values: dict) -> dict:
    options = _profile_field_options()

    def allowed(field: str, value: str, parent_value: str | None = None) -> bool:
        for option in options[field]:
            if option["value"] != value:
                continue
            if parent_value is None:
                return option.get("parentValue") in (None, "")
            return option.get("parentValue") == parent_value
        return False

    office = str(values.get("office") or "").strip()
    floor = str(values.get("floor") or "").strip()
    building = str(values.get("building") or "").strip()
    preferred_rooms = [
        str(room or "").strip().lower()
        for room in (values.get("preferred_rooms") or [])
        if str(room or "").strip()
    ]

    if not office or not allowed("office", office):
        raise HTTPException(400, "Office không hợp lệ.")

    if len(preferred_rooms) > 3:
        raise HTTPException(400, "Prefered rooms chỉ được chọn tối đa 3 phòng.")

    room_options = options["preferredRooms"]
    room_values = {room["value"]: room for room in room_options}
    for room in preferred_rooms:
        option = room_values.get(room)
        if not option or option.get("parentValue") != office:
            raise HTTPException(400, "Prefered room không hợp lệ với office đã chọn.")

    if office != "campus":
        return {
            "office": office,
            "floor": "",
            "building": "",
            "preferred_rooms": preferred_rooms,
        }

    if floor and not allowed("floor", floor, office):
        raise HTTPException(400, "Floor không hợp lệ.")
    if building and not allowed("building", building, office):
        raise HTTPException(400, "Building không hợp lệ.")
    return {
        "office": office,
        "floor": floor,
        "building": building,
        "preferred_rooms": preferred_rooms,
    }


def _profile_payload(profile: dict | None, email: str | None = None) -> dict | None:
    if not profile and not email:
        return None
    row = profile or {}
    profile_email = (row.get("email") or email or "").strip().lower()
    return {
        "email": profile_email,
        "email_username": row.get("email_username")
        or (profile_email.split("@", 1)[0] if "@" in profile_email else ""),
        "phone": row.get("phone") or "",
        "office": row.get("office") or "",
        "floor": row.get("floor") or "",
        "building": row.get("building") or "",
        "preferred_rooms": row.get("preferred_rooms") or [],
        "book_without_confirmation": bool(row.get("book_without_confirmation")),
        "theme": row.get("theme") or "system",
        "language": row.get("language") or "vi",
        "role": row.get("role") or "user",
    }


def _read_user_profile(profile_id: str | None, email: str | None = None) -> dict | None:
    if not settings.supabase_enabled or not profile_id and not email:
        return None
    try:
        from .supabase_client import get_supabase

        query = (
            get_supabase()
            .table("user_profiles")
            .select(
                "id, email, email_username, phone, office, floor, building, "
                "preferred_rooms, book_without_confirmation, theme, language, role"
            )
            .limit(1)
        )
        if profile_id:
            query = query.eq("id", profile_id)
        else:
            query = query.eq("email", email)
        res = query.execute()
        return res.data[0] if res.data else None
    except Exception as e:  # noqa: BLE001 - profile reads should not break auth checks
        log.warning("could not read user profile: %s", e)
        return None


def _me_profile_response(claims: dict) -> tuple[dict | None, bool]:
    email = _profile_email(claims)
    if not settings.supabase_enabled:
        return _profile_payload(None, email), True

    profile_id = _upsert_user_profile(claims)
    profile = _read_user_profile(profile_id, email)
    return _profile_payload(profile, email), _profile_is_complete(profile)


def _claims_from_bearer(request: Request) -> dict:
    bearer = request.headers.get("Authorization", "")
    if not bearer.startswith("Bearer "):
        raise HTTPException(401, "Not authenticated")
    return auth.verify_bearer(bearer[len("Bearer ") :])


def _request_identity(request: Request) -> tuple[str | None, str | None]:
    """Return (auth.users id, email) for either auth path without fetching Graph."""
    bearer = request.headers.get("Authorization", "")
    if bearer.startswith("Bearer "):
        claims = _claims_from_bearer(request)
        return claims.get("sub"), _profile_email(claims)

    token = auth.get_manual_token(auth.session_id(request))
    if not token:
        raise HTTPException(401, "Not authenticated")
    claims = auth.get_manual_claims(auth.session_id(request))
    return None, _profile_email(claims)


async def _booking_auth_context(
    request: Request,
) -> tuple[str, str | None, str | None, str | None]:
    """Return Graph token, auth.users id, user_profiles id, and email."""
    if request.headers.get("Authorization", "").startswith("Bearer "):
        claims = _claims_from_bearer(request)
        auth_user_id = claims["sub"]
        graph_token = await auth.get_graph_token(auth_user_id)
        return (
            graph_token,
            auth_user_id,
            _upsert_user_profile(claims),
            _profile_email(claims),
        )

    token = auth.get_manual_token(auth.session_id(request))
    if not token:
        raise HTTPException(401, "Not authenticated")
    claims = auth.get_manual_claims(auth.session_id(request))
    return token, None, _upsert_user_profile(claims), _profile_email(claims)


@router.post("/api/auth/token")
async def set_token(request: Request, access_token: str = Body(..., embed=True)):
    """Manual mode: paste a Graph access token (e.g. from Graph Explorer).

    Token does not auto-refresh — paste again when it expires (~1h). Works without
    admin consent / Supabase.
    """
    if not access_token or not access_token.strip():
        raise HTTPException(400, "access_token rỗng")
    claims = await auth.verify_manual_graph_token(access_token)
    sid = auth.session_id(request)
    auth.set_manual_token(sid, access_token, claims)
    user_profile_id = _upsert_user_profile(claims)
    _update_pending_scheduled_graph_token(
        access_token,
        user_profile_id=user_profile_id,
    )
    if user_profile_id:
        token_pool.save_token(
            user_profile_id, access_token, user_email=_profile_email(claims)
        )
    return JSONResponse({"ok": True, "username": _profile_display_name(claims)})


def _lookup_profile_by_phone(phone: str) -> dict | None:
    if not settings.supabase_enabled:
        return None
    from .supabase_client import get_supabase

    res = (
        get_supabase()
        .table("user_profiles")
        .select("id, auth_user_id, email, email_username, phone")
        .eq("phone", phone)
        .limit(1)
        .execute()
    )
    return res.data[0] if res.data else None


@router.post("/api/auth/zalo")
async def auth_zalo(
    request: Request,
    token: str = Body(..., embed=True),
    access_token: str = Body(..., embed=True),
):
    """Mini App: đăng nhập bằng SĐT Zalo.

    Ý tưởng: SĐT → tra `user_profiles` ra user nào → CẤP SESSION CHO USER ĐÓ LUÔN.
    Không kiểm tra gì thêm lúc login (đọc chat chỉ cần biết user là ai). Việc gửi
    tin nhắn sau này cần Graph token thì BE tự lấy qua Microsoft refresh_token đã
    lưu của chính user đó — với điều kiện user đã link Microsoft từ trước.
    """
    phone = await auth.resolve_zalo_phone(token, access_token)

    profile = _lookup_profile_by_phone(phone)
    # 403 = SĐT chưa có trong VNGMeet (user chưa từng được tạo/liên kết) → client
    # hiện màn "Vui lòng liên kết Microsoft trước".
    if not profile:
        raise HTTPException(403, "Số điện thoại chưa được đăng ký trong VNGMeet.")

    email = profile.get("email") or ""
    session_claims = {
        # sub = auth.users UUID nếu có → get_graph_token(sub) chạy được khi gửi chat.
        # Nếu profile chưa có auth_user_id, vẫn auth được để ĐỌC, chỉ là chưa gửi
        # được tin (chưa link Microsoft) — đúng tinh thần "map ra user là auth luôn".
        "sub": profile.get("auth_user_id") or str(profile["id"]),
        "profile_id": str(profile["id"]),
        "email": email,
        "preferred_username": email,
        "name": profile.get("email_username") or email,
        "phone": phone,
    }
    session_jwt = auth.mint_zalo_session(session_claims)
    return JSONResponse(
        {"access_token": session_jwt, "username": session_claims["name"]}
    )


@router.post("/api/auth/link")
async def link_microsoft(
    request: Request,
    provider_refresh_token: str = Body(..., embed=True),
    provider_access_token: str | None = Body(None, embed=True),
):
    """Supabase mode: store the Microsoft refresh token after Azure sign-in."""
    bearer = request.headers.get("Authorization", "")
    if not bearer.startswith("Bearer "):
        raise HTTPException(401, "Not authenticated")
    claims = auth.verify_bearer(bearer[len("Bearer ") :])
    if not provider_refresh_token or not provider_refresh_token.strip():
        raise HTTPException(400, "provider_refresh_token rỗng")
    auth_user_id = claims["sub"]
    auth.store_refresh_token(auth_user_id, provider_refresh_token.strip())

    graph_token = (provider_access_token or "").strip()
    if graph_token:
        token_exp = auth.decode_jwt_claims(graph_token).get("exp")
        expires_in = (
            max(0, int(token_exp) - int(time.time()))
            if isinstance(token_exp, (int, float))
            else 3600
        )
        auth.cache_graph_token(auth_user_id, graph_token, expires_in)
    else:
        auth.invalidate_graph_token(auth_user_id)
        graph_token = await auth.get_graph_token(auth_user_id)

    user_profile_id = _upsert_user_profile(claims)
    _update_pending_scheduled_graph_token(
        graph_token,
        user_profile_id=user_profile_id,
        auth_user_id=auth_user_id,
    )
    token_pool.save_token(auth_user_id, graph_token, user_email=_profile_email(claims))
    return {"ok": True}


@router.get("/api/auth/me")
def me(request: Request):
    bearer = request.headers.get("Authorization", "")
    if bearer.startswith("Bearer "):
        claims = _claims_from_bearer(request)
        profile, profile_complete = _me_profile_response(claims)
        return JSONResponse(
            {
                "authenticated": True,
                "username": _profile_display_name(claims),
                "email": _profile_email(claims),
                "graphLinked": auth.has_refresh_token(claims["sub"]),
                "profile": profile,
                "profileComplete": profile_complete,
                "tokenExpiresAt": claims.get("exp"),
            }
        )
    sid = auth.session_id(request)
    token = auth.get_manual_token(sid)
    if not token:
        return JSONResponse({"authenticated": False})
    claims = auth.get_manual_claims(sid)
    profile, profile_complete = _me_profile_response(claims)
    # The pasted Graph token is a JWT; surface its `exp` so the UI can count down
    # to expiry (the manual token does not auto-refresh).
    token_exp = auth.decode_jwt_claims(token).get("exp")
    return JSONResponse(
        {
            "authenticated": True,
            "username": _profile_display_name(claims),
            "email": _profile_email(claims),
            "profile": profile,
            "profileComplete": profile_complete,
            "tokenExpiresAt": token_exp,
        }
    )


@router.post("/api/users/me/activity")
def touch_user_activity(request: Request):
    """Update the current user's profile activity timestamp."""
    if request.headers.get("Authorization", "").startswith("Bearer "):
        claims = _claims_from_bearer(request)
    else:
        token = auth.get_manual_token(auth.session_id(request))
        if not token:
            raise HTTPException(401, "Not authenticated")
        claims = auth.get_manual_claims(auth.session_id(request))
    _upsert_user_profile(claims)
    return {"ok": True}


@router.post("/api/auth/logout")
def logout(request: Request):
    auth.logout(auth.session_id(request))
    return JSONResponse({"ok": True})


@router.get("/api/users/profile-options")
def user_profile_options(request: Request):
    _request_identity(request)
    return _profile_field_options()


@router.patch("/api/users/me/profile")
def update_my_profile(request: Request, payload: UserProfileUpdateRequest):
    if not settings.supabase_enabled:
        raise HTTPException(503, "User profile requires Supabase configuration.")

    if request.headers.get("Authorization", "").startswith("Bearer "):
        claims = _claims_from_bearer(request)
    else:
        token = auth.get_manual_token(auth.session_id(request))
        if not token:
            raise HTTPException(401, "Not authenticated")
        claims = auth.get_manual_claims(auth.session_id(request))

    cleaned = _validate_profile_selection(payload.model_dump())
    # _validate_profile_selection only keeps location fields; carry the toggle
    # through separately when the client sent it.
    if payload.book_without_confirmation is not None:
        cleaned["book_without_confirmation"] = payload.book_without_confirmation
    if payload.theme is not None:
        theme = str(payload.theme).strip().lower()
        if theme not in ("system", "light", "dark"):
            raise HTTPException(400, "Theme không hợp lệ.")
        cleaned["theme"] = theme
    if payload.language is not None:
        language = str(payload.language).strip().lower()
        if language not in ("en", "vi"):
            raise HTTPException(400, "Language không hợp lệ.")
        cleaned["language"] = language

    profile_id = _upsert_user_profile(claims)
    if not profile_id:
        raise HTTPException(503, "Could not resolve user profile.")

    try:
        from .supabase_client import get_supabase

        now = datetime.now(timezone.utc).isoformat()
        res = (
            get_supabase()
            .table("user_profiles")
            .update({**cleaned, "updated_at": now, "last_seen_at": now})
            .eq("id", profile_id)
            .execute()
        )
        profile = _read_user_profile(profile_id, _profile_email(claims))
        if not res.data and not profile:
            raise HTTPException(404, "User profile not found.")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Could not update user profile: {e}")

    return {
        "ok": True,
        "profile": _profile_payload(profile, _profile_email(claims)),
        "profileComplete": _profile_is_complete(profile),
    }
