-- Run once in Supabase SQL Editor before deploying the multi-select capacity UI.
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
