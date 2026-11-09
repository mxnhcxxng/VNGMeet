-- Add the Campus V1 floor-2 rooms missing from meeting_room_metadata:
-- 2332, DC, Melbourne, New York. Source: their MyVNG wiki pages
--   2332      https://my.vng.vn/wiki/document?id=cbbdbf00-534d-11ec-ae15-13fee31efb7a
--   DC        https://my.vng.vn/wiki/document?id=72f6b860-5355-11ec-ae15-13fee31efb7a
--   Melbourne https://my.vng.vn/wiki/document?id=233d0e50-5391-11ec-ae15-13fee31efb7a
--   New York  https://my.vng.vn/wiki/document?id=3ae34e20-535a-11ec-ae15-13fee31efb7a
--
-- Email is left empty (the wiki doesn't list mailboxes; the availability job
-- skips rooms without one). The wiki has no room photos, so thumbnail_link
-- stays empty and the app shows its default thumbnail. map_link = the route
-- map image on each page. New York's page has no directions text.
-- Safe to rerun: Campus rooms are matched by name and updated, never
-- duplicated (an email already set on a row is kept). Rooms with the same name
-- in other offices are left alone. (An earlier version matched by name only
-- and overwrote TNR's New York — see fix_new_york_rooms.sql.)

do $$
declare
  r record;
  existing uuid;
begin
  for r in
    select * from (values
      ('2332', 'F2', null::text, 20,
       'https://wiki.vng.vn/file_storage/public/attachment-fe3c13c0-9831-4e93-8efb-6208bf67be2f.jpg',
       'Go straight from the lift. The 2332 room is on the left.',
       'Đi thẳng từ thang máy, phòng 2332 nằm bên trái.'),
      ('DC', 'F2', null::text, 15,
       'https://wiki.vng.vn/file_storage/public/attachment-9b442de4-5aea-44e7-9674-0fbe0f9a2966.jpg',
       'From the lift, go straight along the hallway to the entrance of area B3. The DC room is on the right-hand side.',
       'Từ thang máy, đi thẳng theo hành lang đến lối vào khu B3, phòng DC nằm bên tay phải.'),
      ('Melbourne', 'F2', 'Blue zone', 10,
       'https://wiki.vng.vn/file_storage/public/attachment-66dc00e6-7629-4f4e-a724-2fe35fdff684.jpg',
       'Go to the 2nd floor, turn right at the elevator. The Melbourne meeting room is in the SMT office.',
       'Lên tầng 2, rẽ phải ở thang máy, phòng họp Melbourne nằm trong văn phòng SMT.'),
      ('New York', 'F2', null::text, 20,
       'https://wiki.vng.vn/file_storage/public/attachment-513caab5-9b24-4057-ab00-0d1cadecc683.jpg',
       null::text,
       null::text)
    ) as v(name, floor, zone, capacity, map_link, direction, direction_vi)
  loop
    -- Only Campus rows: the same name can exist in another office (TNR has a
    -- "New York"), which must not be touched.
    select id into existing
    from meeting_room_metadata
    where lower(name) = lower(r.name) and lower(trim(office)) = 'campus'
    order by (email is not null) desc
    limit 1;

    if existing is null then
      insert into meeting_room_metadata (name, office, building, floor, capacity, in_use)
      values (r.name, 'campus', 'V1', r.floor, r.capacity, false)
      returning id into existing;
    end if;

    update meeting_room_metadata set
      office       = 'campus',
      building     = 'V1',
      floor        = r.floor,
      zone         = r.zone,
      capacity     = r.capacity,  -- capacity_size is generated from this
      in_use       = false,  -- not bookable in the app yet
      map_link     = r.map_link,
      direction    = r.direction,
      direction_vi = r.direction_vi
    where id = existing;
  end loop;
end $$;

-- Fix for import_room_doha.sql: the static.vng.vn image used as Doha's photo
-- is actually the wiki's "IT Helpdesk" contact avatar, shown on every page.
update meeting_room_metadata
set thumbnail_link = null
where thumbnail_link = 'https://static.vng.vn/myvng/0496780e-5ef0-4ebd-9221-05fe09273d2a.jpg';
