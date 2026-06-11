export const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    ...init,
  });
  if (res.status === 401) {
    throw new Error("UNAUTHENTICATED");
  }
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

export interface Me {
  authenticated: boolean;
  username?: string;
}

export interface Room {
  id: string;
  name: string;
  email: string;
  building?: string;
  floor?: string;
  capacity?: number;
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

export const api = {
  loginUrl: () => `${API_URL}/api/auth/login`,
  me: () => req<Me>("/api/auth/me"),
  setToken: (access_token: string) =>
    req<{ ok: boolean; username?: string }>("/api/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token }),
    }),
  logout: () => req<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  rooms: () => req<Room[]>("/api/rooms"),
  schedule: (days: number, emails?: string) =>
    req<ScheduleResponse>(
      `/api/schedule?days=${days}${emails ? `&emails=${encodeURIComponent(emails)}` : ""}`
    ),
};
