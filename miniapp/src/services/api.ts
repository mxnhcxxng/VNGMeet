import { API_BASE } from "@/config";
import { clearToken, getToken } from "@/services/auth";
import type { PhoneGrant } from "@/services/phone";
import type { ChatMessage, ChatThread } from "@/types";

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
