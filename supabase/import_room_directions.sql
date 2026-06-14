-- Import room directions from the room-list CSV metadata.
-- Run after supabase/schema.sql. Safe to rerun; only non-empty directions are applied.

alter table meeting_room_metadata add column if not exists direction text;

with imported(name, direction) as (
  values
    ('Amsterdam', E'Go to the 3rd floor, turn left at the pantry VNG Games, follow the map and go to the Zalopay area (blue zone), go straight forward then turn left at the Rome/Paris meeting room.\nGo to the 3rd floor by using staircase at the parking lot (or the elevator), then come into the office and turn left.'),
    ('Athens', E'Go to the 3rd floor, turn left at the pantry VNG Games, follow the map and go to the Zalopay area (blue zone), go straight forward then turn left at the Rome/Paris meeting room.\nGo to the 3rd floor by using staircase at the parking lot (or the elevator), then come into the office and turn left.'),
    ('Barcelona', E'Go to the 3rd floor, turn left at the pantry VNG Games, follow the map and go to the Zalopay area (blue zone), go straight forward then turn left at the Rome/Paris meeting room.\nGo to the 3rd floor by using staircase at the parking lot (or the elevator), then come into the office and turn left.'),
    ('Beijing', E'From Main Lobby, go straight through Atrium, turn right towards the IT Helpdesk area, then turn right again and go straight. The Beijing meeting room is on the right-hand side.'),
    ('Berlin', E'Go to the 3rd floor, turn left at the pantry VNG Games, follow the map and go to the Zalopay area (blue zone), go straight forward then turn left at the Rome/Paris meeting room.\nGo to the 3rd floor by using staircase at the parking lot (or the elevator), then come into the office and turn left.'),
    ('Cornell', E'From the 7-Eleven store, go straight to the intersection at the Atrium and turn left, then turn right into the Training area. The Cornell meeting room is on the right-hand side.\nFrom the Main Lobby, go straight through the Atrium, then turn left into the Training area. The Cornell meeting room is on the left-hand side'),
    ('Dubai', E'Go to the 3rd floor, turn left at the Pantry GE, follow the map and go to the Zalopay area (blue zone), turn right when you meet the Rome meeting room.\nGo to the 3rd floor by using staircase at the parking lot (or the elevator), then come into the office, turn right and go straight forward.'),
    ('FA Meeting', E'Go straight from 7-Eleven convenience store, turn right at the first intersection, go straight and turn left at the end of the path.'),
    ('Helsinki', E'From Main Lobby, go straight through Atrium, turn right towards the IT Helpdesk area, then turn right again and go straight. Helsinki meeting room is on the left.'),
    ('Jakarta', E'Go straight from main door to the reception area, turn left at Ha Noi meeting room'),
    ('Lyon', E'From the 7-Eleven store, go straight to the intersection at the Atrium and turn left, then turn right into the Training area. The Lyon meeting room is on the right-hand side.\nFrom the Main Lobby, go straight through the Atrium, then turn left into the Training area. The Lyon meeting room is on the left-hand side'),
    ('Madrid', E'Go to the 3rd floor, turn left at the pantry VNG Games, follow the map and go to the Zalopay area (blue zone), go straight forward.\nGo to the 3rd floor by using staircase at the parking lot (or the elevator), then come into the office and turn right.'),
    ('Manchester', E'Go to the 3rd floor, turn left at the pantry VNG Games, follow the map and go to the Zalopay area (blue zone), go straight forward.\nGo to the 3rd floor by using staircase at the parking lot (or the elevator), then come into the office and turn right.'),
    ('Nairobi', E'From Main Lobby, go straight through Atrium, turn right towards the IT Helpdesk area, then turn right again and go straight. Nairobi meeting room is on the left.'),
    ('Nottingham', E'From the 7-Eleven store, go straight to the intersection at the Atrium and turn left, then turn right into the Training area. The Nottingham meeting room is on the right-hand side.\nFrom the Main Lobby, go straight through the Atrium, then turn left into the Training area. The Nottingham meeting room is on the left-hand side.'),
    ('Oslo', E'Go to the 3rd floor, turn left at the pantry VNG Games, when reaching the balcony, Oslo meeting room is on the right-hand side.'),
    ('Paris', E'Go to the 3rd floor, turn left at the pantry VNG Games, follow the map and go to the Zalopay area (blue zone), go straight forward.\nGo to the 3rd floor by using staircase at the parking lot (or the elevator), then come into the office and turn right.'),
    ('Rome', E'Go to the 3rd floor, turn left at the pantry VNG Games, follow the map and go to the Zalopay area (blue zone), go straight forward.\nGo to the 3rd floor by using staircase at the parking lot (or the elevator), then come into the office and turn right.'),
    ('San Francisco', E'Go to the 2nd floor and turn right.'),
    ('Sao Paulo', E'Go straight from 7-Eleven convenience store, turn right at the first intersection, Sao Paulo meeting room is on the right-hand side.'),
    ('Seattle', E'Go to the 2nd floor, Seattle meeting room is on the right way'),
    ('Seoul', E'Go to the 3rd floor, turn right at the pantry VNG Games'),
    ('Shanghai', E'Go to the 3rd floor, turn right at the pantry VNG Games, when reaching the steel staircase then turn right, go straight forward and Shanghai meeting room is on the right-hand side.\nGo straight from the lift, turn left at the end of the balcony, Shanghai meeting room is on the left-hand side.'),
    ('Shenzhen', E'Go to the 3rd floor, turn right at the pantry VNG Games, when reaching the steel staircase then turn right, go straight forward at the end of the hallway.\nGo straight from the lift, turn right at the intersection, and reach the end of the hallway'),
    ('Silicon Valley', E'From the 7-Eleven store, go straight to the first intersection and turn left. Then, continue straight and turn right. The Silicon Valley meeting room is on the right-hand side.\nFrom the Main Lobby, follow the pathway on the left side of the Atrium, continue straight past the Training rooms, then turn left. The Silicon Valley meeting room is on the left-hand side.'),
    ('Singapore', E'From the 7-Eleven store, go straight to the first intersection and turn left. Then, continue straight and turn right. The Singapore meeting room is on the right-hand side.\nFrom the Main Lobby, follow the pathway on the left side of the Atrium, continue straight past the Training rooms, then turn left. The Singapore meeting room is on the left-hand side.'),
    ('Sydney', E'From the 7-Eleven store, go straight to the first intersection and turn left. Then, continue straight and turn right. The Sydney meeting room is on the right-hand side.\nFrom the Main Lobby, follow the pathway on the left side of the Atrium, continue straight past the Training rooms, then turn left. The Sydney meeting room is on the left-hand side.'),
    ('Taipei', E'Go to the 3rd floor, turn right at the pantry VNG Games, when reaching the steel staircase then turn right, go straight forward and Taipei meeting room is on the left-hand side.\nGo straight from the lift, turn left at the end of the balcony, Taipei meeting room is on the right-hand side.'),
    ('Tel Aviv', E'From the 7-Eleven store, go straight to the first intersection and turn left. Then, continue straight and turn right. The Tel Aviv meeting room is on the right-hand side.\nFrom the Main Lobby, follow the pathway on the left side of the Atrium, continue straight past the Training rooms, then turn left. The Tel Aviv meeting room is on the left-hand side.'),
    ('Tokyo', E'go to the 3rd floor, the meeting room is on the left of Pantry VNG Games'),
    ('Venice', E'Go to the 3rd floor, turn left at the pantry VNG Games, when reaching the balcony then turn right, Venice meeting room is on the left-hand side'),
    ('Yale', E'From the 7-Eleven store, go straight to the intersection at the Atrium and turn left, then turn right into the Training area. The Yale meeting room is on the right-hand side.\nFrom the Main Lobby, go straight through the Atrium, then turn left into the Training area. The Yale meeting room is on the left-hand side.'),
    ('Yangoon', E'Go from the main gate to the Hanoi room, turn left, then go straight, the Yangoon room is on the right'),
    ('Zurich', E'Go to the 3rd floor, turn left at the pantry VNG Games, when reaching the balcony then turn right, Zurich meeting room is on the left-hand side')
)
update meeting_room_metadata as m
set direction = imported.direction
from imported
where lower(btrim(m.name)) = lower(btrim(imported.name))
  and nullif(btrim(imported.direction), '') is not null;
