"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  Button,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Select,
  TextArea,
  TextField,
  toast,
} from "@heroui/react";
import { CircleInfo, Clock } from "@gravity-ui/icons";
import { api } from "@/lib/api";
import { useT } from "@/app/providers";
import { useTokenExpiry } from "./TokenExpiryProvider";

export interface BookingSlot {
  roomEmail: string;
  roomName: string;
  date: string; // ISO "2026-06-11"
  startTime: string; // "09:00"
  thumbnail?: string; // meeting_room_metadata.thumbnail_link
  schedule?: boolean; // day is beyond the live window → a schedule booking, not instant
}

export function BookingModal({
  isOpen,
  onClose,
  slot,
  endOptions,
  initialEndTime,
  userDomain,
  onBooked,
}: {
  isOpen: boolean;
  onClose: () => void;
  slot: BookingSlot | null;
  endOptions: string[]; // selectable end times (after startTime)
  initialEndTime?: string | null; // end time pre-selected from a drag selection
  userDomain?: string; // email username, used to auto-fill the meeting title
  onBooked: () => void;
}) {
  const t = useT();
  const { ensureTokenTime } = useTokenExpiry();
  const [subject, setSubject] = useState("");
  const [attendees, setAttendees] = useState("");
  const [notes, setNotes] = useState("");
  const [endTime, setEndTime] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialise the end time once per opened slot. A drag selection passes the
  // chosen end via `initialEndTime`; otherwise default to the first option (the
  // single-slot duration). Keyed so the user's later manual changes aren't
  // overwritten on re-render.
  const initKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen || !slot) {
      initKeyRef.current = null;
      return;
    }
    const key = `${slot.roomEmail}|${slot.date}|${slot.startTime}|${initialEndTime ?? ""}`;
    if (initKeyRef.current === key) return;
    initKeyRef.current = key;
    const preferred =
      initialEndTime && endOptions.includes(initialEndTime)
        ? initialEndTime
        : endOptions[0] ?? "";
    setEndTime(preferred);
    setError(null);
  }, [endOptions, initialEndTime, isOpen, slot]);

  // Auto-fill the meeting title when the modal opens: "<Domain>'s Meeting" for
  // instant bookings, "<Domain>'s Scheduled Meeting" for schedule bookings.
  useEffect(() => {
    if (!isOpen || !slot) return;
    if (userDomain) {
      setSubject(
        t(
          slot.schedule
            ? "booking.subjectScheduled"
            : "booking.subjectInstant",
          { domain: userDomain },
        ),
      );
    } else {
      setSubject(
        t(
          slot.schedule
            ? "booking.subjectScheduledNoName"
            : "booking.subjectInstantNoName",
        ),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, slot, userDomain]);

  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  const clearDraft = () => {
    setSubject("");
    setAttendees("");
    setNotes("");
    setEndTime("");
  };

  if (!slot || !isOpen) return null;

  const submit = async () => {
    if (!subject.trim()) {
      setError(t("booking.titleRequired"));
      return;
    }
    // The backend processes scheduled bookings at 00:00:01 the next day, when
    // the target date enters the live booking window. Keep the token valid
    // until that run, plus the shared safety buffer.
    if (slot.schedule) {
      const nextRun = new Date();
      nextRun.setDate(nextRun.getDate() + 1);
      nextRun.setHours(0, 0, 1, 0);
      const neededSeconds = Math.max(
        0,
        Math.ceil((nextRun.getTime() - Date.now()) / 1000),
      );
      if (!ensureTokenTime(neededSeconds)) return;
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
        booking_type: slot.schedule ? "scheduled" : "instant",
        method: "manual",
        subject: subject.trim(),
        attendees: attendees
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean),
        body: notes.trim() || undefined,
      });
      toast.success(t("booking.created"), {
        description: t("booking.createdDesc"),
      });
      onBooked();
      clearDraft();
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
        toast.danger(t("booking.failed"), {
          description: t("booking.failedDesc"),
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
      <div className="flex w-full max-w-[800px] flex-col overflow-hidden rounded-2xl bg-white dark:bg-[#0c0e12] shadow-2xl">
        {/* Room thumbnail (meeting_room_metadata.thumbnail_link) */}
        <div className="px-6 pt-6">
          <div className="relative h-[120px] w-full overflow-hidden rounded-lg bg-default-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={slot.thumbnail || "/default-room-thumbnail.png"}
              alt={slot.roomName}
              className="h-full w-full object-cover"
            />
            {slot.schedule && (
              <div className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-1 text-sm font-medium leading-5 text-[var(--accent-foreground)] shadow-sm">
                <Clock width={16} height={16} />
                <span>{t("booking.scheduledBadge")}</span>
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
            <Label>{t("booking.meetingTitle")}</Label>
            <Input
              variant="secondary"
              placeholder={t("booking.meetingTitlePlaceholder")}
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </TextField>

          <div className="grid grid-cols-2 gap-4">
            <TextField fullWidth isDisabled>
              <Label>{t("booking.startTime")} {req}</Label>
              <Input variant="secondary" value={slot.startTime} readOnly />
            </TextField>

            <Select
              variant="secondary"
              selectedKey={endTime || null}
              onSelectionChange={(key) => setEndTime((key as string) ?? "")}
            >
              <Label>{t("booking.endTime")} {req}</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {endOptions.map((opt) => (
                    <ListBoxItem key={opt} id={opt}>
                      {opt}
                    </ListBoxItem>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
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

          {slot.schedule && (
            <div className="grid gap-3 pt-1">
              <div className="flex items-start gap-2 text-sm leading-5 text-default-600">
                <CircleInfo width={16} height={16} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                <p>{t("booking.scheduleInfo1")}</p>
              </div>
              <div className="flex items-start gap-2 text-sm leading-5 text-default-600">
                <CircleInfo width={16} height={16} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                <p>{t("booking.scheduleInfo2")}</p>
              </div>
            </div>
          )}

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
            {t("common.cancel")}
          </Button>
          <Button className="flex-1 rounded-full" onPress={submit} isPending={loading}>
            {t("booking.book")}
          </Button>
        </div>
      </div>
    </div>
  );
}
