"use client";

import { useEffect, useState } from "react";
import {
  Modal,
  ModalContent,
  ModalBody,
  ModalFooter,
  Button,
  Input,
  Textarea,
  Select,
  SelectItem,
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

  if (!slot) return null;

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
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      placement="center"
      backdrop="blur"
      size="lg"
      classNames={{ base: "overflow-hidden" }}
    >
      <ModalContent>
        {/* Gradient header */}
        <div className="bg-gradient-to-br from-primary to-secondary px-6 py-5 text-white">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white/20 text-lg font-bold backdrop-blur">
              {initials}
            </div>
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wide text-white/70">Đặt phòng</p>
              <h2 className="truncate text-lg font-bold">{slot.roomName}</h2>
              <p className="truncate text-xs text-white/80">{slot.roomEmail}</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Chip
              size="sm"
              variant="flat"
              startContent={<IconCalendar />}
              classNames={{ base: "bg-white/20 text-white capitalize", content: "px-1" }}
            >
              {fmtDate(slot.date)}
            </Chip>
            <Chip
              size="sm"
              variant="flat"
              startContent={<IconClock />}
              classNames={{ base: "bg-white/20 text-white", content: "px-1" }}
            >
              {slot.startTime} – {endTime || "…"}
            </Chip>
          </div>
        </div>

        <ModalBody className="gap-4 py-5">
          <Input
            isRequired
            label="Tiêu đề cuộc họp"
            labelPlacement="outside"
            placeholder="VD: Họp team sprint planning"
            value={subject}
            onValueChange={setSubject}
            variant="bordered"
            startContent={<span className="text-default-400"><IconTitle /></span>}
          />

          <Select
            label="Giờ kết thúc"
            labelPlacement="outside"
            selectedKeys={endTime ? [endTime] : []}
            onSelectionChange={(keys) => setEndTime(Array.from(keys)[0] as string)}
            variant="bordered"
            startContent={<span className="text-default-400"><IconClock /></span>}
          >
            {endOptions.map((t) => (
              <SelectItem key={t}>{t}</SelectItem>
            ))}
          </Select>

          <Input
            label="Người tham dự"
            labelPlacement="outside"
            placeholder="email1@vng.com, email2@vng.com"
            value={attendees}
            onValueChange={setAttendees}
            variant="bordered"
            description="Phân tách bằng dấu phẩy (tùy chọn)"
            startContent={<span className="text-default-400"><IconUsers /></span>}
          />

          <Textarea
            label="Ghi chú / nội dung"
            labelPlacement="outside"
            placeholder="Nội dung cuộc họp (tùy chọn)"
            value={notes}
            onValueChange={setNotes}
            variant="bordered"
            minRows={2}
          />

          {error && (
            <Chip color="danger" variant="flat" size="sm" className="self-start">
              {error}
            </Chip>
          )}
        </ModalBody>

        <ModalFooter className="border-t border-default-100">
          <Button variant="light" onPress={onClose} isDisabled={loading}>
            Hủy
          </Button>
          <Button
            color="primary"
            onPress={submit}
            isLoading={loading}
            className="font-medium shadow-md shadow-primary/30"
          >
            Đặt phòng
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
