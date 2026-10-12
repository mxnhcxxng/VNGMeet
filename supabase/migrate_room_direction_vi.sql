-- Chỉ đường tiếng Việt cho meeting_room_metadata, song song cột `direction`
-- (tiếng Anh). Minigame "Phòng ở đâu?" và các màn chỉ đường hiển thị theo ngôn
-- ngữ người dùng, fallback về `direction` khi chưa có bản dịch.
alter table meeting_room_metadata add column if not exists direction_vi text;
comment on column meeting_room_metadata.direction_vi is 'Hướng dẫn đi đến phòng họp (tiếng Việt).';

-- Bản dịch theo từng câu chỉ đường tiếng Anh hiện có (nhiều phòng dùng chung một câu).
-- Chỉ điền khi direction_vi còn trống để không ghi đè bản đã sửa tay.
update meeting_room_metadata set direction_vi = 'Lên tầng 3, rẽ trái ở pantry VNG Games, đi theo bản đồ đến khu vực Zalopay (khu màu xanh dương), đi thẳng rồi rẽ trái ở phòng họp Rome/Paris.
Lên tầng 3 bằng cầu thang bộ ở bãi xe (hoặc thang máy), vào văn phòng rồi rẽ trái.'
  where direction = 'Go to the 3rd floor, turn left at the pantry VNG Games, follow the map and go to the Zalopay area (blue zone), go straight forward then turn left at the Rome/Paris meeting room.
Go to the 3rd floor by using staircase at the parking lot (or the elevator), then come into the office and turn left.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Lên tầng 3, rẽ trái ở pantry VNG Games, đi theo bản đồ đến khu vực Zalopay (khu màu xanh dương), đi thẳng khoảng 2 mét và nhìn bên tay phải.'
  where direction = 'Go to the 3rd floor, turn left at the pantry VNG Games, follow the map and go to the Zalopay area (blue zone), go straight forward about 2 meters and look on the right-hand side' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Từ sảnh chính, đi thẳng qua Atrium, rẽ phải về phía khu IT Helpdesk, rẽ phải lần nữa rồi đi thẳng. Phòng họp Beijing nằm bên tay phải.'
  where direction = 'From Main Lobby, go straight through Atrium, turn right towards the IT Helpdesk area, then turn right again and go straight. The Beijing meeting room is on the right-hand side.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Từ cửa hàng 7-Eleven, đi thẳng đến ngã tư ở Atrium rồi rẽ trái, sau đó rẽ phải vào khu Training. Phòng họp Cornell nằm bên tay phải.
Từ sảnh chính, đi thẳng qua Atrium rồi rẽ trái vào khu Training. Phòng họp Cornell nằm bên tay trái.'
  where direction = 'From the 7-Eleven store, go straight to the intersection at the Atrium and turn left, then turn right into the Training area. The Cornell meeting room is on the right-hand side.
From the Main Lobby, go straight through the Atrium, then turn left into the Training area. The Cornell meeting room is on the left-hand side' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Lên tầng 3, rẽ trái ở Pantry GE, đi theo bản đồ đến khu vực Zalopay (khu màu xanh dương), gặp phòng họp Rome thì rẽ phải.
Lên tầng 3 bằng cầu thang bộ ở bãi xe (hoặc thang máy), vào văn phòng rồi rẽ phải và đi thẳng.'
  where direction = 'Go to the 3rd floor, turn left at the Pantry GE, follow the map and go to the Zalopay area (blue zone), turn right when you meet the Rome meeting room.
Go to the 3rd floor by using staircase at the parking lot (or the elevator), then come into the office, turn right and go straight forward.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Lên tầng 3, rẽ trái ở pantry VNG Games, đi theo bản đồ đến khu vực Zalopay (khu màu xanh dương), đi thẳng rồi rẽ trái ở phòng họp Rome/Paris.
Lên tầng 3 bằng cầu thang bộ ở bãi xe (hoặc thang máy), vào văn phòng rồi rẽ phải.'
  where direction = 'Go to the 3rd floor, turn left at the pantry VNG Games, follow the map and go to the Zalopay area (blue zone), go straight forward then turn left at the Rome/Paris meeting room.
