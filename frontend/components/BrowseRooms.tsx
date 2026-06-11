"use client";

import { useState } from "react";
import { Button, Chip, Switch } from "@heroui/react";
import type { ScheduleResponse } from "@/lib/api";

const ROOM_IMAGES = [
  "linear-gradient(135deg,#a8c0ff,#3f2b96)",
  "linear-gradient(135deg,#f6d365,#fda085)",
  "linear-gradient(135deg,#84fab0,#8fd3f4)",
  "linear-gradient(135deg,#d4fc79,#96e6a1)",
  "linear-gradient(135deg,#fbc2eb,#a6c1ee)",
  "linear-gradient(135deg,#fdcbf1,#e6dee9)",
];

function fmtDate(iso: string) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("vi-VN", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

function addLabel(time: string, slotMinutes: number) {
  const [h, m] = time.split(":").map(Number);
  const end = h * 60 + m + slotMinutes;
  return `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
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
  const rooms = data.rooms;
  const cols = `72px repeat(${rooms.length}, minmax(150px, 1fr))`;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-default-200 px-6 py-3">
        <Button size="sm" variant="bordered" onPress={() => setDayIndex(() => 0)}>
          Hôm nay
        </Button>
        <div className="flex items-center gap-1">
          <Button
            isIconOnly
            size="sm"
            variant="bordered"
            isDisabled={dayIndex <= 0}
            onPress={() => setDayIndex((n) => Math.max(0, n - 1))}
          >
            ‹
          </Button>
          <Button
            isIconOnly
            size="sm"
            variant="bordered"
            isDisabled={dayIndex >= data.days.length - 1}
            onPress={() => setDayIndex((n) => Math.min(data.days.length - 1, n + 1))}
          >
            ›
          </Button>
        </div>
        <Chip variant="flat" className="capitalize">
          {fmtDate(data.days[dayIndex])}
        </Chip>

        <div className="ml-auto flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch size="sm" isSelected={vacantOnly} onValueChange={setVacantOnly} color="success" />
            <span className="text-sm text-default-600">Chỉ phòng trống</span>
          </div>
          <Button size="sm" variant="flat" isLoading={refreshing} onPress={onRefresh}>
            Làm mới
          </Button>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto p-6">
        <div className="min-w-fit">
          {/* Room header cards */}
          <div className="sticky top-0 z-20 grid gap-2 bg-background pb-2" style={{ gridTemplateColumns: cols }}>
            <div /> {/* corner */}
            {rooms.map((r, i) => (
              <div key={r.email} className="rounded-large border border-default-200 bg-content1 p-2">
                <div
                  className="mb-2 h-16 w-full rounded-medium"
                  style={{ background: ROOM_IMAGES[i % ROOM_IMAGES.length] }}
                />
                <p className="truncate text-sm font-semibold" title={r.name}>
                  {r.name}
                </p>
                <p className="truncate text-xs text-default-400">
                  {r.capacity ? `👤 ${r.capacity}` : r.email}
                </p>
              </div>
            ))}
          </div>

          {/* Time rows */}
          {data.times.map((t, ti) => (
            <div key={t} className="grid gap-2" style={{ gridTemplateColumns: cols }}>
              <div className="flex h-14 items-start justify-end pr-2 pt-1 text-xs tabular-nums text-default-400">
                {t}
              </div>
              {rooms.map((r) => {
                const status = r.grid[ti]?.[dayIndex] ?? 0;
                const free = status === 0;
                if (vacantOnly && !free) {
                  return <div key={r.email} className="h-14" />;
                }
                return (
                  <div key={r.email} className="h-14 py-0.5">
                    <div
                      className={`flex h-full flex-col justify-center rounded-medium border px-2 text-xs ${
                        free
                          ? "border-success-200 bg-success-50 text-success-700"
                          : "border-danger-200 bg-danger-50 text-danger-600"
                      }`}
                    >
                      <span className="font-semibold">{free ? "Trống" : "Đã book"}</span>
                      <span className="opacity-70">
                        {t} - {addLabel(t, data.slotMinutes)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
