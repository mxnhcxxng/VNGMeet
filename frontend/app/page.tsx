"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  Chip,
  Spinner,
  Textarea,
} from "@heroui/react";
import { api, type Me, type ScheduleResponse } from "@/lib/api";
import { supabase, supabaseEnabled } from "@/lib/supabase";
import { Sidebar, type View } from "@/components/Sidebar";
import { BrowseRooms } from "@/components/BrowseRooms";
import { ChatPanel } from "@/components/ChatPanel";

const RANGE_DAYS = 14;

function LoginScreen({ onAuthed }: { onAuthed: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submitToken = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.setToken(token.trim());
      onAuthed();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-4">
      {/* Decorative gradient backdrop */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary-50 via-background to-secondary-50" />
      <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-primary-200/40 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -right-24 h-72 w-72 rounded-full bg-secondary-200/40 blur-3xl" />

      <Card className="relative w-full max-w-md border border-white/40 shadow-2xl" radius="lg">
        <CardBody className="gap-6 p-8">
          {/* Brand */}
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-secondary text-2xl font-bold text-white shadow-lg shadow-primary/30">
              VM
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">VNG Meet</h1>
              <p className="mt-1 text-sm text-default-500">
                Đăng nhập để xem &amp; đặt phòng họp
              </p>
            </div>
          </div>

          {/* Supabase OAuth — only when configured (cần admin consent). */}
          {supabaseEnabled && (
            <>
              <Button
                color="primary"
                size="lg"
                onPress={() => api.signIn()}
                className="font-medium shadow-md shadow-primary/30"
                startContent={
                  <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden>
                    <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                    <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                    <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                    <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                  </svg>
                }
              >
                Đăng nhập với Microsoft
              </Button>

              <div className="flex items-center gap-3 text-xs font-medium text-default-400">
                <div className="h-px flex-1 bg-default-200" />
                HOẶC TEST NHANH
                <div className="h-px flex-1 bg-default-200" />
              </div>
            </>
          )}

          <div className="flex flex-col gap-3">
            <Textarea
              label="Graph access token"
              labelPlacement="outside"
              description="Lấy từ Graph Explorer → tab Access token. Hết hạn ~1h thì dán lại."
              placeholder="paste access token here"
              minRows={3}
              variant="bordered"
              value={token}
              onValueChange={setToken}
              classNames={{ input: "font-mono text-xs" }}
            />
            <Button
              variant="flat"
              color="secondary"
              isDisabled={!token.trim()}
              isLoading={busy}
              onPress={submitToken}
            >
              Dùng access token này
            </Button>
            {err && (
              <Chip color="danger" variant="flat" size="sm" className="self-start">
                {err}
              </Chip>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

export default function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("browse");
  const [data, setData] = useState<ScheduleResponse | null>(null);
  const [dayIndex, setDayIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch {
      setMe({ authenticated: false });
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial auth check (covers the manual-token cookie session).
  useEffect(() => {
    refreshMe();
  }, [refreshMe]);

  // Supabase OAuth flow (only when configured).
  useEffect(() => {
    if (!supabase) return;
    const { data: sub } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!session) return;
      // Supabase exposes the Microsoft refresh token only right after OAuth.
      if (session.provider_refresh_token) {
        try {
          await api.link(session.provider_refresh_token);
        } catch {
          /* non-fatal */
        }
      }
      if (event !== "TOKEN_REFRESHED") refreshMe();
    });
    return () => sub.subscription.unsubscribe();
  }, [refreshMe]);

  const loadSchedule = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      // Read from the cached availability table (refreshed every 15 min) instead
      // of querying Graph live. Fall back to a live Graph query when the cache
      // isn't available (e.g. manual-token dev mode without Supabase → 503).
      try {
        setData(await api.availability(RANGE_DAYS));
      } catch (e: any) {
        if (e.message === "UNAUTHENTICATED") throw e;
        setData(await api.schedule(RANGE_DAYS));
      }
    } catch (e: any) {
      setError(e.message === "UNAUTHENTICATED" ? "Phiên đăng nhập hết hạn." : e.message);
      if (e.message === "UNAUTHENTICATED") setMe({ authenticated: false });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (me?.authenticated) loadSchedule();
  }, [me?.authenticated, loadSchedule]);

  useEffect(() => {
    if (!me?.authenticated) return;

    const touch = async () => {
      try {
        await api.touchUserActivity();
      } catch {
        /* non-fatal */
      }
    };
    const touchWhenVisible = () => {
      if (document.visibilityState === "visible") touch();
    };

    touch();
    const interval = window.setInterval(touchWhenVisible, 60_000);
    window.addEventListener("focus", touch);
    document.addEventListener("visibilitychange", touchWhenVisible);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", touch);
      document.removeEventListener("visibilitychange", touchWhenVisible);
    };
  }, [me?.authenticated]);

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    if (supabase) await api.signOut();
    setMe({ authenticated: false });
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner label="Đang tải..." />
      </div>
    );
  }

  if (!me?.authenticated) {
    return <LoginScreen onAuthed={refreshMe} />;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        view={view}
        onChange={setView}
        username={me.username}
        onLogout={handleLogout}
      />

      <main className="flex min-w-0 flex-1 flex-col bg-white">
        {error && (
          <div className="border-b border-danger-200 bg-danger-50 px-6 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1">
          {refreshing && !data ? (
            <div className="flex h-full items-center justify-center">
              <Spinner label="Đang quét phòng họp..." />
            </div>
          ) : view === "chat" ? (
            <ChatPanel data={data} dayIndex={dayIndex} />
          ) : !data?.rooms.length ? (
            <div className="flex h-full items-center justify-center text-default-500">
              Không tìm thấy phòng nào được đánh dấu là meeting room.
            </div>
          ) : (
            <BrowseRooms
              data={data}
              dayIndex={dayIndex}
              setDayIndex={(fn) => setDayIndex((n) => fn(n))}
              refreshing={refreshing}
              onRefresh={loadSchedule}
            />
          )}
        </div>
      </main>
    </div>
  );
}
