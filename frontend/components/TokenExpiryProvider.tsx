"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@heroui/react";
import { CircleInfo, Xmark, TriangleExclamation } from "@gravity-ui/icons";
import { useT } from "@/app/providers";
import { supabase } from "@/lib/supabase";

// Require the token to remain valid for this long after a task is expected to
// run. This gives scheduled jobs a small margin for startup and API latency.
export const TOKEN_BUFFER_SECONDS = 10 * 60;

type ModalReason = "info" | "refresh";

interface TokenExpiryValue {
  // Unix seconds the auth token expires at, or null when unknown.
  expiresAt: number | null;
  // Seconds remaining right now (clamped at 0), or null when unknown.
  getRemainingSeconds: () => number | null;
  // Opens the token help modal. `reason="refresh"` highlights the refresh steps.
  openTokenModal: (reason?: ModalReason) => void;
  // Returns true if there is enough token time to finish a task needing
  // `neededSeconds`. When not, opens the refresh modal and returns false.
  // Unknown expiry never blocks.
  ensureTokenTime: (neededSeconds: number) => boolean;
}

const TokenExpiryContext = createContext<TokenExpiryValue | null>(null);

export function useTokenExpiry(): TokenExpiryValue {
  const ctx = useContext(TokenExpiryContext);
  if (!ctx) throw new Error("useTokenExpiry must be used within TokenExpiryProvider");
  return ctx;
}

