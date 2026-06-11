"use client";

import { useRef, useState } from "react";
import { Avatar, Button, Input } from "@heroui/react";
import type { ScheduleResponse } from "@/lib/api";

interface Msg {
  role: "user" | "assistant";
  text: string;
}

// Very small client-side helper: answers "phòng nào trống lúc <giờ>?" using loaded data.
function answer(data: ScheduleResponse | null, dayIndex: number, q: string): string {
  if (!data || !data.rooms.length) {
    return "Mình chưa có dữ liệu phòng. Bạn mở tab Browse rooms để tải lịch trước nhé.";
  }
  const day = data.days[dayIndex];
  const m = q.match(/(\d{1,2})\s*(?::|h|giờ)?\s*(\d{2})?/);
  let timeIdx = 0;
  let timeLabel = data.times[0];
  if (m) {
    const hh = parseInt(m[1], 10);
    const mm = m[2] ? parseInt(m[2], 10) : 0;
    const target = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    const found = data.times.findIndex((t) => t === target || t.startsWith(String(hh).padStart(2, "0") + ":"));
    if (found >= 0) {
      timeIdx = found;
      timeLabel = data.times[found];
    }
  }
  const free = data.rooms.filter((r) => (r.grid[timeIdx]?.[dayIndex] ?? 0) === 0);
  if (!free.length) {
    return `Khung ${timeLabel} ngày ${day} không còn phòng trống 😕`;
  }
  const names = free.map((r) => `• ${r.name}`).join("\n");
  return `Lúc ${timeLabel} ngày ${day} có ${free.length} phòng trống:\n${names}`;
}

export function ChatPanel({
  data,
  dayIndex,
}: {
  data: ScheduleResponse | null;
  dayIndex: number;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([
    {
      role: "assistant",
      text: "Chào bạn 👋 Hỏi mình về phòng họp nhé. Ví dụ: \"Phòng nào trống lúc 10h?\"",
    },
  ]);
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const send = () => {
    const q = input.trim();
    if (!q) return;
    const reply = answer(data, dayIndex, q);
    setMsgs((m) => [...m, { role: "user", text: q }, { role: "assistant", text: reply }]);
    setInput("");
    setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col p-6">
      <div className="flex-1 space-y-4 overflow-y-auto pr-1">
        {msgs.map((m, i) => (
          <div key={i} className={`flex gap-3 ${m.role === "user" ? "flex-row-reverse" : ""}`}>
            <Avatar
              size="sm"
              name={m.role === "user" ? "Bạn" : "AI"}
              className={m.role === "assistant" ? "bg-success-500 text-white" : ""}
            />
            <div
              className={`max-w-[80%] whitespace-pre-line rounded-large px-4 py-2.5 text-sm ${
                m.role === "user"
                  ? "bg-foreground text-background"
                  : "bg-content2 text-foreground"
              }`}
            >
              {m.text}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="mt-4 flex gap-2">
        <Input
          value={input}
          onValueChange={setInput}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Hỏi về phòng họp..."
          variant="bordered"
        />
        <Button color="success" className="text-white" onPress={send}>
          Gửi
        </Button>
      </div>
    </div>
  );
}
