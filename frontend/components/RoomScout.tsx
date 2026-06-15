"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Button,
  Checkbox,
  Chip,
  Label,
  ListBox,
  ListBoxItem,
  Select,
  Spinner,
  toast,
} from "@heroui/react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleInfo,
  Copy,
  Magnifier,
} from "@gravity-ui/icons";
import type { ReactNode } from "react";
import {
  api,
  type CapacitySize,
  type RoomScout as RoomScoutRow,
  type UserProfileOption,
} from "@/lib/api";
import { BrandIcon } from "./BrandIcon";

const SCOUT_SUBTITLE =
  "We'll check for available rooms every 30 minutes and notify you by email when a matching room is found.";

const DURATION_OPTIONS = [
  { value: "30", label: "30 min" },
  { value: "60", label: "1 hour" },
  { value: "90", label: "1.5 hours" },
  { value: "120", label: "2 hours" },
  { value: "150", label: "2.5 hours" },
  { value: "180", label: "3 hours" },
];

const CAPACITY_OPTIONS: { value: CapacitySize; label: string }[] = [
  { value: "small", label: "Small (≤4)" },
  { value: "medium", label: "Medium (5–12)" },
  { value: "large", label: "Large (13+)" },
];

// Business hours 09:00–18:00, 30-minute steps (matches backend slot_minutes).
const TIME_OPTIONS = (() => {
  const out: string[] = [];
  for (let m = 9 * 60; m <= 18 * 60; m += 30) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  }
  return out;
})();

function timeToMinutes(value: string) {
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m);
}

function durationLabel(minutes: number) {
  return DURATION_OPTIONS.find((o) => o.value === String(minutes))?.label ?? `${minutes} min`;
}

function capacityLabel(size?: CapacitySize | null) {
  if (!size) return "Any";
  return CAPACITY_OPTIONS.find((o) => o.value === size)?.label ?? size;
}

function pickRandom<T>(list: T[]): T | undefined {
  if (!list.length) return undefined;
  return list[Math.floor(Math.random() * list.length)];
}

export function RoomScout({
  userName,
  userOffice,
  officeOptions = [],
  roomThumbnails = [],
  onActiveChange,
}: {
  userName?: string;
  userOffice?: string;
  officeOptions?: UserProfileOption[];
  roomThumbnails?: string[];
  onActiveChange?: (active: boolean) => void;
}) {
  const [scouts, setScouts] = useState<RoomScoutRow[]>([]);
  const [canSendMail, setCanSendMail] = useState(true);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await api.roomScouts();
      setScouts(res.scouts);
      setCanSendMail(res.can_send_mail);
      onActiveChange?.(res.scouts.some((s) => s.status === "active"));
    } catch (e: any) {
      toast.danger("Could not load Room Scout", {
        description: e.message === "UNAUTHENTICATED" ? "Please sign in again." : e.message,
      });
    } finally {
      setLoading(false);
    }
  }, [onActiveChange]);

  useEffect(() => {
    load();
  }, [load]);

  const activeScout = useMemo(
    () => scouts.find((s) => s.status === "active") ?? null,
    [scouts],
  );

  // When the signed-in token lacks Mail.Send we can't run a scout, so we guide
  // the user through granting the permission instead of showing the form.
  const showGuide = !loading && !activeScout && !canSendMail;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex min-h-full w-full flex-col items-center justify-center px-6 py-10">
        <div className={`w-full ${showGuide ? "max-w-[640px]" : "max-w-[480px]"}`}>
          {loading ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : activeScout ? (
            <ScoutingCard
              scout={activeScout}
              thumbnails={roomThumbnails}
              onChanged={load}
            />
          ) : showGuide ? (
            <ScoutPermissionGuide userName={userName} />
          ) : (
            <ScoutForm
              userName={userName}
              userOffice={userOffice}
              officeOptions={officeOptions}
              onCreated={load}
            />
          )}
        </div>
      </div>
    </div>
  );
}

const GUIDE_SUBTITLE =
  "We'll check for available rooms every 30 minutes and send you an Outlook email when a matching room becomes available.";

const GRAPH_EXPLORER_URL =
  "https://developer.microsoft.com/en-us/graph/graph-explorer";
const SEND_MAIL_URL =
  "https://graph.microsoft.com/v1.0/me/microsoft.graph.sendMail";

type GuideStep = { image: string; body: ReactNode; copy?: string };

