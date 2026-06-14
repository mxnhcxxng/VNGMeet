"use client";

import { useEffect, useRef, useState } from "react";
import {
  EllipsisVertical,
  Pencil,
  PencilToSquare,
  LayoutHeaderCells,
  Gear,
  LayoutSideContentLeft,
  ArrowRightFromSquare,
  ClockArrowRotateLeft,
  TrashBin,
} from "@gravity-ui/icons";
import { Button, Dropdown, Label } from "@heroui/react";
import type { ChatThread } from "@/lib/api";
import { BrandIcon } from "./BrandIcon";

export type View = "browse" | "chat" | "settings" | "bookingHistory";

// Shared pill-button layout for the nav / setting rows (matches the design).
const ROW =
  "flex h-10 w-full items-center gap-2 rounded-full px-4 text-base font-medium text-[#18181b] transition-colors";

function ChatThreadRow({
  thread,
  active,
  onClick,
  onRename,
  onDelete,
}: {
  thread: ChatThread;
  active: boolean;
  onClick: () => void;
  onRename?: (threadId: string, title: string) => Promise<void>;
  onDelete?: (threadId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(thread.title || "Chat mới");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraftTitle(thread.title || "Chat mới");
  }, [editing, thread.title]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startRename = () => {
    if (!onRename || busy) return;
    setDraftTitle(thread.title || "Chat mới");
    setEditing(true);
  };

  const cancelRename = () => {
    setDraftTitle(thread.title || "Chat mới");
    setEditing(false);
  };

  const saveRename = async () => {
    const nextTitle = draftTitle.trim();
    if (!nextTitle) {
      cancelRename();
      return;
    }
    if (nextTitle === (thread.title || "Chat mới")) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onRename?.(thread.id, nextTitle);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const deleteThread = async () => {
    if (!onDelete || busy) return;
    const ok = window.confirm("Xoá chat này?");
    if (!ok) return;
    setBusy(true);
    try {
      await onDelete(thread.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`group/thread flex h-10 w-full items-center rounded-full pl-4 pr-1 text-sm font-medium text-[#18181b] transition-colors ${
        active ? "bg-[var(--default)]" : "hover:bg-[#f5f5f5]"
      }`}
      title={thread.title || "Chat mới"}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draftTitle}
          disabled={busy}
          onChange={(event) => setDraftTitle(event.target.value)}
          onBlur={saveRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") saveRename();
            if (event.key === "Escape") cancelRename();
          }}
          className="min-w-0 flex-1 bg-transparent text-sm font-medium text-[#18181b] outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={onClick}
          className="min-w-0 flex-1 truncate text-left outline-none"
        >
          {thread.title || "Chat mới"}
        </button>
      )}

      {!editing && (
        <Dropdown>
          <Button
            isIconOnly
            aria-label="Chat menu"
            variant="ghost"
            size="sm"
            isDisabled={busy}
            className="size-8 shrink-0 rounded-full opacity-0 transition-opacity group-hover/thread:opacity-100 group-focus-within/thread:opacity-100 data-[open=true]:opacity-100"
            onClick={(event) => event.stopPropagation()}
          >
            <EllipsisVertical className="outline-none" />
          </Button>
          <Dropdown.Popover>
            <Dropdown.Menu
              onAction={(key) => {
                if (key === "rename-chat") startRename();
                if (key === "delete-chat") deleteThread();
              }}
            >
              <Dropdown.Item id="rename-chat" textValue="Rename">
                <Pencil className="size-4 shrink-0 text-muted" />
                <Label>Rename</Label>
              </Dropdown.Item>
              <Dropdown.Item id="delete-chat" textValue="Delete" variant="danger">
                <TrashBin className="size-4 shrink-0 text-danger" />
                <Label>Delete</Label>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      )}
    </div>
  );
}

