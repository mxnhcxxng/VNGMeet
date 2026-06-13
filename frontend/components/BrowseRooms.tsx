"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  ChevronLeft,
  ChevronRight,
  ArrowsRotateRight,
  Magnifier,
} from "@gravity-ui/icons";
import { I18nProvider } from "react-aria-components";
import { parseDate, parseTime } from "@internationalized/date";
import type { ScheduleResponse, ScheduleRoom } from "@/lib/api";
import { BookingModal, type BookingSlot } from "./BookingModal";

const SLOT_H = 48; // px per slot row (half hour → 96px per hour)
const TIME_COL = 72; // px width of the left time-label column

function addLabel(time: string, slotMinutes: number) {
  const [h, m] = time.split(":").map(Number);
  const end = h * 60 + m + slotMinutes;
  return `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
}

/** ISO "2016-06-13" → "13/6/2016" (matches the toolbar date label). */
function formatDmy(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d}/${m}/${y}`;
}

// Event palettes lifted from the design's utility colour ramps.
const EVENT_BOOKED = {
  bg: "#fef3f2",
  border: "#fecdca",
  title: "#b42318",
};
const EVENT_MINE = {
  bg: "#edfcf2",
  border: "#aaf0c4",
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
  if (room.capacity_size) return CAPACITY_RANK[room.capacity_size] ?? 3;
  if (typeof room.capacity !== "number") return 3;
  if (room.capacity <= 4) return CAPACITY_RANK.small;
  if (room.capacity <= 8) return CAPACITY_RANK.medium;
  return CAPACITY_RANK.large;
}

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
  preferredRooms?: string[];
}) {
  const [isOpen, setIsOpen] = useState(false);
  const onOpen = () => setIsOpen(true);
  const onClose = () => setIsOpen(false);
  const [selectedSlot, setSelectedSlot] = useState<BookingSlot | null>(null);
  const [endOptions, setEndOptions] = useState<string[]>([]);

  // Office is picked via the tabs; rooms are further narrowed by a name search.
  // Default to the user's work location, falling back to Campus.
  const defaultOffice = userOffice || "campus";
  const [office, setOffice] = useState(defaultOffice);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setOffice(defaultOffice);
  }, [defaultOffice]);

  const times = data.times;
  const slotMinutes = data.slotMinutes;
  const dayStart = times[0] ?? "08:00";
  const dayEnd = addLabel(times[times.length - 1] ?? "17:30", slotMinutes);

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

  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const currentRange = useMemo(() => {
    if (data.days[dayIndex] !== todayIso) return null;
    const currentSlotMinutes = Math.floor(nowMinutes / slotMinutes) * slotMinutes;
    const currentTime = `${String(Math.floor(currentSlotMinutes / 60)).padStart(2, "0")}:${String(
      currentSlotMinutes % 60
    ).padStart(2, "0")}`;
    const start = businessIndexByTime.get(currentTime);
    return start === undefined ? null : { start, end: start + 1 };
  }, [businessIndexByTime, data.days, dayIndex, nowMinutes, slotMinutes, todayIso]);

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
  const cols = `${TIME_COL}px repeat(${rooms.length}, minmax(155px, 1fr))`;

  function endOptionsFor(ti: number): string[] {
    const lastEnd = addLabel(times[times.length - 1], slotMinutes);
    return [...times.slice(ti + 1), lastEnd];
  }

  function openBooking(
    roomEmail: string,
    roomName: string,
    t: string,
    ti: number,
    thumbnail?: string,
    schedule?: boolean
  ) {
    setSelectedSlot({
      roomEmail,
      roomName,
      date: data.days[dayIndex],
      startTime: t,
      thumbnail,
      schedule,
    });
    setEndOptions(endOptionsFor(ti));
    onOpen();
  }

  // Current-time marker (only when the selected day is today). Offset is measured
  // from midnight since the grid now spans the full day.
  const nowLabel = `${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes()
  ).padStart(2, "0")}`;
  const markerOffset = (nowMinutes / slotMinutes) * SLOT_H;
  const showMarker = data.days[dayIndex] === todayIso;

  // Auto-scroll the grid so it opens on a sensible anchor, one block from the top:
  // before 13:00 → anchor on the block right before 09:00; from 13:00 on →
  // anchor on the block right before 13:00.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const anchorMinutes = nowMinutes < 13 * 60 ? 9 * 60 : 13 * 60;
    const anchorBlock = Math.floor(anchorMinutes / slotMinutes);
    el.scrollTop = Math.max(0, (anchorBlock - 1) * SLOT_H);
  }, [nowMinutes, slotMinutes, rooms.length]);

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Office tabs */}
      <div className="border-b border-[color:var(--separator)] bg-white px-6 pt-3">
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
      <div className="flex flex-wrap items-center gap-3 border-b border-[color:var(--separator)] bg-white px-6 py-4">
        <Button variant="tertiary" className="rounded-full" onPress={() => setDayIndex(() => 0)}>
          Today
        </Button>

        {/* Day navigation + date picker, grouped into a single pill. */}
        <I18nProvider locale="vi-VN">
          <div className="inline-flex h-9 items-center overflow-hidden rounded-full bg-[var(--default)] text-[var(--foreground)]">
            <button
              type="button"
              aria-label="Ngày trước"
              disabled={dayIndex <= 0}
              onClick={() => setDayIndex((n) => Math.max(0, n - 1))}
              className="flex h-full w-9 items-center justify-center transition-colors hover:bg-[var(--default-hover)] disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ChevronLeft width={16} height={16} />
            </button>
            <span className="h-5 w-px bg-[var(--separator)]" />
            <DatePicker
              aria-label="Ngày"
              value={parseDate(data.days[dayIndex])}
              minValue={parseDate(data.days[0])}
              maxValue={parseDate(data.days[data.days.length - 1])}
              onChange={(date) => {
                if (!date) return;
                const idx = data.days.indexOf(date.toString());
                if (idx >= 0) setDayIndex(() => idx);
              }}
            >
              <DatePicker.Trigger className="flex h-9 items-center gap-2 px-4 text-sm font-medium outline-none transition-colors hover:bg-[var(--default-hover)]">
                <CalendarIcon width={16} height={16} />
                <span className="whitespace-nowrap">{formatDmy(data.days[dayIndex])}</span>
              </DatePicker.Trigger>
              <DatePicker.Popover className="!max-w-none w-fit">
                <Calendar>
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
                      {(date) => <Calendar.Cell date={date} />}
                    </Calendar.GridBody>
                  </Calendar.Grid>
                </Calendar>
              </DatePicker.Popover>
            </DatePicker>
            <span className="h-5 w-px bg-[var(--separator)]" />
            <button
              type="button"
              aria-label="Ngày sau"
              disabled={dayIndex >= data.days.length - 1}
              onClick={() => setDayIndex((n) => Math.min(data.days.length - 1, n + 1))}
              className="flex h-full w-9 items-center justify-center transition-colors hover:bg-[var(--default-hover)] disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ChevronRight width={16} height={16} />
            </button>
          </div>

          {/* Business-hours window (read-only) */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-default-600">From</span>
            <TimeField aria-label="Giờ bắt đầu" value={parseTime(dayStart)} hourCycle={24} isReadOnly>
              <TimeField.Group variant="secondary">
                <TimeField.Input>
                  {(segment) => <TimeField.Segment segment={segment} />}
                </TimeField.Input>
              </TimeField.Group>
            </TimeField>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-default-600">To</span>
            <TimeField aria-label="Giờ kết thúc" value={parseTime(dayEnd)} hourCycle={24} isReadOnly>
              <TimeField.Group variant="secondary">
                <TimeField.Input>
                  {(segment) => <TimeField.Segment segment={segment} />}
                </TimeField.Input>
              </TimeField.Group>
            </TimeField>
          </div>
        </I18nProvider>

        <Button
          isIconOnly
          variant="tertiary"
          aria-label="Làm mới"
          className="rounded-full"
          onPress={onRefresh}
          isDisabled={refreshing}
        >
          {refreshing ? <Spinner size="sm" /> : <ArrowsRotateRight width={16} height={16} />}
        </Button>

        {/* Search rooms by name */}
        <SearchField
          aria-label="Tìm phòng"
          variant="secondary"
          value={query}
          onChange={setQuery}
          className="ml-auto w-[280px]"
        >
          <SearchField.Group>
            <SearchField.SearchIcon>
              <Magnifier width={16} height={16} />
            </SearchField.SearchIcon>
            <SearchField.Input placeholder="Search for rooms" />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
      </div>

      {/* Calendar */}
      <div ref={scrollRef} className="flex-1 overflow-auto">
        {rooms.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6">
            <Card className="w-full max-w-md border border-[color:var(--separator)] bg-white text-center shadow-sm">
              <Card.Content className="items-center gap-4 p-8">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-default-100 text-default-500">
                  <CalendarIcon width={20} height={20} />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-default-900">
                    Không có phòng phù hợp
                  </h2>
                  <p className="mt-1 text-sm text-default-500">
                    Thử đổi văn phòng hoặc xóa từ khóa tìm kiếm.
                  </p>
                </div>
                {query && (
                  <Button variant="secondary" onPress={() => setQuery("")}>
                    Xóa tìm kiếm
                  </Button>
                )}
              </Card.Content>
            </Card>
          </div>
        ) : (
          <div className="min-w-fit">
            {/* Room header */}
            <div
              className="sticky top-0 z-20 grid border-b border-[color:var(--separator)] bg-white shadow-sm"
              style={{ gridTemplateColumns: cols }}
            >
              <div className="sticky left-0 z-30 border-r border-[color:var(--separator)] bg-white" />
              {rooms.map((r) => (
                <div
                  key={r.email}
                  className="flex items-center justify-center border-r border-[color:var(--separator)] p-2"
                >
                  <p
                    className="truncate text-xs font-semibold text-default-700"
                    title={r.name}
                  >
                    {r.name}
                  </p>
                </div>
              ))}
            </div>

            {/* Rows */}
            <div className="relative">
              {allTimes.map((t) => {
                const onHour = t.endsWith(":00");
                const bi = businessIndexByTime.get(t);
                return (
                  <div key={t} className="grid" style={{ gridTemplateColumns: cols }}>
                    {/* time label (sticky to the left while scrolling) */}
                    <div
                      className="sticky left-0 z-10 border-r border-[color:var(--separator)] bg-white"
                      style={{ height: SLOT_H }}
                    >
                      {onHour && (
                        <span className="absolute right-2 top-1.5 text-xs font-medium text-default-500">
                          {t}
                        </span>
                      )}
                    </div>

                  {rooms.map((r) => {
                    // Outside the business-hours window → greyed out, not bookable.
                    if (bi === undefined) {
                      return (
                        <div
                          key={r.email}
                          aria-disabled
                          className="border-r border-t border-[color:var(--separator)]"
                          style={{
                            height: SLOT_H,
                            backgroundColor: "var(--background-secondary)",
                          }}
                        />
                      );
                    }

                    const status = r.grid[bi]?.[dayIndex] ?? 0;
                    // Schedule days (status 3/4/5) sit beyond the live Graph
                    // window — bookings there are "schedule" bookings.
                    const schedule = status >= 3;
                    const free = status === 0 || status === 3;
                    const myBooking = status === 2 || status === 5;
                    const prevBusy =
                      bi > 0 && (r.grid[bi - 1]?.[dayIndex] ?? 0) === status;
                    const nextBusy =
                      bi < times.length - 1 &&
                      (r.grid[bi + 1]?.[dayIndex] ?? 0) === status;

                    if (free) {
                      return (
                        <div
                          key={r.email}
                          role="button"
                          tabIndex={0}
                          onClick={() => openBooking(r.email, r.name, t, bi, r.thumbnail_link, schedule)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              openBooking(r.email, r.name, t, bi, r.thumbnail_link, schedule);
                            }
                          }}
                          className="group cursor-pointer border-r border-t border-[color:var(--separator)] bg-white px-1 outline-none transition-colors hover:bg-[var(--accent-soft)] hover:shadow-[inset_0_0_0_1px_var(--accent)] focus:bg-[var(--accent-soft)] focus:shadow-[inset_0_0_0_1px_var(--accent)]"
                          style={{ height: SLOT_H }}
                        >
                          <div className="flex h-full items-center justify-center">
                            <span className="rounded-md px-2 py-0.5 text-xs font-semibold text-transparent transition-colors group-hover:bg-[var(--accent)] group-hover:text-[var(--accent-foreground)] group-focus:bg-[var(--accent)] group-focus:text-[var(--accent-foreground)]">
                              {schedule ? "+ Schedule Book" : "+ Book"}
                            </span>
                          </div>
                        </div>
                      );
                    }

                    // Busy block — styled as the design's event card, merged across
                    // consecutive slots of the same status.
                    const palette = myBooking ? EVENT_MINE : EVENT_BOOKED;
                    return (
                      <div
                        key={r.email}
                        className="border-r border-t border-[color:var(--separator)] bg-white"
                        style={{ height: SLOT_H }}
                      >
                        <div
                          className="h-full px-1.5"
                          style={{ paddingTop: prevBusy ? 0 : 6, paddingBottom: nextBusy ? 0 : 6 }}
                        >
                          <div
                            className="h-full overflow-hidden px-2"
                            style={{
                              backgroundColor: palette.bg,
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
                                        ? "Your schedule"
                                        : "My booking"
                                      : schedule
                                        ? "Scheduled"
                                        : "Booked"}
                                  </p>
                                  {myBooking && (
                                    <span
                                      className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                                      style={{ backgroundColor: EVENT_MINE.dot }}
                                    />
                                  )}
                                </div>
                                {myBooking && (
                                  <p className="truncate text-xs" style={{ color: EVENT_MINE.time }}>
                                    {t}
                                  </p>
                                )}
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
                className="pointer-events-none absolute left-0 right-0 z-10 flex -translate-y-1/2 items-center"
                style={{ top: markerOffset }}
              >
                <span
                  className="flex shrink-0 justify-end pr-1.5"
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
                </span>
                <span
                  className="-ml-1 h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: "var(--accent)" }}
                />
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
        onBooked={onRefresh}
      />
    </div>
  );
}
