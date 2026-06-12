"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  Chip,
  Input,
  Label,
  Link,
  Spinner,
  TextField,
} from "@heroui/react";
import {
  api,
  type ChatThread,
  type Me,
  type ScheduleResponse,
  type UserProfileOptions,
} from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { Sidebar, type View } from "@/components/Sidebar";
import { BrowseRooms } from "@/components/BrowseRooms";
import { ChatPanel } from "@/components/ChatPanel";

const RANGE_DAYS = 14;
const GRAPH_EXPLORER_URL =
  "https://developer.microsoft.com/en-us/graph/graph-explorer";

const LOGIN_STEPS = [
  {
    title: "Go to Microsoft Graph Explorer",
    description:
      "Open Graph Explorer and sign in with your VNG Microsoft work account.",
    action: "Open Graph Explorer",
  },
  {
    title: "Copy the access token",
    description:
      "Open the Access token panel, copy the full token, then return to VNG Meet.",
    action: "Find Access token",
  },
  {
    title: "Paste and authenticate",
    description:
      "Paste the token into the input on the left and continue to browse meeting rooms.",
    action: "Authenticate",
  },
];

function LoginScreen({ onAuthed }: { onAuthed: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const currentStep = LOGIN_STEPS[stepIndex];

  const goToStep = (direction: 1 | -1) => {
    setStepIndex(
      (current) => (current + direction + LOGIN_STEPS.length) % LOGIN_STEPS.length,
    );
  };

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
    <div className="min-h-screen bg-[#F3F3F3]">
      <main className="grid min-h-screen lg:grid-cols-[1fr_1.04fr]">
        <section className="flex items-center justify-center px-6 py-12 sm:px-10 lg:px-16">
          <div className="w-full max-w-[480px]">
            <img
              src="/icon.svg"
              alt="VNG Meet"
              className="mb-16 h-14 w-14 rounded-2xl"
            />

            <div>
              <h1 className="text-2xl font-bold leading-8 tracking-tight text-default-900">
                Welcome back
              </h1>
              <p className="mt-5 max-w-md text-base leading-6 text-default-500">
                Please read the instruction on the right side to get the
                Microsoft Graph Access Token
              </p>
            </div>

            <form
              className="mt-12 flex flex-col gap-8"
              onSubmit={(event) => {
                event.preventDefault();
                if (token.trim()) submitToken();
              }}
            >
              <TextField fullWidth>
                <Label>Access Token</Label>
                <Input
                  placeholder="Paste access token here"
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
              </TextField>

              <Button
                type="submit"
                size="lg"
                fullWidth
                isDisabled={!token.trim()}
                isPending={busy}
              >
                Authenticate
              </Button>

              {err && (
                <Chip color="danger" variant="soft" size="sm">
                  {err}
                </Chip>
              )}
            </form>
          </div>
        </section>

        <section className="relative min-h-[520px] overflow-hidden bg-[#111827] text-white lg:m-0 lg:rounded-bl-[88px]">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(96,165,250,0.32),transparent_32%),radial-gradient(circle_at_80%_20%,rgba(34,197,94,0.2),transparent_28%),linear-gradient(135deg,#1f2937_0%,#111827_46%,#0f172a_100%)]" />
          <div className="absolute inset-x-12 top-16 hidden h-px bg-white/20 sm:block" />
          <div className="absolute right-14 top-16 hidden h-[calc(100%-8rem)] w-px bg-white/15 sm:block" />
          <div className="absolute left-1/2 top-20 hidden h-72 w-72 -translate-x-1/2 rounded-full border border-white/10 sm:block" />

          <div className="relative flex min-h-full flex-col justify-end px-6 py-10 sm:px-12 lg:px-20 lg:py-16">
            <div className="mb-10 max-w-2xl">
              <Chip
                color="accent"
                variant="soft"
              >
                Step {stepIndex + 1} of {LOGIN_STEPS.length}
              </Chip>
              <h2 className="text-3xl font-bold leading-tight sm:text-4xl">
                {currentStep.title}
              </h2>
              <p className="mt-5 max-w-xl text-lg leading-8 text-white/75">
                {currentStep.description}
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                {stepIndex === 0 ? (
                  <Button
                    onPress={() => window.open(GRAPH_EXPLORER_URL, "_blank", "noreferrer")}
                  >
                    {currentStep.action}
                  </Button>
                ) : (
                  <Button>{currentStep.action}</Button>
                )}
                <Link
                  href={GRAPH_EXPLORER_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  {GRAPH_EXPLORER_URL}
                </Link>
              </div>
            </div>

            <div className="flex items-center justify-between gap-6">
              <div className="flex gap-2">
                {LOGIN_STEPS.map((step, index) => (
                  <Button
                    key={step.title}
                    size="sm"
                    aria-label={`Go to step ${index + 1}`}
                    variant={index === stepIndex ? "primary" : "secondary"}
                    onPress={() => setStepIndex(index)}
                  >
                    {index + 1}
                  </Button>
                ))}
              </div>

              <div className="flex gap-4">
                <Button
                  isIconOnly
                  variant="outline"
                  aria-label="Previous instruction"
                  onPress={() => goToStep(-1)}
                >
                  <span className="text-3xl leading-none">‹</span>
                </Button>
                <Button
                  isIconOnly
                  variant="outline"
                  aria-label="Next instruction"
                  onPress={() => goToStep(1)}
                >
                  <span className="text-3xl leading-none">›</span>
                </Button>
              </div>
            </div>
          </div>
        </section>
      </main>
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
      <Card className="w-full max-w-xl border border-default-200 shadow-xl">
        <Card.Content className="gap-6 p-8">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Hoàn tất thông tin cá nhân
            </h1>
            <p className="mt-2 text-sm text-default-500">
              Thông tin này giúp gợi ý và lọc phòng họp đúng địa điểm làm việc của bạn.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField fullWidth isDisabled className="sm:col-span-2">
              <Label>Email</Label>
              <Input value={email} />
            </TextField>
            <TextField fullWidth isDisabled className="sm:col-span-2">
              <Label>Email username</Label>
              <Input value={emailUsername} />
            </TextField>
            <label className="flex flex-col gap-2 text-sm font-medium">
              Office
              <select
                value={office}
                onChange={(event) => setOffice(event.target.value)}
                required
                disabled={optionsLoading}
                className="rounded-lg border border-default-200 bg-white px-3 py-2"
              >
                <option value="">Chọn office</option>
                {(options?.office ?? []).map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-2 text-sm font-medium">
              Floor
              <select
                value={floor}
                onChange={(event) => setFloor(event.target.value)}
                required={isCampus}
                disabled={!isCampus || optionsLoading}
                className="rounded-lg border border-default-200 bg-white px-3 py-2"
              >
                <option value="">Chọn floor</option>
                {floorOptions.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-2 text-sm font-medium sm:col-span-2">
              Building
              <select
                value={building}
                onChange={(event) => setBuilding(event.target.value)}
                required={isCampus}
                disabled={!isCampus || optionsLoading}
                className="rounded-lg border border-default-200 bg-white px-3 py-2"
              >
                <option value="">Chọn building</option>
                {buildingOptions.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {err && (
            <Chip color="danger" variant="soft" size="sm" className="self-start">
              {err}
            </Chip>
          )}

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="ghost" onPress={onLogout}>
              Đăng xuất
            </Button>
            <Button
              isDisabled={!canSave || optionsLoading}
              isPending={busy}
              onPress={submitProfile}
            >
              Tiếp tục đặt phòng
            </Button>
          </div>
        </Card.Content>
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
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <Spinner />
        <span className="text-sm text-default-500">Đang tải...</span>
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
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <Spinner />
              <span className="text-sm text-default-500">
                Đang quét phòng họp...
              </span>
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
              userOffice={me.profile?.office}
            />
          )}
        </div>
      </main>
    </div>
  );
}
