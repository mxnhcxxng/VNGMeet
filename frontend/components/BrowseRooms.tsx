"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Card, Chip, Spinner } from "@heroui/react";
import type { Room, ScheduleResponse } from "@/lib/api";
import { BookingModal, type BookingSlot } from "./BookingModal";

const SLOT_H = 44; // px per slot row

function fmtDate(iso: string) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("vi-VN", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function addLabel(time: string, slotMinutes: number) {
  const [h, m] = time.split(":").map(Number);
  const end = h * 60 + m + slotMinutes;
  return `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
}

function hourLabel(t: string) {
  const [h] = t.split(":").map(Number);
  const ap = h < 12 ? "AM" : "PM";
  return `${h % 12 || 12} ${ap}`;
}

const IconCalendar = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
  </svg>
);
const IconClock = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
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

/** Compact native dropdown styled with Hero UI tokens to match the toolbar. */
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
  const active = value !== "";
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`h-10 rounded-lg border bg-white px-3 text-sm font-medium outline-none transition-colors hover:bg-default-50 focus:border-primary ${
        active ? "border-primary text-primary" : "border-default-200 text-default-700"
      }`}
    >
      <option value="">{label}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
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
  const cols = `64px repeat(${rooms.length}, minmax(160px, 1fr))`;
  const dayStart = times[0] ?? "08:00";
  const dayEnd = addLabel(times[times.length - 1] ?? "17:30", data.slotMinutes);

  function endOptionsFor(ti: number): string[] {
    const lastEnd = addLabel(times[times.length - 1], data.slotMinutes);
    return [...times.slice(ti + 1), lastEnd];
  }

  function openBooking(roomEmail: string, roomName: string, t: string, ti: number) {
    setSelectedSlot({ roomEmail, roomName, date: data.days[dayIndex], startTime: t });
    setEndOptions(endOptionsFor(ti));
    onOpen();
  }

  // Current-time marker (only when the selected day is today and within hours).
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const [sh, sm] = dayStart.split(":").map(Number);
  const minutesFromStart = now.getHours() * 60 + now.getMinutes() - (sh * 60 + sm);
  const markerOffset = (minutesFromStart / data.slotMinutes) * SLOT_H;
  const showMarker =
    data.days[dayIndex] === todayIso && markerOffset >= 0 && markerOffset <= times.length * SLOT_H;

  return (
    <div className="flex h-full flex-col bg-default-50">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-default-200 bg-white px-6 py-4">
        <Button
          variant={dayIndex === 0 ? "primary" : "secondary"}
          onPress={() => setDayIndex(() => 0)}
        >
          Today
        </Button>

        <div className="flex items-center overflow-hidden rounded-lg border border-default-200 bg-white">
          <Button
            isIconOnly
            variant="ghost"
            aria-label="Ngày trước"
            isDisabled={dayIndex <= 0}
            onPress={() => setDayIndex((n) => Math.max(0, n - 1))}
            className="rounded-none"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </Button>
          <div className="h-5 w-px bg-default-200" />
          <Button
            isIconOnly
            variant="ghost"
            aria-label="Ngày sau"
            isDisabled={dayIndex >= data.days.length - 1}
            onPress={() => setDayIndex((n) => Math.min(data.days.length - 1, n + 1))}
            className="rounded-none"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </Button>
        </div>

        <Chip
          variant="secondary"
          className="h-10 gap-2 px-3 text-sm font-medium capitalize"
        >
          <span className="text-default-500">
            <IconCalendar />
          </span>
          <span className="capitalize">{fmtDate(data.days[dayIndex])}</span>
        </Chip>

        {/* Business-hours window */}
        <Chip variant="secondary" className="h-10 gap-2 px-3 text-sm font-medium">
          <span className="text-default-500">
            <IconClock />
          </span>
          {dayStart}
        </Chip>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-default-400">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
        <Chip variant="secondary" className="h-10 gap-2 px-3 text-sm font-medium">
          <span className="text-default-500">
            <IconClock />
          </span>
          {dayEnd}
        </Chip>

        {/* Metadata filters (office / capacity size) */}
        {opts.offices.length > 0 && (
          <FilterSelect
            label="Văn phòng"
            value={office}
            onChange={setOffice}
            options={opts.offices.map((o) => ({ value: o, label: o }))}
          />
        )}
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
              <div className="border-r border-default-200" />
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
              {times.map((t, ti) => {
                const onHour = t.endsWith(":00");
                return (
                  <div key={t} className="grid" style={{ gridTemplateColumns: cols }}>
                    {/* time label */}
                    <div
                      className="relative border-r border-default-200 bg-white"
                      style={{ height: SLOT_H }}
                    >
                      {onHour && (
                        <span className="absolute -top-2 right-2 text-xs font-medium text-default-500">
                          {hourLabel(t)}
                        </span>
                      )}
                    </div>

                  {rooms.map((r) => {
                    const status = r.grid[ti]?.[dayIndex] ?? 0;
                    const free = status === 0;
                    const myBooking = status === 2;
                    const prevBusy =
                      ti > 0 && (r.grid[ti - 1]?.[dayIndex] ?? 0) === status;
                    const nextBusy =
                      ti < times.length - 1 &&
                      (r.grid[ti + 1]?.[dayIndex] ?? 0) === status;

                    if (free) {
                      return (
                        <div
                          key={r.email}
                          role="button"
                          tabIndex={0}
                          onClick={() => openBooking(r.email, r.name, t, ti)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              openBooking(r.email, r.name, t, ti);
                            }
                          }}
                          className={`group cursor-pointer border-r border-default-200 bg-white px-1 outline-none transition-colors ${
                            onHour ? "border-t border-t-default-200" : "border-t border-t-default-100"
                          } hover:bg-primary-50 focus:bg-primary-50`}
                          style={{ height: SLOT_H }}
                        >
                          <div className="flex h-full items-center justify-center rounded-lg text-xs font-semibold text-transparent group-hover:text-primary group-focus:text-primary">
                            + Book
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
                className="pointer-events-none absolute left-0 right-0 z-10 flex items-center"
                style={{ top: markerOffset }}
              >
                <span className="ml-[56px] h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-primary" />
                <span className="h-px flex-1 bg-primary" />
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
