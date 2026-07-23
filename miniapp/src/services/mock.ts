// Dữ liệu mock cho màn Home. Chưa nối backend — thay bằng API thật sau này.
// Ảnh dùng placeholder ổn định từ picsum (seed cố định → luôn ra cùng 1 ảnh).

export interface UpcomingEvent {
  id: string;
  room: string;
  date: string; // dd/MM
  time: string; // HH:mm - HH:mm
  location: string;
  image: string;
}

export interface AvailableRoom {
  id: string;
  name: string;
  time: string; // HH:mm - HH:mm
  duration: string; // vd "1h", "2h"
  image: string;
}

const img = (seed: string, size = 400) =>
  `https://picsum.photos/seed/${seed}/${size}/${size}`;

export const upcomingEvent: UpcomingEvent = {
  id: "evt-1",
  room: "Amsterdam",
  date: "22/07",
  time: "14:00 - 16:00",
  location: "Tầng 3 - Toà V1",
  image: img("vngmeet-amsterdam", 640),
};

export const availableRooms: AvailableRoom[] = [
  {
    id: "room-jakarta",
    name: "Jakarta",
    time: "14:00 - 15:00",
    duration: "1h",
    image: img("vngmeet-jakarta"),
  },
  {
    id: "room-beijing",
    name: "Beijing",
    time: "14:00 - 17:00",
    duration: "2h",
    image: img("vngmeet-beijing"),
  },
  {
    id: "room-amsterdam",
    name: "Amsterdam",
    time: "14:00 - 15:00",
    duration: "1h",
    image: img("vngmeet-amsterdam-2"),
  },
];
