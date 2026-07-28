import { API_BASE } from "@/config";
import { clearToken, getToken } from "@/services/auth";
import type { PhoneGrant } from "@/services/phone";
import type {
  BookingHistoryItem,
  ChatMessage,
  ChatThread,
  DirectoryRoom,
  FreeRoomsResponse,
  MeResponse,
  RoomScout,
  RoomScoutPayload,
  RoomScoutsResponse,
  ScheduleResponse,
  UpcomingEvent,
  UserProfile,
  UserProfileOptions,
} from "@/types";

// Ném ra khi backend trả 401 → session token đã bị xoá, Layout sẽ tự authen lại
// bằng SĐT Zalo.
export class AuthError extends Error {
  constructor() {
    super("UNAUTHENTICATED");
    this.name = "AuthError";
  }
}

// SĐT Zalo chưa được liên kết với tài khoản Microsoft trong VNGMeet (BE trả 403).
// User phải link Microsoft trước (theo phương án B).
export class LinkRequiredError extends Error {
  constructor(public detail?: string) {
    super("LINK_REQUIRED");
    this.name = "LinkRequiredError";
  }
}

// Cache cho lựa chọn hồ sơ (office/floor/building/phòng) — gần như tĩnh trong 1
// phiên. Giữ CẢ promise (chống gọi trùng) LẪN giá trị đã resolve (để màn "Thông
// tin cá nhân" đọc đồng bộ ngay lúc mount → không giật, không loading).
let profileOptionsPromise: Promise<UserProfileOptions> | null = null;
let profileOptionsValue: UserProfileOptions | null = null;

