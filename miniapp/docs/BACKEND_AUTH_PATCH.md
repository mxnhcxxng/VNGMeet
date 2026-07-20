# Backend patch — auth bằng header cho Mini App

## Vì sao cần

Luồng "dán token" hiện tại dựa vào **session cookie** (`SessionMiddleware`, `same_site="lax"`).
Cookie này chỉ được gửi trong ngữ cảnh **same-site**. Mini App chạy trên domain của Zalo
(`h5.zdn.vn` / zapps) → **cross-site** với backend `vngcloud.vn` → cookie không được gửi kèm
→ mọi request sau login trả `401`.

Cách xử lý: cho phép client gửi Graph token trực tiếp qua header **`X-Graph-Token`** (stateless,
không cần cookie). Client Mini App (`src/services/api.ts`) đã gửi header này sẵn.

> Repo backend: https://github.com/mxnhcxxng/VNGMeet — thư mục `backend/app/`.
> Sau khi sửa, **deploy lại** backend trên AgentBase.

---

## 1. `backend/app/auth.py` — thêm 2 helper

Thêm vào cuối phần "manual-token path" (gần `def logout`):

```python
def manual_token_from_request(request: Request) -> str | None:
    """Manual Graph token từ header (mini app) hoặc cookie session (web)."""
    header = request.headers.get("X-Graph-Token")
    if header and header.strip():
        return header.strip()
    return get_manual_token(session_id(request))


def manual_claims_from_request(request: Request) -> dict:
    header = request.headers.get("X-Graph-Token")
    if header and header.strip():
        # Header path không lưu claims server-side → đọc trực tiếp từ JWT.
        return decode_jwt_claims(header.strip())
    return get_manual_claims(session_id(request))
```

Và trong `resolve_token()`, đổi nhánh manual:

```python
    # cũ:
    # token = get_manual_token(session_id(request))
    # mới:
    token = manual_token_from_request(request)
    if not token:
        raise HTTPException(401, "Not authenticated")
    return token, None
```

## 2. `backend/app/profiles.py` — thay ở 4 chỗ

Ở `_request_identity`, `_booking_auth_context`, `me` (`/api/auth/me`),
`touch_user_activity`, `update_my_profile` — đổi:

```python
auth.get_manual_token(auth.session_id(request))   →  auth.manual_token_from_request(request)
auth.get_manual_claims(auth.session_id(request))  →  auth.manual_claims_from_request(request)
```

## 3. `backend/app/chat.py` — thay ở `_current_user_profile_id`

```python
# cũ:
token = auth.get_manual_token(auth.session_id(request))
if not token:
    raise HTTPException(401, "Not authenticated")
claims = auth.get_manual_claims(auth.session_id(request))
# mới:
token = auth.manual_token_from_request(request)
if not token:
    raise HTTPException(401, "Not authenticated")
claims = auth.manual_claims_from_request(request)
```

---

## 4. CORS — thêm origin của Mini App vào `FRONTEND_URL`

Header tuỳ biến `X-Graph-Token` kích hoạt CORS preflight. Backend chỉ cho qua các origin trong
`FRONTEND_URL` (`allow_credentials=True` nên không dùng `*` được). Cập nhật biến môi trường:

- **Dev (zmp start):** thêm `http://localhost:3000` (đã có sẵn trong `.env.example`).
- **Prod (Zalo thật):** thêm `https://h5.zdn.vn`.

Ví dụ: `FRONTEND_URL=http://localhost:3000,https://h5.zdn.vn,https://<frontend-endpoint-cũ>`

---

## Lưu ý

- Claims ở header path được decode từ chính Graph token JWT (`upn`/`name`/`email`). Nếu thấy
  email/tên hiển thị sai, đổi `manual_claims_from_request` (nhánh header) sang gọi
  `await verify_manual_graph_token(...)` — nhưng hàm này async, cần refactor các call site tương ứng.
- Chat yêu cầu Supabase được cấu hình trên backend (`_require_supabase_chat`). Backend đã deploy
  hẳn đã bật, nên không cần chỉnh thêm.
