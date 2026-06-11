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
