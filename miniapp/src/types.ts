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

// Trạng thái một lượt đặt phòng — khớp status của backend (user_activity).
export type BookingStatus =
  | "success"
  | "ok"
  | "pending"
  | "failed"
  | "canceled";

// Một dòng trong tab "Lịch sử đặt phòng" (Figma 346-1292) — khớp item trả về từ
// GET /api/bookings (đã được backend bổ sung location/image/office/map).
export interface BookingHistoryItem {
  id: string;
  room_email?: string | null;
  room_name?: string | null; // vd "Amsterdam"
  date: string; // ISO yyyy-mm-dd
  start_time: string; // HH:MM(:SS)
  end_time: string; // HH:MM(:SS)
  booking_type?: "instant" | "scheduled" | "scout";
  method?: "manual" | "chatbot";
  subject?: string | null; // tiêu đề cuộc họp (vd "Cuộc họp của cuongdm4")
  attendees?: string[] | null;
  body?: string | null;
  status: BookingStatus;
  // backend enrich thêm để dựng card + màn chi tiết:
  location?: string | null; // vd "Tầng 3 - Toà V1"
  image?: string | null; // thumbnail_link của phòng
  office?: string | null; // vd "Campus" (subtitle màn chi tiết)
  map?: string | null; // map_link — ảnh sơ đồ chỉ đường
}

// --- Lưới lịch phòng (màn "Tìm phòng") — khớp GET /api/availability của backend,
// dùng CHUNG shape với bản web (xem frontend/lib/api.ts ScheduleResponse). ---

// Trạng thái 1 ô (slot × ngày) trong grid:
//  - Băng "instant" (hôm nay/ngày gần): 0 trống · 1 bận · 2 bạn đã đặt.
//  - Băng "scheduled" (ngoài cửa sổ Graph): 3 trống · 4 người khác đặt · 5 bạn đặt.
//  - 6/7 = đặt của bạn đang chờ phòng phản hồi · 8/9 = cuộc họp bạn được mời.
export type ScheduleStatus = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface ScheduleRoom {
  name: string;
  email: string;
  building?: string | null;
  floor?: string | null;
  capacity?: number | null;
  capacity_size?: "small" | "medium" | "large" | null;
  zone?: string | null;
  office?: string | null;
  thumbnail_link?: string | null;
  // grid[timeIndex][dayIndex] → trạng thái ô.
  grid: ScheduleStatus[][];
  // Cuộc họp của user trong phòng này (tổ chức HOẶC được mời) — dùng để xếp phòng
  // "có lịch hôm nay lên đầu" và chấm xanh ngày có lịch trên dải chọn ngày.
  meetings?: Array<{
    date: string; // ISO yyyy-mm-dd
    start: string; // HH:MM
    end: string; // HH:MM
    role?: "owner" | "attendee";
    subject?: string;
  }>;
}

export interface ScheduleResponse {
  timezone: string;
  slotMinutes: number; // độ dài 1 slot (phút), vd 30
  days: string[]; // ISO yyyy-mm-dd, today .. today+N-1
  times: string[]; // nhãn giờ trong khung giờ làm việc, vd "09:00"
  rooms: ScheduleRoom[];
}

// Hồ sơ người dùng — khớp field trong GET /api/auth/me (profile). Chỉ khai báo
// các field màn "Tìm phòng" cần: office (lọc phòng theo toà) + phòng ưa thích.
export interface UserProfile {
  office?: string | null;
  building?: string | null;
  floor?: string | null;
  preferred_rooms?: string[] | null; // danh sách email phòng ưa thích
}

export interface MeResponse {
  authenticated: boolean;
  username?: string;
  email?: string;
  profile?: UserProfile | null;
  profileComplete?: boolean;
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
