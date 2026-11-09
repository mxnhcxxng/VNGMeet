-- Fix: import_rooms_campus_f2.sql matched "New York" by name only and
-- overwrote the existing TNR (VNG Hà Nội) New York room with Campus data.
-- This script
--   1) restores that row to its TNR details from the MyVNG wiki
--      (https://my.vng.vn/wiki/document?id=647e5ce0-9ce9-11ee-a485-91292c4d6e47:
--       TNR building, floor 16, 8 seats) — its email/thumbnail were never touched;
--   2) creates a separate Campus New York (V1, floor 2, 20 seats, in_use = false).
-- The TNR row's in_use is left as it is (it's a real, bookable Hà Nội room).
-- Building and floor spelling for the TNR row are copied from the other TNR
-- rooms so it groups with them. Safe to rerun.

do $$
declare
  tnr_id      uuid;
  campus_id   uuid;
  tnr_building text;
  tnr_floor    text;
begin
  -- 1) The TNR row: already restored (office = tnr) or the overwritten one.
  select id into tnr_id from meeting_room_metadata
  where lower(name) = 'new york' and lower(trim(office)) = 'tnr'
  limit 1;

  if tnr_id is null then
    select id into tnr_id from meeting_room_metadata
    where lower(name) = 'new york'
    order by (email is not null) desc
    limit 1;
  end if;

  if tnr_id is not null then
    select building into tnr_building from meeting_room_metadata
    where lower(trim(office)) = 'tnr' and id <> tnr_id and building is not null
    group by building order by count(*) desc limit 1;

    -- Match how other TNR rows write floors ("F16" vs "16").
    select case when bool_or(floor ilike 'f%') then 'F16' else '16' end into tnr_floor
    from meeting_room_metadata
    where lower(trim(office)) = 'tnr' and id <> tnr_id and floor is not null;

    update meeting_room_metadata set
      office       = 'tnr',
      building     = tnr_building,
      floor        = coalesce(tnr_floor, 'F16'),
      zone         = null,
      capacity     = 8,
      map_link     = 'https://wiki.vng.vn/file_storage/public/attachment-bf91edaa-7be5-4dd2-a125-00138245cb13.jpg',
      direction    = null,
      direction_vi = null
    where id = tnr_id;
  end if;

  -- 2) The Campus row (no email yet, like the other floor-2 imports).
  select id into campus_id from meeting_room_metadata
  where lower(name) = 'new york' and lower(trim(office)) = 'campus'
  limit 1;

  if campus_id is null then
    insert into meeting_room_metadata (name, office, building, floor, capacity, in_use, map_link)
    values ('New York', 'campus', 'V1', 'F2', 20, false,
            'https://wiki.vng.vn/file_storage/public/attachment-513caab5-9b24-4057-ab00-0d1cadecc683.jpg');
  end if;
end $$;

-- Check: each room the imports touched, with its office. A name that also
-- exists in another office (or a Campus row that has an email) may have been
-- an existing room that got overwritten the same way — review those rows.
select name, office, building, floor, capacity, email, in_use
from meeting_room_metadata
where lower(name) in ('new york', '2332', 'dc', 'melbourne', 'doha')
order by lower(name), office;
