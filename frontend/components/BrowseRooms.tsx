"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Button,
  Calendar,
  Card,
  DateField,
  DatePicker,
  SearchField,
  Spinner,
  Tabs,
  TimeField,
} from "@heroui/react";
import {
  Calendar as CalendarIcon,
  ArrowLeft,
  ArrowRightFromLine,
  ChevronLeft,
  ChevronRight,
  ArrowsRotateRight,
  Magnifier,
  HeartFill,
  PersonFill,
} from "@gravity-ui/icons";
import { I18nProvider } from "react-aria-components";
import { parseDate, parseTime } from "@internationalized/date";
import { api, type Booking, type ScheduleResponse, type ScheduleRoom } from "@/lib/api";
import { useLanguage } from "@/app/providers";
import type { TranslationKey } from "@/lib/i18n";
import { BookingModal, type BookingSlot } from "./BookingModal";
import { EditBookingModal } from "./EditBookingModal";
import { clearBookingHistoryCache } from "./BookingHistory";
import { patchUrlParams, readUrlParams } from "@/lib/urlState";

const SLOT_H = 48; // px per slot row (half hour → 96px per hour)
const TIME_COL = 72; // px width of the left time-label column
const ROOM_HEADER_H = 56; // keep loading and loaded room headers identical
const DEFAULT_DAY_START = "09:00";
const DEFAULT_DAY_END = "18:00";
const SCHEDULE_MAX_DURATION_MINUTES = 3 * 60;

// Descriptive labels for the building code shown on the booking modal's venue
// chip. Falls back to the raw building value for unmapped codes.
const VENUE_LABEL: Record<string, string> = {
  V1: "V1 (VNGGames, Zalo, GreenNode)",
  V2: "V2 (ZaloPay)",
};

function venueLabel(building?: string) {
  if (!building) return undefined;
  const key = building.trim();
  return VENUE_LABEL[key] ?? building;
}

function addLabel(time: string, slotMinutes: number) {
  const [h, m] = time.split(":").map(Number);
  const end = h * 60 + m + slotMinutes;
  return `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
}

function timeToMinutes(time: string) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(
    minutes % 60,
  ).padStart(2, "0")}`;
}

function timeValueToLabel(value: { hour: number; minute: number } | null) {
  if (!value) return null;
  return `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`;
}

// Fallback frozen-order store used only if the parent doesn't supply one. The
// parent (page.tsx) normally owns the store so it can clear it on tab change.
const frozenRoomOrder = new Map<string, string[]>();

