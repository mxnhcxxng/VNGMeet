-- Delete duplicate meeting_room_metadata rows: rows identical in every column
-- except id (and created_at / updated_at), as found by find_duplicate_rooms.sql.
-- Keeps ONE row per group (the earliest created, else the lowest id) and
-- deletes the rest — the room itself stays.
--
-- Only room_availability references this table (on delete cascade), so a
-- deleted copy's cached availability goes with it; these copies have no email
-- and in_use = false, so they have none.
--
-- RETURNING lists what was deleted — expected 7 rows (one extra copy each of
-- Da Nang, Ha Noi, Liverpool, Mumbai, Oxford, Sai Gon, Stanford). Run
-- find_duplicate_rooms.sql again afterwards: it should return nothing.

with rows as (
  select
    m.id,
    to_jsonb(m) - array['id', 'created_at', 'updated_at'] as body,
    row_number() over (
      partition by to_jsonb(m) - array['id', 'created_at', 'updated_at']
      order by (to_jsonb(m) ->> 'created_at') nulls last, m.id
    ) as rn
  from meeting_room_metadata m
)
delete from meeting_room_metadata t
using rows r
where t.id = r.id and r.rn > 1
returning t.id, t.name, t.office, t.floor;
