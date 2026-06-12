"use client";

import { useEffect, useState } from "react";
import {
  Button,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Select,
  TextArea,
  TextField,
  Chip,
} from "@heroui/react";
import { api } from "@/lib/api";

export interface BookingSlot {
  roomEmail: string;
  roomName: string;
  date: string; // ISO "2026-06-11"
  startTime: string; // "09:00"
}

function fmtDate(iso: string) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("vi-VN", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

const IconCalendar = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
  </svg>
);
const IconClock = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
  </svg>
);
const IconTitle = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 7V5h16v2M9 19h6M12 5v14" />
  </svg>
);
const IconUsers = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

export function BookingModal({
  isOpen,
  onClose,
  slot,
  endOptions,
  onBooked,
}: {
  isOpen: boolean;
  onClose: () => void;
  slot: BookingSlot | null;
  endOptions: string[]; // selectable end times (after startTime)
  onBooked: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [attendees, setAttendees] = useState("");
  const [notes, setNotes] = useState("");
  const [endTime, setEndTime] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form whenever a new slot is opened.
  useEffect(() => {
    if (isOpen && slot) {
      setSubject("");
      setAttendees("");
      setNotes("");
      setEndTime(endOptions[0] ?? "");
      setError(null);
    }
  }, [isOpen, slot, endOptions]);

  if (!slot || !isOpen) return null;

  const initials = slot.roomName
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  const submit = async () => {
    if (!subject.trim()) {
      setError("Vui lòng nhập tiêu đề cuộc họp.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await api.book({
        room_email: slot.roomEmail,
        room_name: slot.roomName,
        date: slot.date,
        start_time: slot.startTime,
        end_time: endTime,
        booking_type: "instant",
        method: "manual",
        subject: subject.trim(),
        attendees: attendees
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean),
        body: notes.trim() || undefined,
      });
      onBooked();
      onClose();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg === "UNAUTHENTICATED") {
        setError("Bạn cần đăng nhập lại.");
      } else if (msg.startsWith("403")) {
        setError("Thiếu quyền tạo lịch (cần Calendars.ReadWrite). Đăng nhập lại để cấp quyền.");
      } else {
        setError(`Đặt phòng thất bại: ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Gradient header */}
        <div className="bg-gradient-to-br from-primary to-secondary px-6 py-5">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white/20 text-lg font-bold text-default-900 backdrop-blur">
              {initials}
            </div>
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wide text-default-500">Đặt phòng</p>
              <h2 className="truncate text-lg font-bold text-default-900">{slot.roomName}</h2>
              <p className="truncate text-xs text-default-500">{slot.roomEmail}</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Chip
              size="sm"
              variant="soft"
            >
              {fmtDate(slot.date)}
            </Chip>
            <Chip
              size="sm"
              variant="soft"
            >
              {slot.startTime} – {endTime || "…"}
            </Chip>
          </div>
        </div>

        <div className="grid gap-4 px-6 py-5">
          <TextField fullWidth>
            <Label>Tiêu đề cuộc họp</Label>
            <Input
              variant="secondary"
              placeholder="VD: Họp team sprint planning"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </TextField>

          <Select
            variant="secondary"
            selectedKey={endTime || null}
            onSelectionChange={(key) => setEndTime((key as string) ?? "")}
          >
            <Label>Giờ kết thúc</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {endOptions.map((t) => (
                  <ListBoxItem key={t} id={t}>
                    {t}
                  </ListBoxItem>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>

          <TextField fullWidth>
            <Label>Người tham dự</Label>
            <Input
              variant="secondary"
              placeholder="email1@vng.com, email2@vng.com"
              value={attendees}
              onChange={(event) => setAttendees(event.target.value)}
            />
          </TextField>

          <TextField fullWidth>
            <Label>Nội dung cuộc họp</Label>
            <TextArea
              variant="secondary"
              placeholder="Nội dung cuộc họp (tùy chọn)"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </TextField>

          {error && (
            <Chip color="danger" variant="soft" size="sm">
              {error}
            </Chip>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-default-100 px-6 py-4">
          <Button variant="ghost" onPress={onClose} isDisabled={loading}>
            Hủy
          </Button>
          <Button
            onPress={submit}
            isPending={loading}
          >
            Đặt phòng
          </Button>
        </div>
      </div>
    </div>
  );
}