export function Sidebar({
  view,
  onChange,
  username,
  onLogout,
  chatThreads,
  activeThreadId,
  onNewChat,
  onSelectThread,
  onRenameThread,
  onDeleteThread,
}: {
  view: View;
  onChange: (v: View) => void;
  username?: string;
  onLogout: () => void;
  chatThreads?: ChatThread[];
  activeThreadId?: string | null;
  onNewChat?: () => void;
  onSelectThread?: (threadId: string) => void;
  onRenameThread?: (threadId: string, title: string) => Promise<void>;
  onDeleteThread?: (threadId: string) => Promise<void>;
}) {
  const display = username || "Người dùng";
  const name = display.replace(/@.*/, "");
  const email = display.includes("@") ? display : "";

  return (
    <aside className="flex w-[280px] shrink-0 flex-col rounded-2xl bg-white shadow-sm">
      {/* Brand + collapse */}
      <div className="flex items-center justify-between px-5 pt-5">
        <div className="flex items-center gap-[7.5px]">
          <BrandIcon size={24} className="shrink-0" />
          <span className="text-[18px] font-bold leading-6 text-[#181d27]">VNG MEET</span>
        </div>
        <button
          type="button"
          aria-label="Thu gọn"
          className="flex h-8 w-8 items-center justify-center rounded-2xl text-[#18181b] transition-colors hover:bg-[#f5f5f5]"
        >
          <LayoutSideContentLeft width={16} height={16} />
        </button>
      </div>

      {/* Primary nav */}
      <div className="mt-5 flex flex-col gap-0.5 px-4">
        <button
          type="button"
          onClick={() => {
            onChange("chat");
            onNewChat?.();
          }}
          className={`${ROW} ${view === "chat" && !activeThreadId ? "bg-[var(--default)]" : "hover:bg-[#f5f5f5]"}`}
        >
          <PencilToSquare width={16} height={16} />
          New chat
        </button>
        <button
          type="button"
          onClick={() => onChange("browse")}
          className={`${ROW} ${view === "browse" ? "bg-[var(--default)]" : "hover:bg-[#f5f5f5]"}`}
        >
          <LayoutHeaderCells width={16} height={16} />
          Browse Rooms
        </button>
        <button
          type="button"
          onClick={() => onChange("bookingHistory")}
          className={`${ROW} ${view === "bookingHistory" ? "bg-[var(--default)]" : "hover:bg-[#f5f5f5]"}`}
        >
          <ClockArrowRotateLeft width={16} height={16} />
          Booking History
        </button>
      </div>

      {/* Recents (chat threads) */}
      <div className="mt-3 flex min-h-0 flex-1 flex-col px-4">
        <div className="px-3 pb-1 pt-3 text-xs font-medium text-[#71717a]">Recents</div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {(chatThreads ?? []).map((thread) => {
            const active = view === "chat" && activeThreadId === thread.id;
            return (
              <ChatThreadRow
                key={thread.id}
                thread={thread}
                active={active}
                onClick={() => {
                  onChange("chat");
                  onSelectThread?.(thread.id);
                }}
                onRename={onRenameThread}
                onDelete={onDeleteThread}
              />
            );
          })}
          {!(chatThreads ?? []).length && (
            <div className="px-4 py-2 text-sm text-[#a4a7ae]">Chưa có thread</div>
          )}
        </div>
      </div>

      {/* Setting + divider + user (with logout) */}
      <div className="flex flex-col gap-4 px-4 pb-5 pt-5">
        <button
          type="button"
          onClick={() => onChange("settings")}
          className={`${ROW} ${view === "settings" ? "bg-[var(--default)]" : "hover:bg-[#f5f5f5]"}`}
        >
          <Gear width={16} height={16} />
          Setting
        </button>

        <div className="h-px w-full bg-[#e9eaeb]" />

        <div className="flex items-center justify-between gap-3 px-1 py-2">
          <div className="flex min-w-0 items-center gap-3">
            <img
              src="/default-avatar.jpg"
              alt={display || "User"}
              className="h-9 w-9 shrink-0 rounded-full object-cover"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-[#18181b]">{name}</p>
              {email && <p className="truncate text-xs text-[#71717a]">{email}</p>}
            </div>
          </div>
          <button
            type="button"
            onClick={onLogout}
            aria-label="Đăng xuất"
            title="Đăng xuất"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#71717a] transition-colors hover:bg-[#f5f5f5] hover:text-[#18181b]"
          >
            <ArrowRightFromSquare width={16} height={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}