export function TokenExpiryProvider({
  fallbackExpiresAt,
  onExpired,
  children,
}: {
  fallbackExpiresAt?: number | null;
  // Called once the token actually lapses (badge countdown hits zero). The app
  // uses this to show the "session expired" prompt and sign the user out.
  onExpired?: () => void;
  children: React.ReactNode;
}) {
  // Live Supabase session expiry (auto-refreshed) takes precedence over the
  // backend-reported token exp passed in as a fallback (manual-token flow).
  const [sessionExpiresAt, setSessionExpiresAt] = useState<number | null>(null);
  const [modal, setModal] = useState<{ open: boolean; reason: ModalReason }>({
    open: false,
    reason: "info",
  });

  useEffect(() => {
    const client = supabase;
    if (!client) return;
    let active = true;
    client.auth.getSession().then(({ data }) => {
      if (active) setSessionExpiresAt(data.session?.expires_at ?? null);
    });
    const { data: sub } = client.auth.onAuthStateChange((_event, session) => {
      setSessionExpiresAt(session?.expires_at ?? null);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const expiresAt = sessionExpiresAt ?? fallbackExpiresAt ?? null;

  // Fire `onExpired` the moment the token reaches its expiry. Supabase
  // auto-refresh pushes `expiresAt` forward before it lapses (re-running this
  // effect and clearing the timer), so this only triggers when the session can
  // no longer be refreshed. The +1s grace + re-check guards against a race with
  // an in-flight refresh. Kept in a ref so a changing callback identity doesn't
  // reset the timer.
  const onExpiredRef = useRef(onExpired);
  onExpiredRef.current = onExpired;
  useEffect(() => {
    if (expiresAt === null) return;
    const fire = () => {
      // Skip if a refresh moved the deadline into the future in the meantime.
      if (expiresAt - Math.floor(Date.now() / 1000) > 0) return;
      onExpiredRef.current?.();
    };
    const msUntil = expiresAt * 1000 - Date.now() + 1000;
    if (msUntil <= 0) {
      fire();
      return;
    }
    const timer = setTimeout(fire, msUntil);
    return () => clearTimeout(timer);
  }, [expiresAt]);

  const getRemainingSeconds = useCallback(() => {
    if (expiresAt === null) return null;
    return Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  }, [expiresAt]);

  const openTokenModal = useCallback((reason: ModalReason = "info") => {
    setModal({ open: true, reason });
  }, []);

  const ensureTokenTime = useCallback(
    (neededSeconds: number) => {
      const remaining = getRemainingSeconds();
      if (remaining === null) return true; // unknown → don't block
      if (neededSeconds + TOKEN_BUFFER_SECONDS > remaining) {
        setModal({ open: true, reason: "refresh" });
        return false;
      }
      return true;
    },
    [getRemainingSeconds],
  );

  const value = useMemo<TokenExpiryValue>(
    () => ({ expiresAt, getRemainingSeconds, openTokenModal, ensureTokenTime }),
    [expiresAt, getRemainingSeconds, openTokenModal, ensureTokenTime],
  );

  return (
    <TokenExpiryContext.Provider value={value}>
      {children}
      {modal.open && (
        <TokenInfoModal
          reason={modal.reason}
          onClose={() => setModal((m) => ({ ...m, open: false }))}
        />
      )}
    </TokenExpiryContext.Provider>
  );
}

// Help modal explaining the Microsoft access token. When opened with
// reason="refresh" it shows a warning banner and scrolls to the refresh steps.
function TokenInfoModal({
  reason,
  onClose,
}: {
  reason: ModalReason;
  onClose: () => void;
}) {
  const t = useT();
  const refreshRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reason === "refresh") {
      refreshRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [reason]);

  const sections = [
    { q: t("tokenModal.q1"), body: <p>{t("tokenModal.a1")}</p> },
    { q: t("tokenModal.q2"), body: <p>{t("tokenModal.a2")}</p> },
    {
      q: t("tokenModal.q3"),
      body: (
        <>
          <p>{t("tokenModal.a3a")}</p>
          <p className="mt-1">{t("tokenModal.a3b")}</p>
        </>
      ),
    },
    {
      q: t("tokenModal.q4"),
      body: (
        <>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              {t("tokenModal.a4step1")}{" "}
              <a
                href="https://developer.microsoft.com/en-us/graph/graph-explorer"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-[#f05a22] underline underline-offset-2 hover:opacity-80"
              >
                {t("tokenModal.a4step1Link")}
              </a>
            </li>
            <li>{t("tokenModal.a4step2")}</li>
            <li>{t("tokenModal.a4step3")}</li>
            <li>{t("tokenModal.a4step4")}</li>
          </ol>
          <p className="mt-2">{t("tokenModal.a4note")}</p>
        </>
      ),
    },
  ];

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-[#0c0e12]">
        {/* Header: orange info icon (accent) + title + close */}
        <div className="flex items-start gap-3 px-6 pt-6">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#f05a22]/10 text-[#f05a22]">
            <CircleInfo width={22} height={22} />
          </span>
          <h2 className="flex-1 pt-1.5 text-lg font-semibold text-[#181d27] dark:text-[#f7f7f7]">
            {reason === "refresh" ? t("tokenModal.refreshTitle") : t("tokenModal.title")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-[#71717a] transition-colors hover:bg-[#f5f5f5] hover:text-[#18181b] dark:text-[#94979c] dark:hover:bg-[#22262f] dark:hover:text-[#f7f7f7]"
          >
            <Xmark width={18} height={18} />
          </button>
        </div>

        {/* Body */}
        <div className="mt-4 min-h-0 flex-1 space-y-5 overflow-y-auto px-6">
          {reason === "refresh" && (
            <div className="flex items-start gap-2 rounded-xl bg-[#fee7de] p-3 text-sm leading-6 text-[#535862] dark:bg-[#3B1202] dark:text-[#fee7de]">
              <TriangleExclamation className="mt-0.5 size-4 shrink-0 text-[#F05A22]" />
              <span>{t("tokenModal.refreshBanner")}</span>
            </div>
          )}
          {sections.map((s, i) => (
            <div
              key={i}
              ref={i === sections.length - 1 ? refreshRef : undefined}
              className="flex gap-3"
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[#f05a22]/10 text-xs font-semibold text-[#f05a22]">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-[#181d27] dark:text-[#f7f7f7]">{s.q}</p>
                <div className="mt-1 text-sm leading-6 text-[#535862] dark:text-[#94979c]">
                  {s.body}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex justify-end px-6 pb-6 pt-5">
          <Button className="rounded-full" onPress={onClose}>
            {t("tokenModal.close")}
          </Button>
        </div>
      </div>
    </div>
  );
}
