-- Two columns, both aimed at the same failure: Room Scout auto-booking a room it
-- has no business auto-booking, once a minute, until the scout expires.
--
-- 1) room_scouts.declined_attempts
--    Room+window pairs whose meeting request the room DECLINED. Without them the
--    scout re-books the same block every cycle: the room declines, sync deletes
--    the orphaned event, _release_room_availability_owner frees the slots, and the
--    next cycle reads a cache identical to the one before. Observed in production
--    as one create/decline/delete round trip per minute against a single room.
--
--    Shape: [{"room_email": "...", "date": "YYYY-MM-DD", "start_time": "HH:MM",
--             "end_time": "HH:MM"}]
--
-- 2) room_availability.graph_synced_at
--    When Graph free/busy last wrote this row — as opposed to `updated_at`, which
--    ANY writer stamps. _mark_room_availability_owner, _release_room_availability_owner
--    and sync_my_calendar all touch updated_at, so the scout's own booking activity
--    refreshed the very timestamp its staleness guard consults. A row Graph had not
--    been able to read for hours still looked one second old.
alter table public.room_scouts
  add column if not exists declined_attempts jsonb not null default '[]'::jsonb;

comment on column public.room_scouts.declined_attempts is
  'Room+window pairs this scout already had declined; treated as busy on later cycles.';

alter table public.room_availability
  add column if not exists graph_synced_at timestamptz;

comment on column public.room_availability.graph_synced_at is
  'Last time refresh_availability_delegated wrote this row from Graph free/busy. '
  'Only that job may set it. NULL means never synced -> Room Scout must not '
  'auto-book against this row.';