const GUIDE_STEPS: GuideStep[] = [
  {
    image: "/scout-steps/step-1.png",
    copy: GRAPH_EXPLORER_URL,
    body: (
      <>
        Go to{" "}
        <a
          href={GRAPH_EXPLORER_URL}
          target="_blank"
          rel="noreferrer"
          className="underline [text-underline-position:from-font] hover:text-default-900"
        >
          Microsoft Graph Explorer.
        </a>
      </>
    ),
  },
  {
    image: "/scout-steps/step-2.png",
    copy: SEND_MAIL_URL,
    body: (
      <>
        Change the request method to <b className="font-semibold">POST</b> and
        enter the following URL:
      </>
    ),
  },
  {
    image: "/scout-steps/step-3.png",
    body: (
      <>
        Click <b className="font-semibold">Run Query</b>, then open the{" "}
        <b className="font-semibold">Modify Permissions</b> tab and{" "}
        <b className="font-semibold">Consent</b> to the Mail.Send permission.
      </>
    ),
  },
  {
    image: "/scout-steps/step-4.png",
    body: (
      <>
        Return to <b className="font-semibold">VNG Meet</b> and sign in again{" "}
        <b className="font-semibold">using a new access token</b>. Once
        completed, Scouting will be ready to send Outlook email notifications.
      </>
    ),
  },
];

function GuideArrow({
  direction,
  disabled,
  onPress,
}: {
  direction: "left" | "right";
  disabled: boolean;
  onPress: () => void;
}) {
  const Icon = direction === "left" ? ChevronLeft : ChevronRight;
  return (
    <Button
      isIconOnly
      variant="secondary"
      className="rounded-full"
      aria-label={direction === "left" ? "Previous step" : "Next step"}
      isDisabled={disabled}
      onPress={onPress}
    >
      <Icon width={16} height={16} />
    </Button>
  );
}

function StepCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.danger("Could not copy to clipboard");
    }
  };

  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy link"}
      onClick={copy}
      className="shrink-0 rounded-md p-1 text-default-500 transition hover:bg-default-100 hover:text-default-700"
    >
      {copied ? (
        <Check className="size-4 text-success" />
      ) : (
        <Copy className="size-4" />
      )}
    </button>
  );
}

