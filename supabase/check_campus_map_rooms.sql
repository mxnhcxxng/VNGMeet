-- Compare the rooms labelled on the campus map (frontend/lib/campusMap.ts,
-- from the Figma floor maps) with Campus rooms in meeting_room_metadata.
-- Read-only. Names are matched loosely, like the app does: case, spaces and
-- punctuation are ignored and doubled letters folded ("Yangoon" = "Yangon",
-- "Ha Noi" = "Hanoi", "Cornel" = "Cornell").
--
-- status:
--   missing_in_db  — on the map, no matching DB row        → needs importing
--   not_on_map     — Campus row in the DB, no label on map  → check the maps
--   ok             — on both (floor_mismatch flags F1/F2/F3 disagreements)

with map_rooms(map_name, map_floor) as (
  values
    -- Floor 1
    ('Stockholm', 'F1'), ('Singapore', 'F1'), ('Silicon Valley', 'F1'), ('Sydney', 'F1'),
    ('Tel Aviv', 'F1'), ('Cambridge', 'F1'), ('Harvard', 'F1'), ('Oxford', 'F1'),
    ('Stanford', 'F1'), ('Yale', 'F1'), ('Cornell', 'F1'), ('Lyon', 'F1'),
    ('Nottingham', 'F1'), ('Mumbai', 'F1'), ('Sao Paulo', 'F1'), ('Manila', 'F1'),
    ('Yangoon', 'F1'), ('Jakarta', 'F1'), ('Ha Noi', 'F1'), ('Da Nang', 'F1'),
    ('Sai Gon', 'F1'), ('Beijing', 'F1'), ('Nairobi', 'F1'), ('Helsinki', 'F1'),
    -- Floor 2
    ('New York', 'F2'), ('San Francisco', 'F2'), ('Seattle', 'F2'), ('2332', 'F2'),
    ('DC', 'F2'), ('Melbourne', 'F2'),
    -- Floor 3
    ('Rome', 'F3'), ('Manchester', 'F3'), ('Durham', 'F3'), ('Bangalore', 'F3'),
    ('Dubai', 'F3'), ('Madrid', 'F3'), ('Paris', 'F3'), ('Athens', 'F3'),
    ('Amsterdam', 'F3'), ('Barcelona', 'F3'), ('Berlin', 'F3'), ('Liverpool', 'F3'),
    ('Zurich', 'F3'), ('Venice', 'F3'), ('Tokyo', 'F3'), ('Doha', 'F3'),
    ('Seoul', 'F3'), ('Taipei', 'F3'), ('Vancouver', 'F3'), ('Toronto', 'F3'),
    ('Shanghai', 'F3'), ('Shenzhen', 'F3')
),
map_keyed as (
  select map_name, map_floor,
         regexp_replace(regexp_replace(lower(map_name), '[^a-z0-9]', '', 'g'), '(.)\1+', '\1', 'g') as k
  from map_rooms
),
db_keyed as (
  select name as db_name, email, building, floor as db_floor, capacity, in_use,
         regexp_replace(regexp_replace(lower(name), '[^a-z0-9]', '', 'g'), '(.)\1+', '\1', 'g') as k
  from meeting_room_metadata
  where lower(trim(office)) = 'campus'
)
select
  case
    when d.k is null then 'missing_in_db'
    when m.k is null then 'not_on_map'
    else 'ok'
  end as status,
  m.map_name,
  m.map_floor,
  d.db_name,
  d.db_floor,
  d.building,
  d.email,
  d.capacity,
  d.in_use,
  (m.k is not null and d.k is not null
    and upper(coalesce(d.db_floor, '')) <> m.map_floor) as floor_mismatch
from map_keyed m
full outer join db_keyed d on d.k = m.k
order by
  case
    when d.k is null then 0
    when m.k is null then 1
    else 2
  end,
  coalesce(m.map_floor, d.db_floor),
  coalesce(m.map_name, d.db_name);
