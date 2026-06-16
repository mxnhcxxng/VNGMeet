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
import { useT } from "@/app/providers";
import type { TFunction, TranslationKey } from "@/lib/i18n";
import { BrandIcon } from "./BrandIcon";

const DURATION_VALUES = ["30", "60", "90", "120", "150", "180"] as const;
const DURATION_KEY: Record<string, TranslationKey> = {
  "30": "scout.dur30",
  "60": "scout.dur60",
  "90": "scout.dur90",
  "120": "scout.dur120",
  "150": "scout.dur150",
  "180": "scout.dur180",
};

const CAPACITY_VALUES: CapacitySize[] = ["small", "medium", "large"];
const CAPACITY_KEY: Record<CapacitySize, TranslationKey> = {
  small: "scout.capSmall",
  medium: "scout.capMedium",
  large: "scout.capLarge",
};

function durationOptions(t: TFunction) {
  return DURATION_VALUES.map((v) => ({ value: v, label: t(DURATION_KEY[v]) }));
}

function capacityOptions(t: TFunction): { value: CapacitySize; label: string }[] {
  return CAPACITY_VALUES.map((v) => ({ value: v, label: t(CAPACITY_KEY[v]) }));
}

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

function durationLabel(t: TFunction, minutes: number) {
  const key = DURATION_KEY[String(minutes)];
  return key ? t(key) : t("scout.durFallback", { n: minutes });
}

