"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Autocomplete,
  Button,
  Chip,
  EmptyState,
  InputGroup,
  type Key,
  Label,
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
import { Check, Copy } from "@gravity-ui/icons";
import { supabase } from "@/lib/supabase";
import { Sidebar, type View } from "@/components/Sidebar";
import { BrowseRooms } from "@/components/BrowseRooms";
import {
  ChatPanel,
  clearChatMessagesCache,
  deleteCachedChatThread,
  prefetchChatThread,
} from "@/components/ChatPanel";
import { SettingsScreen } from "@/components/SettingsScreen";
import { BrandIcon } from "@/components/BrandIcon";
import { useTheme } from "@/app/providers";
import {
  BookingHistory,
  clearBookingHistoryCache,
} from "@/components/BookingHistory";

// Keep the browse range aligned with backend availability_days.
const RANGE_DAYS = 18;
const GRAPH_EXPLORER_URL =
  "https://developer.microsoft.com/en-us/graph/graph-explorer";

function CopyLinkButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    let ok = false;

    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        /* fall through to the execCommand fallback below */
      }
    }

    if (!ok) {
      // Fallback for non-secure contexts (e.g. http over a LAN IP) or when the
      // async clipboard API rejects.
      try {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        ok = document.execCommand("copy");
        document.body.removeChild(textarea);
      } catch {
        /* ignore copy failures */
      }
    }

    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <button
      type="button"
      aria-label={copied ? "Link copied" : "Copy link"}
      onClick={copy}
      className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/60"
    >
      <Chip
        color="default"
        variant="soft"
        size="sm"
        className="inline-flex cursor-pointer items-center gap-1"
      >
        {copied ? <Check width={14} /> : <Copy width={14} />}
        <Chip.Label>{copied ? "Copied" : "Copy"}</Chip.Label>
      </Chip>
    </button>
  );
}

function ArrowIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-6"
      aria-hidden
    >
      {direction === "left" ? (
        <>
          <path d="M19 12H5" />
          <path d="m12 19-7-7 7-7" />
        </>
      ) : (
        <>
          <path d="M5 12h14" />
          <path d="m12 5 7 7-7 7" />
        </>
      )}
    </svg>
  );
}

function CarouselArrow({
  direction,
  label,
  onPress,
}: {
  direction: "left" | "right";
  label: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onPress}
      className="flex size-14 shrink-0 items-center justify-center rounded-full border border-white/50 text-white transition hover:bg-white/10"
    >
      <ArrowIcon direction={direction} />
    </button>
  );
}

// Full-bleed slide backgrounds exported from Figma (node 32:4966 / 32:4986 /
// 32:5113). Each image already bakes in the device mockup and highlight
// annotations at the design's 3:4 frame ratio, so it just needs to cover the
// panel with a dark gradient on top for the caption.
const SLIDE_BACKGROUNDS: Record<LoginStepKey, string> = {
  graph: "/auth/graph.png",
  account: "/auth/account.png",
  token: "/auth/token.png",
};

function SlideBackground({ stepKey }: { stepKey: LoginStepKey }) {
  return (
    // translateZ(0) + isolate promote this container to its own compositing
    // layer so the rounded clip survives while the <img> layers cross-fade —
    // otherwise the corner radius flickers off mid-transition.
    <div className="absolute inset-0 overflow-hidden [isolation:isolate] [transform:translateZ(0)] lg:rounded-l-[80px]">
      {(Object.keys(SLIDE_BACKGROUNDS) as LoginStepKey[]).map((key) => (
        <img
          key={key}
          src={SLIDE_BACKGROUNDS[key]}
          alt=""
          className={`absolute inset-0 h-full w-full object-cover object-center transition-opacity duration-300 ease-out ${
            key === stepKey ? "opacity-100" : "opacity-0"
          }`}
        />
      ))}
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0)_0%,rgba(0,0,0,0.4)_79.24%)]" />
    </div>
  );
}

type LoginStepKey = "graph" | "account" | "token";

