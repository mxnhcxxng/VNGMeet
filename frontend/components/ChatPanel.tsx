"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import {
  Avatar,
  Button,
  Chip,
  Input,
  Label,
  ScrollShadow,
  Spinner,
  TextArea,
  TextField,
  Tooltip,
} from "@heroui/react";
import {
  ArrowDown,
  Check,
  Copy,
  PaperPlane,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
} from "@gravity-ui/icons";
import { api, type BookingRequest, type ChatMessage, type ChatThread } from "@/lib/api";

const SUGGESTIONS = [
  "I need a room for 6 people from 2 to 4 this afternoon",
  "Book a room for tomorrow's team meeting",
  "Show available rooms close to my location",
  "Find a room for a 10-person review session next week",
];

function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-1.5" aria-label="Đang soạn trả lời">
      <span className="typing-dot" style={{ animationDelay: "0ms" }} />
      <span className="typing-dot" style={{ animationDelay: "150ms" }} />
      <span className="typing-dot" style={{ animationDelay: "300ms" }} />
    </div>
  );
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="text-sm leading-7 text-[#252b37]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
          strong: ({ children }) => (
            <strong className="font-semibold text-[#181d27]">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-[#175cd3] underline underline-offset-2 hover:text-[#1449a3]"
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <img
              src={src ?? ""}
              alt={alt ?? "Map"}
              className="mt-2 max-h-72 w-full rounded-lg border border-[#e9eaeb] object-contain"
              loading="lazy"
            />
          ),
          ul: ({ children }) => (
            <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-7">{children}</li>,
          h1: ({ children }) => (
            <h1 className="mb-2 mt-1 text-lg font-semibold text-[#181d27]">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-1 text-base font-semibold text-[#181d27]">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1 mt-1 text-sm font-semibold text-[#181d27]">{children}</h3>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-3 border-l-2 border-[#e9eaeb] pl-3 text-[#535862] last:mb-0">
              {children}
            </blockquote>
          ),
          code: ({ className, children }) => {
            const text = String(children);
            const isBlock = /language-/.test(className ?? "") || text.includes("\n");
            return isBlock ? (
              <code className="font-mono text-[13px]">{children}</code>
            ) : (
              <code className="rounded bg-[#f0f0f1] px-1.5 py-0.5 font-mono text-[13px] text-[#181d27]">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="mb-3 overflow-x-auto rounded-lg bg-[#f5f5f5] p-3 leading-6 last:mb-0">
              {children}
            </pre>
          ),
          hr: () => <hr className="my-3 border-[#e9eaeb]" />,
          table: ({ children }) => (
            <div className="mb-3 overflow-x-auto last:mb-0">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-[#e9eaeb] bg-[#f9f9fa] px-3 py-1.5 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-[#e9eaeb] px-3 py-1.5">{children}</td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
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
      (item?.name === "book_room" || item?.name === "schedule_room") &&
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

function FieldInput({
  label,
  value,
  onChange,
  type,
  placeholder,
  isDisabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  isDisabled?: boolean;
}) {
  return (
    <TextField fullWidth isDisabled={isDisabled}>
      <Label>{label}</Label>
      <Input
        variant="secondary"
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </TextField>
  );
}

function FieldTextArea({
  label,
  value,
  onChange,
  isDisabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  isDisabled?: boolean;
}) {
  return (
    <TextField fullWidth isDisabled={isDisabled}>
      <Label>{label}</Label>
      <TextArea
        rows={3}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </TextField>
  );
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
    <div className="mt-3 w-full max-w-md rounded-2xl border border-[#e9eaeb] bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-[#181d27]">Xác nhận đặt phòng</div>
          <div className="text-xs text-[#535862]">
            Kiểm tra và chỉnh thông tin trước khi book.
          </div>
        </div>
        {actioned && (
          <Chip size="sm" color="success" variant="soft">
            Đã xử lý
          </Chip>
        )}
      </div>
      {localError && (
        <Chip size="sm" color="danger" variant="soft" className="mb-3">
          {localError}
        </Chip>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <FieldInput
          label="Phòng"
          value={draft.room_name || draft.room_email}
          onChange={(value) => update("room_name", value)}
          isDisabled={disabled}
        />
        <FieldInput
          label="Email phòng"
          value={draft.room_email}
          onChange={(value) => update("room_email", value)}
          isDisabled={disabled}
        />
        <FieldInput
          label="Ngày"
          type="date"
          value={draft.date}
          onChange={(value) => update("date", value)}
          isDisabled={disabled}
        />
        <div className="grid grid-cols-2 gap-2">
          <FieldInput
            label="Bắt đầu"
            type="time"
            value={draft.start_time}
            onChange={(value) => update("start_time", value)}
            isDisabled={disabled}
          />
          <FieldInput
            label="Kết thúc"
            type="time"
            value={draft.end_time}
            onChange={(value) => update("end_time", value)}
            isDisabled={disabled}
          />
        </div>
      </div>

      <div className="mt-2 grid gap-2">
        <FieldInput
          label="Tiêu đề"
          value={draft.subject}
          onChange={(value) => update("subject", value)}
          isDisabled={disabled}
        />
        <FieldInput
          label="Người tham dự"
          value={attendeesText}
          onChange={setAttendeesText}
          placeholder="email1@company.com, email2@company.com"
          isDisabled={disabled}
        />
        <FieldTextArea
          label="Nội dung"
          value={draft.body ?? ""}
          onChange={(value) => update("body", value)}
          isDisabled={disabled}
        />
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <Button
          size="sm"
          variant="secondary"
          isDisabled={disabled}
          isPending={busyAction === "reject"}
          onPress={() => submitAction("reject")}
        >
          Từ chối
        </Button>
        <Button
          size="sm"
          variant="primary"
          isDisabled={disabled || !draft.room_email}
          isPending={busyAction === "accept"}
          onPress={() => submitAction("accept")}
        >
          Đồng ý
        </Button>
      </div>
    </div>
  );
}

function ActionIconButton({
  label,
  onPress,
  isActive,
  children,
}: {
  label: string;
  onPress: () => void;
  isActive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <Tooltip.Trigger>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={label}
          onPress={onPress}
          className={`size-7 rounded-lg ${
            isActive ? "text-[#175cd3]" : "text-[#a4a7ae] hover:text-[#414651]"
          }`}
        >
          {children}
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}

function AssistantActions({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const [vote, setVote] = useState<"up" | "down" | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
      <ActionIconButton label={copied ? "Đã copy" : "Copy"} onPress={copy}>
        {copied ? <Check width={15} /> : <Copy width={15} />}
      </ActionIconButton>
      <ActionIconButton
        label="Hữu ích"
        onPress={() => setVote((v) => (v === "up" ? null : "up"))}
        isActive={vote === "up"}
      >
        <ThumbsUp width={15} />
      </ActionIconButton>
      <ActionIconButton
        label="Chưa tốt"
        onPress={() => setVote((v) => (v === "down" ? null : "down"))}
        isActive={vote === "down"}
      >
        <ThumbsDown width={15} />
      </ActionIconButton>
    </div>
  );
}

function AssistantAvatar() {
  return (
    <Avatar size="sm" color="accent" className="mt-0.5 shrink-0">
      <Avatar.Fallback color="accent">
        <Sparkles width={16} />
      </Avatar.Fallback>
    </Avatar>
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
  const [showScrollDown, setShowScrollDown] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollDown(distanceFromBottom > 160);
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      setShowScrollDown(false);
      return;
    }
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    setShowScrollDown(false);
  };

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

  const resetTextareaHeight = () => {
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const send = async (override?: string) => {
    const content = (override ?? input).trim();
    if (!content || sending) return;
    setInput("");
    resetTextareaHeight();
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

  const pickSuggestion = (text: string) => {
    setInput(text);
    textareaRef.current?.focus();
  };

  const empty = !threadId && messages.length === 0 && !sending;

  return (
    <div className="flex h-full w-full flex-col">
      <ScrollShadow
        ref={scrollRef}
        onScroll={onScroll}
        hideScrollBar
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-3xl px-5 py-6">
          {error && (
            <Chip color="danger" variant="soft" size="sm" className="mb-4 self-start">
              {error}
            </Chip>
          )}

          {loading ? (
            <div className="flex h-[60vh] flex-col items-center justify-center gap-3">
              <Spinner />
              <span className="text-sm text-[#535862]">Đang tải chat...</span>
            </div>
          ) : empty ? (
            <div className="flex h-[60vh] flex-col items-center justify-center text-center">
              <Avatar size="lg" color="accent" className="mb-5">
                <Avatar.Fallback color="accent">
                  <Sparkles width={24} />
                </Avatar.Fallback>
              </Avatar>
              <h1 className="text-2xl font-semibold tracking-tight text-[#181d27]">
                When would you like to book a room?
              </h1>
              <p className="mt-2 max-w-md text-sm text-[#535862]">
                Describe your meeting and I&apos;ll suggest the best available rooms.
              </p>
              <div className="mt-8 grid w-full max-w-xl gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((text) => (
                  <button
                    key={text}
                    type="button"
                    onClick={() => pickSuggestion(text)}
                    className="rounded-xl border border-[#e9eaeb] bg-white px-4 py-3 text-left text-sm text-[#414651] transition hover:border-[#d5d7da] hover:bg-[#f9f9fa]"
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-6 pb-4">
              {messages.map((message) => {
                const pending = pendingBookingFromMessage(message);
                const action = pending
                  ? actionStatusByConfirmation(messages, pending.confirmationId)
                  : null;
                const actioned = Boolean(
                  action && (action.action === "reject" || action.status === "ok")
                );

                if (message.role === "user") {
                  return (
                    <div key={message.id} className="flex justify-end">
                      <div className="max-w-[80%] whitespace-pre-line rounded-2xl rounded-br-md bg-[#f5f5f5] px-4 py-2.5 text-sm leading-6 text-[#181d27]">
                        {message.content}
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={message.id} className="group flex gap-3">
                    <AssistantAvatar />
                    <div className="min-w-0 flex-1">
                      {message.content.trim() && <MarkdownMessage content={message.content} />}
                      {pending && (
                        <BookingConfirmationCard
                          pending={pending}
                          threadId={threadId}
                          actioned={actioned}
                          onActionMessage={appendActionMessage}
                        />
                      )}
                      {message.content.trim() && <AssistantActions content={message.content} />}
                    </div>
                  </div>
                );
              })}
              {sending && (
                <div className="flex gap-3">
                  <AssistantAvatar />
                  <TypingDots />
                </div>
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>
      </ScrollShadow>

      <div className="relative mx-auto w-full max-w-3xl px-5 pb-6">
        {showScrollDown && !empty && (
          <div className="pointer-events-none absolute -top-2 left-0 right-0 flex justify-center">
            <Button
              isIconOnly
              size="sm"
              variant="secondary"
              aria-label="Cuộn xuống cuối"
              onPress={scrollToBottom}
              className="pointer-events-auto size-9 rounded-full shadow-md"
            >
              <ArrowDown width={16} />
            </Button>
          </div>
        )}

        <div className="flex items-end gap-2 rounded-2xl border border-[#e9eaeb] bg-white p-3 shadow-sm transition focus-within:border-[#d5d7da]">
          <textarea
            ref={textareaRef}
            rows={2}
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              const el = event.target;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
            }}
            placeholder="Describe your meeting requirements..."
            className="block max-h-[200px] min-h-[52px] w-full flex-1 resize-none bg-transparent px-1 py-1.5 text-sm leading-6 text-[#181d27] outline-none placeholder:text-[#a4a7ae]"
            onKeyDown={(e) => {
              // Ignore Enter while an IME composition is active (Vietnamese / CJK
              // input methods on macOS, etc.). The Enter that commits the
              // composition would otherwise send the message early and leave the
              // just-committed syllable (e.g. "không") behind in the input.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <Button
            isIconOnly
            variant="primary"
            aria-label="Send"
            className="size-10 shrink-0 rounded-full"
            isDisabled={!input.trim()}
            isPending={sending}
            onPress={() => send()}
          >
            <PaperPlane width={18} />
          </Button>
        </div>
      </div>
    </div>
  );
}