function ScoutPermissionGuide({ userName }: { userName?: string }) {
  const [stepIndex, setStepIndex] = useState(0);
  const total = GUIDE_STEPS.length;
  const step = GUIDE_STEPS[stepIndex];

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <BrandIcon size={34} />
        <Magnifier className="size-7 text-[#F05A22]" />
      </div>
      <h1 className="mt-3 text-2xl font-bold text-default-900">
        Hi, {userName || "there"}
      </h1>
      <p className="mt-1.5 text-sm leading-5 text-default-500">
        {GUIDE_SUBTITLE}
      </p>

      <div className="mt-5 flex items-start gap-2 rounded-xl bg-[#fee7de] p-3 text-sm leading-6 text-[#535862] dark:bg-[#3B1202] dark:text-[#fee7de]">
        <CircleInfo className="mt-0.5 size-4 shrink-0 text-[#F05A22]" />
        <span>
          Scouting requires email permission so we can notify you when a room
          becomes available. Please follow the steps below to grant access.
        </span>
      </div>

      {/* Fixed-ratio frame so the height stays reserved while the next image
          loads — switching steps no longer collapses/jumps the layout. */}
      <div className="relative mt-5 aspect-[3372/1920] w-full overflow-hidden rounded-xl border border-default-200 bg-default-100">
        <img
          key={step.image}
          src={step.image}
          alt={`Step ${stepIndex + 1} of ${total}`}
          className="scout-thumb-fade absolute inset-0 h-full w-full object-cover"
        />
      </div>

      <div className="mt-5 flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Chip
            size="sm"
            variant="secondary"
            className="w-fit text-xs font-medium text-[#F05A22]"
          >
            Step {stepIndex + 1} of {total}
          </Chip>
          {/* Stack all four step bodies in one grid cell so the block keeps the
              height of the tallest step — switching steps never shifts layout. */}
          <div className="grid text-sm leading-6 text-default-600">
            {GUIDE_STEPS.map((s, i) => (
              <div
                key={i}
                aria-hidden={i !== stepIndex}
                className={`col-start-1 row-start-1 ${
                  i === stepIndex ? "" : "invisible"
                }`}
              >
                <p>{s.body}</p>
                {s.copy && (
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span className="break-all font-semibold text-default-900">
                      {s.copy}
                    </span>
                    <StepCopyButton text={s.copy} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <GuideArrow
            direction="left"
            disabled={stepIndex === 0}
            onPress={() => setStepIndex((i) => Math.max(0, i - 1))}
          />
          <GuideArrow
            direction="right"
            disabled={stepIndex === total - 1}
            onPress={() => setStepIndex((i) => Math.min(total - 1, i + 1))}
          />
        </div>
      </div>
    </div>
  );
}

function ScoutForm({
  userName,
  userOffice,
  officeOptions,
  onCreated,
}: {
  userName?: string;
  userOffice?: string;
  officeOptions: UserProfileOption[];
  onCreated: () => void | Promise<void>;
}) {
  const [office, setOffice] = useState(userOffice || "");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [duration, setDuration] = useState("");
  const [capacity, setCapacity] = useState<string>("");
  const [ignoreLunch, setIgnoreLunch] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setOffice(userOffice || "");
  }, [userOffice]);

  const startOptions = useMemo(
    () => TIME_OPTIONS.slice(0, -1).map((t) => ({ value: t, label: t })),
    [],
  );
  const endOptions = useMemo(() => {
    const after = startTime ? timeToMinutes(startTime) : -Infinity;
    return TIME_OPTIONS.filter((t) => timeToMinutes(t) > after).map((t) => ({
      value: t,
      label: t,
    }));
  }, [startTime]);

  const submit = async () => {
    if (!office) {
      toast.warning("Please choose an office.");
      return;
    }
    if (!startTime || !endTime) {
      toast.warning("Please choose a scout range.");
      return;
    }
    if (!duration) {
      toast.warning("Please choose a duration.");
      return;
    }
    if (!capacity) {
      toast.warning("Please choose a capacity.");
      return;
    }
    if (timeToMinutes(endTime) - timeToMinutes(startTime) < Number(duration)) {
      toast.warning("Scout range must be at least as long as the duration.");
      return;
    }
    setSaving(true);
    try {
      await api.createRoomScout({
        duration_minutes: Number(duration),
        capacity_size: capacity as CapacitySize,
        scout_start_time: startTime,
        scout_end_time: endTime,
        ignore_lunch_break: ignoreLunch,
        office: office || null,
      });
      toast.success("Room Scout started", {
        description: "We'll email you when a matching room opens up.",
      });
      await onCreated();
    } catch (e: any) {
      toast.danger("Could not start Room Scout", { description: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <BrandIcon size={34} />
        <Magnifier className="size-7 text-[#F05A22]" />
      </div>
      <h1 className="mt-3 text-2xl font-bold text-default-900">
        Hi, {userName || "there"}
      </h1>
      <p className="mt-1.5 text-sm leading-5 text-default-500">{SCOUT_SUBTITLE}</p>

      <div className="mt-6 grid gap-4">
        <SelectField
          label="Office"
          placeholder="Select Office"
          value={office}
          onChange={setOffice}
          options={officeOptions.map((o) => ({ value: o.value, label: o.label }))}
        />

        <div>
          <Label className="mb-1.5 block">Scout range</Label>
          <div className="grid grid-cols-2 gap-4">
            <SelectField
              placeholder="Start Time"
              value={startTime}
              onChange={(value) => {
                setStartTime(value);
                if (endTime && timeToMinutes(endTime) <= timeToMinutes(value)) {
                  setEndTime("");
                }
              }}
              options={startOptions}
              maxRows={5}
            />
            <SelectField
              placeholder="End Time"
              value={endTime}
              onChange={setEndTime}
              options={endOptions}
              maxRows={5}
            />
          </div>
        </div>

        <Checkbox
          variant="secondary"
          isSelected={ignoreLunch}
          onChange={setIgnoreLunch}
        >
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          <Checkbox.Content>
            <span className="text-sm font-medium text-default-700">
              Ignore lunch break
            </span>
          </Checkbox.Content>
        </Checkbox>

        <SelectField
          label="Duration"
          placeholder="Select Duration"
          value={duration}
          onChange={setDuration}
          options={DURATION_OPTIONS}
        />

        <SelectField
          label="Capacity"
          placeholder="Select Capacity"
          value={capacity}
          onChange={setCapacity}
          options={CAPACITY_OPTIONS}
        />

        <div className="flex items-start gap-1.5 text-sm leading-5 text-default-500">
          <CircleInfo className="mt-0.5 size-4 shrink-0 text-[#F05A22]" />
          <span>Room scouting is currently limited to same-day bookings.</span>
        </div>

        <Button className="mt-2 w-full rounded-full" onPress={submit} isPending={saving}>
          Start Room Scout
        </Button>
      </div>
    </div>
  );
}

function ScoutingCard({
  scout,
  thumbnails,
  onChanged,
}: {
  scout: RoomScoutRow;
  thumbnails: string[];
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<"cancel" | "found" | null>(null);

  // Random thumbnail that crossfades to another random one every 5s.
  const [pair, setPair] = useState<{ cur?: string; prev?: string }>(() => ({
    cur: pickRandom(thumbnails),
  }));
  useEffect(() => {
    if (thumbnails.length === 0) return;
    if (!pair.cur) setPair({ cur: pickRandom(thumbnails) });
    if (thumbnails.length < 2) return;
    const t = setInterval(() => {
      setPair((p) => ({ cur: pickRandom(thumbnails) ?? p.cur, prev: p.cur }));
    }, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thumbnails]);

  // Sequential blinking dots: "." → ".." → "..." → repeat.
  const [dots, setDots] = useState(1);
  useEffect(() => {
    const t = setInterval(() => setDots((d) => (d % 3) + 1), 450);
    return () => clearInterval(t);
  }, []);

  const stop = async (kind: "cancel" | "found") => {
    setBusy(kind);
    try {
      await api.stopRoomScout(scout.id, kind === "found" ? "success" : "canceled");
      if (kind === "found") {
        toast.success("Nice! Room Scout stopped", {
          description: "Glad you found a room.",
        });
      } else {
        toast.success("Room Scout cancelled");
      }
      await onChanged();
    } catch (e: any) {
      toast.danger("Could not stop Room Scout", { description: e.message });
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="relative h-[150px] w-full overflow-hidden rounded-xl bg-default-100">
        {pair.prev && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={pair.prev}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
        {pair.cur ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={pair.cur}
            src={pair.cur}
            alt="Scouting room"
            className="scout-thumb-fade absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary to-secondary text-2xl font-bold text-white">
            Room Scout
          </div>
        )}
      </div>

      <h1 className="mt-5 text-2xl font-bold text-default-900">
        Scouting
        <span className="ml-0.5 inline-block w-6 text-left align-baseline">
          {".".repeat(dots)}
        </span>
      </h1>
      <p className="mt-1.5 text-sm leading-5 text-default-500">{SCOUT_SUBTITLE}</p>

      <dl className="mt-5 grid gap-2.5 text-sm">
        <DetailRow label="Office" value={scout.office || "All"} />
        <DetailRow label="Duration" value={durationLabel(scout.duration_minutes)} />
        <DetailRow
          label="Scout Range"
          value={
            scout.scout_start_time && scout.scout_end_time
              ? `${scout.scout_start_time} - ${scout.scout_end_time}`
              : "-"
          }
        />
        <DetailRow label="Capacity" value={capacityLabel(scout.capacity_size)} />
      </dl>

      <div className="mt-4 flex items-start gap-1.5 text-sm leading-5 text-default-500">
        <CircleInfo className="mt-0.5 size-4 shrink-0 text-[#F05A22]" />
        <span>Room scouting is currently limited to same-day bookings.</span>
      </div>

      <div className="mt-5 flex items-center gap-2">
        <Button
          variant="tertiary"
          className="rounded-full"
          isPending={busy === "cancel"}
          isDisabled={busy === "found"}
          onPress={() => stop("cancel")}
        >
          Cancel Scouting
        </Button>
        <Button
          className="flex-1 rounded-full"
          isPending={busy === "found"}
          isDisabled={busy === "cancel"}
          onPress={() => stop("found")}
        >
          I already found a room
        </Button>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-default-500">{label}</dt>
      <dd className="font-medium text-default-900">{value}</dd>
    </div>
  );
}

function SelectField({
  label,
  placeholder,
  value,
  onChange,
  options,
  className,
  maxRows,
}: {
  label?: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  className?: string;
  // When set, the dropdown shows at most this many rows before scrolling.
  maxRows?: number;
}) {
  return (
    <Select
      variant="secondary"
      className={`flex flex-col gap-1.5 ${className ?? ""}`}
      placeholder={placeholder}
      selectedKey={value || null}
      onSelectionChange={(key) => onChange(key ? String(key) : "")}
      aria-label={label ?? placeholder}
    >
      {label && <Label>{label}</Label>}
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox
          className={maxRows ? "overflow-y-auto" : undefined}
          style={maxRows ? { maxHeight: `${maxRows * 2.5}rem` } : undefined}
        >
          {options.map((item) => (
            <ListBoxItem key={item.value} id={item.value}>
              {item.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
