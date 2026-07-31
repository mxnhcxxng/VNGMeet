-- Zalo Mini App — "Revoke and Remove User Data" webhook support.
-- https://docs.zaloplatforms.com/docs/MA/openApis/open/webhook/eventRevokeAndRemoveUserData
--
-- Zalo gửi webhook `user.revoke.consent` kèm Zalo `userId` (app-scoped) khi user
-- rút lại sự đồng ý. Để xoá đúng dữ liệu của user đó, ta phải lưu ánh xạ
-- Zalo userId -> user_profiles. Mini App định danh nội bộ bằng SĐT nên trước đây
-- KHÔNG lưu Zalo userId; migration này bổ sung cột + bảng audit.

-- 1) Ánh xạ Zalo userId -> hồ sơ. Ghi lúc /api/auth/zalo (service_role), client
--    không đọc cột này (RLS select policy hiện tại chỉ trả cột hồ sơ của chính
--    mình; không có policy nào để lộ zalo_user_id ra ngoài mục đích nội bộ).
alter table user_profiles add column if not exists zalo_user_id text;
create index if not exists idx_user_profiles_zalo_user_id
  on user_profiles (zalo_user_id)
  where zalo_user_id is not null;

-- 2) Nhật ký xử lý sự kiện thu hồi (bằng chứng tuân thủ). Chỉ lưu định danh Zalo
--    (chủ thể của yêu cầu xoá) + số bản ghi đã xoá; KHÔNG lưu thêm PII.
create table if not exists zalo_data_revocations (
  id uuid primary key default gen_random_uuid(),
  event text not null,                       -- vd 'user.revoke.consent'
  app_id text,                               -- appId từ payload
  zalo_user_id text not null,                -- userId từ payload (chủ thể xoá)
  event_timestamp bigint,                    -- timestamp (ms) từ payload, nếu có
  matched_profiles integer not null default 0,   -- số hồ sơ khớp userId
  purged boolean not null default false,     -- đã xoá xong dữ liệu chưa
  detail jsonb,                              -- tóm tắt số dòng đã xoá theo bảng
  received_at timestamptz not null default now()
);
create index if not exists idx_zalo_data_revocations_user
  on zalo_data_revocations (zalo_user_id, received_at desc);

-- Server-side only (service-role). RLS bật, không policy => chặn mọi client.
alter table zalo_data_revocations enable row level security;
