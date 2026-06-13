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
} from "@heroui/react";
import { api } from "@/lib/api";

export interface BookingSlot {
  roomEmail: string;
  roomName: string;
  date: string; // ISO "2026-06-11"
  startTime: string; // "09:00"
  thumbnail?: string; // meeting_room_metadata.thumbnail_link
}

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

  const req = <span className="text-danger">*</span>;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex w-full max-w-[800px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Room thumbnail (meeting_room_metadata.thumbnail_link) */}
        <div className="px-6 pt-6">
          <div className="h-[120px] w-full overflow-hidden rounded-lg bg-default-100">
            {slot.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={slot.thumbnail}
                alt={slot.roomName}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary to-secondary text-2xl font-bold text-white">
                {initials}
              </div>
            )}
          </div>
        </div>

        {/* Room name + email */}
        <div className="px-6 pb-5 pt-6">
          <h2 className="text-base font-semibold text-default-900">{slot.roomName}</h2>
          <p className="text-sm text-default-500">{slot.roomEmail}</p>
        </div>

        {/* Form */}
        <div className="grid gap-4 px-6">
          <TextField fullWidth isRequired>
            <Label>Meeting Title</Label>
            <Input
              variant="secondary"
              placeholder="Meeting title"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </TextField>

          <div className="grid grid-cols-2 gap-4">
            <TextField fullWidth isDisabled>
              <Label>Start time {req}</Label>
              <Input variant="secondary" value={slot.startTime} readOnly />
            </TextField>

            <Select
              variant="secondary"
              selectedKey={endTime || null}
              onSelectionChange={(key) => setEndTime((key as string) ?? "")}
            >
              <Label>End time {req}</Label>
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
          </div>

          <TextField fullWidth>
            <Label>Attendees</Label>
            <Input
              variant="secondary"
              placeholder='Invite required attendees, separate by a comma ","'
              value={attendees}
              onChange={(event) => setAttendees(event.target.value)}
            />
          </TextField>

          <TextField fullWidth>
            <Label>Description</Label>
            <TextArea
              variant="secondary"
              placeholder="Meeting description"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </TextField>

          {error && <p className="text-sm text-danger">{error}</p>}
        </div>

        {/* Buttons */}
        <div className="flex items-center justify-center gap-2 px-6 pb-6 pt-8">
          <Button
            variant="tertiary"
            className="flex-1 rounded-full"
            onPress={onClose}
            isDisabled={loading}
          >
            Cancel
          </Button>
          <Button className="flex-1 rounded-full" onPress={submit} isPending={loading}>
            Book
          </Button>
        </div>
      </div>
    </div>
  );
}
