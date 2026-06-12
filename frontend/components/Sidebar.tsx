"use client";

import type { ChatThread } from "@/lib/api";

export type View = "browse" | "chat";

const ITEMS: { key: View; label: string; icon: React.ReactNode }[] = [
  {
    key: "browse",
    label: "Browse rooms",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </svg>
    ),
  },
  {
    key: "chat",
    label: "Chat to book",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
];

function initialsOf(name: string) {
  return name
    .replace(/@.*/, "")
    .split(/[.\s_]+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
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
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-[#e9eaeb] bg-white px-4 pb-5 pt-6">
      {/* Brand */}
      <div className="mb-6 flex items-center gap-2.5 px-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-gradient-to-br from-[#1570ef] to-[#6938ef] text-white shadow-sm">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z" />
          </svg>
        </div>
        <span className="text-[17px] font-bold tracking-tight text-[#181d27]">VNG Meet</span>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-1">
        {ITEMS.map((it) => {
          const active = view === it.key;
          return (
            <button
              key={it.key}
              onClick={() => onChange(it.key)}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-[15px] font-semibold transition-colors ${
                active
                  ? "bg-[#fafafa] text-[#252b37]"
                  : "text-[#535862] hover:bg-[#fafafa] hover:text-[#252b37]"
              }`}
            >
              <span className={active ? "text-[#414651]" : "text-[#717680]"}>{it.icon}</span>
              {it.label}
            </button>
          );
        })}
      </nav>

      <div className="mt-6 min-h-0 flex-1 border-t border-[#e9eaeb] pt-4">
        <button
          onClick={() => {
            onChange("chat");
            onNewChat?.();
          }}
          className="mb-3 flex w-full items-center gap-3 rounded-md px-3 py-2 text-[14px] font-semibold text-[#252b37] transition-colors hover:bg-[#fafafa]"
        >
          <span className="text-[#717680]">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          New chat
        </button>

        <div className="mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-[#a4a7ae]">
          Threads
        </div>
        <div className="max-h-[calc(100vh-270px)] space-y-1 overflow-y-auto pr-1">
          {(chatThreads ?? []).map((thread) => {
            const active = view === "chat" && activeThreadId === thread.id;
            return (
              <button
                key={thread.id}
                onClick={() => {
                  onChange("chat");
                  onSelectThread?.(thread.id);
                }}
                className={`block w-full truncate rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  active
                    ? "bg-[#f5f5f5] font-semibold text-[#181d27]"
                    : "text-[#535862] hover:bg-[#fafafa] hover:text-[#181d27]"
                }`}
                title={thread.title || "Chat mới"}
              >
                {thread.title || "Chat mới"}
              </button>
            );
          })}
          {!(chatThreads ?? []).length && (
            <div className="px-3 py-2 text-sm text-[#a4a7ae]">Chưa có thread</div>
          )}
        </div>
      </div>

      {/* User */}
      <div className="mt-auto flex items-center gap-3 border-t border-[#e9eaeb] pt-4">
        <div className="relative shrink-0">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#f4f3ff] text-sm font-semibold text-[#5925dc]">
            {initialsOf(display) || "U"}
          </div>
          <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-[#17b26a]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[#181d27]">{name}</p>
          {email && <p className="truncate text-xs text-[#535862]">{email}</p>}
        </div>
        <button
          onClick={onLogout}
          title="Đăng xuất"
          className="rounded-md p-2 text-[#717680] transition-colors hover:bg-[#fafafa] hover:text-[#181d27]"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
          </svg>
        </button>
      </div>
    </aside>
  );
}
