"use client";

import { useEffect, useRef, useState } from "react";
import {
  EllipsisVertical,
  Pencil,
  PencilToSquare,
  Magnifier,
  Gear,
  ArrowRightFromSquare,
  ClockArrowRotateLeft,
  Binoculars,
  TrashBin,
  Xmark,
} from "@gravity-ui/icons";
import { Button, Dropdown, Label } from "@heroui/react";
import type { ChatThread } from "@/lib/api";
import { useT } from "@/app/providers";
import { useTokenExpiry } from "./TokenExpiryProvider";
import { BrandIcon } from "./BrandIcon";

export type View = "browse" | "chat" | "settings" | "bookingHistory" | "roomScout";

// Shared pill-button layout for the nav / setting rows (matches the design).
const ROW =
  "flex h-10 w-full items-center gap-2 rounded-full px-4 text-base font-medium text-[#18181b] dark:text-[#f7f7f7] transition-colors";

function ChatThreadRow({
  thread,
  active,
  onClick,
  onPrefetch,
  onRename,
  onDelete,
}: {
  thread: ChatThread;
  active: boolean;
  onClick: () => void;
  onPrefetch?: () => void;
  onRename?: (threadId: string, title: string) => Promise<void>;
  onDelete?: (threadId: string) => Promise<void>;
}) {
  const t = useT();
  const fallbackTitle = t("sidebar.defaultChatTitle");
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(thread.title || fallbackTitle);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Track the action menu's open state ourselves so the ⋮ button stays visible
  // and in its hover look while the menu/action-sheet is open, even after the
  // pointer leaves the row (the popover renders in a portal → row loses hover).
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fade long titles to transparent on the right (Claude-style) instead of an
  // ellipsis. When the ⋮ button is hidden the fade reaches the row's edge; once
  // the button shows (row hover or menu open) the fade finishes ~2.5rem earlier
  // so the text clears out BEFORE the button instead of bleeding under it.
  const titleBase =
    "min-w-0 flex-1 overflow-hidden whitespace-nowrap text-left outline-none";
  const edgeFade =
    "[mask-image:linear-gradient(to_right,#000_calc(100%_-_2.5rem),transparent)] " +
    "[-webkit-mask-image:linear-gradient(to_right,#000_calc(100%_-_2.5rem),transparent)]";
  const beforeBtnFade =
    "[mask-image:linear-gradient(to_right,#000_calc(100%_-_3.75rem),transparent_calc(100%_-_2.5rem))] " +
    "[-webkit-mask-image:linear-gradient(to_right,#000_calc(100%_-_3.75rem),transparent_calc(100%_-_2.5rem))]";
  const groupHoverBeforeBtnFade =
    "group-hover/thread:[mask-image:linear-gradient(to_right,#000_calc(100%_-_3.75rem),transparent_calc(100%_-_2.5rem))] " +
    "group-hover/thread:[-webkit-mask-image:linear-gradient(to_right,#000_calc(100%_-_3.75rem),transparent_calc(100%_-_2.5rem))]";
  const titleFade = menuOpen
    ? `${titleBase} ${beforeBtnFade}`
    : `${titleBase} ${edgeFade} ${groupHoverBeforeBtnFade}`;

  useEffect(() => {
    if (!editing) setDraftTitle(thread.title || fallbackTitle);
  }, [editing, thread.title, fallbackTitle]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startRename = () => {
    if (!onRename || busy) return;
    setDraftTitle(thread.title || fallbackTitle);
    setEditing(true);
  };

  const cancelRename = () => {
    setDraftTitle(thread.title || fallbackTitle);
    setEditing(false);
  };

  const saveRename = async () => {
    const nextTitle = draftTitle.trim();
    if (!nextTitle) {
      cancelRename();
      return;
    }
    if (nextTitle === (thread.title || fallbackTitle)) {
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

  const performDelete = async () => {
    if (!onDelete || busy) return;
    setBusy(true);
    try {
      await onDelete(thread.id);
      setConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`group/thread relative flex h-10 w-full items-center rounded-full pl-4 pr-1 text-sm font-medium text-[#18181b] dark:text-[#f7f7f7] transition-colors ${
        active
          ? "bg-[var(--default)]"
          : menuOpen
            ? "bg-[#f5f5f5] dark:bg-[#22262f]"
            : "hover:bg-[#f5f5f5] dark:hover:bg-[#22262f]"
      }`}
      title={thread.title || fallbackTitle}
      onMouseEnter={onPrefetch}
      onFocus={onPrefetch}
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
          className="min-w-0 flex-1 bg-transparent text-sm font-medium text-[#18181b] dark:text-[#f7f7f7] outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={onClick}
          className={titleFade}
        >
          {thread.title || fallbackTitle}
        </button>
      )}

      {!editing && (
        <Dropdown onOpenChange={setMenuOpen}>
          <Button
            isIconOnly
            aria-label={t("sidebar.chatMenu")}
            variant="ghost"
            size="sm"
            isDisabled={busy}
            className={`absolute right-1 top-1/2 size-8 shrink-0 -translate-y-1/2 rounded-full transition-opacity ${
              menuOpen
                ? "pointer-events-auto opacity-100 bg-[#e4e4e7] dark:bg-[#2a2f38]"
                : "pointer-events-none opacity-0 group-hover/thread:pointer-events-auto group-hover/thread:opacity-100 group-hover/thread:bg-[#e4e4e7] dark:group-hover/thread:bg-[#2a2f38]"
            }`}
            onClick={(event) => event.stopPropagation()}
          >
            <EllipsisVertical className="outline-none" />
          </Button>
          <Dropdown.Popover>
            <Dropdown.Menu
              onAction={(key) => {
                if (key === "rename-chat") startRename();
                if (key === "delete-chat") setConfirmOpen(true);
              }}
            >
              <Dropdown.Item id="rename-chat" textValue={t("sidebar.rename")}>
                <Pencil className="size-4 shrink-0 text-muted" />
                <Label>{t("sidebar.rename")}</Label>
              </Dropdown.Item>
              <Dropdown.Item
                id="delete-chat"
                textValue={t("common.delete")}
                variant="danger"
              >
                <TrashBin className="size-4 shrink-0 text-danger" />
                <Label>{t("common.delete")}</Label>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      )}

      {confirmOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setConfirmOpen(false);
          }}
        >
          <div className="w-full max-w-[420px] rounded-2xl bg-white p-6 shadow-2xl dark:bg-[#0c0e12]">
            <h2 className="text-lg font-semibold text-default-900">
              {t("sidebar.deleteChatTitle")}
            </h2>
            <p className="mt-2 text-sm leading-6 text-default-600">
              {t("sidebar.deleteChatBodyPre")}
              {" "}
              <span className="font-medium text-default-900">
                “{thread.title || fallbackTitle}”
              </span>
              {t("sidebar.deleteChatBodyPost")}
            </p>
            <div className="mt-6 flex items-center justify-end gap-2">
              <Button
                variant="tertiary"
                className="rounded-full"
                isDisabled={busy}
                onPress={() => setConfirmOpen(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="danger"
                className="rounded-full"
                isPending={busy}
                onPress={performDelete}
              >
                {t("common.delete")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Clickable "Token expires in: HH:MM:SS" badge. Ticks every second for the
// display; the shared provider owns the underlying expiry + help modal.
function TokenExpiryBadge() {
  const t = useT();
  const { expiresAt, autoRefresh, openTokenModal } = useTokenExpiry();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(interval);
  }, []);

  // Direct Microsoft logins silently auto-refresh the Graph token, so a
  // countdown would only mislead — hide the badge entirely for them.
  if (autoRefresh) return null;

  const remaining = expiresAt === null ? null : Math.max(0, expiresAt - now);
  const expired = remaining !== null && remaining <= 0;

  let value: string;
  if (remaining === null) value = t("sidebar.tokenUnavailable");
  else if (expired) value = t("sidebar.tokenExpired");
  else {
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    const s = remaining % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    value = `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  // Amber under 2 min, red once expired.
  const valueTone = expired
    ? "text-danger"
    : remaining !== null && remaining < 120
      ? "text-[#dc6803] dark:text-[#f79009]"
      : "text-[#18181b] dark:text-[#f7f7f7]";

  return (
    <button
      type="button"
      onClick={() => openTokenModal("info")}
      className="flex w-full items-center justify-center gap-2 rounded-full bg-[#ebebec] py-1.5 text-sm font-medium transition-colors hover:bg-[#e0e0e1] dark:bg-[#22262f] dark:hover:bg-[#2a2f38]"
    >
      <span className="text-[#71717a] dark:text-[#94979c]">{t("sidebar.tokenExpiresIn")}</span>
      <span className={`font-medium ${remaining !== null && !expired ? "tabular-nums" : ""} ${valueTone}`}>
        {value}
      </span>
    </button>
  );
}

export function Sidebar({
  view,
  onChange,
  username,
  onLogout,
  scoutingActive,
  chatThreads,
  chatThreadsLoading,
  activeThreadId,
  onNewChat,
  onSelectThread,
  onPrefetchThread,
  onRenameThread,
  onDeleteThread,
  open = false,
  onClose,
}: {
  view: View;
  onChange: (v: View) => void;
  username?: string;
  onLogout: () => void;
  scoutingActive?: boolean;
  chatThreads?: ChatThread[];
  chatThreadsLoading?: boolean;
  activeThreadId?: string | null;
  onNewChat?: () => void;
  onSelectThread?: (threadId: string) => void;
  onPrefetchThread?: (threadId: string) => void;
  onRenameThread?: (threadId: string, title: string) => Promise<void>;
  onDeleteThread?: (threadId: string) => Promise<void>;
  // Below `lg` the sidebar is an off-canvas drawer: `open` slides it in and
  // `onClose` is called by the backdrop, the ✕ button, Escape, and every
  // navigation row (picking a destination should reveal it, not hide it).
  open?: boolean;
  onClose?: () => void;
}) {
  const t = useT();
  const display = username || t("common.user");
  const name = display.replace(/@.*/, "");
  const email = display.includes("@") ? display : "";
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);

  // Every navigation action doubles as "close the drawer" on mobile; on desktop
  // `onClose` is a no-op because the sidebar is always visible.
  const navigate = (run: () => void) => () => {
    run();
    onClose?.();
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  return (
    <>
      {/* Drawer backdrop (mobile only) */}
      <div
        aria-hidden
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity duration-300 lg:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

    <aside
      className={`fixed inset-y-2 left-2 z-50 flex w-[280px] max-w-[calc(100vw-4rem)] shrink-0 flex-col rounded-2xl bg-white dark:bg-[#0c0e12] shadow-xl transition-transform duration-300 ease-out lg:static lg:z-auto lg:max-w-none lg:translate-x-0 lg:shadow-sm ${
        open ? "translate-x-0" : "-translate-x-[calc(100%+1rem)]"
      }`}
    >
      {/* Brand */}
      <div className="flex items-center justify-between gap-2 px-5 pt-5">
        <div className="flex items-center gap-[7.5px]">
          <BrandIcon size={24} className="shrink-0" />
          <span className="text-[18px] font-bold leading-6 text-[#181d27] dark:text-[#f7f7f7]">VNG MEET</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("sidebar.closeMenu")}
          className="-mr-1 flex size-8 shrink-0 items-center justify-center rounded-full text-[#71717a] transition-colors hover:bg-[#f5f5f5] hover:text-[#18181b] dark:text-[#94979c] dark:hover:bg-[#22262f] dark:hover:text-[#f7f7f7] lg:hidden"
        >
          <Xmark width={16} height={16} />
        </button>
      </div>

      {/* Primary nav */}
      <div className="mt-5 flex flex-col gap-0.5 px-4">
        <button
          type="button"
          onClick={navigate(() => onNewChat?.())}
          className={`${ROW} ${view === "chat" && !activeThreadId ? "bg-[var(--default)]" : "hover:bg-[#f5f5f5] dark:hover:bg-[#22262f]"}`}
        >
          <PencilToSquare width={16} height={16} />
          {t("sidebar.newChat")}
        </button>
        <button
          type="button"
          onClick={navigate(() => onChange("browse"))}
          className={`${ROW} ${view === "browse" ? "bg-[var(--default)]" : "hover:bg-[#f5f5f5] dark:hover:bg-[#22262f]"}`}
        >
          <Magnifier width={16} height={16} />
          {t("sidebar.browseRooms")}
        </button>
        <button
          type="button"
          onClick={navigate(() => onChange("roomScout"))}
          className={`${ROW} ${view === "roomScout" ? "bg-[var(--default)]" : "hover:bg-[#f5f5f5] dark:hover:bg-[#22262f]"}`}
        >
          <Binoculars width={16} height={16} />
          {t("sidebar.roomScout")}
          {scoutingActive && (
            <span className="relative ml-1 flex size-2" aria-label={t("sidebar.scoutingActive")}>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#f05a22] opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-[#f05a22]" />
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={navigate(() => onChange("bookingHistory"))}
          className={`${ROW} ${view === "bookingHistory" ? "bg-[var(--default)]" : "hover:bg-[#f5f5f5] dark:hover:bg-[#22262f]"}`}
        >
          <ClockArrowRotateLeft width={16} height={16} />
          {t("sidebar.bookingHistory")}
        </button>
      </div>

      {/* Recents (chat threads) */}
      <div className="mt-3 flex min-h-0 flex-1 flex-col px-4">
        <div className="px-3 pb-1 pt-3 text-xs font-medium text-[#71717a] dark:text-[#94979c]">{t("sidebar.recents")}</div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {chatThreadsLoading && !(chatThreads ?? []).length ? (
            // Skeleton pills while the first thread fetch is in flight — same
            // h-10 rounded-full shape as ChatThreadRow so it doesn't jump on load.
            Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="px-1 py-0.5" aria-hidden>
                <div
                  className="h-9 animate-pulse rounded-full bg-default"
                  style={{ width: `${85 - index * 8}%` }}
                />
              </div>
            ))
          ) : (
            <>
              {(chatThreads ?? []).map((thread) => {
                const active = view === "chat" && activeThreadId === thread.id;
                return (
                  <ChatThreadRow
                    key={thread.id}
                    thread={thread}
                    active={active}
                    onClick={navigate(() => onSelectThread?.(thread.id))}
                    onPrefetch={
                      onPrefetchThread
                        ? () => onPrefetchThread(thread.id)
                        : undefined
                    }
                    onRename={onRenameThread}
                    onDelete={onDeleteThread}
                  />
                );
              })}
              {!(chatThreads ?? []).length && (
                <div className="px-4 py-2 text-sm text-[#a4a7ae] dark:text-[#94979c]">{t("sidebar.noChats")}</div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Setting + divider + user (with logout) */}
      <div className="flex flex-col gap-4 px-4 pb-5 pt-5">
        <button
          type="button"
          onClick={navigate(() => onChange("settings"))}
          className={`${ROW} ${view === "settings" ? "bg-[var(--default)]" : "hover:bg-[#f5f5f5] dark:hover:bg-[#22262f]"}`}
        >
          <Gear width={16} height={16} />
          {t("sidebar.settings")}
        </button>

        <div className="h-px w-full bg-[#e9eaeb] dark:bg-[#373a41]" />

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-3 px-1 py-2">
            <div className="flex min-w-0 items-center gap-3">
              <img
                src="/default-avatar.jpg"
                alt={display || "User"}
                className="h-9 w-9 shrink-0 rounded-full object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-[#18181b] dark:text-[#f7f7f7]">{name}</p>
                {email && <p className="truncate text-xs text-[#71717a] dark:text-[#94979c]">{email}</p>}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setLogoutConfirmOpen(true)}
              aria-label={t("sidebar.logout")}
              title={t("sidebar.logout")}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#71717a] dark:text-[#94979c] transition-colors hover:bg-[#f5f5f5] dark:hover:bg-[#22262f] hover:text-[#18181b] dark:hover:text-[#f7f7f7]"
            >
              <ArrowRightFromSquare width={16} height={16} />
            </button>
          </div>

          <TokenExpiryBadge />
        </div>
      </div>

      {logoutConfirmOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setLogoutConfirmOpen(false);
          }}
        >
          <div className="w-full max-w-[420px] rounded-2xl bg-white p-6 shadow-2xl dark:bg-[#0c0e12]">
            <h2 className="text-lg font-semibold text-default-900">{t("sidebar.logoutTitle")}</h2>
            <p className="mt-2 text-sm leading-6 text-default-600">
              {t("sidebar.logoutBody")}
            </p>
            <div className="mt-6 flex items-center justify-end gap-2">
              <Button
                variant="tertiary"
                className="rounded-full"
                onPress={() => setLogoutConfirmOpen(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="danger"
                className="rounded-full"
                onPress={() => {
                  setLogoutConfirmOpen(false);
                  onLogout();
                }}
              >
                {t("sidebar.logout")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </aside>
    </>
  );
}
