-- Backward compatibility for the production Room Scout payload:
--   capacity_size: "medium"
-- and no scout_date/capacity_sizes fields.

alter table public.room_scouts
  add column if not exists scout_date date;

update public.room_scouts
set scout_date = (created_at at time zone 'Asia/Ho_Chi_Minh')::date
where scout_date is null;

alter table public.room_scouts
  alter column scout_date
  set default ((now() at time zone 'Asia/Ho_Chi_Minh')::date);

alter table public.room_scouts
  alter column scout_date set not null;

alter table public.room_scouts
  add column if not exists capacity_sizes text[] not null default '{}';

update public.room_scouts
set capacity_sizes = array[capacity_size]
where capacity_size is not null
  and cardinality(capacity_sizes) = 0;

alter table public.room_scouts
  drop constraint if exists room_scouts_capacity_sizes_check;

alter table public.room_scouts
  add constraint room_scouts_capacity_sizes_check check (
    capacity_sizes <@ array['small', 'medium', 'large']::text[]
  );

create or replace function public.sync_room_scout_capacity_sizes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.capacity_size is not null
     and (new.capacity_sizes is null or cardinality(new.capacity_sizes) = 0) then
    new.capacity_sizes := array[new.capacity_size];
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_room_scout_capacity_sizes
  on public.room_scouts;

create trigger trg_sync_room_scout_capacity_sizes
before insert or update of capacity_size, capacity_sizes
on public.room_scouts
for each row
execute function public.sync_room_scout_capacity_sizes();
