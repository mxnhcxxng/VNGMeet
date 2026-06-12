-- VNG Meet — Supabase schema.
-- Chạy trong Supabase → SQL Editor (hoặc supabase db push nếu dùng CLI).

-- Refresh token Graph cho mỗi user. Không tạo policy → RLS chặn mọi client;
-- chỉ service_role (backend) đọc/ghi được.
create table if not exists provider_tokens (
  user_id uuid primary key references auth.users on delete cascade,
  refresh_token text not null,
  updated_at timestamptz default now()
);
alter table provider_tokens enable row level security;

-- Mirror user profile lấy từ Supabase/Azure auth claim hoặc manual Graph token.
-- Client chỉ đọc được profile của chính mình; backend service_role ghi/upsert.
create table if not exists user_profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users on delete cascade,
  email text not null,
  email_username text generated always as (split_part(email, '@', 1)) stored,
  office text,
  floor text,
  building text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_profiles_email_has_at check (position('@' in email) > 1)
);
alter table user_profiles add column if not exists office text;
alter table user_profiles add column if not exists floor text;
alter table user_profiles add column if not exists building text;
create unique index if not exists user_profiles_email_lower_key
  on user_profiles (lower(email));
create unique index if not exists user_profiles_email_key
  on user_profiles (email);
alter table user_profiles enable row level security;
create policy "users can read own profile" on user_profiles
  for select to authenticated using ((select auth.uid()) = auth_user_id);

-- Lookup options for the onboarding user profile form. Read through backend
-- service_role so the frontend always gets the current DB-managed list.
create table if not exists user_profile_field_options (
  field text not null,
  value text not null,
  label text not null,
  parent_field text,
  parent_value text,
  display_order integer not null default 0,
  enabled boolean not null default true,
  primary key (field, value),
  constraint user_profile_field_options_field_check
    check (field in ('office', 'floor', 'building')),
  constraint user_profile_field_options_parent_check
    check (
      (parent_field is null and parent_value is null)
      or (parent_field = 'office' and parent_value is not null)
    )
);
alter table user_profile_field_options enable row level security;
insert into user_profile_field_options
  (field, value, label, parent_field, parent_value, display_order)
values
  ('office', 'campus', 'Campus', null, null, 10),
  ('office', 'sala', 'Sala', null, null, 20),
  ('office', 'tnr', 'TNR', null, null, 30),
  ('floor', '1', '1', 'office', 'campus', 10),
  ('floor', '2', '2', 'office', 'campus', 20),
  ('floor', '3', '3', 'office', 'campus', 30),
  ('floor', '4', '4', 'office', 'campus', 40),
  ('building', 'V1', 'V1 (VNG, Zalo, Greennode)', 'office', 'campus', 10),
  ('building', 'V2', 'V2 (Zalopay)', 'office', 'campus', 20)
on conflict (field, value) do update set
  label = excluded.label,
  parent_field = excluded.parent_field,
  parent_value = excluded.parent_value,
  display_order = excluded.display_order,
  enabled = true;

-- Chat thread lưu theo user_profiles.id. Client chỉ thao tác thread của chính mình;
-- backend service_role có thể ghi/đọc toàn bộ khi xử lý chatbot.
create table if not exists thread (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references user_profiles(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_thread_user_updated_at
  on thread (user_id, updated_at desc);
alter table thread enable row level security;
create policy "users can read own threads" on thread
  for select to authenticated
  using (
    exists (
      select 1
      from user_profiles
      where user_profiles.id = thread.user_id
        and user_profiles.auth_user_id = (select auth.uid())
    )
  );
create policy "users can create own threads" on thread
  for insert to authenticated
  with check (
    exists (
      select 1
      from user_profiles
      where user_profiles.id = thread.user_id
        and user_profiles.auth_user_id = (select auth.uid())
    )
  );
create policy "users can update own threads" on thread
  for update to authenticated
  using (
    exists (
      select 1
      from user_profiles
      where user_profiles.id = thread.user_id
        and user_profiles.auth_user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1
      from user_profiles
      where user_profiles.id = thread.user_id
        and user_profiles.auth_user_id = (select auth.uid())
    )
  );
create policy "users can delete own threads" on thread
  for delete to authenticated
  using (
    exists (
      select 1
      from user_profiles
      where user_profiles.id = thread.user_id
        and user_profiles.auth_user_id = (select auth.uid())
    )
  );

-- Messages thuộc thread, có người gửi/người nhận đều trỏ về user_profiles.id.
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references thread(id) on delete cascade,
  from_user_id uuid not null references user_profiles(id) on delete cascade,
  to_user_id uuid not null references user_profiles(id) on delete cascade,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint messages_content_not_blank check (length(btrim(content)) > 0)
);
create index if not exists idx_messages_thread_created_at
  on messages (thread_id, created_at);
create index if not exists idx_messages_from_user_created_at
  on messages (from_user_id, created_at desc);
create index if not exists idx_messages_to_user_created_at
  on messages (to_user_id, created_at desc);
alter table messages enable row level security;
create policy "users can read own thread messages" on messages
  for select to authenticated
  using (
    exists (
      select 1
      from thread
      join user_profiles on user_profiles.id = thread.user_id
      where thread.id = messages.thread_id
        and user_profiles.auth_user_id = (select auth.uid())
    )
  );
create policy "users can create messages in own threads" on messages
  for insert to authenticated
  with check (
    exists (
      select 1
      from thread
      join user_profiles on user_profiles.id = thread.user_id
      where thread.id = messages.thread_id
        and user_profiles.auth_user_id = (select auth.uid())
        and messages.from_user_id = user_profiles.id
    )
  );

-- Mirror metadata booking (event thật vẫn nằm ở Microsoft calendar).
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade,
  room_email text not null,
  room_name text,
  date date not null,
  start_time text,
  end_time text,
  subject text,
  graph_event_id text,
  web_link text,
  created_at timestamptz default now()
);
alter table bookings enable row level security;
create policy "own bookings" on bookings
  for select using (auth.uid() = user_id);

