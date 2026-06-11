"use client";

import { Tooltip } from "@heroui/react";
import type { ScheduleRoom } from "@/lib/api";

const STATUS_LABEL: Record<number, string> = {
  0: "Trống",
  1: "Tạm giữ (tentative)",
  2: "Đã book",
  3: "Out of office",
  4: "Làm việc nơi khác",
};

function statusColor(status: number): string {
  // 0 = free -> green, anything else -> red-ish (booked)
  if (status === 0) return "bg-success-400 hover:bg-success-500";
  if (status === 1) return "bg-warning-400 hover:bg-warning-500";
  return "bg-danger-400 hover:bg-danger-500";
}

function dayLabel(iso: string): { dow: string; date: string } {
  const d = new Date(iso + "T00:00:00");
  const dow = d.toLocaleDateString("vi-VN", { weekday: "short" });
  const date = d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
  return { dow, date };
}

export function RoomGrid({
  room,
  days,
  times,
}: {
  room: ScheduleRoom;
  days: string[];
  times: string[];
}) {
  return (
    <div className="overflow-x-auto rounded-large border border-default-200 bg-content1 p-2">
      <table className="border-separate border-spacing-1">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-content1 px-2 py-1 text-xs font-medium text-default-500">
              Giờ \ Ngày
            </th>
            {days.map((d) => {
              const { dow, date } = dayLabel(d);
              return (
                <th key={d} className="px-2 py-1 text-center text-xs font-medium">
                  <div className="capitalize text-default-700">{dow}</div>
                  <div className="text-default-400">{date}</div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {times.map((t, ti) => (
            <tr key={t}>
              <td className="sticky left-0 z-10 bg-content1 pr-2 text-right text-xs tabular-nums text-default-500">
                {t}
              </td>
              {days.map((d, di) => {
                const status = room.grid[ti]?.[di] ?? 0;
                return (
                  <td key={d} className="p-0">
                    <Tooltip
                      content={`${room.name} · ${dayLabel(d).date} ${t} — ${STATUS_LABEL[status] ?? "?"}`}
                      delay={300}
                    >
                      <div
                        className={`h-6 w-12 cursor-default rounded-small transition-colors ${statusColor(status)}`}
                      />
                    </Tooltip>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
