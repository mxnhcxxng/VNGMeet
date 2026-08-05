"""Chẩn đoán vì sao provider_refresh_token không đổi được ra Graph token mới.

Chạy ĐỘC LẬP với luồng login — không cần đăng nhập được vào app, không cần đọc
log server. Nó làm đúng y hệt những gì auth.get_graph_token() làm, rồi in ra mã
lỗi AADSTS mà Azure trả về.

    cd backend && venv/bin/python diag_refresh_token.py
    cd backend && venv/bin/python diag_refresh_token.py <user_id>

KHÔNG in ra refresh token, access token, client_secret hay bất kỳ giá trị bí mật
nào — chỉ in độ dài, mã lỗi, và các claim vô hại (scp/upn/exp).
"""

import asyncio
import sys

import httpx

from app.auth import decode_jwt_claims
from app.config import get_settings

s = get_settings()

# --------------------------------------------------------------------------- #
# 1) Cấu hình phía backend đã đủ chưa (chỉ in trạng thái, không in giá trị)
# --------------------------------------------------------------------------- #
print("[cfg] client_id set?     ", bool(s.client_id.strip()), f"(len={len(s.client_id.strip())})")
print("[cfg] client_secret set? ", bool(s.client_secret.strip()), f"(len={len(s.client_secret.strip())})")
print("[cfg] tenant_id          ", s.tenant_id or "(rỗng)")
print("[cfg] token_endpoint     ", s.token_endpoint)
print("[cfg] scope gửi khi refresh:", " ".join(s.scopes))
print("[cfg] supabase_enabled   ", s.supabase_enabled)

if not s.supabase_enabled:
    print("\n=> supabase_enabled=False: không đọc được provider_tokens. Dừng.")
    raise SystemExit(1)

# --------------------------------------------------------------------------- #
# 2) Lấy refresh token đã lưu (không in nội dung)
# --------------------------------------------------------------------------- #
from app.supabase_client import get_supabase  # noqa: E402

q = (
    get_supabase()
    .table("provider_tokens")
    .select("user_id, refresh_token, updated_at")
)
if len(sys.argv) > 1:
    q = q.eq("user_id", sys.argv[1])
rows = q.execute().data or []

print(f"\n[db] provider_tokens: {len(rows)} row(s)")
if not rows:
    print("=> Chưa có refresh token nào được lưu. Đây là lỗi ở bước api.link (#2). Dừng.")
    raise SystemExit(1)

for r in rows:
    rt = r.get("refresh_token") or ""
    print(
        f"  user_id={str(r.get('user_id'))[:8]}… "
        f"rt_len={len(rt):5} "
        f"updated_at={str(r.get('updated_at'))[:19]}  "
        "(LƯU Ý: updated_at bị đóng băng ở lần INSERT đầu — không phải dấu hiệu rotate)"
    )


# --------------------------------------------------------------------------- #
# 3) Đổi thật với Azure — đây là câu trả lời
# --------------------------------------------------------------------------- #
async def try_exchange(user_id: str, refresh_token: str) -> None:
    data = {
        "client_id": s.client_id,
        "client_secret": s.client_secret,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "scope": " ".join(s.scopes),
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(s.token_endpoint, data=data)

    short = str(user_id)[:8] + "…"
    try:
        body = resp.json()
    except Exception:  # noqa: BLE001 - body có thể rỗng/không phải JSON
        body = {}

    if resp.status_code != 200:
        print(f"\n[exchange {short}] ❌ HTTP {resp.status_code}")
        print(f"  error       = {body.get('error')}")
        print(f"  error_codes = {body.get('error_codes')}")
        # error_description CÓ chứa mô tả AADSTS hữu ích và không lộ secret,
        # nhưng có thể echo lại request param -> chỉ in phần trước dấu phẩy đầu.
        desc = str(body.get("error_description") or "")
        print(f"  hint        = {desc.split(chr(10))[0][:200]}")
        return

    at = body.get("access_token") or ""
    claims = decode_jwt_claims(at)
    new_rt = body.get("refresh_token") or ""
    print(f"\n[exchange {short}] ✅ HTTP 200 — refresh CHẠY ĐƯỢC")
    print(f"  expires_in   = {body.get('expires_in')}s")
    print(f"  scp          = {claims.get('scp')}")
    print(f"  aud          = {claims.get('aud')}")
    print(f"  upn/email    = {claims.get('upn') or claims.get('unique_name') or claims.get('email') or '(rỗng)'}")
    print(f"  rotate?      = {'CÓ token mới' if new_rt and new_rt != refresh_token else 'giữ nguyên token cũ'}")
    print("  => Nếu chỗ này OK thì lỗi KHÔNG nằm ở offline_access/refresh token.")


async def main() -> None:
    for r in rows:
        rt = (r.get("refresh_token") or "").strip()
        if not rt:
            print(f"\n[exchange {str(r.get('user_id'))[:8]}…] refresh_token rỗng — bỏ qua")
            continue
        await try_exchange(r["user_id"], rt)


asyncio.run(main())
