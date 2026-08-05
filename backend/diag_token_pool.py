"""Chẩn đoán vì sao graph_token_pool bị 'decrypt failed'.
Chạy tại thư mục backend/:  venv/bin/python diag_token_pool.py
KHÔNG in ra key hay token — chỉ in độ dài, prefix, và loại lỗi."""

from app.config import get_settings
from app.bookings import (
    _encrypt_scheduled_graph_token,
    _decrypt_scheduled_graph_token,
)

s = get_settings()

# 1) Backend local đang dùng key nào? (chỉ in trạng thái, không in giá trị)
key_set = bool(s.scheduled_token_encryption_key.strip())
print(f"[key] SCHEDULED_TOKEN_ENCRYPTION_KEY set? {key_set} "
      f"(len={len(s.scheduled_token_encryption_key.strip())})")
print(f"[key] fallback derive-from-SESSION_SECRET? {not key_set} "
      f"(session_secret len={len(s.session_secret)})")

# 2) Round-trip test bằng chính key local -> chứng minh key có tự giải mã được không
sample = "x" * 2000  # cỡ gần bằng 1 Graph access token
try:
    enc = _encrypt_scheduled_graph_token(sample)
    dec = _decrypt_scheduled_graph_token(enc)
    print(f"[roundtrip] OK — encrypt/decrypt bằng key local chạy tốt "
          f"(cipher len={len(enc)})")
except Exception as e:
    print(f"[roundtrip] FAIL: {type(e).__name__}: {e}")

# 3) Đọc các row trong pool, thử decrypt từng cái (không in nội dung)
if not s.supabase_enabled:
    print("[pool] supabase_enabled=False -> job không đụng pool. Dừng.")
    raise SystemExit

from app.supabase_client import get_supabase

rows = (
    get_supabase()
    .table("graph_token_pool")
    .select("owner_key, user_email, status, updated_at, expires_at, token_encrypted")
    .order("updated_at", desc=True)
    .limit(20)
    .execute()
    .data
    or []
)
print(f"[pool] {len(rows)} row(s):")
for r in rows:
    enc = r.get("token_encrypted") or ""
    owner = (r.get("owner_key") or "")[:8] + "…"
    prefix_ok = enc.startswith("fernet:")
    try:
        _decrypt_scheduled_graph_token(enc)
        verdict = "DECRYPT-OK"
    except Exception as e:
        verdict = f"{type(e).__name__}: {e}"
    print(f"  owner={owner:12} status={r.get('status'):8} "
          f"updated={str(r.get('updated_at'))[:19]} "
          f"cipher_len={len(enc):5} prefix_ok={prefix_ok} -> {verdict}")
