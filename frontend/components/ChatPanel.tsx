"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import {
  Avatar,
  Button,
  Checkbox,
  Chip,
  ScrollShadow,
  Spinner,
} from "@heroui/react";
import {
  ArrowDown,
  Calendar,
  Check,
  Clock,
  Copy,
  PaperPlane,
  ThumbsDown,
  ThumbsUp,
} from "@gravity-ui/icons";
import { api, type BookingRequest, type ChatMessage, type ChatThread } from "@/lib/api";
import { BrandIcon } from "./BrandIcon";

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
  createdAt?: string;
};

// Module-level cache so switching away from Chat and back does not refetch
// already-opened threads. Cleared on logout, and per-thread on delete.
const cachedMessagesByThread = new Map<string, ChatMessage[]>();

export function clearChatMessagesCache() {
  cachedMessagesByThread.clear();
}

export function deleteCachedChatThread(threadId: string) {
  cachedMessagesByThread.delete(threadId);
}

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
    createdAt: message.created_at,
  };
}

function actionStatusByConfirmation(messages: ChatMessage[], confirmationId: string) {
  return ([...messages].reverse().find((message) => {
    return (message.metadata as any)?.booking_action?.confirmation_id === confirmationId;
  })?.metadata as any)?.booking_action;
}

type BookingOutcome = "success" | "expired" | "failed" | "cancelled" | null;

