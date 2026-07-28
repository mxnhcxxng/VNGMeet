import { openChat } from "zmp-sdk";

// OA (Official Account) của Zalo Bot đặt phòng. Mở chat với OA này để user nhắn
// trực tiếp với bot.
export const CHATBOT_OA_ID = "4092201589741480262";
export const CHATBOT_URL = "https://zalo.me/4092201589741480262";

// Mở chat với OA qua zmp-sdk (chỉ chạy trong app Zalo); ngoài app thì fallback
// mở link zalo.me.
export function openChatbot(): void {
  try {
    void openChat({ type: "oa", id: CHATBOT_OA_ID }).catch(() => {
      window.open(CHATBOT_URL, "_blank");
    });
  } catch {
    window.open(CHATBOT_URL, "_blank");
  }
}
