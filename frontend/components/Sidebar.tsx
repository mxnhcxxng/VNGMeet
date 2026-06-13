"use client";

import { Dropdown } from "@heroui/react";
import {
  PencilToSquare,
  LayoutHeaderCells,
  Gear,
  LayoutSideContentLeft,
} from "@gravity-ui/icons";
import type { ChatThread } from "@/lib/api";

export type View = "browse" | "chat";

function initialsOf(name: string) {
  return name
    .replace(/@.*/, "")
    .split(/[.\s_]+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

// Shared pill-button layout for the nav / setting rows (matches the design).
const ROW =
  "flex h-10 w-full items-center gap-2 rounded-full px-4 text-base font-medium text-[#18181b] transition-colors";

export function Sidebar({
  view,
  onChange,
  username,
  onLogout,
  chatThreads,
  activeThreadId,
  onNewChat,
  onSelectThread,
}: {
  view: View;
  onChange: (v: View) => void;
  username?: string;
  onLogout: () => void;
  chatThreads?: ChatThread[];
  activeThreadId?: string | null;
  onNewChat?: () => void;
  onSelectThread?: (threadId: string) => void;
}) {
  const display = username || "Người dùng";
  const name = display.replace(/@.*/, "");
  const email = display.includes("@") ? display : "";

  return (
    <aside className="flex w-[280px] shrink-0 flex-col rounded-2xl bg-white shadow-sm">
      {/* Brand + collapse */}
      <div className="flex items-center justify-between px-5 pt-5">
        <div className="flex items-center gap-[7.5px]">
          <div
            className="flex h-6 w-6 items-center justify-center rounded-lg text-white"
            style={{ backgroundImage: "linear-gradient(225deg, #ff9f81 0%, #f2460e 100%)" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 4v16M12 4v10M19 4v16" />
            </svg>
          </div>
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
          className={`${ROW} hover:bg-[#f5f5f5]`}
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
      </div>

      {/* Recents (chat threads) */}
      <div className="mt-3 flex min-h-0 flex-1 flex-col px-4">
        <div className="px-3 pb-1 pt-3 text-xs font-medium text-[#71717a]">Recents</div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
          {(chatThreads ?? []).map((thread) => {
            const active = view === "chat" && activeThreadId === thread.id;
            return (
              <button
                key={thread.id}
                type="button"
                onClick={() => {
                  onChange("chat");
                  onSelectThread?.(thread.id);
                }}
                title={thread.title || "Chat mới"}
                className={`flex h-10 w-full items-center rounded-full px-4 text-left text-sm font-medium text-[#18181b] transition-colors ${
                  active ? "bg-[var(--default)]" : "hover:bg-[#f5f5f5]"
                }`}
              >
                <span className="truncate">{thread.title || "Chat mới"}</span>
              </button>
            );
          })}
          {!(chatThreads ?? []).length && (
            <div className="px-4 py-2 text-sm text-[#a4a7ae]">Chưa có thread</div>
          )}
        </div>
      </div>

      {/* Setting (account menu) + divider + user */}
      <div className="flex flex-col gap-4 px-4 pb-5">
        <Dropdown>
          <Dropdown.Trigger className={`${ROW} justify-start !bg-transparent hover:!bg-[#f5f5f5]`}>
            <Gear width={16} height={16} />
            Setting
          </Dropdown.Trigger>
          <Dropdown.Popover>
            <Dropdown.Menu>
              <Dropdown.Item id="logout" onAction={onLogout}>
                Đăng xuất
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>

        <div className="h-px w-full bg-[#e9eaeb]" />

        <div className="flex items-center gap-3 px-1 py-2">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#a5b4fc] to-[#7c3aed] text-sm font-semibold text-white">
            {initialsOf(display) || "U"}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-[#18181b]">{name}</p>
            {email && <p className="truncate text-xs text-[#71717a]">{email}</p>}
          </div>
        </div>
      </div>
    </aside>
  );
}
