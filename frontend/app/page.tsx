"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  Chip,
  Input,
  Select,
  SelectItem,
  Spinner,
  Textarea,
} from "@heroui/react";
import {
  api,
  type ChatThread,
  type Me,
  type ScheduleResponse,
  type UserProfileOptions,
} from "@/lib/api";
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

function ProfileInfoScreen({
  me,
  onSaved,
  onLogout,
}: {
  me: Me;
  onSaved: (me: Me) => void;
  onLogout: () => void;
}) {
  const [office, setOffice] = useState(me.profile?.office ?? "");
  const [floor, setFloor] = useState(me.profile?.floor ?? "");
  const [building, setBuilding] = useState(me.profile?.building ?? "");
  const [options, setOptions] = useState<UserProfileOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const email = me.profile?.email || me.email || "";
  const emailUsername =
    me.profile?.email_username || (email.includes("@") ? email.split("@")[0] : "");
  const isCampus = office === "campus";
  const floorOptions =
    options?.floor.filter((item) => item.parentValue === office) ?? [];
  const buildingOptions =
    options?.building.filter((item) => item.parentValue === office) ?? [];
  const canSave = Boolean(office && (!isCampus || (floor && building)));

  useEffect(() => {
    const loadOptions = async () => {
      setOptionsLoading(true);
      setErr(null);
      try {
        setOptions(await api.userProfileOptions());
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setOptionsLoading(false);
      }
    };
    loadOptions();
  }, []);

  useEffect(() => {
    if (!isCampus) {
      setFloor("");
      setBuilding("");
    }
  }, [isCampus]);

  const submitProfile = async () => {
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.updateUserProfile({
        office,
        floor: isCampus ? floor : "",
        building: isCampus ? building : "",
      });
      onSaved({
        ...me,
        profile: res.profile,
        profileComplete: res.profileComplete,
      });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-default-50 p-4">
      <Card className="w-full max-w-xl border border-default-200 shadow-xl" radius="lg">
        <CardBody className="gap-6 p-8">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Hoàn tất thông tin cá nhân
            </h1>
            <p className="mt-2 text-sm text-default-500">
              Thông tin này giúp gợi ý và lọc phòng họp đúng địa điểm làm việc của bạn.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Email"
              labelPlacement="outside"
              value={email}
              isDisabled
              variant="bordered"
              className="sm:col-span-2"
            />
            <Input
              label="Email username"
              labelPlacement="outside"
              value={emailUsername}
              isDisabled
              variant="bordered"
              className="sm:col-span-2"
            />
            <Select
              label="Office"
              labelPlacement="outside"
              placeholder="Chọn office"
              selectedKeys={office ? [office] : []}
              onChange={(event) => setOffice(event.target.value)}
              isRequired
              variant="bordered"
              isDisabled={optionsLoading}
            >
              {(options?.office ?? []).map((item) => (
                <SelectItem key={item.value}>{item.label}</SelectItem>
              ))}
            </Select>
            <Select
              label="Floor"
              labelPlacement="outside"
              placeholder="Chọn floor"
              selectedKeys={floor ? [floor] : []}
              onChange={(event) => setFloor(event.target.value)}
              isRequired={isCampus}
              variant="bordered"
              isDisabled={!isCampus || optionsLoading}
            >
              {floorOptions.map((item) => (
                <SelectItem key={item.value}>{item.label}</SelectItem>
              ))}
            </Select>
            <Select
              label="Building"
              labelPlacement="outside"
              placeholder="Chọn building"
              selectedKeys={building ? [building] : []}
              onChange={(event) => setBuilding(event.target.value)}
              isRequired={isCampus}
              variant="bordered"
              isDisabled={!isCampus || optionsLoading}
              className="sm:col-span-2"
            >
              {buildingOptions.map((item) => (
                <SelectItem key={item.value}>{item.label}</SelectItem>
              ))}
            </Select>
          </div>

          {err && (
            <Chip color="danger" variant="flat" size="sm" className="self-start">
              {err}
            </Chip>
          )}

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="light" onPress={onLogout}>
              Đăng xuất
            </Button>
            <Button
              color="primary"
              isDisabled={!canSave || optionsLoading}
              isLoading={busy}
              onPress={submitProfile}
            >
              Tiếp tục đặt phòng
            </Button>
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
  const [chatThreads, setChatThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const canEnterBooking = Boolean(me?.authenticated && me.profileComplete !== false);

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
    if (canEnterBooking) loadSchedule();
  }, [canEnterBooking, loadSchedule]);

  const loadChatThreads = useCallback(async () => {
    try {
      const res = await api.chatThreads();
      setChatThreads(res.threads);
    } catch {
      setChatThreads([]);
    }
  }, []);

  useEffect(() => {
    if (canEnterBooking) loadChatThreads();
  }, [canEnterBooking, loadChatThreads]);

  useEffect(() => {
    if (!canEnterBooking) return;

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
  }, [canEnterBooking]);

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    if (supabase) await api.signOut();
    setMe({ authenticated: false });
    setChatThreads([]);
    setActiveThreadId(null);
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

  if (me.profileComplete === false) {
    return (
      <ProfileInfoScreen
        me={me}
        onSaved={setMe}
        onLogout={handleLogout}
      />
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        view={view}
        onChange={setView}
        username={me.username}
        onLogout={handleLogout}
        chatThreads={chatThreads}
        activeThreadId={activeThreadId}
        onNewChat={() => setActiveThreadId(null)}
        onSelectThread={setActiveThreadId}
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
            <ChatPanel
              threadId={activeThreadId}
              onThreadSelected={setActiveThreadId}
              onThreadsChanged={setChatThreads}
            />
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
