"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Button,
  ButtonGroup,
  Card,
  Chip,
  DateField,
  ListBox,
  ListBoxItem,
  Select,
  Spinner,
  Tabs,
  TimeField,
} from "@heroui/react";
import { parseDate, parseTime } from "@internationalized/date";
import type { Room, ScheduleResponse } from "@/lib/api";
import { BookingModal, type BookingSlot } from "./BookingModal";

const SLOT_H = 44; // px per slot row

function addLabel(time: string, slotMinutes: number) {
  const [h, m] = time.split(":").map(Number);
  const end = h * 60 + m + slotMinutes;
  return `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
}

function hourLabel(t: string) {
  const [h] = t.split(":").map(Number);
  return `${String(h).padStart(2, "0")}:00`;
}

const IconCalendar = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
  </svg>
);
const CAPACITY_SIZE_OPTIONS = [
  { value: "small", label: "Nhỏ" },
  { value: "medium", label: "Vừa" },
  { value: "large", label: "Lớn" },
] as const;

type CapacitySize = (typeof CAPACITY_SIZE_OPTIONS)[number]["value"];

function capacitySizeFor(room: Room): CapacitySize | "" {
  if (room.capacity_size) return room.capacity_size;
  const capacity = room.capacity ?? 0;
  if (capacity <= 0) return "";
  if (capacity <= 4) return "small";
  if (capacity >= 6 && capacity <= 8) return "medium";
  if (capacity > 8) return "large";
  return "";
}

/** Sentinel key for the "no filter" entry, since react-aria keys can't be "". */
const FILTER_ALL_KEY = "__all__";

/** Compact Hero UI dropdown to match the toolbar. */
function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Select
      aria-label={label}
      variant="secondary"
      placeholder={label}
      selectedKey={value || FILTER_ALL_KEY}
      onSelectionChange={(key) =>
        onChange(key === FILTER_ALL_KEY ? "" : (key as string))
      }
    >
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          <ListBoxItem id={FILTER_ALL_KEY}>{label}</ListBoxItem>
          {options.map((o) => (
            <ListBoxItem key={o.value} id={o.value}>
              {o.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

export function BrowseRooms({
  data,
  dayIndex,
  setDayIndex,
  refreshing,
  onRefresh,
  userOffice,
}: {
  data: ScheduleResponse;
  dayIndex: number;
  setDayIndex: (fn: (n: number) => number) => void;
  refreshing: boolean;
  onRefresh: () => void;
  userOffice?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const onOpen = () => setIsOpen(true);
  const onClose = () => setIsOpen(false);
  const [selectedSlot, setSelectedSlot] = useState<BookingSlot | null>(null);
  const [endOptions, setEndOptions] = useState<string[]>([]);

  // Room metadata filters (sourced from meeting_room_metadata via the API).
  const defaultOffice = userOffice ?? "";
  const [office, setOffice] = useState(defaultOffice);
  const [capacitySize, setCapacitySize] = useState("");

  useEffect(() => {
    setOffice(defaultOffice);
  }, [defaultOffice]);

  // Distinct, sorted option lists derived from the rooms' metadata.
  const opts = useMemo(() => {
    const uniq = (vals: (string | undefined)[]) =>
      [...new Set(vals.filter((v): v is string => !!v))].sort((a, b) =>
        a.localeCompare(b)
      );
    const capacitySizes = new Set(
      data.rooms.map(capacitySizeFor).filter((size): size is CapacitySize => !!size)
    );
    return {
      offices: uniq(data.rooms.map((r) => r.office)),
      capacitySizes: CAPACITY_SIZE_OPTIONS.filter((option) => capacitySizes.has(option.value)),
    };
  }, [data.rooms]);

  const filtersActive = office !== defaultOffice || !!capacitySize;

  const rooms = useMemo(() => {
    return data.rooms.filter(
      (r) =>
        (!office || r.office === office) &&
        (!capacitySize || capacitySizeFor(r) === capacitySize)
    );
  }, [data.rooms, office, capacitySize]);

  const clearFilters = () => {
    setOffice(defaultOffice);
    setCapacitySize("");
  };

  const times = data.times;
  const slotMinutes = data.slotMinutes;
  const cols = `64px repeat(${rooms.length}, minmax(160px, 1fr))`;
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

  function endOptionsFor(ti: number): string[] {
    const lastEnd = addLabel(times[times.length - 1], slotMinutes);
    return [...times.slice(ti + 1), lastEnd];
  }

  function openBooking(roomEmail: string, roomName: string, t: string, ti: number) {
    setSelectedSlot({ roomEmail, roomName, date: data.days[dayIndex], startTime: t });
    setEndOptions(endOptionsFor(ti));
    onOpen();
  }

  // Current-time marker (only when the selected day is today). Offset is measured
  // from midnight since the grid now spans the full day.
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const markerOffset = (nowMinutes / slotMinutes) * SLOT_H;
  const showMarker = data.days[dayIndex] === todayIso;

  return (
    <div className="flex h-full flex-col bg-default-50">
      {/* Office tabs */}
      {opts.offices.length > 0 && (
        <div className="border-b border-default-200 bg-white px-6 pt-3">
          <Tabs
            variant="secondary"
            selectedKey={office || undefined}
            onSelectionChange={(key) => setOffice(key as string)}
          >
            <Tabs.ListContainer>
              <Tabs.List>
                {opts.offices.map((o) => (
                  <Tabs.Tab key={o} id={o} className="w-auto min-w-fit">
                    {o}
                    <Tabs.Indicator />
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-default-200 bg-white px-6 py-4">
        <Button
          variant={dayIndex === 0 ? "primary" : "secondary"}
          onPress={() => setDayIndex(() => 0)}
        >
          Today
        </Button>

        <ButtonGroup variant="secondary">
          <Button
            isIconOnly
            aria-label="Ngày trước"
            isDisabled={dayIndex <= 0}
            onPress={() => setDayIndex((n) => Math.max(0, n - 1))}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </Button>
          <Button
            isIconOnly
            aria-label="Ngày sau"
            isDisabled={dayIndex >= data.days.length - 1}
            onPress={() => setDayIndex((n) => Math.min(data.days.length - 1, n + 1))}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </Button>
        </ButtonGroup>

        {/* Date field — navigates within the available schedule range */}
        <DateField
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
          <DateField.Group variant="secondary">
            <DateField.Prefix>
              <span className="text-default-500">
                <IconCalendar />
              </span>
            </DateField.Prefix>
            <DateField.Input>
              {(segment) => <DateField.Segment segment={segment} />}
            </DateField.Input>
          </DateField.Group>
        </DateField>

        {/* Business-hours window */}
        <TimeField aria-label="Giờ bắt đầu" value={parseTime(dayStart)} hourCycle={24} isReadOnly>
          <TimeField.Group variant="secondary">
            <TimeField.Input>
              {(segment) => <TimeField.Segment segment={segment} />}
            </TimeField.Input>
          </TimeField.Group>
        </TimeField>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-default-400">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
        <TimeField aria-label="Giờ kết thúc" value={parseTime(dayEnd)} hourCycle={24} isReadOnly>
          <TimeField.Group variant="secondary">
            <TimeField.Input>
              {(segment) => <TimeField.Segment segment={segment} />}
            </TimeField.Input>
          </TimeField.Group>
        </TimeField>

        {/* Capacity filter (office is selected via the tabs above) */}
        {opts.capacitySizes.length > 0 && (
          <FilterSelect
            label="Sức chứa"
            value={capacitySize}
            onChange={setCapacitySize}
            options={opts.capacitySizes}
          />
        )}
        {filtersActive && (
          <Button variant="ghost" onPress={clearFilters}>
            Xóa lọc
          </Button>
        )}

        <Button
          variant="secondary"
          onPress={onRefresh}
          isDisabled={refreshing}
          className="ml-auto"
        >
          {refreshing ? (
            <Spinner size="sm" />
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          )}
          Làm mới
        </Button>
      </div>

      {/* Calendar */}
      <div className="flex-1 overflow-auto">
        {rooms.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6">
            <Card className="w-full max-w-md border border-default-200 bg-white text-center shadow-sm">
              <Card.Content className="items-center gap-4 p-8">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-default-100 text-default-500">
                  <IconCalendar />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-default-900">
                    Không có phòng phù hợp
                  </h2>
                  <p className="mt-1 text-sm text-default-500">
                    Thử đổi văn phòng, sức chứa hoặc quay lại bộ lọc mặc định.
                  </p>
                </div>
                {filtersActive && (
                  <Button variant="secondary" onPress={clearFilters}>
                    Xóa bộ lọc
                  </Button>
                )}
              </Card.Content>
            </Card>
          </div>
        ) : (
          <div className="min-w-fit">
            {/* Room header */}
            <div
              className="sticky top-0 z-20 grid border-b border-default-200 bg-white shadow-sm"
              style={{ gridTemplateColumns: cols }}
            >
              <div className="sticky left-0 z-30 border-r border-default-200 bg-white" />
              {rooms.map((r) => (
                <div
                  key={r.email}
                  className="border-r border-default-200 px-3 py-3 text-center"
                >
                  <p className="truncate text-sm font-semibold text-default-800" title={r.name}>
                    {r.name}
                  </p>
                  <div className="mt-1 flex justify-center">
                    {r.capacity ? (
                      <Chip size="sm" variant="soft">
                        {r.capacity} người
                      </Chip>
                    ) : (
                      <span className="h-6" />
                    )}
                  </div>
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
                      className="sticky left-0 z-10 border-r border-default-200 bg-white"
                      style={{ height: SLOT_H }}
                    >
                      {onHour && (
                        <span className="absolute right-2 top-1 text-xs font-medium text-default-500">
                          {hourLabel(t)}
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
                          className={`border-r border-default-200 ${
                            onHour ? "border-t border-t-default-200" : "border-t border-t-default-100"
                          }`}
                          style={{
                            height: SLOT_H,
                            backgroundColor: "var(--default)",
                            opacity: 0.6,
                          }}
                        />
                      );
                    }

                    const status = r.grid[bi]?.[dayIndex] ?? 0;
                    const free = status === 0;
                    const myBooking = status === 2;
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
                          onClick={() => openBooking(r.email, r.name, t, bi)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              openBooking(r.email, r.name, t, bi);
                            }
                          }}
                          className={`group cursor-pointer border-r border-default-200 bg-white px-1 outline-none transition-colors hover:bg-[var(--accent-soft)] hover:shadow-[inset_0_0_0_1px_var(--accent)] focus:bg-[var(--accent-soft)] focus:shadow-[inset_0_0_0_1px_var(--accent)] ${
                            onHour ? "border-t border-t-default-200" : "border-t border-t-default-100"
                          }`}
                          style={{ height: SLOT_H }}
                        >
                          <div className="flex h-full items-center justify-center">
                            <span className="rounded-md px-2 py-0.5 text-xs font-semibold text-transparent transition-colors group-hover:bg-[var(--accent)] group-hover:text-[var(--accent-foreground)] group-focus:bg-[var(--accent)] group-focus:text-[var(--accent-foreground)]">
                              + Book
                            </span>
                          </div>
                        </div>
                      );
                    }

                    // busy block (merged look across consecutive slots)
                    return (
                      <div
                        key={r.email}
                        className={`border-r border-default-200 bg-white ${onHour && !prevBusy ? "border-t border-t-default-200" : ""}`}
                        style={{ height: SLOT_H }}
                      >
                        <div
                          className="h-full px-2"
                          style={{
                            backgroundColor: myBooking
                              ? "var(--success-soft)"
                              : "var(--danger-soft)",
                            borderTopLeftRadius: prevBusy ? 0 : 8,
                            borderTopRightRadius: prevBusy ? 0 : 8,
                            borderBottomLeftRadius: nextBusy ? 0 : 8,
                            borderBottomRightRadius: nextBusy ? 0 : 8,
                          }}
                        >
                          {!prevBusy && (
                            <div className="pt-1.5">
                              <p
                                className="truncate text-xs font-semibold"
                                style={{
                                  color: myBooking
                                    ? "var(--success-soft-foreground)"
                                    : "var(--danger-soft-foreground)",
                                }}
                              >
                                {myBooking ? "My booking" : "Booked"}
                              </p>
                            </div>
                          )}
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
                className="pointer-events-none absolute left-0 right-0 z-20 flex items-center"
                style={{ top: markerOffset }}
              >
                <span
                  className="ml-[56px] h-2.5 w-2.5 -translate-y-1/2 rounded-full"
                  style={{ backgroundColor: "var(--success)" }}
                />
                <span className="h-0.5 flex-1" style={{ backgroundColor: "var(--success)" }} />
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