function capacityLabel(t: TFunction, size?: CapacitySize | null) {
  if (!size) return t("scout.capAny");
  return CAPACITY_KEY[size] ? t(CAPACITY_KEY[size]) : size;
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
  const t = useT();
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
      toast.danger(t("scout.loadFailed"), {
        description: e.message === "UNAUTHENTICATED" ? t("scout.loadFailedAuth") : e.message,
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

const GRAPH_EXPLORER_URL =
  "https://developer.microsoft.com/en-us/graph/graph-explorer";
const SEND_MAIL_URL =
  "https://graph.microsoft.com/v1.0/me/microsoft.graph.sendMail";

type GuideStep = { image: string; body: ReactNode; copy?: string };

function buildGuideSteps(t: TFunction): GuideStep[] {
  return [
    {
      image: "/scout-steps/step-1.png",
      copy: GRAPH_EXPLORER_URL,
      body: (
        <>
          {t("scout.guideStep1")}{" "}
          <a
            href={GRAPH_EXPLORER_URL}
            target="_blank"
            rel="noreferrer"
            className="underline [text-underline-position:from-font] hover:text-default-900"
          >
            {t("scout.graphLink")}
          </a>
        </>
      ),
    },
    {
      image: "/scout-steps/step-2.png",
      copy: SEND_MAIL_URL,
      body: (
        <>
          {t("scout.guideStep2a")} <b className="font-semibold">POST</b>{" "}
          {t("scout.guideStep2b")}
        </>
      ),
    },
    {
      image: "/scout-steps/step-3.png",
      body: (
        <>
          {t("scout.guideStep3a")} <b className="font-semibold">Run Query</b>
          {t("scout.guideStep3b")}{" "}
          <b className="font-semibold">Modify Permissions</b>{" "}
          {t("scout.guideStep3c")} <b className="font-semibold">Consent</b>{" "}
          {t("scout.guideStep3d")}
        </>
      ),
    },
    {
      image: "/scout-steps/step-4.png",
      body: (
        <>
          {t("scout.guideStep4a")} <b className="font-semibold">VNG Meet</b>{" "}
          {t("scout.guideStep4b")}{" "}
          <b className="font-semibold">{t("scout.guideStep4Bold")}</b>
          {t("scout.guideStep4c")}
        </>
      ),
    },
  ];
}

function GuideArrow({
  direction,
  disabled,
  onPress,
}: {
  direction: "left" | "right";
  disabled: boolean;
  onPress: () => void;
}) {
  const t = useT();
  const Icon = direction === "left" ? ChevronLeft : ChevronRight;
  return (
    <Button
      isIconOnly
      variant="secondary"
      className="rounded-full"
      aria-label={direction === "left" ? t("scout.guidePrevStep") : t("scout.guideNextStep")}
      isDisabled={disabled}
      onPress={onPress}
    >
      <Icon width={16} height={16} />
    </Button>
  );
}

function StepCopyButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.danger(t("scout.copyFailed"));
    }
  };

  return (
    <button
      type="button"
      aria-label={copied ? t("scout.copied") : t("scout.copyLink")}
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
  const t = useT();
  const GUIDE_STEPS = buildGuideSteps(t);
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
        {t("scout.greeting", { name: userName || t("scout.greetingThere") })}
      </h1>
      <p className="mt-1.5 text-sm leading-5 text-default-500">
        {t("scout.guideSubtitle")}
      </p>

      <div className="mt-5 flex items-start gap-2 rounded-xl bg-[#fee7de] p-3 text-sm leading-6 text-[#535862] dark:bg-[#3B1202] dark:text-[#fee7de]">
        <CircleInfo className="mt-0.5 size-4 shrink-0 text-[#F05A22]" />
        <span>{t("scout.permissionInfo")}</span>
      </div>

      {/* Fixed-ratio frame so the height stays reserved while the next image
          loads — switching steps no longer collapses/jumps the layout. */}
      <div className="relative mt-5 aspect-[3372/1920] w-full overflow-hidden rounded-xl border border-default-200 bg-default-100">
        <img
          key={step.image}
          src={step.image}
          alt={t("scout.stepImageAlt", { current: stepIndex + 1, total })}
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
            {t("scout.stepBadge", { current: stepIndex + 1, total })}
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
  const t = useT();
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
    () => TIME_OPTIONS.slice(0, -1).map((tm) => ({ value: tm, label: tm })),
    [],
  );
  const endOptions = useMemo(() => {
    const after = startTime ? timeToMinutes(startTime) : -Infinity;
    return TIME_OPTIONS.filter((tm) => timeToMinutes(tm) > after).map((tm) => ({
      value: tm,
      label: tm,
    }));
  }, [startTime]);

  const submit = async () => {
    if (!office) {
      toast.warning(t("scout.chooseOffice"));
      return;
    }
    if (!startTime || !endTime) {
      toast.warning(t("scout.chooseRange"));
      return;
    }
    if (!duration) {
      toast.warning(t("scout.chooseDuration"));
      return;
    }
    if (!capacity) {
      toast.warning(t("scout.chooseCapacity"));
      return;
    }
    if (timeToMinutes(endTime) - timeToMinutes(startTime) < Number(duration)) {
      toast.warning(t("scout.rangeTooShort"));
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
      toast.success(t("scout.started"), {
        description: t("scout.startedDesc"),
      });
      await onCreated();
    } catch (e: any) {
      toast.danger(t("scout.startFailed"), { description: e.message });
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
        {t("scout.greeting", { name: userName || t("scout.greetingThere") })}
      </h1>
      <p className="mt-1.5 text-sm leading-5 text-default-500">{t("scout.subtitle")}</p>

      <div className="mt-6 grid gap-4">
        <SelectField
          label={t("scout.office")}
          placeholder={t("scout.selectOffice")}
          value={office}
          onChange={setOffice}
          options={officeOptions.map((o) => ({ value: o.value, label: o.label }))}
        />

        <div>
          <Label className="mb-1.5 block">{t("scout.scoutRange")}</Label>
          <div className="grid grid-cols-2 gap-4">
            <SelectField
              placeholder={t("scout.startTime")}
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
              placeholder={t("scout.endTime")}
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
              {t("scout.ignoreLunch")}
            </span>
          </Checkbox.Content>
        </Checkbox>

        <SelectField
          label={t("scout.duration")}
          placeholder={t("scout.selectDuration")}
          value={duration}
          onChange={setDuration}
          options={durationOptions(t)}
        />

        <SelectField
          label={t("scout.capacity")}
          placeholder={t("scout.selectCapacity")}
          value={capacity}
          onChange={setCapacity}
          options={capacityOptions(t)}
        />

        <div className="flex items-start gap-1.5 text-sm leading-5 text-default-500">
          <CircleInfo className="mt-0.5 size-4 shrink-0 text-[#F05A22]" />
          <span>{t("scout.sameDayNote")}</span>
        </div>

        <Button className="mt-2 w-full rounded-full" onPress={submit} isPending={saving}>
          {t("scout.start")}
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
  const t = useT();
  const [busy, setBusy] = useState<"cancel" | "found" | null>(null);

  // Random thumbnail that crossfades to another random one every 5s.
  const [pair, setPair] = useState<{ cur?: string; prev?: string }>(() => ({
    cur: pickRandom(thumbnails),
  }));
  useEffect(() => {
    if (thumbnails.length === 0) return;
    if (!pair.cur) setPair({ cur: pickRandom(thumbnails) });
    if (thumbnails.length < 2) return;
    const id = setInterval(() => {
      setPair((p) => ({ cur: pickRandom(thumbnails) ?? p.cur, prev: p.cur }));
    }, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thumbnails]);

  // Sequential blinking dots: "." → ".." → "..." → repeat.
  const [dots, setDots] = useState(1);
  useEffect(() => {
    const id = setInterval(() => setDots((d) => (d % 3) + 1), 450);
    return () => clearInterval(id);
  }, []);

  const stop = async (kind: "cancel" | "found") => {
    setBusy(kind);
    try {
      await api.stopRoomScout(scout.id, kind === "found" ? "success" : "canceled");
      if (kind === "found") {
        toast.success(t("scout.stopFound"), {
          description: t("scout.stopFoundDesc"),
        });
      } else {
        toast.success(t("scout.stopCancelled"));
      }
      await onChanged();
    } catch (e: any) {
      toast.danger(t("scout.stopFailed"), { description: e.message });
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
            alt={t("scout.scoutingAlt")}
            className="scout-thumb-fade absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary to-secondary text-2xl font-bold text-white">
            {t("scout.cardTitle")}
          </div>
        )}
      </div>

      <h1 className="mt-5 text-2xl font-bold text-default-900">
        {t("scout.scouting")}
        <span className="ml-0.5 inline-block w-6 text-left align-baseline">
          {".".repeat(dots)}
        </span>
      </h1>
      <p className="mt-1.5 text-sm leading-5 text-default-500">{t("scout.subtitle")}</p>

      <dl className="mt-5 grid gap-2.5 text-sm">
        <DetailRow label={t("scout.office")} value={scout.office || t("scout.allOffices")} />
        <DetailRow label={t("scout.duration")} value={durationLabel(t, scout.duration_minutes)} />
        <DetailRow
          label={t("scout.scoutRangeLabel")}
          value={
            scout.scout_start_time && scout.scout_end_time
              ? `${scout.scout_start_time} - ${scout.scout_end_time}`
              : "-"
          }
        />
        <DetailRow label={t("scout.capacity")} value={capacityLabel(t, scout.capacity_size)} />
        <DetailRow label={t("scout.lastChecked")} value={formatLastChecked(scout.last_checked_at)} />
      </dl>

      <div className="mt-4 flex items-start gap-1.5 text-sm leading-5 text-default-500">
        <CircleInfo className="mt-0.5 size-4 shrink-0 text-[#F05A22]" />
        <span>{t("scout.sameDayNote")}</span>
      </div>

      <div className="mt-5 flex items-center gap-2">
        <Button
          variant="tertiary"
          className="rounded-full"
          isPending={busy === "cancel"}
          isDisabled={busy === "found"}
          onPress={() => stop("cancel")}
        >
          {t("scout.cancelScouting")}
        </Button>
        <Button
          className="flex-1 rounded-full"
          isPending={busy === "found"}
          isDisabled={busy === "cancel"}
          onPress={() => stop("found")}
        >
          {t("scout.foundRoom")}
        </Button>
      </div>
    </div>
  );
}

function formatLastChecked(value: string | null | undefined): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString([], {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  });
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
