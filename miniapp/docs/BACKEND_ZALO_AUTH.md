# Backend patch — Đăng nhập Mini App bằng SĐT Zalo (Phương án B)

Mục tiêu: Mini App mở lên → xin quyền SĐT Zalo → BE đổi token Zalo ra SĐT → **tra
`user_profiles` ra user nào → cấp session cho đúng user đó** (coi như auth luôn).
Các request sau gửi `Authorization: Bearer <session_jwt>` và dùng chung đường Graph
token hiện có.

> **Điều kiện:** `user_profiles.phone` của user phải đã được điền sẵn (khi user link
> Microsoft trước đó). SĐT Zalo chỉ là **khoá tra cứu** ra user — không tự tạo Graph token.
>
> - **Đăng nhập + ĐỌC chat** chỉ cần tra được user (email → profile). Chạy được ngay.
> - **GỬI chat** (`POST /chat/messages`) mới cần Graph token của user đó → BE tự lấy qua
>   `refresh_token` đã lưu. Nên để gửi được, user đó phải đã link Microsoft từ trước.

Contract client kỳ vọng (đã code sẵn ở `src/services/api.ts` → `authWithZalo`):

```
POST /api/auth/zalo
  body: { "token": "<zalo_phone_token>", "access_token": "<zalo_access_token>" }

200 → { "access_token": "<vngmeet_session_jwt>", "username": "Nguyen Van A" }
403 → SĐT chưa liên kết Microsoft   (client hiện màn "Vui lòng liên kết Microsoft")
401 → token Zalo sai / hết hạn
```

---

## 0. Env mới (`.env` + `config.py`)

Thêm vào `class Settings` trong `backend/app/config.py`:

```python
    # Zalo Mini App
    zalo_app_secret_key: str = ""          # secret_key của Zalo App (mini.zalo.me)
    miniapp_session_secret: str = ""          # khoá ký session JWT của VNGMeet cho Mini App
    miniapp_session_ttl_seconds: int = 30 * 24 * 3600   # 30 ngày
```

`.env` (KHÔNG commit — đây là secret):

```
ZALO_APP_SECRET_KEY=<lấy trong mini.zalo.me → App settings>
MINIAPP_SESSION_SECRET=<chuỗi random đủ dài, ví dụ openssl rand -hex 32>
```

---

## 1. `backend/app/auth.py` — thêm 3 helper

```python
ZALO_SESSION_ISS = "vngmeet-zalo"


async def resolve_zalo_phone(zalo_token: str, zalo_access_token: str) -> str:
    """Đổi token của getPhoneNumber() ra SĐT (chuẩn hoá về dạng VN local).

    Token hết hạn sau 2 phút, dùng 1 lần. secret_key CHỈ ở server.
    """
    s = get_settings()
    if not s.zalo_app_secret_key:
        raise HTTPException(500, "Server missing ZALO_APP_SECRET_KEY")
    headers = {
        "access_token": zalo_access_token.strip(),
        "code": zalo_token.strip(),
        "secret_key": s.zalo_app_secret_key,
    }
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get("https://graph.zalo.me/v2.0/me/info", headers=headers)
    data = resp.json() if resp.content else {}
    if resp.status_code != 200 or data.get("error") != 0:
        raise HTTPException(401, f"Zalo token không hợp lệ: {data.get('message')}")
    number = (data.get("data") or {}).get("number")
    phone = normalize_vn_phone(number)   # đã có sẵn trong file này
    if not phone:
        raise HTTPException(401, "Không lấy được số điện thoại từ Zalo")
    return phone


def mint_zalo_session(claims: dict) -> str:
    """Ký session JWT của VNGMeet cho Mini App (HS256).

    claims phải chứa ít nhất `sub` (auth.users UUID). Nên kèm email/name/phone
    để các endpoint downstream (profile, chat) đọc như claims của Supabase.
    """
    import jwt
    import time

    s = get_settings()
    if not s.miniapp_session_secret:
        raise HTTPException(500, "Server missing MINIAPP_SESSION_SECRET")
    now = int(time.time())
    payload = {
        **claims,
        "iss": ZALO_SESSION_ISS,
        "aud": "authenticated",              # để qua verify_jwt-style aud check
        "iat": now,
        "exp": now + s.miniapp_session_ttl_seconds,
    }
    return jwt.encode(payload, s.miniapp_session_secret, algorithm="HS256")


def _verify_zalo_session(token: str) -> dict | None:
    """Trả claims nếu là session JWT do VNGMeet ký, else None (để fallback Supabase)."""
    import jwt

    s = get_settings()
    if not s.miniapp_session_secret:
        return None
    try:
        claims = jwt.decode(
            token,
            s.miniapp_session_secret,
            algorithms=["HS256"],
            audience="authenticated",
        )
    except jwt.PyJWTError:
        return None
    return claims if claims.get("iss") == ZALO_SESSION_ISS else None


def verify_bearer(token: str) -> dict:
    """Chấp nhận CẢ session JWT của VNGMeet (Zalo) LẪN Supabase JWT."""
    claims = _verify_zalo_session(token)
    if claims is not None:
        return claims
    return verify_jwt(token)   # Supabase HS256 (đã có sẵn)
```