-- Log kết quả đặt phòng theo user profile. Ghi qua backend service_role; client chưa đọc/ghi trực tiếp.
create table if not exists user_activity (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references user_profiles(id) on delete cascade,
  room_email text not null,
  room_name text,
  date date not null,
  start_time text not null,
  end_time text not null,
  booking_type text not null,
  method text not null,
  status text not null,
  error_message text,
  created_at timestamptz not null default now(),
  constraint user_activity_booking_type_check check (booking_type in ('instant', 'schedule')),
  constraint user_activity_method_check check (method in ('manual', 'chatbot')),
  constraint user_activity_status_check check (status in ('ok', 'failed'))
);
create index if not exists idx_user_activity_user_created_at
  on user_activity (user_id, created_at desc);
alter table user_activity enable row level security;

-- Phòng yêu thích (client tự quản qua anon key + RLS).
create table if not exists favorite_rooms (
  user_id uuid references auth.users on delete cascade,
  room_email text not null,
  room_name text,
  primary key (user_id, room_email)
);
alter table favorite_rooms enable row level security;
create policy "manage own favorites" on favorite_rooms
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Nhóm sức chứa cho meeting_room_metadata, dùng cho filter Browse rooms.
-- Quy ước hiện tại: <=4 Nhỏ, 6-8 Vừa, >8 Lớn.
alter table meeting_room_metadata
  add column if not exists capacity_size text generated always as (
    case
      when capacity is null then null
      when capacity <= 4 then 'small'
      when capacity between 6 and 8 then 'medium'
      when capacity > 8 then 'large'
      else null
    end
  ) stored;

-- Cache availability phòng họp. Một background job (app-only Graph) refresh mỗi
-- 15 phút; frontend đọc grid từ đây thay vì gọi Graph trực tiếp.
-- slots: mảng 96 slot 15 phút/ngày, index = hour*4 + minute/15 (0=00:00 .. 95=23:45).
-- Giá trị: 0 = free, 1 = busy.
-- slot_owner_ids: mảng 96 user_profiles.id nullable, dùng để map busy slot nào là của user hiện tại.
create table if not exists room_availability (
  room_id        uuid not null references meeting_room_metadata(id) on delete cascade,
  date           date not null,
  slots          smallint[] not null,
  slot_owner_ids uuid[] not null default array_fill(null::uuid, ARRAY[96]),
  updated_at     timestamptz not null default now(),
  primary key (room_id, date),
  constraint room_availability_slots_len check (array_length(slots, 1) = 96),
  constraint room_availability_slot_owner_ids_len check (array_length(slot_owner_ids, 1) = 96)
);
alter table room_availability
  add column if not exists slot_owner_ids uuid[] not null default array_fill(null::uuid, ARRAY[96]);
alter table room_availability
  drop constraint if exists room_availability_slot_owner_ids_len;
alter table room_availability
  add constraint room_availability_slot_owner_ids_len check (array_length(slot_owner_ids, 1) = 96);
create index if not exists idx_room_availability_date on room_availability(date);
alter table room_availability enable row level security;
-- Chỉ user đã đăng nhập đọc được; ghi chỉ qua service_role (backend job).
create policy "authenticated_can_read_availability" on room_availability
  for select to authenticated using (true);