// Giá trị options đã cache (null nếu chưa prefetch xong). Component đọc để khởi
// tạo state đồng bộ, khỏi chờ mạng khi mở màn.
export function getCachedProfileOptions(): UserProfileOptions | null {
  return profileOptionsValue;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      // Session JWT do backend cấp sau khi authen bằng SĐT Zalo.
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) {
    clearToken();
    throw new AuthError();
  }
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export const api = {
  // Authen bằng SĐT Zalo: gửi grant (token + accessToken) lên backend. Backend
  // đổi token→SĐT qua Zalo Open API, map SĐT→user và trả về session JWT.
  // KHÔNG đi qua request() vì lúc này chưa có session token và không muốn 401
  // ở đây kích hoạt vòng lặp authen.
  authWithZalo: async (
    grant: PhoneGrant,
  ): Promise<{ access_token: string; username?: string }> => {
    const res = await fetch(`${API_BASE}/auth/zalo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: grant.token,
        access_token: grant.accessToken,
      }),
    });
    // 403 = SĐT chưa link tài khoản Microsoft → phân biệt để hiện đúng thông báo.
    if (res.status === 403) {
      throw new LinkRequiredError(await res.text().catch(() => undefined));
    }
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return res.json();
  },

  // Hồ sơ người dùng (office, phòng ưa thích...) — dùng để lọc phòng theo toà và
  // đánh dấu phòng ưa thích ở màn "Tìm phòng". Dùng chung /api/auth/me với web.
  me: () => request<MeResponse>("/auth/me"),

  // Cập nhật hồ sơ user — dùng CHUNG PATCH /api/users/me/profile với web. Backend
  // BẮT BUỘC office hợp lệ, nên payload phải kèm đầy đủ office/floor/building/
  // preferred_rooms hiện tại; theme/language là phần muốn đổi. Trả hồ sơ mới.
  updateProfile: (payload: {
    office: string;
    floor?: string;
    building?: string;
    preferred_rooms?: string[];
    book_without_confirmation?: boolean;
    theme?: string;
    language?: string;
  }) =>
    request<{ ok: boolean; profile: UserProfile; profileComplete: boolean }>(
      "/users/me/profile",
      { method: "PATCH", body: JSON.stringify(payload) },
    ),

  // Danh sách lựa chọn cho các trường hồ sơ (office/floor/building/phòng ưa
  // thích) ở màn "Thông tin cá nhân" — dùng CHUNG GET /api/users/profile-options
  // với web. Cache lại promise + giá trị; `force` để nạp lại. Lỗi thì KHÔNG cache
  // để lần sau còn thử lại được.
  userProfileOptions: (force?: boolean) => {
    if (force) {
      profileOptionsPromise = null;
      profileOptionsValue = null;
    }
    if (!profileOptionsPromise) {
      profileOptionsPromise = request<UserProfileOptions>(
        "/users/profile-options",
      )
        .then((o) => {
          profileOptionsValue = o;
          return o;
        })
        .catch((e) => {
          profileOptionsPromise = null;
          throw e;
        });
    }
    return profileOptionsPromise;
  },

  // Lịch sắp tới cho Home: booking thành công & gần nhất trong tương lai.
  // { event: null } khi không có → frontend ẩn section.
  upcomingBooking: () =>
    request<{ event: UpcomingEvent | null }>("/bookings/upcoming"),

  // Lịch sử đặt phòng của chính user (backend suy owner từ token) — dùng chung
  // GET /api/bookings với web; backend đã bổ sung location/image/office/map.
  bookingHistory: () =>
    request<{ bookings: BookingHistoryItem[] }>("/bookings"),

  // Phòng trống hôm nay (đủ 6 mốc thời lượng trong 1 lần gọi). Chỉ gọi khi mở
  // app / bấm làm mới.
  freeRoomsToday: () => request<FreeRoomsResponse>("/rooms/free-today"),

  // Danh sách phòng cho màn "Chỉ đường" — đọc thẳng meeting_room_metadata (không
  // cần Graph token). Kèm chỉ đường + ảnh sơ đồ để dựng màn chi tiết.
  roomsDirectory: () => request<{ rooms: DirectoryRoom[] }>("/rooms/directory"),

  // Lưới lịch phòng cho màn "Tìm phòng" — dùng CHUNG endpoint với web
  // (/api/availability, đọc từ cache Supabase). API_BASE đã có sẵn "/api".
  // days = số ngày muốn xem tính từ hôm nay; emails rỗng = mọi phòng đang dùng.
  availability: (days: number, emails?: string) =>
    request<ScheduleResponse>(
      `/availability?days=${days}${
        emails ? `&emails=${encodeURIComponent(emails)}` : ""
      }`,
    ),

  // Đặt phòng (instant). booking_type do backend tự quyết theo ngày, gửi "instant"
  // cho phòng trống hôm nay/ngày mai. attendees là danh sách username (BE tự thêm
  // hậu tố domain).
  book: (payload: {
    room_email: string;
    room_name?: string | null;
    date: string;
    start_time: string;
    end_time: string;
    subject: string;
    attendees?: string[];
    body?: string | null;
  }) =>
    request<{ ok: boolean }>("/bookings", {
      method: "POST",
      body: JSON.stringify({
        booking_type: "instant",
        method: "manual",
        ...payload,
      }),
    }),

  // --- Săn phòng (Room Scout) — dùng CHUNG /api/room-scouts với web. Backend
  // tự động kiểm tra phòng mỗi phút trong khung giờ đã chọn và đặt ngay khi có
  // phòng phù hợp (auto-book), suy user từ session JWT như đặt phòng thường. ---
  roomScouts: () => request<RoomScoutsResponse>("/room-scouts"),

  createRoomScout: (payload: RoomScoutPayload) =>
    request<{ ok: boolean; scout: RoomScout }>("/room-scouts", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  updateRoomScout: (id: string, payload: RoomScoutPayload) =>
    request<{ ok: boolean; scout: RoomScout }>(`/room-scouts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  // Dừng phiên săn phòng (huỷ). outcome mặc định "canceled".
  stopRoomScout: (id: string, outcome: "canceled" | "success" = "canceled") =>
    request<{ ok: boolean; status: string }>(
      `/room-scouts/${id}?outcome=${outcome}`,
      { method: "DELETE" },
    ),

  // Xác nhận đã xem tất cả phiên săn phòng thành công (ẩn màn "đã tìm thấy").
  acknowledgeAllRoomScouts: () =>
    request<{ ok: boolean }>("/room-scouts/acknowledge-all", {
      method: "POST",
    }),

  chatThreads: () => request<{ threads: ChatThread[] }>("/chat/threads"),

  chatMessages: (threadId: string) =>
    request<{ messages: ChatMessage[] }>(
      `/chat/threads/${threadId}/messages`,
    ),

  sendChatMessage: (payload: { thread_id?: string | null; content: string }) =>
    request<{ thread: ChatThread; messages: ChatMessage[] }>(
      "/chat/messages",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),

  // Liên kết tài khoản với Zalo Bot: đổi mã pairing (bot cấp qua deep-link) lấy
  // liên kết chat_id ↔ tài khoản VNG. Cần session hiện tại (Bearer) của Mini App.
  linkBot: (code: string) =>
    request<{ ok: boolean }>("/bot/link", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
};
