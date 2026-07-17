-- Pool token Graph (mã hoá) cho job nền refresh room_availability.
--
-- Mỗi lần user đăng nhập / đổi refresh token thành công, backend lưu access
-- token Graph hiện tại (Fernet, cùng khoá với scheduled bookings) kèm hạn dùng.
-- Job nền mỗi phút mượn token ACTIVE mới nhất để gọi getSchedule và cập nhật
-- cache — request của user không còn phải tự đi refresh Graph nữa.
--
-- Mỗi user một row (upsert theo owner_key). Không tạo policy → RLS chặn mọi
-- client; chỉ service_role (backend) đọc/ghi được.
create table if not exists graph_token_pool (
  -- auth.users id (đường Supabase) hoặc user_profiles.id (đường manual token).
  owner_key text primary key,
  user_email text,
  -- "fernet:..." — access token Graph đã mã hoá, KHÔNG bao giờ lưu plaintext.
  token_encrypted text not null,
  expires_at timestamptz not null,
  -- active: dùng được | expired: quá expires_at | invalid: Graph từ chối (revoke,
  -- đổi mật khẩu, thiếu scope) — job tự chuyển trạng thái, đăng nhập mới ghi đè.
  status text not null default 'active'
    check (status in ('active', 'invalid', 'expired')),
  last_error text,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists graph_token_pool_pick_idx
  on graph_token_pool (status, expires_at desc);

alter table graph_token_pool enable row level security;
