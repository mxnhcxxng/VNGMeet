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
  preferred_rooms text[] not null default '{}',
  active_booking boolean not null default false,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_profiles_email_has_at check (position('@' in email) > 1)
);
alter table user_profiles add column if not exists office text;
alter table user_profiles add column if not exists floor text;
alter table user_profiles add column if not exists building text;
alter table user_profiles add column if not exists preferred_rooms text[] not null default '{}';
alter table user_profiles add column if not exists active_booking boolean not null default false;
alter table user_profiles alter column active_booking set default false;
update user_profiles set active_booking = false where active_booking is null;
alter table user_profiles alter column active_booking set not null;
-- When true, the chatbot books a room immediately after the user picks one,
-- skipping the in-chat confirmation card. Opt-in via the card's checkbox.
alter table user_profiles add column if not exists book_without_confirmation boolean not null default false;
alter table user_profiles alter column book_without_confirmation set default false;
update user_profiles set book_without_confirmation = false where book_without_confirmation is null;
alter table user_profiles alter column book_without_confirmation set not null;
-- UI theme preference: 'system' follows the OS setting, 'light' / 'dark' force a mode.
alter table user_profiles add column if not exists theme text not null default 'system';
alter table user_profiles alter column theme set default 'system';
update user_profiles set theme = 'system' where theme is null;
alter table user_profiles
  add constraint user_profiles_theme_check check (theme in ('system', 'light', 'dark')) not valid;
-- UI language preference: 'en' English, 'vi' Vietnamese. Defaults to 'vi'.
alter table user_profiles add column if not exists language text not null default 'vi';
alter table user_profiles alter column language set default 'vi';
update user_profiles set language = 'vi' where language is null;
alter table user_profiles alter column language set not null;
alter table user_profiles
  add constraint user_profiles_language_check check (language in ('en', 'vi')) not valid;
-- Access role. 'admin' sees the full assistant reply (including <think> blocks),
-- 'user' has them hidden in the UI. Role is managed by service_role only; the
-- client read policy below never lets a user change their own role.
alter table user_profiles add column if not exists role text not null default 'user';
alter table user_profiles alter column role set default 'user';
update user_profiles set role = 'user' where role is null;
alter table user_profiles alter column role set not null;
alter table user_profiles
  add constraint user_profiles_role_check check (role in ('admin', 'user')) not valid;
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
  ('building', 'V1', 'V1 (VNGGames, Zalo, GreenNode)', 'office', 'campus', 10),
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
  feedback text check (feedback in ('positive', 'negative')),
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
  auth_user_id uuid references auth.users on delete set null,
  graph_access_token text,
  room_email text not null,
  room_name text,
  date date not null,
  start_time text not null,
  end_time text not null,
  booking_type text not null,
  method text not null,
  subject text,
  attendees text[] not null default '{}',
  body text,
  status text not null,
  error_message text,
  graph_event_id text,
  web_link text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint user_activity_booking_type_check check (booking_type in ('instant', 'scheduled')),
  constraint user_activity_method_check check (method in ('manual', 'chatbot')),
  constraint user_activity_status_check check (status in ('ok', 'failed', 'pending'))
);
alter table user_activity add column if not exists auth_user_id uuid references auth.users on delete set null;
alter table user_activity add column if not exists graph_access_token text;
comment on column user_activity.graph_access_token is
  'Encrypted manual Graph access token for pending scheduled bookings. Values must use fernet:<ciphertext>.';
alter table user_activity add column if not exists subject text;
alter table user_activity add column if not exists attendees text[] not null default '{}';
alter table user_activity add column if not exists body text;
alter table user_activity add column if not exists graph_event_id text;
alter table user_activity add column if not exists web_link text;
alter table user_activity add column if not exists processed_at timestamptz;
alter table user_activity alter column attendees set default '{}';
update user_activity set attendees = '{}' where attendees is null;
alter table user_activity alter column attendees set not null;
alter table user_activity
  drop constraint if exists user_activity_booking_type_check;
update user_activity
set booking_type = 'scheduled'
where booking_type = 'schedule';
alter table user_activity
  add constraint user_activity_booking_type_check check (booking_type in ('instant', 'scheduled'));
alter table user_activity
  drop constraint if exists user_activity_status_check;
alter table user_activity
  add constraint user_activity_status_check check (status in ('ok', 'failed', 'pending'));
create index if not exists idx_user_activity_user_created_at
  on user_activity (user_id, created_at desc);
create index if not exists idx_user_activity_scheduled_pending
  on user_activity (status, date, created_at)
  where booking_type = 'scheduled';
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

-- Nhóm sức chứa cho meeting_room_metadata, dùng cho filter Browse rooms/chatbot.
-- Quy ước hiện tại: <=4 Nhỏ, 5-12 Vừa, 13+ Lớn.
alter table meeting_room_metadata
  add column if not exists capacity_size text generated always as (
    case
      when capacity is null then null::text
      when capacity <= 4 then 'small'::text
      when capacity between 5 and 12 then 'medium'::text
      when capacity > 12 then 'large'::text
      else null::text
    end
  ) stored;
