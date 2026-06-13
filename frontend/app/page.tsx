"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Autocomplete,
  Button,
  Chip,
  EmptyState,
  Input,
  type Key,
  Label,
  Link,
  ListBox,
  ListBoxItem,
  SearchField,
  Select,
  Spinner,
  Tag,
  TagGroup,
  TextField,
  useFilter,
} from "@heroui/react";
import {
  api,
  type ChatThread,
  type Me,
  type ScheduleResponse,
  type UserProfileOption,
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
    <div className="min-h-screen bg-white">
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
                  variant="secondary"
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

        <section className="relative min-h-[520px] overflow-hidden bg-white text-default-900 lg:m-0 lg:border-l lg:border-default-200">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(21,112,239,0.06),transparent_32%),radial-gradient(circle_at_80%_20%,rgba(22,179,100,0.05),transparent_28%)]" />
          <div className="absolute inset-x-12 top-16 hidden h-px bg-default-200 sm:block" />
          <div className="absolute right-14 top-16 hidden h-[calc(100%-8rem)] w-px bg-default-200 sm:block" />
          <div className="absolute left-1/2 top-20 hidden h-72 w-72 -translate-x-1/2 rounded-full border border-default-200 sm:block" />

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
              <p className="mt-5 max-w-xl text-lg leading-8 text-default-500">
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
  const [preferredRooms, setPreferredRooms] = useState<string[]>(
    me.profile?.preferred_rooms ?? []
  );
  const [options, setOptions] = useState<UserProfileOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const email =
    [me.profile?.email, me.email, me.username].find((value) =>
      Boolean(value && value.includes("@"))
    ) ||
    me.profile?.email ||
    me.email ||
    "";
  const emailUsername =
    me.profile?.email_username ||
    (email.includes("@") ? email.split("@", 1)[0] : "");
  const isCampus = office === "campus";
  const floorOptions =
    options?.floor.filter((item) => item.parentValue === office) ?? [];
  const buildingOptions =
    options?.building.filter((item) => item.parentValue === office) ?? [];
  const preferredRoomOptions =
    options?.preferredRooms.filter((item) => item.parentValue === office) ?? [];
  const canSave = Boolean(office);
  const { contains } = useFilter({ sensitivity: "base" });

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

  const changeOffice = (key: Key | null) => {
    setOffice((key as string) ?? "");
    setPreferredRooms([]);
  };

  const updatePreferredRooms = (keys: readonly Key[]) => {
    setPreferredRooms(keys.map(String).slice(0, 3));
  };

  const removePreferredRoomTags = (keys: Set<Key>) => {
    setPreferredRooms((current) => current.filter((item) => !keys.has(item)));
  };

  const submitProfile = async () => {
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.updateUserProfile({
        office,
        floor: isCampus ? floor : "",
        building: isCampus ? building : "",
        preferred_rooms: preferredRooms,
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

  const req = <span className="text-danger">*</span>;

  return (
    <div className="flex min-h-screen items-center justify-center bg-default-100 p-4">
      <div className="flex w-full max-w-[640px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Banner */}
        <div className="px-6 pt-6">
          <div className="h-[120px] w-full rounded-lg bg-gradient-to-r from-purple-300 via-pink-300 to-amber-200" />
        </div>

        {/* Header */}
        <div className="px-6 pb-5 pt-6">
          <h2 className="text-base font-semibold text-default-900">
            Complete your details to get room recommendations
          </h2>
        </div>

        {/* Form */}
        <div className="grid gap-4 px-6">
          <div className="grid grid-cols-2 gap-4">
            <TextField fullWidth isDisabled>
              <Label>Domain {req}</Label>
              <Input variant="secondary" value={emailUsername} />
            </TextField>
            <TextField fullWidth isDisabled>
              <Label>Email {req}</Label>
              <Input variant="secondary" value={email} />
            </TextField>
          </div>

          <Select
            variant="secondary"
            className="flex flex-col gap-2"
            placeholder="Choose Office"
            selectedKey={office || null}
            onSelectionChange={changeOffice}
            isRequired
            isDisabled={optionsLoading}
          >
            <Label>Office</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {(options?.office ?? []).map((item) => (
                  <ListBoxItem key={item.value} id={item.value}>
                    {item.label}
                  </ListBoxItem>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>

          <div className="grid grid-cols-2 gap-4">
            <Select
              variant="secondary"
              className="flex flex-col gap-2"
              placeholder="Choose Building"
              selectedKey={building || null}
              onSelectionChange={(key) => setBuilding((key as string) ?? "")}
              isDisabled={!isCampus || optionsLoading}
            >
              <Label>Building</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {buildingOptions.map((item) => (
                    <ListBoxItem key={item.value} id={item.value}>
                      {item.label}
                    </ListBoxItem>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            <Select
              variant="secondary"
              className="flex flex-col gap-2"
              placeholder="Choose Floor"
              selectedKey={floor || null}
              onSelectionChange={(key) => setFloor((key as string) ?? "")}
              isDisabled={!isCampus || optionsLoading}
            >
              <Label>Floor</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {floorOptions.map((item) => (
                    <ListBoxItem key={item.value} id={item.value}>
                      {item.label}
                    </ListBoxItem>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>

          <Autocomplete<UserProfileOption, "multiple">
            variant="secondary"
            fullWidth
            className="flex flex-col gap-2 [&_.autocomplete__trigger]:w-full"
            placeholder="Choose Prefered Rooms (MAX: 3)"
            selectionMode="multiple"
            value={preferredRooms}
            onChange={updatePreferredRooms}
            isDisabled={!office || optionsLoading}
          >
            <Label>Prefered Rooms</Label>
            <Autocomplete.Trigger>
              <Autocomplete.Value>
                {({ defaultChildren, isPlaceholder, state }) => {
                  if (isPlaceholder || state.selectedItems.length === 0) {
                    return defaultChildren;
                  }

                  const selectedItemKeys = state.selectedItems.map((item) => item.key);

                  return (
                    <TagGroup
                      size="sm"
                      variant="surface"
                      onRemove={removePreferredRoomTags}
                    >
                      <TagGroup.List>
                        {selectedItemKeys.map((selectedItemKey) => {
                          const item = preferredRoomOptions.find(
                            (room) => room.value === String(selectedItemKey)
                          );

                          if (!item) return null;

                          return (
                            <Tag key={item.value} id={item.value}>
                              {item.label}
                            </Tag>
                          );
                        })}
                      </TagGroup.List>
                    </TagGroup>
                  );
                }}
              </Autocomplete.Value>
              <Autocomplete.ClearButton />
              <Autocomplete.Indicator />
            </Autocomplete.Trigger>
            <Autocomplete.Popover className="max-h-[248px] w-[var(--trigger-width)] overflow-y-auto">
              <Autocomplete.Filter filter={contains}>
                <div className="w-full px-2 py-2">
                  <SearchField
                    autoFocus
                    aria-label="Search prefered rooms"
                    name="search"
                    variant="secondary"
                    fullWidth
                  >
                    <SearchField.Group>
                      <SearchField.SearchIcon />
                      <SearchField.Input placeholder="Choose Prefered Rooms (MAX: 3)" />
                      <SearchField.ClearButton />
                    </SearchField.Group>
                  </SearchField>
                </div>
                <ListBox
                  className="max-h-[200px] overflow-y-auto"
                  renderEmptyState={() => <EmptyState>No results found</EmptyState>}
                >
                  {preferredRoomOptions.map((item) => (
                    <ListBoxItem
                      key={item.value}
                      id={item.value}
                      textValue={item.label}
                      isDisabled={
                        preferredRooms.length >= 3 && !preferredRooms.includes(item.value)
                      }
                    >
                      {item.label}
                      <ListBoxItem.Indicator />
                    </ListBoxItem>
                  ))}
                </ListBox>
              </Autocomplete.Filter>
            </Autocomplete.Popover>
          </Autocomplete>

          {err && (
            <Chip color="danger" variant="soft" size="sm" className="self-start">
              {err}
            </Chip>
          )}
        </div>

        {/* Buttons */}
        <div className="flex items-center justify-center gap-2 px-6 pb-6 pt-8">
          <Button
            variant="tertiary"
            className="flex-1 rounded-full"
            onPress={onLogout}
            isDisabled={busy}
          >
            Cancel
          </Button>
          <Button
            className="flex-1 rounded-full"
            isDisabled={!canSave || optionsLoading}
            isPending={busy}
            onPress={submitProfile}
          >
            Save
          </Button>
        </div>
      </div>
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
    <div className="flex h-screen gap-2 overflow-hidden bg-[#f0f0f1] p-2">
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

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-white shadow-sm">
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
