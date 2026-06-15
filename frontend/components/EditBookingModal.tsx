"use client";

import { useEffect, useState, type MouseEvent } from "react";
import { Button, Input, Label, TextArea, TextField, toast } from "@heroui/react";
import { Clock } from "@gravity-ui/icons";
import { api, type Booking } from "@/lib/api";

export function EditBookingModal({
  isOpen,
  booking,
  thumbnail,
  onClose,
  onSaved,
}: {
  isOpen: boolean;
  booking: Booking | null;
  thumbnail?: string; // meeting_room_metadata.thumbnail_link (when known)
  onClose: () => void;
  onSaved: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [attendees, setAttendees] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the form whenever a different booking is opened.
  useEffect(() => {
    if (!isOpen || !booking) return;
    setSubject(booking.subject ?? "");
    setAttendees((booking.attendees ?? []).join(", "));
    setNotes(booking.body ?? "");
    setError(null);
  }, [isOpen, booking]);

  if (!isOpen || !booking) return null;

  const isScheduled = booking.booking_type === "scheduled";
  const roomName = booking.room_name || booking.room_email;
  const initials = roomName
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  const submit = async () => {
    if (!subject.trim()) {
      setError("Vui lòng nhập tiêu đề cuộc họp.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await api.updateBooking(booking.id, {
        subject: subject.trim(),
        attendees: attendees
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean),
        body: notes.trim(),
      });
      toast.success("Booking updated", {
        description: "Your meeting has been updated successfully.",
      });
      onSaved();
      onClose();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg === "UNAUTHENTICATED") {
        toast.danger("Session expired", {
          description: "Please sign in again to continue.",
        });
      } else if (msg.startsWith("403")) {
        toast.danger("Permission required", {
          description:
            "Calendar write access (Calendars.ReadWrite) is needed. Please sign in again to grant it.",
        });
      } else {
        toast.danger("Update failed", {
          description: "Could not update the booking. Please try again.",
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const req = <span className="text-danger">*</span>;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={closeFromBackdrop}
    >
      <div className="flex w-full max-w-[560px] flex-col overflow-hidden rounded-2xl bg-white dark:bg-[#0c0e12] shadow-2xl">
        {/* Room thumbnail (meeting_room_metadata.thumbnail_link) */}
        <div className="px-6 pt-6">
          <div className="relative h-[120px] w-full overflow-hidden rounded-lg bg-default-100">
            {thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={thumbnail}
                alt={roomName}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary to-secondary text-2xl font-bold text-white">
                {initials}
              </div>
            )}
            {isScheduled && (
              <div className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-1 text-sm font-medium leading-5 text-[var(--accent-foreground)] shadow-sm">
                <Clock width={16} height={16} />
                <span>Scheduled Booking</span>
              </div>
            )}
          </div>
        </div>

        {/* Room name + email */}
        <div className="px-6 pb-1 pt-6">
          <h2 className="text-base font-semibold text-default-900">
            {roomName} - Edit booking
          </h2>
          <p className="text-sm text-default-500">{booking.room_email}</p>
        </div>

        <div className="grid gap-4 px-6 pt-4">
          <TextField fullWidth isRequired>
            <Label>Meeting Title</Label>
            <Input
              variant="secondary"
              placeholder="Meeting title"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </TextField>

          {/* Date & time are fixed once booked — shown read-only for context. */}
          <TextField fullWidth isDisabled>
            <Label>Date {req}</Label>
            <Input variant="secondary" value={booking.date} readOnly />
          </TextField>

          <div className="grid grid-cols-2 gap-4">
            <TextField fullWidth isDisabled>
              <Label>Start time {req}</Label>
              <Input variant="secondary" value={booking.start_time} readOnly />
            </TextField>
            <TextField fullWidth isDisabled>
              <Label>End time {req}</Label>
              <Input variant="secondary" value={booking.end_time} readOnly />
            </TextField>
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
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
