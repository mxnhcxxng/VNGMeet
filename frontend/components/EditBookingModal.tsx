"use client";

import { useEffect, useState, type MouseEvent } from "react";
import {
  Button,
  Input,
  Label,
  TextArea,
  TextField,
  toast,
} from "@heroui/react";
import { Clock } from "@gravity-ui/icons";
import { api, type Booking } from "@/lib/api";
import { attendeesToInput } from "@/lib/attendees";
import { roomFlag } from "@/lib/roomFlags";
import { useT } from "@/app/providers";

export function EditBookingModal({
  isOpen,
  booking,
  thumbnail,
  readOnly = false,
  bookedBy,
  onClose,
  onSaved,
}: {
  isOpen: boolean;
  booking: Booking | null;
  thumbnail?: string; // meeting_room_metadata.thumbnail_link (when known)
  // Read-only mode: a meeting the user is only invited to. All fields are locked,
  // empty ones show N/A, the title shows who booked it, and only Close is offered.
  readOnly?: boolean;
  bookedBy?: string; // organizer email, shown in the read-only title
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
  const na = t("common.na");

  const title = readOnly
    ? t("booking.bookedBy", {
        by: bookedBy ? bookedBy.split("@")[0] : t("common.unknown"),
      })
    : t("booking.editTitle");

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onMouseDown={closeFromBackdrop}
    >
      {/* Below `lg` the two halves stack and the dialog turns into a scrollable
          bottom sheet; from `lg` up it's the side-by-side banner + form design. */}
      <div className="flex max-h-[92dvh] w-full max-w-[1072px] flex-col gap-4 overflow-y-auto rounded-t-2xl bg-white p-4 shadow-2xl dark:bg-[#0c0e12] sm:max-h-[90dvh] sm:rounded-2xl lg:flex-row lg:gap-6 lg:overflow-visible lg:p-6">
        {/* Banner — 400px wide on desktop, a short cover strip once stacked.
            Thumbnail (meeting_room_metadata.thumbnail_link) with room name +
            email overlaid over a dark gradient for legibility. */}
        <div className="relative h-[160px] w-full shrink-0 overflow-hidden rounded-lg bg-default-100 shadow-lg sm:h-[200px] lg:h-auto lg:min-h-[420px] lg:w-[400px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumbnail || "/default-room-thumbnail.png"}
            alt={roomName}
            className="h-full w-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent from-20% to-black/90 lg:from-50%" />
          <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 p-4 text-white lg:p-6">
            <p className="text-xl font-bold leading-7 lg:text-2xl lg:leading-8">
              {roomFlag(booking.room_name) && (
                <span className="mr-2">{roomFlag(booking.room_name)}</span>
              )}
              {roomName}
            </p>
            <p className="text-sm font-medium leading-5">
              {booking.room_email}
            </p>
          </div>
        </div>

        {/* Form — 600px wide from `lg` up, full width once stacked */}
        <div className="flex w-full flex-col gap-5 lg:w-[600px] lg:shrink-0">
          {/* Title */}
          <div className="flex items-center gap-2">
            {isScheduled && (
              <Clock
                width={20}
                height={20}
                className="shrink-0 text-[var(--accent)]"
              />
            )}
            <h2 className="text-xl font-bold leading-7 text-default-900 lg:text-2xl lg:leading-8">
              {title}
            </h2>
          </div>

          {/* Form */}
          <div className="grid gap-4">
            <TextField fullWidth isRequired={!readOnly} isDisabled={readOnly}>
              <Label>{t("booking.meetingTitle")}</Label>
              <Input
                variant="secondary"
                placeholder={t("booking.meetingTitlePlaceholder")}
                value={readOnly ? subject || na : subject}
                onChange={(event) => setSubject(event.target.value)}
                readOnly={readOnly}
              />
            </TextField>

            {/* Date & time are fixed once booked — shown read-only for context. */}
            <TextField fullWidth isDisabled>
              <Label>
                {t("booking.date")} {req}
              </Label>
              <Input variant="secondary" value={booking.date} readOnly />
            </TextField>

            {/* Start + end always share one row — they read as a single range,
                so stacking them on narrow screens breaks the pairing. */}
            <div className="flex items-start gap-3 sm:gap-4">
              <TextField fullWidth className="min-w-0 flex-1" isDisabled>
                <Label>
                  {t("booking.startTime")} {req}
                </Label>
                <Input
                  variant="secondary"
                  value={booking.start_time}
                  readOnly
                />
              </TextField>
              <TextField fullWidth className="min-w-0 flex-1" isDisabled>
                <Label>
                  {t("booking.endTime")} {req}
                </Label>
                <Input variant="secondary" value={booking.end_time} readOnly />
              </TextField>
            </div>

            <TextField fullWidth isDisabled={readOnly}>
              <Label>{t("booking.attendees")}</Label>
              <Input
                variant="secondary"
                placeholder={t("booking.attendeesPlaceholder")}
                value={readOnly ? attendees || na : attendees}
                onChange={(event) => setAttendees(event.target.value)}
                readOnly={readOnly}
              />
            </TextField>

            <TextField fullWidth isDisabled={readOnly}>
              <Label>{t("booking.description")}</Label>
              <TextArea
                variant="secondary"
                rows={4}
                placeholder={t("booking.descriptionPlaceholder")}
                value={readOnly ? notes || na : notes}
                onChange={(event) => setNotes(event.target.value)}
                readOnly={readOnly}
              />
            </TextField>

            {error && <p className="text-sm text-danger">{error}</p>}
          </div>

          {/* Buttons */}
          <div className="mt-auto flex items-center justify-center gap-2 pt-2">
            {readOnly ? (
              <Button
                variant="tertiary"
                className="flex-1 rounded-full"
                onPress={onClose}
              >
                {t("common.close")}
              </Button>
            ) : (
              <>
                <Button
                  variant="tertiary"
                  className="flex-1 rounded-full"
                  onPress={onClose}
                  isDisabled={loading}
                >
                  {t("common.close")}
                </Button>
                <Button
                  className="flex-1 rounded-full"
                  onPress={submit}
                  isPending={loading}
                >
                  {t("common.saveShort")}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
