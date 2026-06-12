"use client";

import { useEffect, useRef, useState } from "react";
import { Avatar, Button, Chip, Input, Spinner, Textarea } from "@heroui/react";
import { api, type BookingRequest, type ChatMessage, type ChatThread } from "@/lib/api";

function bubbleClass(role: ChatMessage["role"]) {
  return role === "user"
    ? "bg-[#181d27] text-white"
    : "bg-[#f5f5f5] text-[#181d27]";
}

type PendingBooking = {
  confirmationId: string;
  booking: BookingRequest;
};

function pendingBookingFromMessage(message: ChatMessage): PendingBooking | null {
  const toolResults = (message.metadata as any)?.tool_results;
  if (!Array.isArray(toolResults)) return null;
  const pending = toolResults.find(
    (item) =>
      item?.name === "book_room" &&
      item?.result?.requires_confirmation &&
      item?.result?.confirmation_id &&
      item?.result?.booking
  );
  if (!pending) return null;
  return {
    confirmationId: pending.result.confirmation_id,
    booking: pending.result.booking,
  };
}

function actionStatusByConfirmation(messages: ChatMessage[], confirmationId: string) {
  return ([...messages].reverse().find((message) => {
    return (message.metadata as any)?.booking_action?.confirmation_id === confirmationId;
  })?.metadata as any)?.booking_action;
}