Go to the 3rd floor by using staircase at the parking lot (or the elevator), then come into the office and turn right.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Đi thẳng từ cửa hàng tiện lợi 7-Eleven, rẽ phải ở ngã tư đầu tiên, đi thẳng rồi rẽ trái ở cuối lối đi.'
  where direction = 'Go straight from 7-Eleven convenience store, turn right at the first intersection, go straight and turn left at the end of the path.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Từ cửa hàng 7-Eleven, đi thẳng đến ngã tư ở Atrium rồi rẽ trái, sau đó rẽ phải vào khu Training.
Từ sảnh chính, đi thẳng qua Atrium rồi rẽ trái vào khu Training.'
  where direction = 'From the 7-Eleven store, go straight to the intersection at the Atrium and turn left, then turn right into the Training area.
From the Main Lobby, go straight through the Atrium, then turn left into the Training area.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Từ sảnh chính, đi thẳng qua Atrium, rẽ phải về phía khu IT Helpdesk, rẽ phải lần nữa rồi đi thẳng. Phòng họp Helsinki nằm bên trái.'
  where direction = 'From Main Lobby, go straight through Atrium, turn right towards the IT Helpdesk area, then turn right again and go straight. Helsinki meeting room is on the left.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Đi thẳng từ cửa chính đến khu lễ tân, rẽ trái ở phòng họp Ha Noi.'
  where direction = 'Go straight from main door to the reception area, turn left at Ha Noi meeting room' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Từ cửa hàng 7-Eleven, đi thẳng đến ngã tư ở Atrium rồi rẽ trái, sau đó rẽ phải vào khu Training. Phòng họp Lyon nằm bên tay phải.
Từ sảnh chính, đi thẳng qua Atrium rồi rẽ trái vào khu Training. Phòng họp Lyon nằm bên tay trái.'
  where direction = 'From the 7-Eleven store, go straight to the intersection at the Atrium and turn left, then turn right into the Training area. The Lyon meeting room is on the right-hand side.
From the Main Lobby, go straight through the Atrium, then turn left into the Training area. The Lyon meeting room is on the left-hand side' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Lên tầng 3, rẽ trái ở pantry VNG Games, đi theo bản đồ đến khu vực Zalopay (khu màu xanh dương), đi thẳng.
Lên tầng 3 bằng cầu thang bộ ở bãi xe (hoặc thang máy), vào văn phòng rồi rẽ phải.'
  where direction = 'Go to the 3rd floor, turn left at the pantry VNG Games, follow the map and go to the Zalopay area (blue zone), go straight forward.
Go to the 3rd floor by using staircase at the parking lot (or the elevator), then come into the office and turn right.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Đi thẳng từ cửa hàng tiện lợi 7-Eleven, rẽ phải ở ngã tư đầu tiên, phòng họp Manila nằm bên tay phải.'
  where direction = 'Go straight from 7-Eleven convenience store, turn right at the first intersection, Manila meeting room is on the right-hand side.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Từ sảnh chính, đi thẳng qua Atrium, rẽ phải về phía khu IT Helpdesk, rẽ phải lần nữa rồi đi thẳng. Phòng họp Nairobi nằm bên trái.'
  where direction = 'From Main Lobby, go straight through Atrium, turn right towards the IT Helpdesk area, then turn right again and go straight. Nairobi meeting room is on the left.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Từ cửa hàng 7-Eleven, đi thẳng đến ngã tư ở Atrium rồi rẽ trái, sau đó rẽ phải vào khu Training. Phòng họp Nottingham nằm bên tay phải.
Từ sảnh chính, đi thẳng qua Atrium rồi rẽ trái vào khu Training. Phòng họp Nottingham nằm bên tay trái.'
  where direction = 'From the 7-Eleven store, go straight to the intersection at the Atrium and turn left, then turn right into the Training area. The Nottingham meeting room is on the right-hand side.
From the Main Lobby, go straight through the Atrium, then turn left into the Training area. The Nottingham meeting room is on the left-hand side.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Lên tầng 3, rẽ trái ở pantry VNG Games, đến ban công thì phòng họp Oslo nằm bên tay phải.'
  where direction = 'Go to the 3rd floor, turn left at the pantry VNG Games, when reaching the balcony, Oslo meeting room is on the right-hand side.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Lên tầng 2 rồi rẽ phải.'
  where direction = 'Go to the 2nd floor and turn right.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Đi thẳng từ cửa hàng tiện lợi 7-Eleven, rẽ phải ở ngã tư đầu tiên, phòng họp Sao Paulo nằm bên tay phải.'
  where direction = 'Go straight from 7-Eleven convenience store, turn right at the first intersection, Sao Paulo meeting room is on the right-hand side.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Lên tầng 2, phòng họp Seattle nằm bên phải.'
  where direction = 'Go to the 2nd floor, Seattle meeting room is on the right way' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Lên tầng 3, rẽ phải ở pantry VNG Games.'
  where direction = 'Go to the 3rd floor, turn right at the pantry VNG Games' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Lên tầng 3, rẽ phải ở pantry VNG Games, đến cầu thang sắt thì rẽ phải, đi thẳng, phòng họp Shanghai nằm bên tay phải.