const LOGIN_STEPS: {
  key: LoginStepKey;
  title: ReactNode;
  description: ReactNode;
}[] = [
  {
    key: "graph",
    title: (
      <>
        Go to{" "}
        <a
          href={GRAPH_EXPLORER_URL}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-2 underline-offset-2 [text-underline-position:from-font] transition hover:text-white/80"
        >
          Microsoft Graph Explorer
        </a>
      </>
    ),
    description: (
      <div className="flex flex-col gap-0.5">
        <p>
          If the link isn&apos;t available, paste this link into your search bar
        </p>
        <div className="flex items-center gap-2">
          <span className="break-all font-semibold">{GRAPH_EXPLORER_URL}</span>
          <CopyLinkButton text={GRAPH_EXPLORER_URL} />
        </div>
      </div>
    ),
  },
  {
    key: "account",
    title: "Login using your work account",
    description:
      "Due to development constraints, this is currently the only supported connection method.",
  },
  {
    key: "token",
    title: "Get your access token",
    description:
      "Navigate to the Access Token tab, copy the token, and paste it into the field on the left to authenticate.",
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
      (current) =>
        (current + direction + LOGIN_STEPS.length) % LOGIN_STEPS.length,
    );
  };

  const submitToken = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.setToken(token.trim());
      onAuthed();
    } catch (e: any) {
      setErr(
        e.message === "UNAUTHENTICATED"
          ? "Graph token không hợp lệ hoặc đã hết hạn."
          : e.message,
      );
    } finally {
      setBusy(false);
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        setToken(text.trim());
        setErr(null);
      }
    } catch {
      setErr("Không đọc được clipboard. Hãy dán thủ công bằng Cmd/Ctrl+V.");
    }
  };

  return (
    <div className="min-h-screen bg-white dark:bg-[#0c0e12]">
      <main className="grid min-h-screen lg:grid-cols-[1fr_1.04fr]">
        <section className="flex items-center justify-center px-8 py-12">
          <form
            className="flex w-full max-w-[480px] flex-col items-start gap-6"
            onSubmit={(event) => {
              event.preventDefault();
              if (token.trim()) submitToken();
            }}
          >
            <BrandIcon size={64} />

            <div className="flex w-full flex-col gap-3">
              <h1 className="text-2xl font-bold leading-8 text-[#181d27] dark:text-[#f7f7f7]">
                Welcome to VNG Meet
              </h1>
              <p className="text-base leading-6 text-[#535862] dark:text-[#94979c]">
                Please read the instruction on the right side carefully to get
                the Microsoft Graph Access Token
              </p>

              <TextField fullWidth>
                <InputGroup variant="secondary">
                  <InputGroup.Input
                    placeholder="Paste access token here"
                    type="password"
                    autoComplete="off"
                    data-1p-ignore
                    data-lpignore="true"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                  />
                  <InputGroup.Suffix>
                    <button
                      type="button"
                      onClick={handlePaste}
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-[#535862] transition-colors hover:bg-black/5 hover:text-[#181d27] dark:text-[#94979c] dark:hover:bg-white/5 dark:hover:text-[#f7f7f7]"
                    >
                      <Copy width={14} height={14} />
                      Paste
                    </button>
                  </InputGroup.Suffix>
                </InputGroup>
              </TextField>
            </div>

            <div className="flex w-full flex-col gap-3">
              <Button
                type="submit"
                size="lg"
                fullWidth
                isDisabled={!token.trim() || busy}
                isPending={busy}
              >
                {busy ? (
                  <span className="inline-flex items-center justify-center gap-2">
                    <Spinner size="sm" color="current" />
                    Checking...
                  </span>
                ) : (
                  "Authenticate"
                )}
              </Button>

              {err && (
                <Chip color="danger" variant="soft" size="sm">
                  {err}
                </Chip>
              )}
            </div>
          </form>
        </section>

        <section className="relative min-h-[520px] overflow-hidden bg-default-100 text-white lg:rounded-l-[80px]">
          <SlideBackground stepKey={currentStep.key} />

          <div className="absolute inset-x-6 bottom-8 flex items-end justify-center gap-3 sm:inset-x-10 lg:inset-x-14 lg:bottom-14">
            <div
              key={currentStep.key}
              className="auth-caption-in flex min-w-0 flex-1 flex-col items-start gap-3"
            >
              <span className="inline-flex items-center rounded-full border border-white/40 bg-white/10 px-3 py-1 text-xs font-semibold text-white backdrop-blur-sm">
                Step {stepIndex + 1} of {LOGIN_STEPS.length}
              </span>
              <h2 className="text-2xl font-semibold leading-8 text-white">
                {currentStep.title}
              </h2>
              <div className="text-sm font-medium leading-5 text-white">
                {currentStep.description}
              </div>
            </div>

            <div className="flex shrink-0 items-start gap-4">
              <CarouselArrow
                direction="left"
                label="Previous instruction"
                onPress={() => goToStep(-1)}
              />
              <CarouselArrow
                direction="right"
                label="Next instruction"
                onPress={() => goToStep(1)}
              />
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
    me.profile?.preferred_rooms ?? [],
  );
  const [options, setOptions] = useState<UserProfileOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const email =
    [me.profile?.email, me.email, me.username].find((value) =>
      Boolean(value && value.includes("@")),
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

  return (
    <div className="min-h-screen bg-white dark:bg-[#0c0e12]">
      <main className="grid min-h-screen lg:grid-cols-[1fr_1.04fr]">
        <section className="flex items-center justify-center px-8 py-12">
          <div className="flex w-full max-w-[480px] flex-col items-start gap-6">
            <BrandIcon size={64} />

            {/* Header */}
            <div className="flex w-full flex-col gap-3">
              <h1 className="text-2xl font-bold leading-8 text-[#181d27] dark:text-[#f7f7f7]">
                Hi, {emailUsername}
              </h1>
              <p className="text-base leading-6 text-[#535862] dark:text-[#94979c]">
                Complete your details to get better room recommendations. You can
            always change it later in Setting
              </p>
            </div>

            {/* Form */}
            <div className="grid w-full gap-4">
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

              <div className="grid grid-cols-[130px_1fr] gap-4">
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
                <Select
                  variant="secondary"
                  className="flex flex-col gap-2"
                  placeholder="Choose Building"
                  selectedKey={building || null}
                  onSelectionChange={(key) =>
                    setBuilding((key as string) ?? "")
                  }
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

                      const selectedItemKeys = state.selectedItems.map(
                        (item) => item.key,
                      );

                      return (
                        <TagGroup
                          size="sm"
                          variant="surface"
                          onRemove={removePreferredRoomTags}
                        >
                          <TagGroup.List>
                            {selectedItemKeys.map((selectedItemKey) => {
                              const item = preferredRoomOptions.find(
                                (room) =>
                                  room.value === String(selectedItemKey),
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
                      renderEmptyState={() => (
                        <EmptyState>No results found</EmptyState>
                      )}
                    >
                      {preferredRoomOptions.map((item) => (
                        <ListBoxItem
                          key={item.value}
                          id={item.value}
                          textValue={item.label}
                          isDisabled={
                            preferredRooms.length >= 3 &&
                            !preferredRooms.includes(item.value)
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
                <Chip
                  color="danger"
                  variant="soft"
                  size="sm"
                  className="self-start"
                >
                  {err}
                </Chip>
              )}
            </div>

            {/* Buttons */}
            <div className="flex w-full items-center justify-center gap-2">
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
        </section>

        <section className="relative min-h-[520px] overflow-hidden bg-default-100 lg:rounded-l-[80px]">
          <img
            src="/auth/vng-campus.webp"
            alt="VNG Corporation campus"
            className="absolute inset-0 h-full w-full object-cover object-center lg:rounded-l-[80px]"
          />
        </section>
      </main>
    </div>
  );
}

export default function Home() {
  const { setTheme } = useTheme();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpiredOpen, setSessionExpiredOpen] = useState(false);
  const [view, setView] = useState<View>("browse");
  const [data, setData] = useState<ScheduleResponse | null>(null);
  const [dayIndex, setDayIndex] = useState(0);
  const [chatThreads, setChatThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Unsaved-changes guard for the Settings screen. `settingsDirty` is reported
  // by SettingsScreen; `pendingNav` holds the navigation to run if the user
  // confirms leaving; `settingsDiscardRef` reverts the form (and live theme).
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null);
  const settingsDiscardRef = useRef<(() => void) | null>(null);

  // Run a navigation, but if there are unsaved Settings changes, stash it and
  // surface the confirm modal instead.
  const guardNav = (action: () => void) => {
    if (view === "settings" && settingsDirty) {
      setPendingNav(() => action);
      return;
    }
    action();
  };
  const requestView = (next: View) => {
    if (next === view) return;
    guardNav(() => setView(next));
  };
  const confirmLeave = () => {
    settingsDiscardRef.current?.();
    setSettingsDirty(false);
    pendingNav?.();
    setPendingNav(null);
  };
  const cancelLeave = () => setPendingNav(null);
  const canEnterBooking = Boolean(
    me?.authenticated && me.profileComplete !== false,
  );

  const showSessionExpiredModal = useCallback(() => {
    setSessionExpiredOpen(true);
    setError(null);
  }, []);

  const handleSessionExpiredLogin = async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    if (supabase) await api.signOut();
    clearBookingHistoryCache();
    clearChatMessagesCache();
    setSessionExpiredOpen(false);
    setMe({ authenticated: false });
    setData(null);
    setChatThreads([]);
    setActiveThreadId(null);
  };

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

  // Theme is a per-user preference: while signed in, the profile's saved theme
  // is the source of truth. While signed out, ignore any lingering stored
  // choice and follow the OS so the pre-login screens match the system
  // appearance. (ThemeProvider keeps the value in localStorage + on <html>.)
  useEffect(() => {
    if (!me) return;
    if (me.authenticated) {
      if (me.profile?.theme) setTheme(me.profile.theme);
    } else {
      setTheme("system");
    }
  }, [me, setTheme]);

  // Supabase OAuth flow (only when configured).
  useEffect(() => {
    if (!supabase) return;
    const { data: sub } = supabase.auth.onAuthStateChange(
      async (event, session) => {
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
      },
    );
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
      setError(
        e.message === "UNAUTHENTICATED"
          ? "Phiên đăng nhập hết hạn."
          : e.message,
      );
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
    if (sessionExpiredOpen) return;

    const touch = async () => {
      try {
        await api.touchUserActivity();
      } catch (e: any) {
        if (e?.message === "UNAUTHENTICATED") {
          showSessionExpiredModal();
        }
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
  }, [canEnterBooking, sessionExpiredOpen, showSessionExpiredModal]);

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    if (supabase) await api.signOut();
    clearBookingHistoryCache();
    clearChatMessagesCache();
    setSessionExpiredOpen(false);
    setMe({ authenticated: false });
    setChatThreads([]);
    setActiveThreadId(null);
  };

  const handleRenameThread = async (threadId: string, title: string) => {
    try {
      const res = await api.renameChatThread(threadId, title);
      setChatThreads((threads) =>
        threads.map((thread) => (thread.id === threadId ? res.thread : thread)),
      );
    } catch (e: any) {
      setError(e.message);
      throw e;
    }
  };

  const handleDeleteThread = async (threadId: string) => {
    try {
      await api.deleteChatThread(threadId);
      deleteCachedChatThread(threadId);
      setChatThreads((threads) =>
        threads.filter((thread) => thread.id !== threadId),
      );
      // After deleting, drop back to the default chat hero UI.
      guardNav(() => {
        setActiveThreadId(null);
        setView("chat");
      });
    } catch (e: any) {
      setError(e.message);
      throw e;
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <Spinner />
        <span className="text-sm text-default-500">Đang tải...</span>
      </div>
    );
  }

  const sessionExpiredModal = sessionExpiredOpen ? (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-[420px] rounded-2xl bg-white p-6 shadow-2xl dark:bg-[#0c0e12]">
        <h2 className="text-lg font-semibold text-default-900">
          Session expired
        </h2>
        <p className="mt-2 text-sm leading-6 text-default-600">
          Your session has expired. Please log in again.
        </p>
        <Button
          className="mt-6 w-full rounded-full"
          onPress={handleSessionExpiredLogin}
        >
          Log in again
        </Button>
      </div>
    </div>
  ) : null;

  const unsavedChangesModal = pendingNav ? (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && cancelLeave()}
    >
      <div className="w-full max-w-[420px] rounded-2xl bg-white p-6 shadow-2xl dark:bg-[#0c0e12]">
        <h2 className="text-lg font-semibold text-default-900">
          Unsaved changes
        </h2>
        <p className="mt-2 text-sm leading-6 text-default-600">
          You have unsaved changes. If you leave, your changes will be
          discarded.
        </p>
        <div className="mt-6 flex items-center justify-end gap-2">
          <Button
            variant="tertiary"
            className="rounded-full"
            onPress={cancelLeave}
          >
            Stay
          </Button>
          <Button
            variant="danger"
            className="rounded-full"
            onPress={confirmLeave}
          >
            Leave
          </Button>
        </div>
      </div>
    </div>
  ) : null;

  if (!me?.authenticated) {
    return (
      <>
        <LoginScreen onAuthed={refreshMe} />
        {sessionExpiredModal}
      </>
    );
  }

  if (me.profileComplete === false) {
    return (
      <>
        <ProfileInfoScreen me={me} onSaved={setMe} onLogout={handleLogout} />
        {sessionExpiredModal}
      </>
    );
  }

  return (
    <div className="flex h-screen gap-2 overflow-hidden bg-[#f0f0f1] p-2 dark:bg-[#13161b]">
      <Sidebar
        view={view}
        onChange={requestView}
        username={me.username}
        onLogout={handleLogout}
        chatThreads={chatThreads}
        activeThreadId={activeThreadId}
        onNewChat={() =>
          guardNav(() => {
            setView("chat");
            setActiveThreadId(null);
          })
        }
        onSelectThread={(threadId) =>
          guardNav(() => {
            setView("chat");
            setActiveThreadId(threadId);
          })
        }
        onPrefetchThread={prefetchChatThread}
        onRenameThread={handleRenameThread}
        onDeleteThread={handleDeleteThread}
      />

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-white shadow-sm dark:bg-[#0c0e12]">
        {error && (
          <div className="border-b border-danger-200 bg-danger-50 px-6 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1">
          {view === "bookingHistory" ? (
            <BookingHistory />
          ) : view === "settings" ? (
            <SettingsScreen
              me={me}
              onSaved={setMe}
              onDirtyChange={setSettingsDirty}
              discardRef={settingsDiscardRef}
            />
          ) : view === "chat" ? (
            <ChatPanel
              threadId={activeThreadId}
              onThreadSelected={setActiveThreadId}
              onThreadsChanged={setChatThreads}
              userRole={me.profile?.role}
            />
          ) : refreshing && !data ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <Spinner />
              <span className="text-sm text-default-500">
                Đang quét phòng họp...
              </span>
            </div>
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
              userBuilding={me.profile?.building}
              userFloor={me.profile?.floor}
              userDomain={
                me.profile?.email_username ||
                ([me.profile?.email, me.email, me.username]
                  .find((value) => value?.includes("@"))
                  ?.split("@", 1)[0] ??
                  "")
              }
              preferredRooms={me.profile?.preferred_rooms ?? []}
            />
          )}
        </div>
      </main>
      {sessionExpiredModal}
      {unsavedChangesModal}
    </div>
  );
}