function splitAttendees(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function BookingConfirmationCard({
  pending,
  threadId,
  actioned,
  onActionMessage,
}: {
  pending: PendingBooking;
  threadId: string | null;
  actioned: boolean;
  onActionMessage: (message: ChatMessage) => void;
}) {
  const [draft, setDraft] = useState<BookingRequest>(pending.booking);
  const [attendeesText, setAttendeesText] = useState(
    (pending.booking.attendees ?? []).join(", ")
  );
  const [busyAction, setBusyAction] = useState<"accept" | "reject" | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const disabled = actioned || !!busyAction || !threadId;

  const update = (key: keyof BookingRequest, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const submitAction = async (action: "accept" | "reject") => {
    if (!threadId || disabled) return;
    setBusyAction(action);
    setLocalError(null);
    try {
      const booking = {
        ...draft,
        attendees: splitAttendees(attendeesText),
        method: "chatbot" as const,
      };
      const res = await api.chatBookingAction({
        thread_id: threadId,
        confirmation_id: pending.confirmationId,
        action,
        booking: action === "accept" ? booking : undefined,
      });
      onActionMessage(res.message);
    } catch (e: any) {
      setLocalError(e.message);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="mt-3 w-full rounded-lg border border-[#b2ddff] bg-white p-3 text-[#181d27] shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Xác nhận đặt phòng</div>
          <div className="text-xs text-[#535862]">Kiểm tra và chỉnh thông tin trước khi book.</div>
        </div>
        {actioned && (
          <Chip size="sm" color="success" variant="flat">
            Đã xử lý
          </Chip>
        )}
      </div>
      {localError && (
        <Chip size="sm" color="danger" variant="flat" className="mb-3">
          {localError}
        </Chip>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          size="sm"
          label="Phòng"
          value={draft.room_name || draft.room_email}
          onValueChange={(value) => update("room_name", value)}
          isDisabled={disabled}
        />
        <Input
          size="sm"
          label="Email phòng"
          value={draft.room_email}
          onValueChange={(value) => update("room_email", value)}
          isDisabled={disabled}
        />
        <Input
          size="sm"
          label="Ngày"
          type="date"
          value={draft.date}
          onValueChange={(value) => update("date", value)}
          isDisabled={disabled}
        />
        <div className="grid grid-cols-2 gap-2">
          <Input
            size="sm"
            label="Bắt đầu"
            type="time"
            value={draft.start_time}
            onValueChange={(value) => update("start_time", value)}
            isDisabled={disabled}
          />
          <Input
            size="sm"
            label="Kết thúc"
            type="time"
            value={draft.end_time}
            onValueChange={(value) => update("end_time", value)}
            isDisabled={disabled}
          />
        </div>
      </div>

      <div className="mt-2 grid gap-2">
        <Input
          size="sm"
          label="Tiêu đề"
          value={draft.subject}
          onValueChange={(value) => update("subject", value)}
          isDisabled={disabled}
        />
        <Input
          size="sm"
          label="Người tham dự"
          value={attendeesText}
          onValueChange={setAttendeesText}
          placeholder="email1@company.com, email2@company.com"
          isDisabled={disabled}
        />
        <Textarea
          minRows={2}
          maxRows={3}
          size="sm"
          label="Nội dung"
          value={draft.body ?? ""}
          onValueChange={(value) => update("body", value)}
          isDisabled={disabled}
        />
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <Button
          size="sm"
          variant="flat"
          isDisabled={disabled}
          isLoading={busyAction === "reject"}
          onPress={() => submitAction("reject")}
        >
          Từ chối
        </Button>
        <Button
          size="sm"
          color="primary"
          isDisabled={disabled || !draft.room_email || !draft.subject}
          isLoading={busyAction === "accept"}
          onPress={() => submitAction("accept")}
        >
          Đồng ý
        </Button>
      </div>
    </div>
  );
}

export function ChatPanel({
  threadId,
  onThreadSelected,
  onThreadsChanged,
}: {
  threadId: string | null;
  onThreadSelected: (threadId: string) => void;
  onThreadsChanged: (threads: ChatThread[]) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!threadId) {
        setMessages([]);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await api.chatMessages(threadId);
        if (alive) setMessages(res.messages);
      } catch (e: any) {
        if (alive) setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    return () => {
      alive = false;
    };
  }, [threadId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, sending]);

  const refreshThreads = async () => {
    try {
      const res = await api.chatThreads();
      onThreadsChanged(res.threads);
    } catch {
      /* non-fatal */
    }
  };

  const appendActionMessage = (message: ChatMessage) => {
    setMessages((prev) =>
      prev.some((item) => item.id === message.id) ? prev : [...prev, message]
    );
    refreshThreads();
  };

  const send = async () => {
    const content = input.trim();
    if (!content || sending) return;
    setInput("");
    setError(null);
    setSending(true);
    const optimistic: ChatMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      content,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    try {
      const res = await api.sendChatMessage({ thread_id: threadId, content });
      const returned = res.messages;
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== optimistic.id),
        ...returned,
      ]);
      if (!threadId) onThreadSelected(res.thread.id);
      await refreshThreads();
    } catch (e: any) {
      setError(e.message);
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
    } finally {
      setSending(false);
    }
  };

  const empty = !threadId && messages.length === 0 && !sending;

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-5 py-6">
      {error && (
        <Chip color="danger" variant="flat" size="sm" className="mb-3 self-start">
          {error}
        </Chip>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner label="Đang tải chat..." />
          </div>
        ) : empty ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-[#eff8ff] text-[#175cd3]">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-[#181d27]">
              Bạn muốn đặt phòng lúc nào?
            </h1>
            <p className="mt-2 max-w-md text-sm text-[#535862]">
              Nói ngày, giờ, số người và khu vực. Mình sẽ kiểm tra phòng trống trước khi đặt.
            </p>
          </div>
        ) : (
          <div className="space-y-5 pb-4">
            {messages.map((message) => {
              const pending = pendingBookingFromMessage(message);
              const action = pending
                ? actionStatusByConfirmation(messages, pending.confirmationId)
                : null;
              const actioned = Boolean(
                action && (action.action === "reject" || action.status === "ok")
              );
              return (
                <div
                  key={message.id}
                  className={`flex gap-3 ${message.role === "user" ? "flex-row-reverse" : ""}`}
                >
                  <Avatar
                    size="sm"
                    name={message.role === "user" ? "Bạn" : "AI"}
                    className={message.role === "assistant" ? "bg-[#175cd3] text-white" : ""}
                  />
                  <div className="max-w-[82%]">
                    <div
                      className={`whitespace-pre-line rounded-lg px-4 py-3 text-sm leading-6 ${bubbleClass(message.role)}`}
                    >
                      {message.content}
                    </div>
                    {pending && (
                      <BookingConfirmationCard
                        pending={pending}
                        threadId={threadId}
                        actioned={actioned}
                        onActionMessage={appendActionMessage}
                      />
                    )}
                  </div>
                </div>
              );
            })}
            {sending && (
              <div className="flex gap-3">
                <Avatar size="sm" name="AI" className="bg-[#175cd3] text-white" />
                <div className="rounded-lg bg-[#f5f5f5] px-4 py-3 text-sm text-[#535862]">
                  Đang kiểm tra...
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <div className="mt-4 rounded-xl border border-[#d5d7da] bg-white p-2 shadow-sm">
        <Textarea
          minRows={1}
          maxRows={4}
          value={input}
          onValueChange={setInput}
          placeholder="Ví dụ: Tìm phòng cho 6 người ở V1 lúc 14:00-15:00 hôm nay"
          variant="flat"
          classNames={{
            inputWrapper: "bg-transparent shadow-none",
            input: "text-sm",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="flex justify-end px-1 pb-1">
          <Button
            color="primary"
            size="sm"
            isDisabled={!input.trim()}
            isLoading={sending}
            onPress={send}
          >
            Gửi
          </Button>
        </div>
      </div>
    </div>
  );
}
