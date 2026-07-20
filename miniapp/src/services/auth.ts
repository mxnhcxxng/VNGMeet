import { useSyncExternalStore } from "react";

// Lưu SESSION TOKEN (JWT) do backend VNGMeet cấp sau khi authen bằng SĐT Zalo.
// Token này được gửi kèm mọi request qua header "Authorization: Bearer" (xem
// services/api.ts). Không còn dùng Microsoft Graph token dán tay nữa.
const TOKEN_KEY = "vngmeet_session_token";
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  emit();
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// Hook phản ứng: component sẽ re-render khi token thay đổi (login / logout / hết hạn).
export function useToken(): string | null {
  return useSyncExternalStore(subscribe, getToken);
}
