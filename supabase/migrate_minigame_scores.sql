-- Bảng vàng cho minigame đoán tên phòng (/minigame). Mỗi lượt chơi xong là 1 dòng;
-- bảng vàng lấy điểm cao nhất của mỗi người. Chỉ backend (service role) đọc/ghi,
-- nên bật RLS mà không có policy nào.
create table if not exists minigame_scores (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid references auth.users on delete set null,
  email text not null,
  score integer not null,
  correct integer not null default 0,
  close integer not null default 0,
  attempted integer not null default 0,
  created_at timestamptz not null default now()
);
alter table minigame_scores enable row level security;
-- Mỗi minigame có bảng vàng riêng: guess (ảnh -> tên), recall (nhớ tên phòng),
-- quiz (chọn tầng/toà/chỉ đường).
alter table minigame_scores add column if not exists game text not null default 'guess';
drop index if exists idx_minigame_scores_score;
create index if not exists idx_minigame_scores_game_score
  on minigame_scores (game, score desc, created_at);
-- Mỗi lượt chơi là 1 dòng trên bảng vàng (1 người có thể có nhiều lượt), hiển thị
-- theo domain. Admin có thể chơi hộ người khác (vd quầy sự kiện) nên domain không
-- nhất thiết trùng email người đăng nhập. attempt_id = gameId để đánh dấu lượt
-- vừa chơi trên bảng vàng.
alter table minigame_scores add column if not exists domain text;
update minigame_scores set domain = split_part(email, '@', 1) where domain is null;
alter table minigame_scores add column if not exists attempt_id text;
