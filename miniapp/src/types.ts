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
  capacity?: number | null; // số chỗ ngồi (nếu BE có)
  capacity_size?: CapacitySize | null; // small | medium | large
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

// Một phòng trong màn "Chỉ đường" — khớp item trả về từ GET /api/rooms/directory
// (đọc thẳng meeting_room_metadata). office = "Campus" | "TNR" | "Sala"; FE chia
// tab theo office (bỏ Sala vì không có chỉ đường). direction = mô tả đường đi,
// map = ảnh sơ đồ (mở phóng to được).
export interface DirectoryRoom {
  name: string;
  email?: string | null;
  building?: string | null;
  floor?: string | null;
  capacity?: number | null;
  capacity_size?: CapacitySize | null;
  office?: string | null;
  image?: string | null; // thumbnail_link
  direction?: string | null; // chỉ đường (nhiều đoạn, ngăn bằng xuống dòng)
  map?: string | null; // map_link — ảnh sơ đồ chỉ đường
}

// Trạng thái một lượt đặt phòng — khớp status của backend (user_activity).
// Vòng đời BE: pending -> ok -> success -> ongoing (đang diễn ra) -> finished (đã
// dùng xong / check out sớm); canceled + failed là hai kết cục còn lại. Xem
// backend availability._reconcile_room_usage.
//
// TẠM THỜI: "ongoing"/"finished" đang bị comment vì bản Mini App trên prod chưa
// hiểu 2 status này (phải qua duyệt của Zalo mới lên được). Backend đang hạ
// chúng về "success" cho riêng client Mini App — xem
// bookings.LEGACY_MINIAPP_STATUS. Khi bản mới lên prod: bỏ comment ở đây, ở
// pages/history.tsx, components/meeting-detail.tsx, services/i18n.ts, RỒI xoá
// map bên backend.
export type BookingStatus =
  | "success"
  | "ok"
  | "pending"
  // | "ongoing"
  // | "finished"
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

// --- Săn phòng (Room Scout) — khớp GET/POST /api/room-scouts của backend, dùng
// CHUNG shape với bản web (frontend/lib/api.ts RoomScout / RoomScoutPayload). ---

export type CapacitySize = "small" | "medium" | "large";

// Một phiên săn phòng. Backend tự động kiểm tra phòng trống mỗi phút trong khung
// giờ đã chọn và đặt ngay khi có phòng phù hợp → status chuyển "success".
export interface RoomScout {
  id: string;
  email: string;
  scout_date: string; // ISO "yyyy-mm-dd"
  duration_minutes: number;
  capacity_size?: CapacitySize | null;
  capacity_sizes?: CapacitySize[] | null;
  scout_start_time?: string | null; // "HH:MM"
  scout_end_time?: string | null; // "HH:MM"
  ignore_lunch_break?: boolean;
  office?: string | null;
  status: "active" | "stopped" | "expired" | "failed" | "canceled" | "success";
  last_checked_at?: string | null;
  expires_at: string;
  created_at: string;
  // Set khi auto-book thành công → dựng màn "đã tìm thấy phòng".
  booked_room_email?: string | null;
  booked_start_time?: string | null; // "HH:MM"
  booked_end_time?: string | null; // "HH:MM"
  acknowledged_at?: string | null;
  booked_room?: {
    name?: string | null;
    email?: string | null;
    building?: string | null;
    floor?: string | null;
    zone?: string | null;
    capacity_size?: CapacitySize | null;
    thumbnail_link?: string | null;
    map_link?: string | null;
  } | null;
}

// Payload tạo/cập nhật phiên săn phòng (POST/PATCH /api/room-scouts).
export interface RoomScoutPayload {
  scout_date: string; // ISO "yyyy-mm-dd"
  duration_minutes: number;
  capacity_sizes: CapacitySize[];
  scout_start_time: string; // "HH:MM"
  scout_end_time: string; // "HH:MM"
  ignore_lunch_break?: boolean;
  office?: string | null;
}

export interface RoomScoutsResponse {
  scouts: RoomScout[];
  can_send_mail: boolean;
}

// Chế độ giao diện + ngôn ngữ — khớp giá trị hợp lệ của backend (theme:
// system|light|dark, language: en|vi). Dùng chung với bản web.
export type ThemeMode = "system" | "light" | "dark";
export type Language = "en" | "vi";

// Hồ sơ người dùng — khớp field trong GET /api/auth/me (profile). Ngoài các field
// màn "Tìm phòng" cần (office + phòng ưa thích), bổ sung theme/language để đồng bộ
// cài đặt giao diện/ngôn ngữ với bản web.
export interface UserProfile {
  email?: string | null;
  email_username?: string | null;
  phone?: string | null; // SĐT (local VN, vd "0339758256") — hiện ở màn Tài khoản
  office?: string | null;
  building?: string | null;
  floor?: string | null;
  preferred_rooms?: string[] | null; // danh sách email phòng ưa thích
  book_without_confirmation?: boolean | null;
  theme?: ThemeMode | null;
  language?: Language | null;
}

export interface MeResponse {
  authenticated: boolean;
  username?: string;
  email?: string;
  profile?: UserProfile | null;
  profileComplete?: boolean;
  tokenExpiresAt?: number | null; // epoch giây — hạn của session JWT (đếm ngược)
}

// Một lựa chọn cho các trường hồ sơ (office/floor/building/phòng ưa thích) — khớp
// GET /api/users/profile-options, dùng CHUNG shape với web. parentValue dùng để
// lọc floor/building/phòng theo office đang chọn.
export interface UserProfileOption {
  value: string;
  label: string;
  parentField?: string | null;
  parentValue?: string | null;
}

export interface UserProfileOptions {
  office: UserProfileOption[];
  floor: UserProfileOption[];
  building: UserProfileOption[];
  preferredRooms: UserProfileOption[];
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