alter table meeting_room_metadata add column if not exists thumbnail_link text;
alter table meeting_room_metadata add column if not exists map_link text;
alter table meeting_room_metadata add column if not exists direction text;
comment on column meeting_room_metadata.map_link is 'Link bản đồ / vị trí phòng họp.';
comment on column meeting_room_metadata.direction is 'Hướng dẫn đi đến phòng họp dạng text.';

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

-- Room Scout: user asks the app to watch today's availability and email them
-- when a room is free for the desired duration/capacity.
create table if not exists room_scouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.user_profiles(id) on delete cascade,
  auth_user_id uuid references auth.users on delete cascade,
  email text not null,
  duration_minutes integer not null,
  min_capacity integer default 1,
  capacity_size text,
  scout_start_time text,
  scout_end_time text,
  office text,
  status text not null default 'active',
  graph_access_token text,
  last_checked_at timestamptz,
  last_notified_at timestamptz,
  last_notified_signature text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint room_scouts_duration_check check (duration_minutes between 15 and 480),
  constraint room_scouts_capacity_check check (min_capacity is null or min_capacity between 1 and 200),
  constraint room_scouts_capacity_size_check check (capacity_size is null or capacity_size in ('small', 'medium', 'large')),
  constraint room_scouts_status_check check (status in ('active', 'stopped', 'expired', 'failed', 'canceled', 'success'))
);
alter table room_scouts add column if not exists auth_user_id uuid references auth.users on delete cascade;
alter table room_scouts add column if not exists graph_access_token text;
alter table room_scouts add column if not exists office text;
alter table room_scouts add column if not exists last_notified_signature text;
alter table room_scouts add column if not exists capacity_size text;
alter table room_scouts add column if not exists scout_start_time text;
alter table room_scouts add column if not exists scout_end_time text;
-- When true, scouting treats the 12:00-13:00 lunch window as free/skippable.
alter table room_scouts add column if not exists ignore_lunch_break boolean not null default false;
create index if not exists idx_room_scouts_user_status on room_scouts(user_id, status);
create index if not exists idx_room_scouts_active_expires on room_scouts(status, expires_at);
alter table room_scouts enable row level security;
create policy "users can read own room scouts" on room_scouts
  for select to authenticated using ((select auth.uid()) = auth_user_id);
create policy "users can stop own room scouts" on room_scouts
  for update to authenticated using ((select auth.uid()) = auth_user_id)
  with check ((select auth.uid()) = auth_user_id);

-- Supabase-native midnight seed job for room_availability.
-- Runs at 17:00 UTC, which is 00:00 Asia/Ho_Chi_Minh (GMT+7). The function
-- creates missing rows only, so existing availability data is never overwritten.
create extension if not exists pg_cron with schema extensions;

create schema if not exists app_private;

create or replace function app_private.seed_room_availability(
  seed_start_date date default ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
  seed_days integer default 18
)
returns table(
  start_date date,
  end_date date,
  in_use_rooms bigint,
  target_rows bigint,
  inserted_rows bigint,
  missing_rows bigint
)
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_start_date date := seed_start_date;
  v_days integer := greatest(seed_days, 0);
  v_target_date date := seed_start_date + greatest(seed_days, 1) - 1;
begin
  if v_days = 0 then
    return query
    select v_start_date, v_start_date - 1, 0::bigint, 0::bigint, 0::bigint, 0::bigint;
    return;
  end if;

  return query
  with target_rows as (
    select
      m.id as room_id,
      v_target_date as date
    from public.meeting_room_metadata m
    where m.in_use is true
  ), inserted as (
    insert into public.room_availability (
      room_id,
      date,
      slots,
      slot_owner_ids,
      updated_at
    )
    select
      room_id,
      date,
      array_fill((-1)::smallint, array[96]),
      array_fill(null::uuid, array[96]),
      now()
    from target_rows
    on conflict (room_id, date) do nothing
    returning room_id, date
  )
  select
    v_start_date,
    v_target_date,
    (select count(*) from public.meeting_room_metadata where in_use is true),
    (select count(*) from target_rows),
    (select count(*) from inserted),
    (select count(*) from target_rows t where not exists (
      select 1
      from public.room_availability ra
      where ra.room_id = t.room_id
        and ra.date = t.date
    ));
end;
$function$;

revoke all on function app_private.seed_room_availability(date, integer)
  from public, anon, authenticated;

select cron.unschedule(jobid)
from cron.job
where jobname = 'seed_room_availability_midnight_gmt7';

select cron.schedule(
  'seed_room_availability_midnight_gmt7',
  '5 17 * * *',
  $$select * from app_private.seed_room_availability();$$
);