## 2. `backend/app/profiles.py` — endpoint mới `POST /api/auth/zalo`

Cần một hàm tra `auth_user_id` từ SĐT trong `user_profiles` (SĐT đã được điền khi user
link Microsoft). Thêm gần các endpoint auth:

```python
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
```

## 3. Cho session JWT đi chung đường Bearer hiện có

Ở các chỗ đang gọi `auth.verify_jwt(bearer[...])` / `verify_jwt(...)`, đổi sang
`auth.verify_bearer(...)` để chấp nhận cả session JWT của Zalo:

- `auth.py` → `resolve_token()`: nhánh `if bearer:` đổi `verify_jwt(bearer)` → `verify_bearer(bearer)`.
- `profiles.py` → `_claims_from_bearer()`: đổi `auth.verify_jwt(...)` → `auth.verify_bearer(...)`.
- `profiles.py` → `link_microsoft()`, `me()`: tương tự (nếu muốn Mini App cũng gọi được).

Vì session JWT đã chứa `sub` = `auth_user_id`, `get_graph_token(sub)` sẽ tự lấy Graph
token qua `refresh_token` đã lưu — toàn bộ chat/booking chạy y như đường Supabase.

## 4. CORS

Header `Authorization` là "simple-ish" nhưng vẫn nên đảm bảo origin Mini App nằm trong
`FRONTEND_URL` (giống doc `BACKEND_AUTH_PATCH.md`): thêm `https://h5.zdn.vn` (prod) và
`http://localhost:3000` (dev).

---

## Lưu ý & bảo mật

- **Chuẩn hoá SĐT phải khớp:** Zalo trả `"84912345678"` → `normalize_vn_phone` ra
  `"0912345678"`. `user_profiles.phone` (điền từ Graph `mobilePhone`) cũng chuẩn hoá
  bằng chính hàm này → khớp. Nếu dữ liệu cũ lưu SĐT dạng khác, cần migrate cho đồng nhất.
- `secret_key` Zalo **chỉ ở server** — không bao giờ trả về client.
- Session JWT nên có `exp` (mặc định 30 ngày ở trên). Hết hạn → client nhận 401 →
  `Gate` tự chạy lại `getPhoneNumber()` (im lặng) để lấy session mới.
- Cần `pip install pyjwt` (BE đã dùng `import jwt` ở `verify_jwt` nên hẳn đã có).
- Muốn thu hồi phiên từng user: thêm cột `token_version` vào profile và nhét vào claims,
  kiểm ở `_verify_zalo_session` (tuỳ chọn, chưa làm ở trên).
```
