"use client";

import { Avatar } from "@heroui/react";

export type View = "browse" | "chat";

const ITEMS: { key: View; label: string; icon: React.ReactNode }[] = [
  {
    key: "chat",
    label: "Chat",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    key: "browse",
    label: "Browse rooms",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    ),
  },
];

export function Sidebar({
  view,
  onChange,
  username,
  onLogout,
}: {
  view: View;
  onChange: (v: View) => void;
  username?: string;
  onLogout: () => void;
}) {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-default-200 bg-content1 p-4">
      <div className="mb-6 flex items-center gap-2 px-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-medium bg-foreground text-background">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z" />
          </svg>
        </div>
        <span className="text-lg font-semibold tracking-tight">VNG Meet</span>
      </div>

      <nav className="flex flex-col gap-1">
        {ITEMS.map((it) => {
          const active = view === it.key;
          return (
            <button
              key={it.key}
              onClick={() => onChange(it.key)}
              className={`flex items-center gap-3 rounded-medium px-3 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-success-100 text-success-700"
                  : "text-default-600 hover:bg-default-100"
              }`}
            >
              {it.icon}
              {it.label}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto flex items-center gap-3 border-t border-default-200 pt-4">
        <Avatar size="sm" name={username || "U"} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{username || "Người dùng"}</p>
          <button onClick={onLogout} className="text-xs text-default-400 hover:text-danger">
            Đăng xuất
          </button>
        </div>
      </div>
    </aside>
  );
}
