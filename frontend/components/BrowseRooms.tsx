"use client";

import { useMemo, useState } from "react";
import { useDisclosure } from "@heroui/react";
import type { ScheduleResponse } from "@/lib/api";
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

/** Compact toolbar dropdown styled to match the surrounding buttons. */
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
      className={`rounded-md border bg-white px-3 py-2 text-sm font-semibold shadow-[0_1px_2px_0_#0a0d120d] hover:bg-[#fafafa] ${
        active ? "border-[#1570ef] text-[#1570ef]" : "border-[#d5d7da] text-[#414651]"
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
}: {
  data: ScheduleResponse;
  dayIndex: number;
  setDayIndex: (fn: (n: number) => number) => void;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const [vacantOnly, setVacantOnly] = useState(false);
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [selectedSlot, setSelectedSlot] = useState<BookingSlot | null>(null);
  const [endOptions, setEndOptions] = useState<string[]>([]);

  // Room metadata filters (sourced from meeting_room_metadata via the API).
  const [building, setBuilding] = useState("");
  const [floor, setFloor] = useState("");
  const [zone, setZone] = useState("");
  const [office, setOffice] = useState("");
  const [minCapacity, setMinCapacity] = useState("");

  // Distinct, sorted option lists derived from the rooms' metadata.
  const opts = useMemo(() => {
    const uniq = (vals: (string | undefined)[]) =>
      [...new Set(vals.filter((v): v is string => !!v))].sort((a, b) =>
        a.localeCompare(b)
      );
    const caps = [...new Set(data.rooms.map((r) => r.capacity).filter((c): c is number => !!c))].sort(
      (a, b) => a - b
    );
    return {
      buildings: uniq(data.rooms.map((r) => r.building)),
      floors: uniq(data.rooms.map((r) => r.floor)),
      zones: uniq(data.rooms.map((r) => r.zone)),
      offices: uniq(data.rooms.map((r) => r.office)),
      capacities: caps,
    };
  }, [data.rooms]);

  const filtersActive = !!(building || floor || zone || office || minCapacity);

  const rooms = useMemo(() => {
    const minCap = minCapacity ? Number(minCapacity) : 0;
    return data.rooms.filter(
      (r) =>
        (!building || r.building === building) &&
        (!floor || r.floor === floor) &&
        (!zone || r.zone === zone) &&
        (!office || r.office === office) &&
        (!minCap || (r.capacity ?? 0) >= minCap)
    );
  }, [data.rooms, building, floor, zone, office, minCapacity]);

  const clearFilters = () => {
    setBuilding("");
    setFloor("");
    setZone("");
    setOffice("");
    setMinCapacity("");
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
    <div className="flex h-full flex-col bg-white">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[#e9eaeb] px-6 py-4">
        <button
          onClick={() => setDayIndex(() => 0)}
          className="rounded-md border border-[#d5d7da] bg-white px-3.5 py-2 text-sm font-semibold text-[#414651] shadow-[0_1px_2px_0_#0a0d120d] hover:bg-[#fafafa]"
        >
          Today
        </button>

        <div className="flex items-center rounded-md border border-[#d5d7da] bg-white shadow-[0_1px_2px_0_#0a0d120d]">
          <button
            disabled={dayIndex <= 0}
            onClick={() => setDayIndex((n) => Math.max(0, n - 1))}
            className="px-2.5 py-2 text-[#717680] hover:bg-[#fafafa] disabled:opacity-40"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <div className="h-5 w-px bg-[#e9eaeb]" />
          <button
            disabled={dayIndex >= data.days.length - 1}
            onClick={() => setDayIndex((n) => Math.min(data.days.length - 1, n + 1))}
            className="px-2.5 py-2 text-[#717680] hover:bg-[#fafafa] disabled:opacity-40"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
          </button>
        </div>

        <div className="flex items-center gap-2 rounded-md border border-[#d5d7da] bg-white px-3.5 py-2 text-sm font-semibold text-[#414651] shadow-[0_1px_2px_0_#0a0d120d]">
          <span className="text-[#717680]"><IconCalendar /></span>
          <span className="capitalize">{fmtDate(data.days[dayIndex])}</span>
        </div>

        {/* Business-hours window */}
        <div className="flex items-center gap-2 rounded-md border border-[#d5d7da] bg-white px-3 py-2 text-sm font-semibold text-[#414651] shadow-[0_1px_2px_0_#0a0d120d]">
          <span className="text-[#717680]"><IconClock /></span>
          {dayStart}
        </div>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#717680" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        <div className="flex items-center gap-2 rounded-md border border-[#d5d7da] bg-white px-3 py-2 text-sm font-semibold text-[#414651] shadow-[0_1px_2px_0_#0a0d120d]">
          <span className="text-[#717680]"><IconClock /></span>
          {dayEnd}
        </div>

        {/* Vacant only toggle */}
        <div className="ml-1 flex items-center gap-2">
          <button
            onClick={() => setVacantOnly((v) => !v)}
            className={`relative h-5 w-9 rounded-full transition-colors ${vacantOnly ? "bg-[#1570ef]" : "bg-[#e9eaeb]"}`}
            aria-pressed={vacantOnly}
          >
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${vacantOnly ? "left-[18px]" : "left-0.5"}`} />
          </button>
          <span className="text-sm font-medium text-[#414651]">Vacant only</span>
        </div>

        {/* Metadata filters (building / floor / zone / capacity) */}
        {opts.buildings.length > 0 && (
          <FilterSelect
            label="Tòa nhà"
            value={building}
            onChange={setBuilding}
            options={opts.buildings.map((b) => ({ value: b, label: b }))}
          />
        )}
        {opts.floors.length > 0 && (
          <FilterSelect
            label="Tầng"
            value={floor}
            onChange={setFloor}
            options={opts.floors.map((f) => ({ value: f, label: f }))}
          />
        )}
        {opts.zones.length > 0 && (
          <FilterSelect
            label="Khu vực"
            value={zone}
            onChange={setZone}
            options={opts.zones.map((z) => ({ value: z, label: z }))}
          />
        )}
        {opts.offices.length > 0 && (
          <FilterSelect
            label="Văn phòng"
            value={office}
            onChange={setOffice}
            options={opts.offices.map((o) => ({ value: o, label: o }))}
          />
        )}
        {opts.capacities.length > 0 && (
          <FilterSelect
            label="Sức chứa"
            value={minCapacity}
            onChange={setMinCapacity}
            options={opts.capacities.map((c) => ({ value: String(c), label: `≥ ${c} 👤` }))}
          />
        )}
        {filtersActive && (
          <button
            onClick={clearFilters}
            className="rounded-md px-2.5 py-2 text-sm font-semibold text-[#717680] hover:text-[#414651] hover:underline"
          >
            Xóa lọc
          </button>
        )}

        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="ml-auto flex items-center gap-2 rounded-md border border-[#d5d7da] bg-white px-3.5 py-2 text-sm font-semibold text-[#414651] shadow-[0_1px_2px_0_#0a0d120d] hover:bg-[#fafafa] disabled:opacity-50"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={refreshing ? "animate-spin" : ""}>
            <path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          Làm mới
        </button>
      </div>

      {/* Calendar */}
      <div className="flex-1 overflow-auto">
        {rooms.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-default-500">
            <p>Không có phòng nào khớp bộ lọc.</p>
            {filtersActive && (
              <button
                onClick={clearFilters}
                className="rounded-md border border-[#d5d7da] bg-white px-3.5 py-2 text-sm font-semibold text-[#414651] shadow-[0_1px_2px_0_#0a0d120d] hover:bg-[#fafafa]"
              >
                Xóa bộ lọc
              </button>
            )}
          </div>
        ) : (
        <div className="min-w-fit">
          {/* Room header */}
          <div
            className="sticky top-0 z-20 grid border-b border-[#e9eaeb] bg-white"
            style={{ gridTemplateColumns: cols }}
          >
            <div className="border-r border-[#e9eaeb]" />
            {rooms.map((r, i) => (
              <div
                key={r.email}
                className="border-r border-[#e9eaeb] px-3 py-3 text-center"
              >
                <p className="truncate text-sm font-semibold text-[#414651]" title={r.name}>
                  {r.name}
                </p>
                <p className="truncate text-xs text-[#717680]">
                  {r.capacity ? `👤 ${r.capacity}` : " "}
                </p>
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
                    className="relative border-r border-[#e9eaeb]"
                    style={{ height: SLOT_H }}
                  >
                    {onHour && (
                      <span className="absolute -top-2 right-2 text-xs font-medium text-[#717680]">
                        {hourLabel(t)}
                      </span>
                    )}
                  </div>

                  {rooms.map((r) => {
                    const status = r.grid[ti]?.[dayIndex] ?? 0;
                    const free = status === 0;
                    const prevBusy = ti > 0 && (r.grid[ti - 1]?.[dayIndex] ?? 0) !== 0;
                    const nextBusy =
                      ti < times.length - 1 && (r.grid[ti + 1]?.[dayIndex] ?? 0) !== 0;

                    if (vacantOnly && !free) {
                      return (
                        <div
                          key={r.email}
                          className={`border-r border-[#e9eaeb] ${onHour ? "border-t" : "border-t border-t-[#f5f5f5]"}`}
                          style={{ height: SLOT_H }}
                        />
                      );
                    }

                    if (free) {
                      return (
                        <div
                          key={r.email}
                          role="button"
                          tabIndex={0}
                          onClick={() => openBooking(r.email, r.name, t, ti)}
                          className={`group cursor-pointer border-r border-[#e9eaeb] px-1 ${
                            onHour ? "border-t border-t-[#e9eaeb]" : "border-t border-t-[#f5f5f5]"
                          } hover:bg-[#f9fafb]`}
                          style={{ height: SLOT_H }}
                        >
                          <div className="flex h-full items-center justify-center rounded-md text-xs font-medium text-transparent group-hover:text-[#1570ef]">
                            + Book
                          </div>
                        </div>
                      );
                    }

                    // busy block (merged look across consecutive slots)
                    return (
                      <div
                        key={r.email}
                        className={`border-r border-[#e9eaeb] ${onHour && !prevBusy ? "border-t border-t-[#e9eaeb]" : ""}`}
                        style={{ height: SLOT_H }}
                      >
                        <div
                          className="h-full px-2"
                          style={{
                            backgroundColor: "#fef3f2",
                            borderTopLeftRadius: prevBusy ? 0 : 8,
                            borderTopRightRadius: prevBusy ? 0 : 8,
                            borderBottomLeftRadius: nextBusy ? 0 : 8,
                            borderBottomRightRadius: nextBusy ? 0 : 8,
                          }}
                        >
                          {!prevBusy && (
                            <div className="pt-1.5">
                              <p className="truncate text-xs font-semibold" style={{ color: "#b42318" }}>
                                Booked
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
                <span className="ml-[56px] h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-[#1570ef]" />
                <span className="h-px flex-1 bg-[#1570ef]" />
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
