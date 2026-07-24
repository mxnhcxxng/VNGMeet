// Kiểu dữ liệu chat — khớp với response của backend (xem backend/app/chat.py).

export interface ChatThread {
  id: string;
  title?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
  feedback?: "positive" | "negative" | null;
}

// Một phòng trống — khớp item trong GET /api/rooms/free-today.
export interface FreeRoom {
  name?: string | null;
  email?: string | null;
  building?: string | null;
  floor?: string | null;
  image?: string | null; // thumbnail_link
  start_time: string; // HH:MM
  end_time: string; // HH:MM
}

// Phòng trống theo từng mốc thời lượng (phút) → danh sách phòng (đã sort, ≤4).
export interface FreeRoomsResponse {
  day: string; // ISO yyyy-mm-dd của ngày đang xét
  isTomorrow: boolean; // true = đã qua 18:00, hiện ngày mai
  durations: number[]; // [30,60,90,120,150,180]
  byDuration: Record<string, FreeRoom[]>;
}

// Trạng thái một lượt đặt phòng trong lịch sử.
export type BookingStatus = "success" | "pending" | "cancelled";

// Một dòng trong tab "Lịch sử đặt phòng" (Figma 346-1292). Hiện là mock (chưa
// nối BE) nhưng đã đúng shape để sau này map thẳng từ API lịch sử booking.
export interface BookingHistoryItem {
  id: string;
  title: string; // vd "Cuộc họp của cuongdm4"
  status: BookingStatus;
  office?: string | null; // vd "Amsterdam"
  date: string; // ISO yyyy-mm-dd
  start_time: string; // HH:MM
  end_time: string; // HH:MM
  location?: string | null; // vd "Tầng 3 - Toà V1"
  image?: string | null; // thumbnail_link của phòng
}

// Lịch "sắp tới" cho màn Home — khớp GET /api/bookings/upcoming của backend.
export interface UpcomingEvent {
  room_name?: string | null;
  room_email?: string | null;
  date: string; // ISO yyyy-mm-dd
  start_time: string; // HH:MM
  end_time: string; // HH:MM
  subject?: string | null;
  location?: string | null; // vd "Tầng 3 - Toà V1"
  image?: string | null; // thumbnail_link của phòng
  office?: string | null; // office của phòng (subtitle màn chi tiết, vd "Amsterdam")
  map?: string | null; // map_link — ảnh sơ đồ chỉ đường tới phòng
  attendees?: string[] | null; // email người tham dự (FE tự bỏ hậu tố domain)
  body?: string | null; // mô tả cuộc họp
}
