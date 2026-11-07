-- Add the Doha meeting room (VNG Campus, V1 floor 3, red zone) to
-- meeting_room_metadata. Source: MyVNG wiki "Doha Meeting Room"
-- (https://my.vng.vn/wiki/document?id=e54787e0-5342-11ec-ae15-13fee31efb7a).
--
-- Email is left empty for now (the availability job skips rooms without one).
-- Safe to rerun: an existing "Doha" row is updated instead of duplicated (an
-- email already set on it is kept).

do $$
declare
  existing uuid;
begin
  select id into existing
  from meeting_room_metadata
  where lower(name) = 'doha'
  order by (email is not null) desc
  limit 1;

  if existing is null then
    insert into meeting_room_metadata (name, office, building, floor, capacity, in_use)
    values ('Doha', 'campus', 'V1', 'F3', 15, true)
    returning id into existing;
  end if;

  update meeting_room_metadata set
    office         = 'campus',
    building       = 'V1',
    floor          = 'F3',
    zone           = 'Red zone',
    capacity       = 15,  -- capacity_size ("large") is generated from this
    in_use         = true,
    thumbnail_link = 'https://static.vng.vn/myvng/0496780e-5ef0-4ebd-9221-05fe09273d2a.jpg',
    map_link       = 'https://wiki.vng.vn/file_storage/public/attachment-52ebfd1b-8581-4d7c-80e8-d65bfb76ec13.jpg',
    direction      = 'Go to the 3rd floor, the meeting room is on the right of pantry VNG Games (behind the wall). You can come up by the Atrium stairs or by the lift at the parking lot.',
    direction_vi   = 'Lên tầng 3, phòng họp nằm bên phải pantry VNG Games (phía sau bức tường). Có thể lên bằng cầu thang ở Atrium hoặc thang máy ở bãi xe.'
  where id = existing;
end $$;
