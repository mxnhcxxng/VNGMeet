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

// Lấy tên hiển thị từ session JWT (claim email/preferred_username/name/sub).
// Dùng cho lời chào ở màn Home. Trả null nếu chưa có token / không decode được.
export function getDisplayName(): string | null {
  const token = getToken();
  if (!token) return null;
  try {
    const claims = JSON.parse(atob(token.split(".")[1])) as Record<
      string,
      unknown
    >;
    const raw =
      (claims.preferred_username as string) ||
      (claims.username as string) ||
      (claims.name as string) ||
      (claims.email as string) ||
      (claims.sub as string) ||
      "";
    // Nếu là email thì chỉ lấy phần trước @ (vd cuongdm4@vng.com.vn → cuongdm4).
    return raw ? raw.split("@")[0] : null;
  } catch {
    return null;
  }
}

// Hook: tên hiển thị, tự cập nhật khi token đổi.
export function useDisplayName(): string | null {
  return useSyncExternalStore(subscribe, getDisplayName);
}

// Đọc claim `phone` từ session JWT và định dạng dạng nhóm 03X XXX XXXX (chỉ để
// hiển thị ở màn xác nhận liên kết bot). Trả null nếu không có.
export function getPhone(): string | null {
  const token = getToken();
  if (!token) return null;
  try {
    const claims = JSON.parse(atob(token.split(".")[1])) as Record<string, unknown>;
    const raw = typeof claims.phone === "string" ? claims.phone.trim() : "";
    if (!raw) return null;
    const digits = raw.replace(/\D/g, "");
    // 10 số VN (0xx xxx xxxx) → chèn khoảng trắng cho dễ đọc; khác thì trả nguyên.
    if (digits.length === 10) {
      return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
    }
    return raw;
  } catch {
    return null;
  }
}