function formatLocalIsoDate(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** ISO "2016-06-13" → "13/6/2016" (matches the toolbar date label). */
function formatDmy(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d}/${m}/${y}`;
}

const VI_WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"] as const;

function capitalizeFirst(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function formatWeekdayLabel(iso: string, locale: string) {
  const date = new Date(`${iso}T00:00:00`);
  if (locale === "vi-VN") return VI_WEEKDAYS[date.getDay()];
  return capitalizeFirst(
    new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date)
  );
}

function formatCalendarHeaderDay(day: string, locale: string) {
  if (locale !== "vi-VN") return capitalizeFirst(day);
  const normalized = day.trim().toLowerCase();
  if (normalized.includes("cn") || normalized.includes("chủ")) return "CN";
  const digit = normalized.match(/[2-7]/)?.[0];
  return digit ? `T${digit}` : day.toUpperCase();
}

function formatDatePickerLabel(iso: string, locale: string) {
  return `${formatWeekdayLabel(iso, locale)}, ${formatDmy(iso)}`;
}

// True for Saturday/Sunday. `iso` is a "YYYY-MM-DD" calendar date.
function isWeekendIso(iso: string) {
  const day = new Date(`${iso}T00:00:00`).getDay();
  return day === 0 || day === 6;
}

// Matches the normalized weekday header labels for the weekend columns
// ("CN"/"T7" in vi, "Sat"/"Sun" in en).
function isWeekendHeaderLabel(label: string) {
  return ["sat", "sun", "cn", "t7"].includes(
    label.trim().toLowerCase().slice(0, 3),
  );
}

// Event palettes lifted from the design's utility colour ramps.
const EVENT_BOOKED = {
  bg: "var(--event-booked-bg)",
  border: "var(--event-booked-border)",
  title: "#b42318",
};
const EVENT_MINE = {
  bg: "var(--event-mine-bg)",
  border: "var(--event-mine-border)",
  title: "#087443",
  time: "#099250",
  dot: "#16b364",
};
// Pending (amber): my booking that the room hasn't confirmed yet, or a scheduled
// booking not yet placed. Distinct from the green confirmed-mine.
const EVENT_PENDING = {
  bg: "var(--event-pending-bg)",
  border: "var(--event-pending-border)",
  title: "#b54708",
  time: "#dc6803",
  dot: "#f79009",
};

// Fixed office tabs — `value` is the real filter value (matches room.office /
// meeting_room_metadata), `label` is the display name.
const OFFICES = [
  { value: "campus", label: "Campus" },
  { value: "sala", label: "Sala" },
  { value: "tnr", label: "TNR" },
] as const;

const CAPACITY_RANK: Record<string, number> = {
  medium: 0,
  large: 1,
  small: 2,
};

function capacityRank(room: ScheduleRoom) {
  if (typeof room.capacity === "number") {
    if (room.capacity <= 4) return CAPACITY_RANK.small;
    if (room.capacity <= 12) return CAPACITY_RANK.medium;
    return CAPACITY_RANK.large;
  }
  if (room.capacity_size) return CAPACITY_RANK[room.capacity_size] ?? 3;
  return 3;
}

function capacitySize(
  room: ScheduleRoom
): "small" | "medium" | "large" | null {
  if (typeof room.capacity === "number") {
    if (room.capacity <= 4) return "small";
    if (room.capacity <= 12) return "medium";
    return "large";
  }
  return room.capacity_size ?? null;
}

const CAPACITY_LABEL: Record<
  "small" | "medium" | "large",
  { labelKey: TranslationKey; range: string }
> = {
  small: { labelKey: "browse.capSmall", range: "4-" },
  medium: { labelKey: "browse.capMedium", range: "5-12" },
  large: { labelKey: "browse.capLarge", range: "13+" },
};

function numericFloor(floor?: string) {
  if (!floor) return null;
  const match = String(floor).match(/-?\d+/);
  return match ? Number(match[0]) : null;
}

function locationRank(room: ScheduleRoom, userBuilding?: string, userFloor?: string) {
  const roomBuilding = (room.building || "").trim().toLowerCase();
  const profileBuilding = (userBuilding || "").trim().toLowerCase();
  const sameBuilding = Boolean(roomBuilding && profileBuilding && roomBuilding === profileBuilding);
  const userFloorNumber = numericFloor(userFloor);
  const roomFloorNumber = numericFloor(room.floor);
  const hasFloor = userFloorNumber !== null && roomFloorNumber !== null;
  const sameFloor = hasFloor && roomFloorNumber === userFloorNumber;

  if (sameBuilding && sameFloor) return [0, 0, 0];
  if (!sameBuilding && sameFloor) return [1, 0, 0];
  if (sameBuilding && hasFloor) {
    const gap = Math.abs(roomFloorNumber - userFloorNumber);
    const aboveCurrentFloor = roomFloorNumber > userFloorNumber ? 1 : 0;
    return [2, gap, aboveCurrentFloor];
  }
  if (!sameBuilding && hasFloor) {
    const gap = Math.abs(roomFloorNumber - userFloorNumber);
    const aboveCurrentFloor = roomFloorNumber > userFloorNumber ? 1 : 0;
    return [3, gap, aboveCurrentFloor];
  }
  return [4, Number.MAX_SAFE_INTEGER, 1];
}

function isFreeStatus(status: number) {
  return status === 0 || status === 3;
}

function availabilityRank(
  room: ScheduleRoom,
  dayIndex: number,
  range: { start: number; end: number } | null
) {
  if (!range) return 0;
  for (let index = range.start; index < range.end; index += 1) {
    if (!isFreeStatus(room.grid[index]?.[dayIndex] ?? 1)) return 1;
  }
  return 0;
}

export function BrowseRooms({
  data,
  dayIndex,
  setDayIndex,
  refreshing,
  onRefresh,
  userOffice,
  userBuilding,
  userFloor,
  userDomain,
  preferredRooms = [],
  loadingRooms = false,
  roomCountsByOffice,
  orderStore,
}: {
  data: ScheduleResponse;
  dayIndex: number;
  setDayIndex: (fn: (n: number) => number) => void;
  refreshing: boolean;
  onRefresh: (opts?: { force?: boolean }) => void;
  userOffice?: string;
  userBuilding?: string;
  userFloor?: string;
  userDomain?: string;
  preferredRooms?: string[];
  loadingRooms?: boolean;
  roomCountsByOffice?: Record<string, number> | null;
  // Frozen column order, owned by the parent so it survives a mid-refresh
  // remount but is cleared when the user leaves the browse tab (so returning
  // re-sorts). Falls back to a module map if not supplied.
  orderStore?: Map<string, string[]>;
}) {
  const { t: tr, language } = useLanguage();
  const datePickerLocale = language === "vi" ? "vi-VN" : "en-US";
  const [isOpen, setIsOpen] = useState(false);
  const onOpen = () => setIsOpen(true);
  const onClose = () => setIsOpen(false);
  const [selectedSlot, setSelectedSlot] = useState<BookingSlot | null>(null);
  const [endOptions, setEndOptions] = useState<string[]>([]);
  // End time pre-selected from a drag selection (null → modal defaults to the
  // first option, the single-slot duration).
  const [initialEndTime, setInitialEndTime] = useState<string | null>(null);
  // Anchor for the date picker calendar. The custom DatePicker has no Group/
  // DateInput, so react-aria has no element to position the popover against and
  // it falls back to the top-left corner. Wiring the trigger ref fixes that.
  const dateTriggerRef = useRef<HTMLButtonElement>(null);

  // Office is picked via the tabs; rooms are further narrowed by a name search.
  // Default to the user's work location, falling back to Campus.
  const defaultOffice = userOffice || "campus";
  const [office, setOffice] = useState(defaultOffice);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    setOffice(defaultOffice);
  }, [defaultOffice]);

  // Reflect the browse date / office / search into the URL so a link is
  // shareable and a refresh lands on the same view. We only start syncing once
  // real rooms are on screen (`!loadingRooms`) — the loading skeleton renders
  // this same component with placeholder data and must not touch the URL.
  const urlHydratedRef = useRef(false);
  useEffect(() => {
    if (urlHydratedRef.current) return;
    if (loadingRooms || data.days.length === 0) return;
    const params = readUrlParams();
    const q = params.get("q");
    if (q) setQuery(q);
    const off = params.get("office");
    if (off) setOffice(off);
    const date = params.get("date");
    if (date) {
      const idx = data.days.indexOf(date);
      if (idx >= 0) setDayIndex(() => idx);
    }
    urlHydratedRef.current = true;
  }, [loadingRooms, data.days, setDayIndex]);

  useEffect(() => {
    if (!urlHydratedRef.current) return;
    patchUrlParams({
      date: data.days[dayIndex] ?? null,
      office: office || null,
      q: query || null,
    });
  }, [data.days, dayIndex, office, query]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const times = data.times;
  const slotMinutes = data.slotMinutes;
  const [windowStart, setWindowStart] = useState(DEFAULT_DAY_START);
  const [windowEnd, setWindowEnd] = useState(DEFAULT_DAY_END);

  const windowStartMinutes = timeToMinutes(windowStart);
  const windowEndMinutes = timeToMinutes(windowEnd);
  const hasValidWindow = windowEndMinutes > windowStartMinutes;

  // Full 24h grid: render every slot from 00:00 → 24:00. Slots inside the
  // business window map onto the API's per-room availability grid; the rest are
  // shown greyed out and are not bookable.
  const slotsPerDay = Math.floor((24 * 60) / slotMinutes);
  const allTimes = useMemo(
    () =>
      Array.from({ length: slotsPerDay }, (_, i) => {
        const mins = i * slotMinutes;
        return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(
          mins % 60
        ).padStart(2, "0")}`;
      }),
    [slotsPerDay, slotMinutes]
  );
  // Maps a time string to its index in the business-hours availability grid.
  const businessIndexByTime = useMemo(() => {
    const map = new Map<string, number>();
    times.forEach((t, i) => map.set(t, i));
    return map;
  }, [times]);

  const selectedDay = data.days[dayIndex];
  const todayIso = formatLocalIsoDate(now);
  // Bookings are only allowed from today through 15 days out, so clamp both the
  // date-picker range and the day-nav arrows to that window.
  const maxDayIndex = useMemo(() => {
    const maxDate = new Date(now);
    maxDate.setDate(maxDate.getDate() + 15);
    const maxIso = formatLocalIsoDate(maxDate);
    let last = 0;
    for (let i = 0; i < data.days.length; i++) {
      if (data.days[i] <= maxIso) last = i;
      else break;
    }
    return Math.min(last, data.days.length - 1);
  }, [now, data.days]);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const currentRange = useMemo(() => {
    if (selectedDay !== todayIso) return null;
    const currentSlotMinutes = Math.floor(nowMinutes / slotMinutes) * slotMinutes;
    const currentTime = `${String(Math.floor(currentSlotMinutes / 60)).padStart(2, "0")}:${String(
      currentSlotMinutes % 60
    ).padStart(2, "0")}`;
    const start = businessIndexByTime.get(currentTime);
    return start === undefined ? null : { start, end: start + 1 };
  }, [businessIndexByTime, nowMinutes, selectedDay, slotMinutes, todayIso]);

  // Optimistic "pending" cells shown instantly after a booking succeeds, before
  // the availability re-fetch lands. Each entry paints the booked slots pending
  // on the grid; it's ignored once real data shows the cell as taken and self-
  // expires so a failed booking can't leave a phantom block forever.
  const [optimisticPending, setOptimisticPending] = useState<
    { roomEmail: string; date: string; indices: number[]; expires: number }[]
  >([]);

  const rooms = useMemo(() => {
    const q = query.trim().toLowerCase();
    const favorites = new Set(preferredRooms.map((room) => room.trim().toLowerCase()));
    // Rooms where the user has an event (meeting) on the selected day. On those
    // days they jump to the front; on any other day this set is empty and the
    // default ordering below is left untouched.
    const myMeetingDay = data.days[dayIndex];
    const myMeetingEmails = new Set(
      data.rooms
        .filter((r) => (r.meetings ?? []).some((m) => m.date === myMeetingDay))
        .map((r) => r.email.toLowerCase())
    );
    // Ordering ignores the search query so the query only filters an already
    // fixed order (clearing the search restores the same columns in place).
    const fullSorted = data.rooms
      .filter((r) => !office || r.office === office)
      .map((room, index) => ({ room, index }))
      .sort((a, b) => {
        const myMeetingDiff =
          Number(!myMeetingEmails.has(a.room.email.toLowerCase())) -
          Number(!myMeetingEmails.has(b.room.email.toLowerCase()));
        if (myMeetingDiff) return myMeetingDiff;

        const availabilityDiff =
          availabilityRank(a.room, dayIndex, currentRange) -
          availabilityRank(b.room, dayIndex, currentRange);
        if (availabilityDiff) return availabilityDiff;

        const favoriteDiff =
          Number(!favorites.has(a.room.email.toLowerCase())) -
          Number(!favorites.has(b.room.email.toLowerCase()));
        if (favoriteDiff) return favoriteDiff;

        const capacityDiff = capacityRank(a.room) - capacityRank(b.room);
        if (capacityDiff) return capacityDiff;

        const aLocation = locationRank(a.room, userBuilding, userFloor);
        const bLocation = locationRank(b.room, userBuilding, userFloor);
        for (let i = 0; i < aLocation.length; i += 1) {
          const diff = aLocation[i] - bLocation[i];
          if (diff) return diff;
        }

        return a.room.name.localeCompare(b.room.name, "vi") || a.index - b.index;
      })
      .map(({ room }) => room);

    // Pin the order for this office+day. First layout freezes it; later renders
    // reuse the frozen order (any genuinely new rooms are appended in their
    // freshly-sorted position). Rooms hidden by the current search stay in the
    // frozen order so they reappear in place when the search clears.
    const orderKey = `${office} ${dayIndex}`;
    // Skip while showing loading placeholders so fake rooms never seed the order.
    const store = orderStore ?? frozenRoomOrder;
    const frozen = loadingRooms ? undefined : store.get(orderKey);
    let canonical: ScheduleRoom[];
    if (loadingRooms) {
      canonical = fullSorted;
    } else if (frozen) {
      const byEmail = new Map(fullSorted.map((r) => [r.email, r]));
      canonical = [];
      const seen = new Set<string>();
      for (const email of frozen) {
        const room = byEmail.get(email);
        if (room) {
          canonical.push(room);
          seen.add(email);
        }
      }
      const appended: string[] = [];
      for (const room of fullSorted) {
        if (!seen.has(room.email)) {
          canonical.push(room);
          appended.push(room.email);
        }
      }
      if (appended.length > 0) {
        store.set(orderKey, [...frozen, ...appended]);
      }
    } else {
      canonical = fullSorted;
      store.set(
        orderKey,
        fullSorted.map((r) => r.email),
      );
    }

    // Apply the search filter on top of the fixed order.
    const sorted = q
      ? canonical.filter((r) => r.name.toLowerCase().includes(q))
      : canonical;

    // Overlay optimistic pending slots onto free cells so a just-made booking
    // shows immediately. Real data (once refreshed) marks the cell as taken, at
    // which point the overlay is a no-op and the authoritative status wins.
    const active = optimisticPending.filter((o) => o.expires > Date.now());
    if (active.length === 0) return sorted;
    return sorted.map((room) => {
      const mine = active.filter((o) => o.roomEmail === room.email);
      if (mine.length === 0) return room;
      let grid = room.grid;
      let cloned = false;
      for (const o of mine) {
        const di = data.days.indexOf(o.date);
        if (di < 0) continue;
        for (const bi of o.indices) {
          const cur = grid[bi]?.[di];
          if (cur === 0 || cur === 3) {
            if (!cloned) {
              grid = room.grid.map((row) => row.slice());
              cloned = true;
            }
            // 3 = schedule-band free → 7 (pending schedule); else 6 (pending instant).
            grid[bi][di] = cur === 3 ? 7 : 6;
          }
        }
      }
      return cloned ? { ...room, grid } : room;
    });
  }, [
    currentRange,
    data.days,
    data.rooms,
    dayIndex,
    loadingRooms,
    office,
    optimisticPending,
    preferredRooms,
    query,
    userBuilding,
    userFloor,
  ]);
  const favoriteEmails = useMemo(
    () => new Set(preferredRooms.map((room) => room.trim().toLowerCase())),
    [preferredRooms]
  );
  const loadingRoomCount = useMemo(() => {
    if (!loadingRooms) return 0;
    const officeKey = (office || "campus").trim().toLowerCase();
    const knownCount = roomCountsByOffice?.[officeKey];
    return typeof knownCount === "number" ? Math.max(1, Math.min(knownCount, 24)) : 0;
  }, [loadingRooms, office, roomCountsByOffice]);
  const columnCount = loadingRooms ? loadingRoomCount : rooms.length;
  const cols =
    columnCount > 0
      ? `${TIME_COL}px repeat(${columnCount}, minmax(155px, 1fr))`
      : `${TIME_COL}px minmax(775px, 1fr)`;

  function statusFor(room: ScheduleRoom, time: string) {
    const businessIndex = businessIndexByTime.get(time);
    return businessIndex === undefined ? 0 : room.grid[businessIndex]?.[dayIndex] ?? 0;
  }

  function isBookableSlot(room: ScheduleRoom, time: string) {
    const startMinutes = timeToMinutes(time);
    const endMinutes = startMinutes + slotMinutes;
    if (!hasValidWindow || startMinutes < windowStartMinutes || endMinutes > windowEndMinutes) {
      return false;
    }
    return isFreeStatus(statusFor(room, time));
  }

  function endOptionsFor(room: ScheduleRoom, startTime: string, schedule?: boolean): string[] {
    const startMinutes = timeToMinutes(startTime);
    const latestEndMinutes = schedule
      ? Math.min(windowEndMinutes, startMinutes + SCHEDULE_MAX_DURATION_MINUTES)
      : windowEndMinutes;
    const options: string[] = [];

    for (const time of allTimes) {
      const minutes = timeToMinutes(time);
      if (minutes <= startMinutes) continue;
      if (minutes > latestEndMinutes) break;

      const previousSlotStart = minutes - slotMinutes;
      const previousSlotTime = `${String(Math.floor(previousSlotStart / 60)).padStart(
        2,
        "0"
      )}:${String(previousSlotStart % 60).padStart(2, "0")}`;

      if (!isBookableSlot(room, previousSlotTime)) break;
      options.push(time);
    }

    return options;
  }

  function openBooking(
    room: ScheduleRoom,
    t: string,
    schedule?: boolean,
    desiredEnd?: string
  ) {
    setSelectedSlot({
      roomEmail: room.email,
      roomName: room.name,
      date: data.days[dayIndex],
      startTime: t,
      thumbnail: room.thumbnail_link,
      schedule,
      capacitySize: room.capacity_size,
      floor: room.floor,
      location: venueLabel(room.building),
    });
    setEndOptions(endOptionsFor(room, t, schedule));
    setInitialEndTime(desiredEnd ?? null);
    onOpen();
  }

  // --- Edit an existing booking straight from the grid --------------------
  // The grid only carries status codes, not booking ids, so we keep the user's
  // own bookings around and match a clicked "my booking" cell to its record by
  // room + date + the slot falling inside [start, end).
  const [myBookings, setMyBookings] = useState<Booking[]>([]);
  const [editingBooking, setEditingBooking] = useState<Booking | null>(null);
  const [editingThumbnail, setEditingThumbnail] = useState<string | undefined>(undefined);
  // Read-only view for meetings I'm only invited to (not the organizer).
  const [editingReadOnly, setEditingReadOnly] = useState(false);
  const [editingBookedBy, setEditingBookedBy] = useState<string | undefined>(undefined);

  const loadMyBookings = () => {
    api
      .myBookings()
      .then((res) => setMyBookings(res.bookings))
      .catch(() => {});
  };

  useEffect(() => {
    loadMyBookings();
  }, []);

  // ISO dates (YYYY-MM-DD) on which the current user has an active booking, used
  // to render a dot indicator on the corresponding calendar cells.
  const bookedDates = useMemo(() => {
    const set = new Set<string>();
    for (const b of myBookings) {
      if (b.status !== "canceled" && b.status !== "failed") set.add(b.date);
    }
    // Also dot days where I'm invited to / organize a meeting (from the grid's
    // per-room meetings), not just rows I booked via the app.
    for (const room of data.rooms) {
      for (const m of room.meetings ?? []) set.add(m.date);
    }
    return set;
  }, [myBookings, data.rooms]);

  // Per-room set of my meeting START times on the selected day. Used to break the
  // grid block-merge so two back-to-back bookings (1-2, 2-3) render as two blocks,
  // not one 1-3 block.
  const meetingStartsByRoom = useMemo(() => {
    const day = data.days[dayIndex];
    const map = new Map<string, Set<string>>();
    for (const room of data.rooms) {
      const starts = new Set<string>();
      for (const m of room.meetings ?? []) {
        if (m.date === day) starts.add(m.start);
      }
      map.set(room.email, starts);
    }
    return map;
  }, [data.rooms, data.days, dayIndex]);

  function findMyBooking(
    roomEmail: string,
    date: string,
    time: string,
    schedule: boolean
  ): Booking | null {
    const wantType = schedule ? "scheduled" : "instant";
    const matches = myBookings.filter(
      (b) =>
        b.room_email.toLowerCase() === roomEmail.toLowerCase() &&
        b.date === date &&
        b.status !== "canceled" &&
        b.status !== "failed" &&
        time >= b.start_time &&
        time < b.end_time
    );
    // Prefer the booking whose stored type matches the grid band, but fall back
    // to any active match: a scheduled booking that has since been placed now
    // renders on an instant day (status 2) even though its stored booking_type
    // stays "scheduled", so a strict type match would miss it.
    return matches.find((b) => b.booking_type === wantType) ?? matches[0] ?? null;
  }

  function openEditForSlot(room: ScheduleRoom, time: string, schedule: boolean) {
    const booking = findMyBooking(room.email, data.days[dayIndex], time, schedule);
    if (booking) {
      setEditingThumbnail(room.thumbnail_link);
      setEditingReadOnly(false);
      setEditingBookedBy(undefined);
      setEditingBooking(booking);
    }
  }

  // A meeting I'm only invited to: no editable booking row of my own, so build a
  // read-only synthetic from the grid's `meetings` payload and show who booked it.
  function openAttendeeMeeting(room: ScheduleRoom, time: string) {
    const date = data.days[dayIndex];
    const meeting = (room.meetings ?? []).find(
      (m) => m.date === date && time >= m.start && time < m.end,
    );
    if (!meeting) return;
    const synthetic: Booking = {
      id: "",
      room_email: room.email,
      room_name: room.name,
      date,
      start_time: meeting.start,
      end_time: meeting.end,
      booking_type: "instant",
      method: "manual",
      subject: meeting.subject,
      attendees: meeting.attendees,
      body: meeting.body,
      status: "ok",
      web_link: "",
      created_at: "",
    };
    setEditingThumbnail(room.thumbnail_link);
    setEditingBookedBy(meeting.bookedBy ?? undefined);
    setEditingReadOnly(true);
    setEditingBooking(synthetic);
  }

  // --- Drag-to-select start/end across a single room column ----------------
  // Indices are into `allTimes` (the full 24h grid). `anchorIndex` is where the
  // mousedown landed; `headIndex` is the cell under the cursor. The selection is
  // the inclusive range [min, max], so dragging up or down both work. `dragRef`
  // mirrors the state so the window-level mouseup listener and rapid mouseenter
  // handlers read fresh values without stale closures.
  type DragState = {
    room: ScheduleRoom;
    roomEmail: string;
    anchorIndex: number;
    headIndex: number;
  };
  const [drag, setDrag] = useState<DragState | null>(null);
  // Key of the "my booking" block currently hovered. A booking block spans
  // several slot rows, so we light the whole run (not just the slot under the
  // cursor) by matching this key on every cell of the run.
  const [hoveredBooking, setHoveredBooking] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  function setDragState(next: DragState | null) {
    dragRef.current = next;
    setDrag(next);
  }

  // Furthest row reachable from `anchor` toward `target` (either direction)
  // while every slot in between stays bookable in `room`. Stops at the first
  // busy/disabled slot, so the selection never spans an unbookable gap. On
  // schedule days the span is also capped at SCHEDULE_MAX_DURATION_MINUTES, so
  // dragging past 3h just pins the selection at 3h instead of growing further.
  function clampHead(room: ScheduleRoom, anchor: number, target: number) {
    const schedule = statusFor(room, allTimes[anchor]) >= 3;
    const step = target >= anchor ? 1 : -1;
    let head = anchor;
    for (let i = anchor + step; step > 0 ? i <= target : i >= target; i += step) {
      if (!isBookableSlot(room, allTimes[i])) break;
      if (schedule) {
        const lo = Math.min(anchor, i);
        const hi = Math.max(anchor, i);
        const span =
          timeToMinutes(allTimes[hi]) - timeToMinutes(allTimes[lo]) + slotMinutes;
        if (span > SCHEDULE_MAX_DURATION_MINUTES) break;
      }
      head = i;
    }
    return head;
  }

  function beginDrag(room: ScheduleRoom, ti: number) {
    setDragState({ room, roomEmail: room.email, anchorIndex: ti, headIndex: ti });
  }

  // Open the modal for the selected range, then clear the drag. The earliest
  // slot becomes the start; the bottom of the latest slot becomes the end.
  function finishDrag() {
    const d = dragRef.current;
    setDragState(null);
    if (!d) return;
    const lo = Math.min(d.anchorIndex, d.headIndex);
    const hi = Math.max(d.anchorIndex, d.headIndex);
    const startTime = allTimes[lo];
    const schedule = statusFor(d.room, startTime) >= 3;
    const desiredEnd = addLabel(allTimes[hi], slotMinutes);
    openBooking(d.room, startTime, schedule, desiredEnd);
  }

  // Called as the cursor enters any cell mid-drag. The selection tracks only the
  // cursor's row (`ti`) — column and the hovered cell's own state are ignored,
  // so dragging over another column or a disabled cell still moves the
  // selection up/down. It's clamped to the bookable run in the anchor's column.
  // The modal only opens when the mouse is released.
  function extendDrag(ti: number) {
    const d = dragRef.current;
    if (!d) return;
    const head = clampHead(d.room, d.anchorIndex, ti);
    if (head !== d.headIndex) setDragState({ ...d, headIndex: head });
  }

  // Releasing the mouse anywhere ends the drag and opens the modal.
  useEffect(() => {
    if (!drag) return;
    const onUp = () => finishDrag();
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);

  // Current-time marker (only when the selected day is today). Offset is measured
  // from midnight since the grid now spans the full day.
  const nowLabel = `${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes()
  ).padStart(2, "0")}`;
  const markerOffset = (nowMinutes / slotMinutes) * SLOT_H;
  const showMarker = selectedDay === todayIso;

  // Auto-scroll the grid so it opens on a sensible anchor, one block from the top:
  // before 13:00 → anchor on the block right before 09:00; from 13:00 on →
  // anchor on the block right before 13:00.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const currentMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    const anchorMinutes = currentMinutes < 13 * 60 ? 9 * 60 : 13 * 60;
    const anchorBlock = Math.floor(anchorMinutes / slotMinutes);
    el.scrollTop = Math.max(0, (anchorBlock - 1) * SLOT_H);
  }, [slotMinutes]);

  return (
    <div className="flex h-full flex-col bg-white dark:bg-[#0c0e12]">
      {/* Office tabs */}
      <div className="border-b border-[color:var(--separator)] bg-white dark:bg-[#0c0e12] px-6 pt-3">
        <Tabs
          variant="secondary"
          selectedKey={office || undefined}
          onSelectionChange={(key) => setOffice(key as string)}
        >
          <Tabs.ListContainer>
            <Tabs.List>
              {OFFICES.map((o) => (
                <Tabs.Tab key={o.value} id={o.value} className="w-auto min-w-fit">
                  {o.label}
                  <Tabs.Indicator />
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-[color:var(--separator)] bg-white dark:bg-[#0c0e12] px-6 py-4">
        <Button
          variant="tertiary"
          className="rounded-full"
          isDisabled={dayIndex === 0}
          onPress={() => setDayIndex(() => 0)}
        >
          {dayIndex === 0 ? (
            <ArrowRightFromLine width={16} height={16} />
          ) : (
            <ArrowLeft width={16} height={16} />
          )}
          {tr("browse.today")}
        </Button>

        {/* Day navigation + date picker, grouped into a single pill. */}
        <I18nProvider locale={datePickerLocale}>
          <div className="inline-flex h-9 items-center overflow-hidden rounded-full bg-[var(--default)] text-[var(--foreground)]">
            <button
              type="button"
              aria-label={tr("browse.prevDay")}
              disabled={dayIndex <= 0}
              onClick={() => setDayIndex((n) => Math.max(0, n - 1))}
              className="flex h-full w-9 items-center justify-center transition-colors hover:bg-[var(--default-hover)] disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ChevronLeft width={16} height={16} />
            </button>
            <span className="h-5 w-px bg-[var(--separator)]" />
            <DatePicker
              aria-label={tr("browse.datePicker")}
              value={parseDate(data.days[dayIndex])}
              minValue={parseDate(data.days[0])}
              maxValue={parseDate(data.days[maxDayIndex])}
              onChange={(date) => {
                if (!date) return;
                const idx = data.days.indexOf(date.toString());
                if (idx >= 0) setDayIndex(() => idx);
              }}
            >
              <DatePicker.Trigger
                ref={dateTriggerRef}
                className="relative flex h-9 w-36 items-center justify-center px-0 text-[13px] font-medium outline-none transition-colors hover:bg-[var(--default-hover)]"
              >
                <CalendarIcon width={16} height={16} className="absolute left-2.5 shrink-0" />
                <span className="block w-36 shrink-0 whitespace-nowrap pl-7 pr-1 text-center">
                  {formatDatePickerLabel(data.days[dayIndex], datePickerLocale)}
                </span>
              </DatePicker.Trigger>
              <DatePicker.Popover triggerRef={dateTriggerRef} className="!max-w-none w-fit">
                <Calendar
                  firstDayOfWeek="mon"
                  minValue={parseDate(data.days[0])}
                  maxValue={parseDate(data.days[maxDayIndex])}
                >
                  <Calendar.Header>
                    <Calendar.Heading className="text-left first-letter:uppercase" />
                    <div className="flex items-center gap-1">
                      <Calendar.NavButton slot="previous" />
                      <Calendar.NavButton slot="next" />
                    </div>
                  </Calendar.Header>
                  <Calendar.Grid>
                    <Calendar.GridHeader>
                      {(day) => {
                        const label = formatCalendarHeaderDay(day, datePickerLocale);
                        return (
                          <Calendar.HeaderCell
                            className={isWeekendHeaderLabel(label) ? "text-danger" : undefined}
                          >
                            {label}
                          </Calendar.HeaderCell>
                        );
                      }}
                    </Calendar.GridHeader>
                    <Calendar.GridBody>
                      {(date) => (
                        <Calendar.Cell date={date}>
                          {({ formattedDate, isSelected, isDisabled }) => (
                            <>
                              <span
                                className={
                                  isWeekendIso(date.toString()) && !isSelected && !isDisabled
                                    ? "text-danger"
                                    : undefined
                                }
                              >
                                {formattedDate}
                              </span>
                              {bookedDates.has(date.toString()) && (
                                <Calendar.CellIndicator className="!bg-green-500" />
                              )}
                            </>
                          )}
                        </Calendar.Cell>
                      )}
                    </Calendar.GridBody>
                  </Calendar.Grid>
                </Calendar>
              </DatePicker.Popover>
            </DatePicker>
            <span className="h-5 w-px bg-[var(--separator)]" />
            <button
              type="button"
              aria-label={tr("browse.nextDay")}
              disabled={dayIndex >= maxDayIndex}
              onClick={() => setDayIndex((n) => Math.min(maxDayIndex, n + 1))}
              className="flex h-full w-9 items-center justify-center transition-colors hover:bg-[var(--default-hover)] disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ChevronRight width={16} height={16} />
            </button>
          </div>

          {/* Business-hours window */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-default-600">{tr("browse.from")}</span>
            <TimeField
              aria-label={tr("browse.startTime")}
              value={parseTime(windowStart)}
              hourCycle={24}
              isInvalid={!hasValidWindow}
              onChange={(value) => {
                const next = timeValueToLabel(value);
                if (next) setWindowStart(next);
              }}
            >
              <TimeField.Group variant="secondary">
                <TimeField.Input>
                  {(segment) => <TimeField.Segment segment={segment} />}
                </TimeField.Input>
              </TimeField.Group>
            </TimeField>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-default-600">{tr("browse.to")}</span>
            <TimeField
              aria-label={tr("browse.endTime")}
              value={parseTime(windowEnd)}
              hourCycle={24}
              isInvalid={!hasValidWindow}
              onChange={(value) => {
                const next = timeValueToLabel(value);
                if (next) setWindowEnd(next);
              }}
            >
              <TimeField.Group variant="secondary">
                <TimeField.Input>
                  {(segment) => <TimeField.Segment segment={segment} />}
                </TimeField.Input>
              </TimeField.Group>
            </TimeField>
          </div>
          {!hasValidWindow && (
            <span className="text-xs font-semibold text-danger-600">{tr("browse.toAfterFrom")}</span>
          )}
        </I18nProvider>

        <Button
          isIconOnly
          variant="tertiary"
          aria-label={tr("browse.refresh")}
          className="rounded-full"
          onPress={() => onRefresh()}
          isDisabled={refreshing}
        >
          {refreshing ? <Spinner size="sm" /> : <ArrowsRotateRight width={16} height={16} />}
        </Button>

        {/* Search rooms by name */}
        <SearchField
          aria-label={tr("browse.searchRooms")}
          variant="secondary"
          value={query}
          onChange={setQuery}
          className="ml-auto w-[280px]"
        >
          <SearchField.Group>
            <SearchField.SearchIcon>
              <Magnifier width={16} height={16} />
            </SearchField.SearchIcon>
            <SearchField.Input placeholder={tr("browse.searchPlaceholder")} />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
      </div>

      {/* Calendar */}
      <div ref={scrollRef} className="flex-1 overflow-auto">
        {!loadingRooms && rooms.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6">
            <Card className="w-full max-w-md border border-[color:var(--separator)] bg-white dark:bg-[#13161b] text-center shadow-sm">
              <Card.Content className="items-center gap-4 p-8">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-default-100 text-default-500">
                  <CalendarIcon width={20} height={20} />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-default-900">
                    {tr("browse.noRooms")}
                  </h2>
                  <p className="mt-1 text-sm text-default-500">
                    {tr("browse.noRoomsHint")}
                  </p>
                </div>
                {query && (
                  <Button variant="secondary" onPress={() => setQuery("")}>
                    {tr("browse.clearSearch")}
                  </Button>
                )}
              </Card.Content>
            </Card>
          </div>
        ) : (
          <div className="min-w-fit">
            {/* Room header */}
            <div
              className="sticky top-0 z-20 grid border-b border-[color:var(--separator)] bg-white dark:bg-[#0c0e12] shadow-sm"
              style={{ gridTemplateColumns: cols, height: ROOM_HEADER_H }}
            >
              <div
                className="sticky left-0 z-30 border-r border-[color:var(--separator)] bg-white dark:bg-[#0c0e12]"
                style={{ height: ROOM_HEADER_H }}
              />
              {loadingRooms ? (
                columnCount > 0 ? (
                  Array.from({ length: columnCount }).map((_, index) => (
                    <div
                      key={index}
                      className="flex flex-col items-center justify-center gap-1 border-r border-[color:var(--separator)] p-2"
                      style={{ height: ROOM_HEADER_H }}
                      aria-hidden
                    >
                      <div className="h-3 w-24 animate-pulse rounded-full bg-default" />
                      <div className="h-2.5 w-14 animate-pulse rounded-full bg-default" />
                    </div>
                  ))
                ) : (
                  <div style={{ height: ROOM_HEADER_H }} />
                )
              ) : (
                rooms.map((r) => {
                  const isFavorite = favoriteEmails.has(r.email.toLowerCase());
                  const size = capacitySize(r);
                  const cap = size ? CAPACITY_LABEL[size] : null;
                  return (
                    <div
                      key={r.email}
                      className="flex flex-col items-center justify-center gap-1 border-r border-[color:var(--separator)] p-2"
                      style={{ height: ROOM_HEADER_H }}
                    >
                      <div className="flex w-full items-center justify-center gap-1">
                        {isFavorite && (
                          <HeartFill className="shrink-0 text-[#f97316]" width={14} height={14} />
                        )}
                        <p
                          className="truncate text-xs font-semibold text-default-700"
                          title={r.name}
                        >
                          {r.name}
                        </p>
                      </div>
                      {cap && (
                        <div className="flex items-center gap-0.5 text-[10px] text-default-500">
                          <span>
                            {tr(cap.labelKey)} ({cap.range}
                          </span>
                          <PersonFill className="shrink-0" width={10} height={10} />
                          <span>)</span>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Rows */}
            <div className="relative select-none">
              {allTimes.map((t, ti) => {
                const onHour = t.endsWith(":00");
                const bi = businessIndexByTime.get(t);
                const slotStartMinutes = timeToMinutes(t);
                const slotEndMinutes = slotStartMinutes + slotMinutes;
                const outsideWindow =
                  !hasValidWindow ||
                  slotStartMinutes < windowStartMinutes ||
                  slotEndMinutes > windowEndMinutes;
                return (
                  <div key={t} className="grid" style={{ gridTemplateColumns: cols }}>
                    {/* time label (sticky to the left while scrolling) */}
                    <div
                      className="sticky left-0 z-10 border-r border-[color:var(--separator)] bg-white dark:bg-[#0c0e12]"
                      style={{ height: SLOT_H }}
                    >
                      {onHour && (
                        <span className="absolute right-2 top-1.5 text-xs font-medium text-default-500">
                          {t}
                        </span>
                      )}
                    </div>

                  {loadingRooms ? (
                    columnCount > 0 ? (
                      Array.from({ length: columnCount }).map((_, index) => (
                        <div
                          key={index}
                          aria-disabled
                          className={`border-r border-t border-[color:var(--separator)] ${
                            outsideWindow
                              ? "bg-[var(--background-secondary)] dark:bg-[#14171e]"
                              : "bg-white dark:bg-[#0c0e12]"
                          }`}
                          style={{ height: SLOT_H }}
                        />
                      ))
                    ) : (
                      <div
                        aria-disabled
                        className={`border-t border-[color:var(--separator)] ${
                          outsideWindow
                            ? "bg-[var(--background-secondary)] dark:bg-[#14171e]"
                            : "bg-white dark:bg-[#0c0e12]"
                        }`}
                        style={{ height: SLOT_H }}
                      />
                    )
                  ) : (
                    rooms.map((r) => {
                    // Outside the selected window → disabled, not bookable.
                    if (outsideWindow) {
                      return (
                        <div
                          key={r.email}
                          aria-disabled
                          onMouseEnter={() => extendDrag(ti)}
                          // Off-hours/disabled. In dark mode --background-secondary
                          // is only ~4% off the page bg, so the cell reads the same
                          // as a free slot — lift it a touch to set it apart, but
                          // gently enough that the grid separators stay visible.
                          className="border-r border-t border-[color:var(--separator)] bg-[var(--background-secondary)] dark:bg-[#14171e]"
                          style={{ height: SLOT_H }}
                        />
                      );
                    }

                    // Slots outside the backend availability window have no
                    // busy/free cache, but should still follow the user's
                    // visible From/To filter.
                    const status = bi === undefined ? 0 : r.grid[bi]?.[dayIndex] ?? 0;
                    // Schedule days (status 3/4/5) sit beyond the live Graph
                    // window — bookings there are "schedule" bookings.
                    // Status codes: 0/1/2 instant band, 3/4/5 schedule band,
                    // 6/7 = my booking pending, 8/9 = meeting I'm only invited to.
                    const pending = status === 6 || status === 7;
                    const attendeeMeeting = status === 8 || status === 9;
                    const schedule =
                      status === 3 ||
                      status === 4 ||
                      status === 5 ||
                      status === 7 ||
                      status === 9;
                    const free = status === 0 || status === 3;
                    // "myBooking" here = the green/amber "mine" umbrella: my own
                    // booking (confirmed or pending) OR a meeting I'm invited to.
                    // All are clickable and merge into a block.
                    const myBooking =
                      status === 2 || status === 5 || pending || attendeeMeeting;
                    // My meeting starts on this day for this room — block boundaries
                    // so adjacent distinct bookings don't merge into one block.
                    const meetingStarts = meetingStartsByRoom.get(r.email);
                    const isBlockStart = !!meetingStarts && meetingStarts.has(t);
                    const nextIsBlockStart =
                      bi !== undefined &&
                      bi < times.length - 1 &&
                      !!meetingStarts &&
                      meetingStarts.has(times[bi + 1]);
                    const prevBusy =
                      bi !== undefined &&
                      bi > 0 &&
                      (r.grid[bi - 1]?.[dayIndex] ?? 0) === status &&
                      !isBlockStart;
                    const nextBusy =
                      bi !== undefined &&
                      bi < times.length - 1 &&
                      (r.grid[bi + 1]?.[dayIndex] ?? 0) === status &&
                      !nextIsBlockStart;

                    if (free) {
                      const dragLo = drag ? Math.min(drag.anchorIndex, drag.headIndex) : 0;
                      const dragHi = drag ? Math.max(drag.anchorIndex, drag.headIndex) : 0;
                      const selected =
                        drag !== null &&
                        drag.roomEmail === r.email &&
                        ti >= dragLo &&
                        ti <= dragHi;
                      // The earliest selected slot is the booking start → the
                      // "+ Book" chip sticks there.
                      const selectionStart = selected && ti === dragLo;
                      const label = schedule
                        ? tr("browse.scheduleBookChip")
                        : tr("browse.bookChip");
                      return (
                        <div
                          key={r.email}
                          role="button"
                          tabIndex={0}
                          onMouseDown={(event) => {
                            // Left button only; preventDefault stops text
                            // selection while dragging across cells.
                            if (event.button !== 0) return;
                            event.preventDefault();
                            beginDrag(r, ti);
                          }}
                          onMouseEnter={() => extendDrag(ti)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              openBooking(r, t, schedule);
                            }
                          }}
                          className={`accent-keep-blue group cursor-pointer border-r border-t border-[color:var(--separator)] px-1 outline-none transition-colors ${
                            selected
                              ? "bg-[var(--accent-soft)]"
                              : drag
                                ? "bg-white dark:bg-[#0c0e12]"
                                : "bg-white dark:bg-[#0c0e12] hover:bg-[var(--accent-soft)] hover:shadow-[inset_0_0_0_1px_var(--accent)] focus:bg-[var(--accent-soft)] focus:shadow-[inset_0_0_0_1px_var(--accent)]"
                          }`}
                          style={{ height: SLOT_H }}
                        >
                          <div className="flex h-full items-center justify-center">
                            <span
                              className={
                                selectionStart
                                  ? "rounded-md bg-[var(--accent)] px-2 py-0.5 text-xs font-semibold text-[var(--accent-foreground)]"
                                  : selected
                                    ? "hidden"
                                    : drag
                                      ? "rounded-md px-2 py-0.5 text-xs font-semibold text-transparent"
                                      : "rounded-md px-2 py-0.5 text-xs font-semibold text-transparent transition-colors group-hover:bg-[var(--accent)] group-hover:text-[var(--accent-foreground)] group-focus:bg-[var(--accent)] group-focus:text-[var(--accent-foreground)]"
                              }
                            >
                              {label}
                            </span>
                          </div>
                        </div>
                      );
                    }

                    // Busy block — styled as the design's event card, merged across
                    // consecutive slots of the same status.
                    const palette = pending
                      ? EVENT_PENDING
                      : myBooking
                        ? EVENT_MINE
                        : EVENT_BOOKED;
                    // Stable key for the whole booking run (room + day + the run's
                    // first slot). Every cell of the run resolves to the same key,
                    // so hovering any of them lights the entire block.
                    let bookingKey: string | null = null;
                    if (myBooking && bi !== undefined) {
                      let start = bi;
                      // Walk back over same-status cells, but stop at a meeting
                      // boundary so two adjacent bookings get distinct hover keys.
                      while (
                        start > 0 &&
                        (r.grid[start - 1]?.[dayIndex] ?? 0) === status &&
                        !meetingStarts?.has(times[start])
                      ) {
                        start -= 1;
                      }
                      bookingKey = `${r.email}:${dayIndex}:${start}`;
                    }
                    const blockHovered = bookingKey !== null && hoveredBooking === bookingKey;
                    return (
                      <div
                        key={r.email}
                        onMouseEnter={() => {
                          extendDrag(ti);
                          setHoveredBooking(bookingKey);
                        }}
                        onMouseLeave={() => {
                          if (bookingKey !== null) setHoveredBooking(null);
                        }}
                        {...(myBooking
                          ? {
                              role: "button",
                              tabIndex: 0,
                              title: attendeeMeeting
                                ? tr("browse.viewMeeting")
                                : tr("browse.editBooking"),
                              onClick: () =>
                                attendeeMeeting
                                  ? openAttendeeMeeting(r, t)
                                  : openEditForSlot(r, t, schedule),
                              onKeyDown: (event: KeyboardEvent) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  if (attendeeMeeting) openAttendeeMeeting(r, t);
                                  else openEditForSlot(r, t, schedule);
                                }
                              },
                            }
                          : {})}
                        className={`border-r border-t border-[color:var(--separator)] bg-white dark:bg-[#0c0e12] outline-none ${
                          myBooking ? "my-booking-cell cursor-pointer" : ""
                        }`}
                        style={{ height: SLOT_H }}
                      >
                        <div
                          className="h-full px-1.5"
                          style={{ paddingTop: prevBusy ? 0 : 6, paddingBottom: nextBusy ? 0 : 6 }}
                        >
                          <div
                            className={`h-full overflow-hidden px-2 transition-colors ${myBooking ? "my-booking-fill" : ""}`}
                            style={{
                              backgroundColor: blockHovered
                                ? pending
                                  ? "var(--event-pending-bg-hover)"
                                  : "var(--event-mine-bg-hover)"
                                : palette.bg,
                              borderLeft: `1px solid ${palette.border}`,
                              borderRight: `1px solid ${palette.border}`,
                              borderTop: prevBusy ? "none" : `1px solid ${palette.border}`,
                              borderBottom: nextBusy ? "none" : `1px solid ${palette.border}`,
                              borderTopLeftRadius: prevBusy ? 0 : 6,
                              borderTopRightRadius: prevBusy ? 0 : 6,
                              borderBottomLeftRadius: nextBusy ? 0 : 6,
                              borderBottomRightRadius: nextBusy ? 0 : 6,
                              paddingTop: prevBusy ? 0 : 6,
                            }}
                          >
                            {!prevBusy && (
                              <>
                                <div className="flex items-start gap-1">
                                  <p
                                    className="flex-1 truncate text-xs font-semibold"
                                    style={{ color: palette.title }}
                                  >
                                    {pending
                                      ? tr("browse.pendingBooking")
                                      : attendeeMeeting
                                        ? tr("browse.myMeeting")
                                        : myBooking
                                          ? schedule
                                            ? tr("browse.yourSchedule")
                                            : tr("browse.myBooking")
                                          : schedule
                                            ? tr("browse.scheduled")
                                            : tr("browse.booked")}
                                  </p>
                                  {myBooking && (
                                    <span
                                      className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                                      style={{
                                        backgroundColor: pending
                                          ? EVENT_PENDING.dot
                                          : EVENT_MINE.dot,
                                      }}
                                    />
                                  )}
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                    })
                  )}
                </div>
              );
            })}

            {/* Current-time marker */}
            {showMarker && (
              <div
                className="accent-keep-blue pointer-events-none absolute left-0 right-0 z-10 flex -translate-y-1/2 items-center"
                style={{ top: markerOffset }}
              >
                <span
                  className="sticky left-0 z-20 flex shrink-0 items-center justify-end bg-white dark:bg-[#0c0e12] pr-1.5"
                  style={{ width: TIME_COL }}
                >
                  <span
                    className="rounded-full px-2 py-0.5 text-xs font-semibold shadow-sm"
                    style={{
                      backgroundColor: "var(--accent)",
                      color: "var(--accent-foreground)",
                    }}
                  >
                    {nowLabel}
                  </span>
                  <span
                    className="-mr-2 ml-1 h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: "var(--accent)" }}
                  />
                </span>
                <span
                  className="-ml-1 h-px flex-1"
                  style={{ backgroundColor: "var(--accent)" }}
                />
              </div>
            )}
          </div>
        </div>
        )}
      </div>

      <BookingModal
        isOpen={isOpen}
        onClose={onClose}
        slot={selectedSlot}
        endOptions={endOptions}
        initialEndTime={initialEndTime}
        userDomain={userDomain}
        onBooked={(info) => {
          // Paint the just-booked slots pending right away, before the refresh
          // round-trip, so the block shows instantly while the room responds.
          if (info) {
            const indices: number[] = [];
            for (
              let m = timeToMinutes(info.startTime);
              m < timeToMinutes(info.endTime);
              m += slotMinutes
            ) {
              const bi = businessIndexByTime.get(minutesToTime(m));
              if (bi !== undefined) indices.push(bi);
            }
            if (indices.length > 0) {
              setOptimisticPending((prev) => [
                ...prev.filter((o) => o.expires > Date.now()),
                {
                  roomEmail: info.roomEmail,
                  date: info.date,
                  indices,
                  expires: Date.now() + 120000,
                },
              ]);
            }
          }
          clearBookingHistoryCache();
          onRefresh();
          loadMyBookings();
          // Instant bookings start "pending" until the room mailbox responds.
          // The room accepts/declines asynchronously (usually seconds, sometimes
          // longer), so re-sync a few times (forced past the throttle) to catch
          // its decision and flip the status to success/failed on the grid/history.
          for (const delay of [15000, 45000, 90000]) {
            window.setTimeout(() => {
              clearBookingHistoryCache();
              onRefresh({ force: true });
              loadMyBookings();
            }, delay);
          }
        }}
      />

      <EditBookingModal
        isOpen={editingBooking !== null}
        booking={editingBooking}
        thumbnail={editingThumbnail}
        readOnly={editingReadOnly}
        bookedBy={editingBookedBy}
        onClose={() => {
          setEditingBooking(null);
          setEditingReadOnly(false);
          setEditingBookedBy(undefined);
        }}
        onSaved={() => {
          clearBookingHistoryCache();
          onRefresh();
          loadMyBookings();
        }}
      />
    </div>
  );
}
