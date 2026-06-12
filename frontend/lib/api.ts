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
  graphLinked?: boolean;
}

export interface Room {
  id: string;
  name: string;
  email: string;
  building?: string;
  floor?: string;
  capacity?: number;
  zone?: string;
  office?: string;
}

export interface ScheduleRoom extends Room {
  grid: number[][]; // grid[timeIndex][dayIndex] -> status (0 free, 2 busy ...)
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
  subject: string;
  attendees?: string[];
  body?: string;
}

export interface BookingResult {
  ok: boolean;
  id: string;
  webLink?: string;
  subject?: string;
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
  book: (payload: BookingRequest) =>
    req<BookingResult>("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
};
