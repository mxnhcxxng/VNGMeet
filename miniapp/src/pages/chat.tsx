import { useEffect, useRef, useState } from "react";
import { Button, Header, Page, Text, useSnackbar } from "zmp-ui";

import { api, AuthError } from "@/services/api";
import type { ChatMessage } from "@/types";

// Màn chat cơ bản với VNGMeet agent. UI sẽ được define chi tiết sau.
export default function ChatPage() {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const { openSnackbar } = useSnackbar();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadLatest();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  function handleError(e: unknown, fallback: string) {
    if (e instanceof AuthError) {
      // Token đã bị xoá trong api.ts → Gate sẽ tự authen lại bằng SĐT Zalo.
      openSnackbar({
        text: "Phiên đã hết hạn, đang xác thực lại...",
        type: "warning",
      });
      return;
    }
    openSnackbar({ text: fallback, type: "error" });
  }

  async function loadLatest() {
    try {
      const { threads } = await api.chatThreads();
      if (threads.length > 0) {
        setThreadId(threads[0].id);
        const { messages: msgs } = await api.chatMessages(threads[0].id);
        setMessages(msgs);
      }
    } catch (e) {
      handleError(e, "Không tải được lịch sử chat.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSend() {
    const content = input.trim();
    if (!content || sending) return;
    setInput("");
    const optimistic: ChatMessage = {
      id: `tmp-${Date.now()}`,
      role: "user",
      content,
    };
    setMessages((m) => [...m, optimistic]);
    setSending(true);
    try {
      const res = await api.sendChatMessage({
        thread_id: threadId,
        content,
      });
      setThreadId(res.thread.id);
      setMessages((m) => [
        ...m.filter((x) => x.id !== optimistic.id),
        ...res.messages,
      ]);
    } catch (e) {
      // Rollback tin nhắn optimistic + trả lại nội dung vào ô nhập.
      setMessages((m) => m.filter((x) => x.id !== optimistic.id));
      setInput(content);
      handleError(e, "Gửi tin nhắn thất bại.");
    } finally {
      setSending(false);
    }
  }

  function newChat() {
    setThreadId(null);
    setMessages([]);
  }

  return (
    <Page className="flex flex-col h-screen bg-white dark:bg-black">
      <Header title="VNGMeet" showBackIcon={false} />

      <div className="flex items-center px-4 py-2 border-b border-gray-200 dark:border-gray-800">
        <Button size="small" variant="tertiary" onClick={newChat}>
          + Đoạn chat mới
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {loading ? (
          <Text className="text-center text-gray-400 mt-8">Đang tải...</Text>
        ) : messages.length === 0 ? (
          <Text className="text-center text-gray-400 mt-8">
            Hỏi mình về phòng họp nhé! Ví dụ: "Tìm phòng 4 người lúc 9h sáng mai".
          </Text>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words ${
                  m.role === "user"
                    ? "bg-blue-500 text-white"
                    : "bg-gray-100 text-black dark:bg-gray-800 dark:text-white"
                }`}
              >
                {m.content}
              </div>
            </div>
          ))
        )}
        {sending && (
          <div className="flex justify-start">
            <div className="px-3 py-2 rounded-2xl bg-gray-100 dark:bg-gray-800 text-gray-400 text-sm">
              Đang trả lời...
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="flex items-center gap-2 p-3 border-t border-gray-200 dark:border-gray-800">
        <input
          className="flex-1 px-3 py-2 border border-gray-300 rounded-full text-sm outline-none dark:bg-gray-900 dark:text-white dark:border-gray-700"
          placeholder="Nhập tin nhắn..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
        />
        <Button
          onClick={() => void handleSend()}
          disabled={!input.trim() || sending}
          loading={sending}
        >
          Gửi
        </Button>
      </div>
    </Page>
  );
}