function BookingConfirmationCard({
  pending,
  threadId,
  actioned,
  outcome,
  onActionMessage,
}: {
  pending: PendingBooking;
  threadId: string | null;
  actioned: boolean;
  outcome: BookingOutcome;
  onActionMessage: (message: ChatMessage) => void;
}) {
  const [busyAction, setBusyAction] = useState<"accept" | "reject" | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [skipConfirmation, setSkipConfirmation] = useState(false);
  const [expiresAt] = useState(() => {
    const createdAt = pending.createdAt ? new Date(pending.createdAt).getTime() : NaN;
    return (Number.isFinite(createdAt) ? createdAt : Date.now()) + 60_000;
  });
  const [remainingSeconds, setRemainingSeconds] = useState(() =>
    Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
  );
  const expireSentRef = useRef(false);
  const expired = remainingSeconds <= 0;
  const disabled = actioned || expired || !!busyAction || !threadId;
  const booking = pending.booking;
  const roomName = booking.room_name || booking.room_email;
  const title = booking.subject || roomName;
  const mm = String(Math.floor(remainingSeconds / 60)).padStart(2, "0");
  const ss = String(remainingSeconds % 60).padStart(2, "0");

  useEffect(() => {
    if (actioned) return;
    const tick = () => {
      setRemainingSeconds(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [actioned, expiresAt]);

  useEffect(() => {
    if (!threadId || actioned || remainingSeconds > 0 || expireSentRef.current) return;
    expireSentRef.current = true;
    const expire = async () => {
      try {
        const res = await api.chatBookingAction({
          thread_id: threadId,
          confirmation_id: pending.confirmationId,
          action: "expire",
        });
        onActionMessage(res.message);
      } catch {
        /* expiration is best-effort; the card still disables locally */
      }
    };
    expire();
  }, [actioned, onActionMessage, pending.confirmationId, remainingSeconds, threadId]);

  const submitAction = async (action: "accept" | "reject") => {
    if (!threadId || disabled) return;
    setBusyAction(action);
    setLocalError(null);
    try {
      const res = await api.chatBookingAction({
        thread_id: threadId,
        confirmation_id: pending.confirmationId,
        action,
        booking:
          action === "accept" ? { ...booking, method: "chatbot" as const } : undefined,
        book_without_confirmation: action === "accept" ? skipConfirmation : undefined,
      });
      onActionMessage(res.message);
    } catch (e: any) {
      setLocalError(e.message);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="mt-3 flex w-full max-w-[400px] flex-col gap-8 rounded-3xl border border-[#e9eaeb] bg-white p-6">
      <div className="flex flex-col gap-1">
        <div className="flex flex-col items-center gap-3 pt-1">
          <div className="flex size-10 items-center justify-center rounded-full bg-[#fee7de]">
            <Calendar width={16} height={16} className="text-[var(--accent)]" />
          </div>
          <h2 className="w-full break-words text-center text-base font-semibold text-default-900">
            {title}
          </h2>
        </div>
        <p className="text-center text-sm text-default-500">
          Confirm your booking to secure this room
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-base font-medium">
            <span className="text-muted">Room</span>
            <span className="text-default-900">{roomName}</span>
          </div>
          <div className="flex items-center justify-between text-base font-medium">
            <span className="text-muted">Meeting time</span>
            <span className="text-default-900">
              {booking.start_time} - {booking.end_time}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-base font-medium text-muted">Expires in</span>
            {outcome === "success" ? (
              <Chip size="md" color="success" variant="soft">
                Success
              </Chip>
            ) : outcome === "cancelled" ? (
              <Chip size="md" color="default" variant="soft">
                Cancelled
              </Chip>
            ) : outcome === "failed" ? (
              <Chip size="md" color="danger" variant="soft">
                Failed
              </Chip>
            ) : outcome === "expired" || expired ? (
              <Chip size="md" color="danger" variant="soft">
                Expired
              </Chip>
            ) : (
              <Chip size="md" color="danger" variant="soft">
                <span className="flex items-center gap-1">
                  <Clock width={14} height={14} />
                  {mm}:{ss}
                </span>
              </Chip>
            )}
          </div>
        </div>

        <Checkbox
          isSelected={skipConfirmation}
          onChange={setSkipConfirmation}
          isDisabled={disabled}
        >
          <span className="text-sm font-medium text-default-500">
            Book without confirmation next time
          </span>
        </Checkbox>

        {localError && (
          <Chip size="sm" color="danger" variant="soft" className="self-start">
            {localError}
          </Chip>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="tertiary"
          className="shrink-0 rounded-full"
          isDisabled={disabled}
          isPending={busyAction === "reject"}
          onPress={() => submitAction("reject")}
        >
          Cancel
        </Button>
        <Button
          className="flex-1 rounded-full"
          isDisabled={disabled || !booking.room_email}
          isPending={busyAction === "accept"}
          onPress={() => submitAction("accept")}
        >
          Book
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
    <Button
      isIconOnly
      size="sm"
      variant="ghost"
      aria-label={label}
      onPress={onPress}
      className={`size-7 rounded-lg ${isActive ? "text-[var(--accent)]" : "text-muted"}`}
    >
      {children}
    </Button>
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
    <Avatar size="sm" className="mt-0.5 shrink-0 bg-[#FEEAE2]">
      <Avatar.Fallback className="bg-[#FEEAE2]">
        <BrandIcon size={18} />
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
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    threadId ? cachedMessagesByThread.get(threadId) ?? [] : []
  );
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(
    Boolean(threadId && !cachedMessagesByThread.has(threadId))
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const jumpToBottomRef = useRef(true);

  const setCachedMessages = (
    updater: ChatMessage[] | ((messages: ChatMessage[]) => ChatMessage[]),
    cacheThreadId = threadId
  ) => {
    setMessages((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (cacheThreadId) cachedMessagesByThread.set(cacheThreadId, next);
      return next;
    });
  };

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!threadId) {
        jumpToBottomRef.current = true;
        setMessages([]);
        setLoading(false);
        setError(null);
        return;
      }
      const cachedMessages = cachedMessagesByThread.get(threadId);
      if (cachedMessages) {
        jumpToBottomRef.current = true;
        setMessages(cachedMessages);
        setLoading(false);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await api.chatMessages(threadId);
        if (alive) {
          jumpToBottomRef.current = true;
          cachedMessagesByThread.set(threadId, res.messages);
          setMessages(res.messages);
        }
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

  useLayoutEffect(() => {
    if (loading) return;
    const behavior = jumpToBottomRef.current ? "auto" : "smooth";
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior });
      setShowScrollDown(false);
      jumpToBottomRef.current = false;
      return;
    }
    endRef.current?.scrollIntoView({ behavior, block: "end" });
    setShowScrollDown(false);
    jumpToBottomRef.current = false;
  }, [loading, messages.length, sending]);

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
    setCachedMessages((prev) =>
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
    setCachedMessages((prev) => [...prev, optimistic]);
    try {
      const res = await api.sendChatMessage({ thread_id: threadId, content });
      const returned = res.messages;
      setCachedMessages(
        (prev) => [...prev.filter((m) => m.id !== optimistic.id), ...returned],
        res.thread.id
      );
      if (!threadId) onThreadSelected(res.thread.id);
      await refreshThreads();
    } catch (e: any) {
      setError(e.message);
      setCachedMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
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
              <Avatar size="lg" className="mb-5 bg-[#FEEAE2]">
                <Avatar.Fallback className="bg-[#FEEAE2]">
                  <BrandIcon size={28} />
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
                  action &&
                    (action.action === "reject" ||
                      action.status === "ok" ||
                      action.status === "expired")
                );
                // Persisted outcome (survives refresh — read back from message
                // metadata stored by the backend) drives the status chip.
                const outcome: BookingOutcome = !action
                  ? null
                  : action.status === "ok"
                    ? "success"
                    : action.status === "expired"
                      ? "expired"
                      : action.status === "failed"
                        ? "failed"
                        : action.action === "reject"
                          ? "cancelled"
                          : null;

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
                          outcome={outcome}
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

        <div className="flex flex-col gap-2 rounded-2xl border border-[#e9eaeb] bg-[var(--default)] p-3 transition focus-within:bg-[var(--default-hover)]">
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
            className="block max-h-[200px] min-h-[60px] w-full resize-none bg-transparent px-1 py-1.5 text-sm leading-6 text-[#181d27] outline-none placeholder:text-[#a4a7ae]"
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
            className="size-10 shrink-0 self-end rounded-full"
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
