import { supabase } from "./supabase";

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // Supabase path: attach the session JWT. Manual path: rely on the session cookie.
  const token = supabase
    ? (await supabase.auth.getSession()).data.session?.access_token
    : undefined;
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 401) {
    throw new Error("UNAUTHENTICATED");
  }
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

const SCOPES =
  "offline_access openid email profile Place.Read.All Calendars.Read.Shared Calendars.ReadWrite User.Read";

export interface Me {
  authenticated: boolean;
  username?: string;
  email?: string;
  graphLinked?: boolean;
  profile?: UserProfile | null;
  profileComplete?: boolean;
}

export type ThemeMode = "system" | "light" | "dark";

export type UserRole = "admin" | "user";

export interface UserProfile {
  email: string;
  email_username: string;
  office: string;
  floor: string;
  building: string;
  preferred_rooms: string[];
  book_without_confirmation: boolean;
  theme: ThemeMode;
  role: UserRole;
}

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

export interface Room {
  id: string;
  name: string;
  email: string;
  building?: string;
  floor?: string;
  capacity?: number;
  capacity_size?: "small" | "medium" | "large";
  zone?: string;
  office?: string;
  thumbnail_link?: string;
  direction?: string;
}

export interface ScheduleRoom extends Room {
  // Instant days: 0 free, 1 busy, 2 your booking.
  // Scheduled days (room_availability slots still seeded at -1, i.e. beyond the
  // live Graph window): 3 free/schedule-bookable, 4 scheduled by other, 5 your scheduled.
  grid: Array<Array<0 | 1 | 2 | 3 | 4 | 5>>;
}

export interface ScheduleResponse {
  timezone: string;
  slotMinutes: number;
  days: string[];
  times: string[];
  rooms: ScheduleRoom[];
}

export interface BookingRequest {
  room_email: string;
  room_name?: string;
  date: string; // "2026-06-11"
  start_time: string; // "09:00"
  end_time: string; // "10:00"
  booking_type?: "instant" | "scheduled";
  method?: "manual" | "chatbot";
  subject: string;
  attendees?: string[];
  body?: string;
}

export interface UpdateBookingPayload {
  date?: string; // "2026-06-11"
  start_time?: string; // "09:00"
  end_time?: string; // "10:00"
  subject?: string;
  attendees?: string[];
  body?: string;
}

export interface BookingResult {
  ok: boolean;
  id: string;
  webLink?: string;
  subject?: string;
}

export interface Booking {
  id: string;
  room_email: string;
  room_name?: string | null;
  date: string; // "2026-06-11"
  start_time: string; // "09:00"
  end_time: string; // "10:00"
  booking_type: "instant" | "scheduled";
  method: "manual" | "chatbot";
  subject?: string | null;
  attendees?: string[] | null;
  body?: string | null;
  status: "ok" | "failed" | "pending";
  web_link?: string | null;
  created_at: string;
}

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
}

export interface ChatBookingActionPayload {
  thread_id: string;
  confirmation_id: string;
  action: "accept" | "reject" | "expire";
  booking?: BookingRequest;
  book_without_confirmation?: boolean;
}

export const api = {
  // Supabase path (only when configured): OAuth via Azure (Microsoft) provider.
  signIn: () =>
    supabase?.auth.signInWithOAuth({
      provider: "azure",
      options: { scopes: SCOPES, redirectTo: window.location.origin },
    }),
  signOut: () => supabase?.auth.signOut(),
  // Persist the Microsoft refresh token on the backend (once, after OAuth).
  link: (provider_refresh_token: string) =>
    req<{ ok: boolean }>("/api/auth/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider_refresh_token }),
    }),
  // Manual path: paste a Graph access token (no admin / no Supabase needed).
  setToken: (access_token: string) =>
    req<{ ok: boolean; username?: string }>("/api/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token }),
    }),
  logout: () => req<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  me: () => req<Me>("/api/auth/me"),
  userProfileOptions: () => req<UserProfileOptions>("/api/users/profile-options"),
  updateUserProfile: (
    payload: Pick<UserProfile, "office" | "floor" | "building" | "preferred_rooms"> & {
      book_without_confirmation?: boolean;
      theme?: ThemeMode;
    }
  ) =>
    req<{ ok: boolean; profile: UserProfile | null; profileComplete: boolean }>(
      "/api/users/me/profile",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    ),
  touchUserActivity: () =>
    req<{ ok: boolean }>("/api/users/me/activity", { method: "POST" }),
  rooms: () => req<Room[]>("/api/rooms"),
  // Cached availability served from Supabase. The backend refreshes it on demand
  // with the current user's delegated Graph token when rows are older than 5 min.
  // Same shape as schedule() — preferred for the browse grid.
  availability: (days: number, emails?: string) =>
    req<ScheduleResponse>(
      `/api/availability?days=${days}${emails ? `&emails=${encodeURIComponent(emails)}` : ""}`
    ),
  // Live Graph query (kept as a fallback; needs a valid Graph token).
  schedule: (days: number, emails?: string) =>
    req<ScheduleResponse>(
      `/api/schedule?days=${days}${emails ? `&emails=${encodeURIComponent(emails)}` : ""}`
    ),
  // Caller's own booking history. The owner id is derived server-side from the
  // auth token, so this only ever returns the current user's rows.
  myBookings: () => req<{ bookings: Booking[] }>("/api/bookings"),
  book: (payload: BookingRequest) =>
    req<BookingResult>("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  // Edit a booking. Instant bookings update the real calendar event via Graph;
  // scheduled (pending) bookings only update the stored request.
  updateBooking: (id: string, payload: UpdateBookingPayload) =>
    req<{ ok: boolean; booking: Booking }>(`/api/bookings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  // Cancel/delete a booking. Instant bookings are cancelled on the calendar.
  deleteBooking: (id: string) =>
    req<{ ok: boolean }>(`/api/bookings/${id}`, { method: "DELETE" }),
  chatThreads: () => req<{ threads: ChatThread[] }>("/api/chat/threads"),
  renameChatThread: (threadId: string, title: string) =>
    req<{ thread: ChatThread }>(`/api/chat/threads/${threadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  deleteChatThread: (threadId: string) =>
    req<{ ok: boolean }>(`/api/chat/threads/${threadId}`, { method: "DELETE" }),
  chatMessages: (threadId: string) =>
    req<{ messages: ChatMessage[] }>(`/api/chat/threads/${threadId}/messages`),
  sendChatMessage: (payload: { thread_id?: string | null; content: string }) =>
    req<{ thread: ChatThread; messages: ChatMessage[] }>("/api/chat/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  chatBookingAction: (payload: ChatBookingActionPayload) =>
    req<{ ok: boolean; message: ChatMessage }>("/api/chat/bookings/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
};
