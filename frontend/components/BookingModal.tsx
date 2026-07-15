"use client";

import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  Button,
  Chip,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Select,
  TextArea,
  TextField,
  toast,
} from "@heroui/react";
import { CircleInfo, Clock, Persons } from "@gravity-ui/icons";
import { api, type CapacitySize } from "@/lib/api";
import { roomFlag } from "@/lib/roomFlags";
import { useT } from "@/app/providers";
import { useTokenExpiry } from "./TokenExpiryProvider";

export interface BookingSlot {
  roomEmail: string;
  roomName: string;
  date: string; // ISO "2026-06-11"
  startTime: string; // "09:00"
  thumbnail?: string; // meeting_room_metadata.thumbnail_link
  schedule?: boolean; // day is beyond the live window → a schedule booking, not instant
  capacitySize?: CapacitySize; // small | medium | large → capacity chip
  floor?: string; // floor label → "Floor {n}" chip
  location?: string; // building / zone group → location chip
}

// Capacity chip shows a headcount range next to a people icon (e.g. "5-12"),
// mapped from the room's capacity_size band.
const CAPACITY_RANGE: Record<CapacitySize, string> = {
  small: "≤4",
  medium: "5-12",
  large: "13+",
};

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
  onBooked: (info?: {
    roomEmail: string;
    date: string;
    startTime: string;
    endTime: string;
  }) => void;
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
        : (endOptions[0] ?? "");
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
          slot.schedule ? "booking.subjectScheduled" : "booking.subjectInstant",
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
    // The backend processes scheduled bookings at 00:00:00 the next day, when
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
      onBooked({
        roomEmail: slot.roomEmail,
        date: slot.date,
        startTime: slot.startTime,
        endTime,
      });
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

  // Room metadata chips shown over the thumbnail. The capacity chip is the
  // primary variant (people icon + headcount range); floor/venue are secondary.
  // Each renders only when its datum is present, so a room missing e.g. a floor
  // just drops that chip.
  const chips = [
    slot.capacitySize
      ? {
          label: CAPACITY_RANGE[slot.capacitySize],
          variant: "primary" as const,
          icon: <Persons width={14} height={14} />,
        }
      : null,
    slot.floor
      ? {
          label: t("booking.floor", { floor: slot.floor }),
          variant: "secondary" as const,
          icon: null,
        }
      : null,
    slot.location
      ? { label: slot.location, variant: "secondary" as const, icon: null }
      : null,
  ].filter(Boolean) as {
    label: string;
    variant: "primary" | "secondary";
    icon: ReactNode;
  }[];

  const title = slot.schedule
    ? t("booking.scheduledTitle")
    : t("booking.instantTitle");
  const subtitle = slot.schedule
    ? t("booking.scheduleInfo1")
    : t("booking.instantSubtitle");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={closeFromBackdrop}
    >
      <div className="flex w-full max-w-[1072px] gap-6 rounded-2xl bg-white p-6 shadow-2xl dark:bg-[#0c0e12]">
        {/* Banner — 400px wide. The thumbnail (meeting_room_metadata.thumbnail_link)
            with room name, email and metadata chips overlaid over a dark gradient
            for legibility. Stretches to the form's height. */}
        <div className="relative w-[400px] min-h-[420px] shrink-0 overflow-hidden rounded-lg bg-default-100 shadow-lg">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={slot.thumbnail || "/default-room-thumbnail.png"}
            alt={slot.roomName}
            className="h-full w-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent from-50% to-black/90" />
          <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 p-6">
            <div className="text-white">
              <p className="text-2xl font-bold leading-8">
                {roomFlag(slot.roomName) && (
                  <span className="mr-2">{roomFlag(slot.roomName)}</span>
                )}
                {slot.roomName}
              </p>
              <p className="text-sm font-medium leading-5">{slot.roomEmail}</p>
            </div>
            {chips.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {chips.map((chip) => (
                  <Chip
                    key={chip.label}
                    size="md"
                    color="accent"
                    variant={chip.variant}
                    className="backdrop-blur-sm"
                  >
                    <span className="inline-flex items-center gap-1">
                      {chip.icon}
                      {chip.label}
                    </span>
                  </Chip>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Form — 600px wide */}
        <div className="flex w-[600px] shrink-0 flex-col gap-5">
          {/* Title + subtitle */}
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              {slot.schedule && (
                <Clock
                  width={20}
                  height={20}
                  className="shrink-0 text-[var(--accent)]"
                />
              )}
              <h2 className="text-2xl font-bold leading-8 text-default-900">
                {title}
              </h2>
            </div>
            <p className="text-sm leading-5 text-default-500">{subtitle}</p>
          </div>

          {/* Form */}
          <div className="grid gap-4">
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
                <Label>
                  {t("booking.startTime")} {req}
                </Label>
                <Input variant="secondary" value={slot.startTime} readOnly />
              </TextField>

              <Select
                variant="secondary"
                selectedKey={endTime || null}
                onSelectionChange={(key) => setEndTime((key as string) ?? "")}
              >
                <Label>
                  {t("booking.endTime")} {req}
                </Label>
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
                rows={7}
                placeholder={t("booking.descriptionPlaceholder")}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </TextField>

            {slot.schedule && (
              <div className="flex items-start gap-2 pt-1 text-sm leading-5 text-default-600">
                <CircleInfo
                  width={16}
                  height={16}
                  className="mt-0.5 shrink-0 text-[var(--accent)]"
                />
                <p>{t("booking.scheduleInfo2")}</p>
              </div>
            )}

            {error && <p className="text-sm text-danger">{error}</p>}
          </div>

          {/* Buttons */}
          <div className="mt-auto flex items-center justify-center gap-2 pt-2">
            <Button
              variant="tertiary"
              className="flex-1 rounded-full"
              onPress={onClose}
              isDisabled={loading}
            >
              {t("common.cancel")}
            </Button>
            <Button
              className="flex-1 rounded-full"
              onPress={submit}
              isPending={loading}
            >
              {t("booking.book")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