Đi thẳng từ thang máy, rẽ trái ở cuối ban công, phòng họp Shanghai nằm bên tay trái.'
  where direction = 'Go to the 3rd floor, turn right at the pantry VNG Games, when reaching the steel staircase then turn right, go straight forward and Shanghai meeting room is on the right-hand side.
Go straight from the lift, turn left at the end of the balcony, Shanghai meeting room is on the left-hand side.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Lên tầng 3, rẽ phải ở pantry VNG Games, đến cầu thang sắt thì rẽ phải, đi thẳng đến cuối hành lang.
Đi thẳng từ thang máy, rẽ phải ở ngã tư rồi đi đến cuối hành lang.'
  where direction = 'Go to the 3rd floor, turn right at the pantry VNG Games, when reaching the steel staircase then turn right, go straight forward at the end of the hallway.
Go straight from the lift, turn right at the intersection, and reach the end of the hallway' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Từ cửa hàng 7-Eleven, đi thẳng đến ngã tư đầu tiên rồi rẽ trái. Tiếp tục đi thẳng rồi rẽ phải. Phòng họp Silicon Valley nằm bên tay phải.
Từ sảnh chính, đi theo lối bên trái Atrium, đi thẳng qua các phòng Training rồi rẽ trái. Phòng họp Silicon Valley nằm bên tay trái.'
  where direction = 'From the 7-Eleven store, go straight to the first intersection and turn left. Then, continue straight and turn right. The Silicon Valley meeting room is on the right-hand side.
From the Main Lobby, follow the pathway on the left side of the Atrium, continue straight past the Training rooms, then turn left. The Silicon Valley meeting room is on the left-hand side.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Từ cửa hàng 7-Eleven, đi thẳng đến ngã tư đầu tiên rồi rẽ trái. Tiếp tục đi thẳng rồi rẽ phải. Phòng họp Singapore nằm bên tay phải.
Từ sảnh chính, đi theo lối bên trái Atrium, đi thẳng qua các phòng Training rồi rẽ trái. Phòng họp Singapore nằm bên tay trái.'
  where direction = 'From the 7-Eleven store, go straight to the first intersection and turn left. Then, continue straight and turn right. The Singapore meeting room is on the right-hand side.
From the Main Lobby, follow the pathway on the left side of the Atrium, continue straight past the Training rooms, then turn left. The Singapore meeting room is on the left-hand side.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Đi thẳng từ cửa hàng tiện lợi 7-Eleven, rẽ trái ở ngã tư đầu tiên rồi đi thẳng. Phòng họp Stockholm nằm bên tay trái.'
  where direction = 'Go straight from 7-Eleven convenience store, turn left at the first intersection and go straight. Stockholm meeting room is on the left-hand side.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Từ cửa hàng 7-Eleven, đi thẳng đến ngã tư đầu tiên rồi rẽ trái. Tiếp tục đi thẳng rồi rẽ phải. Phòng họp Sydney nằm bên tay phải.
Từ sảnh chính, đi theo lối bên trái Atrium, đi thẳng qua các phòng Training rồi rẽ trái. Phòng họp Sydney nằm bên tay trái.'
  where direction = 'From the 7-Eleven store, go straight to the first intersection and turn left. Then, continue straight and turn right. The Sydney meeting room is on the right-hand side.
From the Main Lobby, follow the pathway on the left side of the Atrium, continue straight past the Training rooms, then turn left. The Sydney meeting room is on the left-hand side.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Lên tầng 3, rẽ phải ở pantry VNG Games, đến cầu thang sắt thì rẽ phải, đi thẳng, phòng họp Taipei nằm bên tay trái.
Đi thẳng từ thang máy, rẽ trái ở cuối ban công, phòng họp Taipei nằm bên tay phải.'
  where direction = 'Go to the 3rd floor, turn right at the pantry VNG Games, when reaching the steel staircase then turn right, go straight forward and Taipei meeting room is on the left-hand side.
