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
