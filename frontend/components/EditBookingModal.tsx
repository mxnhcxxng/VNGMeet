"use client";

import { useEffect, useState, type MouseEvent } from "react";
import { Button, Input, Label, TextArea, TextField, toast } from "@heroui/react";
import { Clock } from "@gravity-ui/icons";
import { api, type Booking } from "@/lib/api";
import { attendeesToInput } from "@/lib/attendees";
import { useT } from "@/app/providers";

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
  const t = useT();
  const [subject, setSubject] = useState("");
  const [attendees, setAttendees] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the form whenever a different booking is opened.
  useEffect(() => {
    if (!isOpen || !booking) return;
    setSubject(booking.subject ?? "");
    setAttendees(attendeesToInput(booking.attendees));
    setNotes(booking.body ?? "");
    setError(null);
  }, [isOpen, booking]);

  if (!isOpen || !booking) return null;

  const isScheduled = booking.booking_type === "scheduled";
  const roomName = booking.room_name || booking.room_email;

  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  const submit = async () => {
    if (!subject.trim()) {
      setError(t("booking.titleRequired"));
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
      toast.success(t("booking.updated"), {
        description: t("booking.updatedDesc"),
      });
      onSaved();
      onClose();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg === "UNAUTHENTICATED") {
        toast.danger(t("booking.sessionExpired"), {
          description: t("booking.sessionExpiredDesc"),
        });
      } else if (msg.startsWith("403")) {
        toast.danger(t("booking.permissionRequired"), {
          description: t("booking.permissionDesc"),
        });
      } else {
        toast.danger(t("booking.updateFailed"), {
          description: t("booking.updateFailedDesc"),
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
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumbnail || "/default-room-thumbnail.png"}
              alt={roomName}
              className="h-full w-full object-cover"
            />
            {isScheduled && (
              <div className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-1 text-sm font-medium leading-5 text-[var(--accent-foreground)] shadow-sm">
                <Clock width={16} height={16} />
                <span>{t("booking.scheduledBadge")}</span>
              </div>
            )}
          </div>
        </div>

        {/* Room name + email */}
        <div className="px-6 pb-1 pt-6">
          <h2 className="text-base font-semibold text-default-900">
            {t("booking.editTitleSuffix", { room: roomName })}
          </h2>
          <p className="text-sm text-default-500">{booking.room_email}</p>
        </div>

        <div className="grid gap-4 px-6 pt-4">
          <TextField fullWidth isRequired>
            <Label>{t("booking.meetingTitle")}</Label>
            <Input
              variant="secondary"
              placeholder={t("booking.meetingTitlePlaceholder")}
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </TextField>

          {/* Date & time are fixed once booked — shown read-only for context. */}
          <TextField fullWidth isDisabled>
            <Label>{t("booking.date")} {req}</Label>
            <Input variant="secondary" value={booking.date} readOnly />
          </TextField>

          <div className="grid grid-cols-2 gap-4">
            <TextField fullWidth isDisabled>
              <Label>{t("booking.startTime")} {req}</Label>
              <Input variant="secondary" value={booking.start_time} readOnly />
            </TextField>
            <TextField fullWidth isDisabled>
              <Label>{t("booking.endTime")} {req}</Label>
              <Input variant="secondary" value={booking.end_time} readOnly />
            </TextField>
          </div>

          <TextField fullWidth>
            <Label>{t("booking.attendees")}</Label>
            <Input
              variant="secondary"
              placeholder={t("booking.attendeesPlaceholder")}
              value={attendees}
              onChange={(event) => setAttendees(event.target.value)}
            />
          </TextField>

          <TextField fullWidth>
            <Label>{t("booking.description")}</Label>
            <TextArea
              variant="secondary"
              placeholder={t("booking.descriptionPlaceholder")}
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
            {t("common.cancel")}
          </Button>
          <Button className="flex-1 rounded-full" onPress={submit} isPending={loading}>
            {t("common.saveShort")}
          </Button>
        </div>
      </div>
    </div>
  );
}