Go straight from the lift, turn left at the end of the balcony, Taipei meeting room is on the right-hand side.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Từ cửa hàng 7-Eleven, đi thẳng đến ngã tư đầu tiên rồi rẽ trái. Tiếp tục đi thẳng rồi rẽ phải. Phòng họp Tel Aviv nằm bên tay phải.
Từ sảnh chính, đi theo lối bên trái Atrium, đi thẳng qua các phòng Training rồi rẽ trái. Phòng họp Tel Aviv nằm bên tay trái.'
  where direction = 'From the 7-Eleven store, go straight to the first intersection and turn left. Then, continue straight and turn right. The Tel Aviv meeting room is on the right-hand side.
From the Main Lobby, follow the pathway on the left side of the Atrium, continue straight past the Training rooms, then turn left. The Tel Aviv meeting room is on the left-hand side.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Lên tầng 3, phòng họp nằm bên trái Pantry VNG Games.'
  where direction = 'go to the 3rd floor, the meeting room is on the left of Pantry VNG Games' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Từ thang máy Atrium, lên tầng 3. Đi ra phía sau thang máy rồi đi thẳng. Toronto là phòng họp thứ hai bên tay trái.'
  where direction = 'From Atrium Lift, go to 3rd floor. Go to the back of the lift then go straight. Toronto is the second meeting room on your left.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Từ thang máy Atrium, lên tầng 3. Đi ra phía sau thang máy rồi đi thẳng. Vancouver là phòng họp đầu tiên bên tay trái.'
  where direction = 'From Atrium Lift, go to 3rd floor. Go to the back of the lift then go straight. Vancouver is the first meeting room on your left.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Lên tầng 3, rẽ trái ở pantry VNG Games, đến ban công thì rẽ phải, phòng họp Venice nằm bên tay trái.'
  where direction = 'Go to the 3rd floor, turn left at the pantry VNG Games, when reaching the balcony then turn right, Venice meeting room is on the left-hand side' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Từ cửa hàng 7-Eleven, đi thẳng đến ngã tư ở Atrium rồi rẽ trái, sau đó rẽ phải vào khu Training. Phòng họp Yale nằm bên tay phải.
Từ sảnh chính, đi thẳng qua Atrium rồi rẽ trái vào khu Training. Phòng họp Yale nằm bên tay trái.'
  where direction = 'From the 7-Eleven store, go straight to the intersection at the Atrium and turn left, then turn right into the Training area. The Yale meeting room is on the right-hand side.
From the Main Lobby, go straight through the Atrium, then turn left into the Training area. The Yale meeting room is on the left-hand side.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Từ cổng chính đi đến phòng Hanoi, rẽ trái rồi đi thẳng, phòng Yangoon nằm bên phải.'
  where direction = 'Go from the main gate to the Hanoi room, turn left, then go straight, the Yangoon room is on the right' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Lên tầng 3, rẽ trái ở pantry VNG Games, đến ban công thì rẽ phải, phòng họp Zurich nằm bên tay trái.'
  where direction = 'Go to the 3rd floor, turn left at the pantry VNG Games, when reaching the balcony then turn right, Zurich meeting room is on the left-hand side' and direction_vi is null;

-- Phòng thêm ngày 2026-10-13 (Mumbai, Da Nang, Ha Noi, Sai Gon).
update meeting_room_metadata set direction_vi = 'Đi thẳng từ cửa hàng tiện lợi 7-Eleven, rẽ trái ở ngã tư đầu tiên, phòng họp Mumbai nằm bên tay trái.'
  where direction = 'Go straight from 7-Eleven convenience store, turn left at the first intersection, Mumbai meeting room is on the left-hand side.' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Đi thẳng từ cửa chính đến khu lễ tân, phòng họp Da Nang nằm bên trái.'
  where direction = 'Go straight from main door to the reception area, Da Nang meeting room is on the left' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Đi thẳng từ cửa chính đến khu lễ tân, phòng họp Ha Noi nằm bên trái.'
  where direction = 'Go straight from main door to the reception area, Ha Noi meeting room is on the left' and direction_vi is null;
update meeting_room_metadata set direction_vi = 'Đi thẳng từ cửa chính đến khu lễ tân, phòng họp Sai Gon nằm bên trái.'
  where direction = 'Go straight from main door to the reception area, Sai Gon meeting room is on the left' and direction_vi is null;
