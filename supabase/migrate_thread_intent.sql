-- Add structured "info" columns to chat threads so the bot can load a compact
-- summary instead of the full message history (token saving) and auto-name the
-- thread as "<intent> • <ngày> • <giờ/thời lượng>".
--
-- intent ∈ book / schedule / scout / update / delete / info. All nullable; the
-- backend derives them from the tool the agent called (falls back to an "info"
-- default for tool-less turns on a fresh thread). title_custom marks threads the
-- user renamed by hand so auto-title never overwrites them.
alter table thread add column if not exists intent text;
alter table thread add column if not exists booking_date date;
alter table thread add column if not exists start_time text;
alter table thread add column if not exists end_time text;
alter table thread add column if not exists duration_minutes integer;
alter table thread add column if not exists title_custom boolean not null default false;
