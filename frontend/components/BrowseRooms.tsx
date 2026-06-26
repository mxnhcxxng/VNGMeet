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
import { useT } from "@/app/providers";
import type { TranslationKey } from "@/lib/i18n";
import { BookingModal, type BookingSlot } from "./BookingModal";
import { EditBookingModal } from "./EditBookingModal";
import { clearBookingHistoryCache } from "./BookingHistory";

const SLOT_H = 48; // px per slot row (half hour → 96px per hour)
const TIME_COL = 72; // px width of the left time-label column
const DEFAULT_DAY_START = "09:00";
const DEFAULT_DAY_END = "18:00";
const SCHEDULE_MAX_DURATION_MINUTES = 3 * 60;

function addLabel(time: string, slotMinutes: number) {
  const [h, m] = time.split(":").map(Number);
  const end = h * 60 + m + slotMinutes;
  return `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
}

function timeToMinutes(time: string) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function timeValueToLabel(value: { hour: number; minute: number } | null) {
  if (!value) return null;
  return `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`;
}

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
}: {
  data: ScheduleResponse;
  dayIndex: number;
  setDayIndex: (fn: (n: number) => number) => void;
  refreshing: boolean;
  onRefresh: () => void;
  userOffice?: string;
  userBuilding?: string;
  userFloor?: string;
  userDomain?: string;
  preferredRooms?: string[];
}) {
  const tr = useT();
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

  const rooms = useMemo(() => {
    const q = query.trim().toLowerCase();
    const favorites = new Set(preferredRooms.map((room) => room.trim().toLowerCase()));
    return data.rooms
      .filter(
        (r) =>
          (!office || r.office === office) &&
          (!q || r.name.toLowerCase().includes(q))
      )
      .map((room, index) => ({ room, index }))
      .sort((a, b) => {
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
  }, [
    currentRange,
    data.rooms,
    dayIndex,
    office,
    preferredRooms,
    query,
    userBuilding,
    userFloor,
  ]);
  const favoriteEmails = useMemo(
    () => new Set(preferredRooms.map((room) => room.trim().toLowerCase())),
    [preferredRooms]
  );
  const cols = `${TIME_COL}px repeat(${rooms.length}, minmax(155px, 1fr))`;

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
    return set;
  }, [myBookings]);

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
      setEditingBooking(booking);
    }
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
        <I18nProvider locale="en-US">
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
                className="flex h-9 items-center gap-2 px-4 text-sm font-medium outline-none transition-colors hover:bg-[var(--default-hover)]"
              >
                <CalendarIcon width={16} height={16} />
                <span className="whitespace-nowrap">{formatDmy(data.days[dayIndex])}</span>
              </DatePicker.Trigger>
              <DatePicker.Popover triggerRef={dateTriggerRef} className="!max-w-none w-fit">
                <Calendar
                  minValue={parseDate(data.days[0])}
                  maxValue={parseDate(data.days[maxDayIndex])}
                >
                  <Calendar.Header>
                    <Calendar.NavButton slot="previous" />
                    <Calendar.Heading />
                    <Calendar.NavButton slot="next" />
                  </Calendar.Header>
                  <Calendar.Grid>
                    <Calendar.GridHeader>
                      {(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}
                    </Calendar.GridHeader>
                    <Calendar.GridBody>
                      {(date) => (
                        <Calendar.Cell date={date}>
                          {({ formattedDate }) => (
                            <>
                              {formattedDate}
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
          onPress={onRefresh}
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
        {rooms.length === 0 ? (
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
              style={{ gridTemplateColumns: cols }}
            >
              <div className="sticky left-0 z-30 border-r border-[color:var(--separator)] bg-white dark:bg-[#0c0e12]" />
              {rooms.map((r) => {
                const isFavorite = favoriteEmails.has(r.email.toLowerCase());
                const size = capacitySize(r);
                const cap = size ? CAPACITY_LABEL[size] : null;
                return (
                  <div
                    key={r.email}
                    className="flex flex-col items-center justify-center gap-1 border-r border-[color:var(--separator)] p-2"
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
              })}
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

                  {rooms.map((r) => {
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
                    const schedule = status >= 3;
                    const free = status === 0 || status === 3;
                    const myBooking = status === 2 || status === 5;
                    const prevBusy =
                      bi !== undefined &&
                      bi > 0 &&
                      (r.grid[bi - 1]?.[dayIndex] ?? 0) === status;
                    const nextBusy =
                      bi !== undefined &&
                      bi < times.length - 1 &&
                      (r.grid[bi + 1]?.[dayIndex] ?? 0) === status;

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
                    const palette = myBooking ? EVENT_MINE : EVENT_BOOKED;
                    // Stable key for the whole booking run (room + day + the run's
                    // first slot). Every cell of the run resolves to the same key,
                    // so hovering any of them lights the entire block.
                    let bookingKey: string | null = null;
                    if (myBooking && bi !== undefined) {
                      let start = bi;
                      while (start > 0 && (r.grid[start - 1]?.[dayIndex] ?? 0) === status) {
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
                              title: tr("browse.editBooking"),
                              onClick: () => openEditForSlot(r, t, schedule),
                              onKeyDown: (event: KeyboardEvent) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  openEditForSlot(r, t, schedule);
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
                              backgroundColor: blockHovered ? "var(--event-mine-bg-hover)" : palette.bg,
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
                                    {myBooking
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
                                      style={{ backgroundColor: EVENT_MINE.dot }}
                                    />
                                  )}
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
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
        onBooked={() => {
          clearBookingHistoryCache();
          onRefresh();
          loadMyBookings();
        }}
      />

      <EditBookingModal
        isOpen={editingBooking !== null}
        booking={editingBooking}
        thumbnail={editingThumbnail}
        onClose={() => setEditingBooking(null)}
        onSaved={() => {
          clearBookingHistoryCache();
          onRefresh();
          loadMyBookings();
        }}
      />
    </div>
  );
}
