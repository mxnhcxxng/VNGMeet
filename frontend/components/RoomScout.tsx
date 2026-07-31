"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Button,
  Calendar,
  Checkbox,
  Chip,
  DatePicker,
  Label,
  ListBox,
  ListBoxItem,
  Select,
  Tag,
  TagGroup,
  toast,
} from "@heroui/react";
import { parseDate } from "@internationalized/date";
import { I18nProvider } from "react-aria-components";
import {
  Binoculars,
  Calendar as CalendarIcon,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleInfo,
  Copy,
  Pencil,
  Persons,
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
import { useTokenExpiry } from "./TokenExpiryProvider";

const SCOUT_MAX_ADVANCE_DAYS = 14;

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

function formatLocalDate(value: Date) {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");
}

function localDateAfter(days: number) {
  const value = new Date();
  value.setHours(12, 0, 0, 0);
  value.setDate(value.getDate() + days);
  return formatLocalDate(value);
}

function formatDmy(value: string) {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

// True for Saturday/Sunday. `iso` is a "YYYY-MM-DD" calendar date.
function isWeekendIso(iso: string) {
  const day = new Date(`${iso}T00:00:00`).getDay();
  return day === 0 || day === 6;
}

// Weekday header labels are short names; treat Sat/Sun (any of our locales) as
// weekend so they can be tinted like the day cells.
function isWeekendHeaderLabel(label: string) {
  return ["sat", "sun", "cn", "t7"].includes(
    label.trim().toLowerCase().slice(0, 3),
  );
}

// Business hours end at 18:00 (the last slot in TIME_OPTIONS). Opening the form
// after that leaves no bookable slot today, so create-mode defaults roll to the
// next day and start back at the first slot (09:00).
function isAfterBusinessHours() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() >= 18 * 60;
}

// Default scout date = today, or tomorrow when opened after business hours.
function defaultScoutDate() {
  return localDateAfter(isAfterBusinessHours() ? 1 : 0);
}

// Default start = the nearest selectable slot at or after the current time.
// After business hours the date rolls to tomorrow (see defaultScoutDate), so the
// fallback here is the first slot (09:00) — the start of that next day.
function defaultStartTime() {
  const options = TIME_OPTIONS.slice(0, -1);
  if (options.length === 0) return "";
  if (isAfterBusinessHours()) return options[0];
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return options.find((tm) => timeToMinutes(tm) >= nowMinutes) ?? options[0];
}

function durationLabel(t: TFunction, minutes: number) {
  const key = DURATION_KEY[String(minutes)];
  return key ? t(key) : t("scout.durFallback", { n: minutes });
}

function capacityLabel(t: TFunction, size?: CapacitySize | null) {
  if (!size) return t("scout.capAny");
  return CAPACITY_KEY[size] ? t(CAPACITY_KEY[size]) : size;
}

// People-count range shown on the success card's capacity chip. Matches
// BookingModal's CAPACITY_RANGE so the two surfaces read identically.
function capacityRange(size?: CapacitySize | null): string {
  if (size === "small") return "≤4";
  if (size === "medium") return "5-12";
  if (size === "large") return "13+";
  return "";
}

function pickRandom<T>(list: T[]): T | undefined {
  if (!list.length) return undefined;
  return list[Math.floor(Math.random() * list.length)];
}

// Module-level cache so switching tabs doesn't reload the scout screen every
// time. Survives remounts within a session; cleared on full reload. Call
// clearRoomScoutCache() on logout to drop another user's data.
let cachedScouts: RoomScoutRow[] | null = null;
let cachedCanSendMail = true;

export function clearRoomScoutCache() {
  cachedScouts = null;
  cachedCanSendMail = true;
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
  const [scouts, setScouts] = useState<RoomScoutRow[]>(cachedScouts ?? []);
  const [canSendMail, setCanSendMail] = useState(cachedCanSendMail);
  // Only show the skeleton on the very first load; once cached, a tab switch
  // renders the cached view instantly and revalidates silently in the background.
  const [loading, setLoading] = useState(cachedScouts === null);
  // When true, the active scout is shown in an editable form instead of the card.
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.roomScouts();
      cachedScouts = res.scouts;
      cachedCanSendMail = res.can_send_mail;
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

  // Stale-while-revalidate: render cached rows instantly (no skeleton) on a tab
  // switch, then refetch in the background so an expired/cancelled scout still
  // reconciles without a visible reload. The first ever load has no cache, so
  // `loading` starts true and the skeleton shows until this resolves.
  useEffect(() => {
    load();
  }, [load]);

  const activeScout = useMemo(
    () => scouts.find((s) => s.status === "active") ?? null,
    [scouts],
  );

  // Leave edit mode if the active scout disappears (e.g. it expired mid-edit).
  useEffect(() => {
    if (!activeScout && editing) setEditing(false);
  }, [activeScout, editing]);

  // A booked (success) scout that hasn't been dismissed and whose meeting day
  // hasn't passed yet — this drives the "we found a room" screen. Scouts are
  // ordered newest-first, so `find` returns the most recent qualifying one.
  const successScout = useMemo(() => {
    const today = localDateAfter(0);
    return (
      scouts.find(
        (s) =>
          s.status === "success" &&
          !s.acknowledged_at &&
          (s.scout_date ?? "") >= today,
      ) ?? null
    );
  }, [scouts]);

  // While a scout is actively hunting, the auto-booker runs every minute in the
  // background; poll so the tab flips to the success screen without a reload.
  useEffect(() => {
    if (!activeScout) return;
    const id = setInterval(() => {
      load();
    }, 20_000);
    return () => clearInterval(id);
  }, [activeScout, load]);

  // Auto-dismiss the success screen at midnight ending the meeting day.
  useEffect(() => {
    if (!successScout?.scout_date) return;
    const midnight = new Date(`${successScout.scout_date}T00:00:00`);
    midnight.setDate(midnight.getDate() + 1);
    const ms = midnight.getTime() - Date.now();
    if (ms <= 0) {
      load();
      return;
    }
    const id = setTimeout(() => load(), Math.min(ms, 2 ** 31 - 1));
    return () => clearTimeout(id);
  }, [successScout, load]);

  // Scout now auto-books instead of emailing, so Mail.Send is no longer required
  // and we don't gate the form on it. The `!canSendMail` term is kept (disabled by
  // the leading `false`) in case the email-notification path is re-enabled later.
  const showGuide = false && !loading && !activeScout && !canSendMail;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex min-h-full w-full flex-col items-center justify-center px-6 py-10">
        <div className={`w-full ${showGuide ? "max-w-[640px]" : "max-w-[480px]"}`}>
          {loading ? (
            <ScoutFormSkeleton />
          ) : activeScout ? (
            editing ? (
              <ScoutForm
                mode="edit"
                scout={activeScout}
                userName={userName}
                userOffice={userOffice}
                onSaved={async () => {
                  setEditing(false);
                  await load();
                }}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <ScoutingCard
                scout={activeScout}
                thumbnails={roomThumbnails}
                officeOptions={officeOptions}
                onChanged={load}
                onEdit={() => setEditing(true)}
              />
            )
          ) : successScout ? (
            <ScoutSuccessCard
              scout={successScout}
              thumbnails={roomThumbnails}
              onDismiss={load}
            />
          ) : showGuide ? (
            <ScoutPermissionGuide userName={userName} />
          ) : (
            <ScoutForm
              userName={userName}
              userOffice={userOffice}
              onSaved={load}
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
        <Binoculars className="size-7 text-[#F05A22]" />
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

// Loading placeholder for the scout screen. Mirrors ScoutForm's shape (the
// default state once loading settles) so the layout doesn't jump when the real
// form, scouting card, or permission guide takes over.
function ScoutFormSkeleton() {
  const Field = ({ labelWidth }: { labelWidth: string }) => (
    <div className="flex flex-col gap-1.5">
      <div className={`h-3 ${labelWidth} animate-pulse rounded-full bg-default`} />
      <div className="h-9 w-full animate-pulse rounded-field bg-default" />
    </div>
  );
  return (
    <div aria-hidden>
      <div className="mb-1 flex items-center gap-1.5">
        <div className="size-[34px] animate-pulse rounded-full bg-default" />
        <div className="size-7 animate-pulse rounded-full bg-default" />
      </div>
      <div className="mt-3 h-7 w-64 max-w-full animate-pulse rounded-full bg-default" />
      <div className="mt-2 h-4 w-80 max-w-full animate-pulse rounded-full bg-default" />

      <div className="mt-6 grid gap-4">
        <Field labelWidth="w-16" />
        <Field labelWidth="w-12" />
        <div>
          <div className="mb-1.5 h-3 w-28 animate-pulse rounded-full bg-default" />
          <div className="grid grid-cols-2 gap-4">
            <div className="h-9 w-full animate-pulse rounded-field bg-default" />
            <div className="h-9 w-full animate-pulse rounded-field bg-default" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="size-4 animate-pulse rounded bg-default" />
          <div className="h-3 w-44 animate-pulse rounded-full bg-default" />
        </div>
        <Field labelWidth="w-24" />
        <div className="mt-2 h-10 w-full animate-pulse rounded-full bg-default" />
      </div>
    </div>
  );
}

function ScoutForm({
  userName,
  userOffice,
  mode = "create",
  scout,
  onSaved,
  onCancel,
}: {
  userName?: string;
  userOffice?: string;
  mode?: "create" | "edit";
  scout?: RoomScoutRow;
  onSaved: () => void | Promise<void>;
  onCancel?: () => void;
}) {
  const t = useT();
  const { ensureTokenTime, autoRefresh } = useTokenExpiry();
  const isEdit = mode === "edit";
  // In edit mode every field is seeded from the existing scout; in create mode
  // office defaults to the user's profile office.
  const [office, setOffice] = useState(scout?.office || userOffice || "");
  const [scoutDate, setScoutDate] = useState(() => scout?.scout_date || defaultScoutDate());
  const [startTime, setStartTime] = useState(() => scout?.scout_start_time || defaultStartTime());
  const [endTime, setEndTime] = useState(scout?.scout_end_time || "");
  const [duration, setDuration] = useState(scout ? String(scout.duration_minutes) : "");
  const [capacities, setCapacities] = useState<CapacitySize[]>(
    scout?.capacity_sizes?.length
      ? scout.capacity_sizes
      : scout?.capacity_size
        ? [scout.capacity_size]
        : [],
  );
  const [ignoreLunch, setIgnoreLunch] = useState(Boolean(scout?.ignore_lunch_break));
  const [saving, setSaving] = useState(false);
  // The custom DatePicker trigger has no DateInput for react-aria to anchor the
  // popover against, so wire the trigger ref (matches BrowseRooms' date picker).
  const dateTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Only mirror the profile office in create mode; edit keeps the scout's value.
    if (!isEdit) setOffice(userOffice || "");
  }, [userOffice, isEdit]);

  const today = localDateAfter(0);
  const maxScoutDate = localDateAfter(SCOUT_MAX_ADVANCE_DAYS);

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

  // The lunch-break option is only meaningful when the chosen range actually
  // overlaps the 12:00-13:00 lunch window; otherwise it's hidden and reset.
  const crossesLunch = useMemo(() => {
    if (!startTime || !endTime) return false;
    return timeToMinutes(startTime) < 13 * 60 && timeToMinutes(endTime) > 12 * 60;
  }, [startTime, endTime]);

  // Auto-check the option as soon as the range crosses lunch (and clear it when
  // it no longer does). Skip the initial run so the seeded value (create: false;
  // edit: the scout's stored choice) is preserved until the user changes the range.
  const lunchFirstRun = useRef(true);
  useEffect(() => {
    if (lunchFirstRun.current) {
      lunchFirstRun.current = false;
      return;
    }
    setIgnoreLunch(crossesLunch);
  }, [crossesLunch]);

  const submit = async () => {
    if (!office) {
      toast.warning(t("scout.chooseOffice"));
      return;
    }
    if (!scoutDate || scoutDate < today || scoutDate > maxScoutDate) {
      toast.warning(t("scout.chooseDate"));
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
    if (capacities.length === 0) {
      toast.warning(t("scout.chooseCapacity"));
      return;
    }
    if (timeToMinutes(endTime) - timeToMinutes(startTime) < Number(duration)) {
      toast.warning(t("scout.rangeTooShort"));
      return;
    }
    // The backend keeps the scout alive until its `expires_at`: the scout's
    // end-time when scouting today, otherwise midnight after today (start of
    // tomorrow) — mirroring create_room_scout. Block if the token won't survive
    // that long so the scout can actually book before it lapses.
    const scoutExpiry =
      scoutDate === today
        ? new Date(`${scoutDate}T${endTime}:00`)
        : (() => {
            const midnight = new Date();
            midnight.setHours(0, 0, 0, 0);
            midnight.setDate(midnight.getDate() + 1);
            return midnight;
          })();
    const neededSeconds = Math.max(
      0,
      Math.ceil((scoutExpiry.getTime() - Date.now()) / 1000),
    );
    if (!ensureTokenTime(neededSeconds)) return;
    const payload = {
      scout_date: scoutDate,
      duration_minutes: Number(duration),
      capacity_sizes: capacities,
      scout_start_time: startTime,
      scout_end_time: endTime,
      ignore_lunch_break: ignoreLunch,
      office: office || null,
    };
    setSaving(true);
    try {
      if (isEdit && scout) {
        await api.updateRoomScout(scout.id, payload);
        toast.success(t("scout.updated"), { description: t("scout.updatedDesc") });
      } else {
        await api.createRoomScout(payload);
        toast.success(t("scout.started"), { description: t("scout.startedDesc") });
      }
      await onSaved();
    } catch (e: any) {
      toast.danger(isEdit ? t("scout.updateFailed") : t("scout.startFailed"), {
        description: e.message,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <BrandIcon size={34} />
        <Binoculars className="size-7 text-[#F05A22]" />
      </div>
      <h1 className="mt-3 text-2xl font-bold text-default-900">
        {isEdit
          ? t("scout.editTitle")
          : t("scout.greeting", { name: userName || t("scout.greetingThere") })}
      </h1>
      <p className="mt-1.5 text-sm leading-5 text-default-500">{t("scout.subtitle")}</p>

      <div className="mt-6 grid gap-4">
        <I18nProvider locale="en-GB">
          <div className="flex flex-col gap-1.5">
            <Label>{t("scout.date")}</Label>
            <DatePicker
              aria-label={t("scout.date")}
              value={parseDate(scoutDate)}
              minValue={parseDate(today)}
              maxValue={parseDate(maxScoutDate)}
              onChange={(value) => {
                if (value) setScoutDate(value.toString());
              }}
            >
              <DatePicker.Trigger
                ref={dateTriggerRef}
                className="flex min-h-9 w-full items-center gap-2 rounded-field bg-[var(--default)] px-3 py-2 text-sm font-medium text-[var(--foreground)] outline-none transition-colors hover:bg-[var(--default-hover)]"
              >
                <CalendarIcon width={16} height={16} className="shrink-0 text-default-500" />
                <span className="flex-1 text-left">{formatDmy(scoutDate)}</span>
              </DatePicker.Trigger>
              <DatePicker.Popover triggerRef={dateTriggerRef} placement="bottom start" className="!max-w-none !min-w-fit w-fit">
                <Calendar
                  firstDayOfWeek="mon"
                  minValue={parseDate(today)}
                  maxValue={parseDate(maxScoutDate)}
                >
                  <Calendar.Header>
                    <Calendar.Heading className="text-left first-letter:uppercase" />
                    <div className="flex items-center gap-1">
                      <Calendar.NavButton slot="previous" />
                      <Calendar.NavButton slot="next" />
                    </div>
                  </Calendar.Header>
                  <Calendar.Grid>
                    <Calendar.GridHeader>
                      {(day) => (
                        <Calendar.HeaderCell
                          className={isWeekendHeaderLabel(day) ? "text-danger" : undefined}
                        >
                          {day}
                        </Calendar.HeaderCell>
                      )}
                    </Calendar.GridHeader>
                    <Calendar.GridBody>
                      {(date) => (
                        <Calendar.Cell date={date}>
                          {({ formattedDate, isSelected, isDisabled }) => (
                            <span
                              className={
                                isWeekendIso(date.toString()) && !isSelected && !isDisabled
                                  ? "text-danger"
                                  : undefined
                              }
                            >
                              {formattedDate}
                            </span>
                          )}
                        </Calendar.Cell>
                      )}
                    </Calendar.GridBody>
                  </Calendar.Grid>
                </Calendar>
              </DatePicker.Popover>
            </DatePicker>
          </div>
        </I18nProvider>

        <SelectField
          label={t("scout.duration")}
          placeholder={t("scout.selectDuration")}
          value={duration}
          onChange={setDuration}
          options={durationOptions(t)}
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
          <p className="mt-1.5 text-xs leading-5 text-default-400">
            {t("scout.scoutRangeHint")}
          </p>

          {crossesLunch && (
            <div className="scout-lunch-reveal mt-1.5">
              <Checkbox
                variant="secondary"
                isSelected={ignoreLunch}
                onChange={setIgnoreLunch}
              >
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <span className="text-sm font-medium text-default-700">
                    {t("scout.ignoreLunch")}
                  </span>
                </Checkbox.Content>
              </Checkbox>
            </div>
          )}
        </div>

        <Select<{ value: CapacitySize; label: string }, "multiple">
          variant="secondary"
          fullWidth
          className="flex flex-col gap-1.5"
          placeholder={t("scout.selectCapacity")}
          selectionMode="multiple"
          value={capacities}
          onChange={(keys) =>
            setCapacities(keys.map(String) as CapacitySize[])
          }
        >
          <Label>{t("scout.capacity")}</Label>
          <Select.Trigger>
            <Select.Value>
              {({ defaultChildren, isPlaceholder }) => {
                if (isPlaceholder || capacities.length === 0) {
                  return defaultChildren;
                }
                return (
                  <TagGroup
                    size="sm"
                    variant="surface"
                    onRemove={(keys) =>
                      setCapacities((current) =>
                        current.filter((item) => !keys.has(item)),
                      )
                    }
                  >
                    <TagGroup.List>
                      {capacities.map((size) => {
                        return (
                          <Tag key={size} id={size}>
                            {capacityLabel(t, size)}
                          </Tag>
                        );
                      })}
                    </TagGroup.List>
                  </TagGroup>
                );
              }}
            </Select.Value>
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover className="w-[var(--trigger-width)]">
            <ListBox>
              {capacityOptions(t).map((item) => (
                <ListBoxItem
                  key={item.value}
                  id={item.value}
                  textValue={item.label}
                >
                  {item.label}
                  <ListBoxItem.Indicator />
                </ListBoxItem>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>

        {/* The auto-stop-at-midnight caveat is a manual-token limitation only.
            Auto-refreshing (direct Microsoft) sessions instead run until the last
            duration-fitting slot, so the note is hidden for them. Otherwise it
            only matters when scouting a day other than today. Mirrors the same
            note on the active ScoutingCard. */}
        {!autoRefresh && scoutDate !== today && (
          <div className="flex items-start gap-2 rounded-xl bg-[#fff4ef] p-3 text-sm leading-5 text-[#535862] dark:bg-[#3B1202] dark:text-[#fee7de]">
            <CircleInfo className="mt-0.5 size-4 shrink-0 text-[#F05A22]" />
            <span>{t("scout.endsAtMidnightNote")}</span>
          </div>
        )}

        {isEdit ? (
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="tertiary"
              className="flex-1 rounded-full"
              isDisabled={saving}
              onPress={() => onCancel?.()}
            >
              {t("scout.cancelEdit")}
            </Button>
            <Button
              className="flex-1 rounded-full"
              onPress={submit}
              isPending={saving}
            >
              {t("scout.update")}
            </Button>
          </div>
        ) : (
          <Button
            className="mt-2 w-full rounded-full"
            onPress={submit}
            isPending={saving}
          >
            {t("scout.start")}
          </Button>
        )}
      </div>
    </div>
  );
}

function ScoutingCard({
  scout,
  thumbnails,
  officeOptions,
  onChanged,
  onEdit,
}: {
  scout: RoomScoutRow;
  thumbnails: string[];
  officeOptions: UserProfileOption[];
  onChanged: () => void | Promise<void>;
  onEdit?: () => void;
}) {
  const t = useT();
  const { autoRefresh } = useTokenExpiry();
  const [busy, setBusy] = useState<"cancel" | null>(null);
  // The auto-stop-at-midnight caveat is a manual-token limitation and only matters
  // when scouting a day other than today. Auto-refreshing (direct Microsoft)
  // sessions run until the last duration-fitting slot, so it's hidden for them.
  const differentDay = Boolean(scout.scout_date) && scout.scout_date !== localDateAfter(0);

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

  const stop = async (kind: "cancel") => {
    setBusy(kind);
    try {
      await api.stopRoomScout(scout.id, "canceled");
      toast.success(t("scout.stopCancelled"));
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

      <div className="mt-5 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-default-900">
          {t("scout.scouting")}
          <span className="ml-0.5 inline-block w-6 text-left align-baseline">
            {".".repeat(dots)}
          </span>
        </h1>
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0 gap-1.5 rounded-full text-[#F05A22]"
          isDisabled={!!busy}
          onPress={() => onEdit?.()}
        >
          <Pencil width={14} height={14} />
          {t("scout.edit")}
        </Button>
      </div>
      <p className="mt-1.5 text-sm leading-5 text-default-500">{t("scout.scoutingSubtitle")}</p>

      <dl className="mt-5 grid gap-2.5 text-sm">
        <DetailRow
            label={t("scout.office")}
            value={
              scout.office
                ? (officeOptions.find((o) => o.value === scout.office)?.label ?? scout.office)
                : t("scout.allOffices")
            }
          />
        <DetailRow
          label={t("scout.date")}
          value={scout.scout_date ? formatDmy(scout.scout_date) : "-"}
        />
        <DetailRow label={t("scout.duration")} value={durationLabel(t, scout.duration_minutes)} />
        <DetailRow
          label={t("scout.scoutRangeLabel")}
          value={
            scout.scout_start_time && scout.scout_end_time
              ? `${scout.scout_start_time} - ${scout.scout_end_time}`
              : "-"
          }
        />
        <DetailRow
          label={t("scout.capacity")}
          value={(scout.capacity_sizes?.length
            ? scout.capacity_sizes
            : scout.capacity_size
              ? [scout.capacity_size]
              : []
          ).map((size) => capacityLabel(t, size)).join(", ") || t("scout.capAny")}
        />
        <DetailRow label={t("scout.lastChecked")} value={formatLastChecked(scout.last_checked_at)} />
      </dl>

      {!autoRefresh && differentDay && (
        <div className="mt-4 flex items-start gap-2 rounded-xl bg-[#fff4ef] p-3 text-sm leading-5 text-[#535862] dark:bg-[#3B1202] dark:text-[#fee7de]">
          <CircleInfo className="mt-0.5 size-4 shrink-0 text-[#F05A22]" />
          <span>{t("scout.endsAtMidnightNote")}</span>
        </div>
      )}

      <div className="mt-5">
        <Button
          variant="tertiary"
          className="w-full rounded-full"
          isPending={busy === "cancel"}
          onPress={() => stop("cancel")}
        >
          {t("scout.cancelScouting")}
        </Button>
      </div>
    </div>
  );
}

// Shown when a scout auto-books a room. Persists until the user taps "Great"
// (acknowledge) or midnight of the meeting day, per the Room Scout spec.
function ScoutSuccessCard({
  scout,
  thumbnails,
  onDismiss,
}: {
  scout: RoomScoutRow;
  thumbnails: string[];
  onDismiss: () => void | Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const room = scout.booked_room ?? null;
  // Prefer the booked room's own thumbnail; fall back to a random one (stable
  // across re-renders so tapping "Great" doesn't reshuffle the image).
  const [bg] = useState(
    () => room?.thumbnail_link || pickRandom(thumbnails) || "/default-room-thumbnail.png",
  );
  const roomName = room?.name || scout.booked_room_email || t("scout.cardTitle");
  const email = room?.email || scout.booked_room_email || "";
  const time =
    scout.booked_start_time && scout.booked_end_time
      ? `${scout.booked_start_time} - ${scout.booked_end_time}`
      : "";
  const zoneText = [room?.building, room?.zone]
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .join(" ");

  // Same chip system as the booking modal's banner: capacity is the primary
  // (orange) accent chip, floor/venue are secondary. Each drops when absent.
  const chips = [
    room?.capacity_size
      ? {
          label: capacityRange(room.capacity_size),
          variant: "primary" as const,
          icon: <Persons width={14} height={14} />,
        }
      : null,
    room?.floor
      ? {
          label: t("booking.floor", { floor: String(room.floor) }),
          variant: "secondary" as const,
          icon: null as ReactNode,
        }
      : null,
    zoneText
      ? { label: zoneText, variant: "secondary" as const, icon: null as ReactNode }
      : null,
  ].filter(Boolean) as {
    label: string;
    variant: "primary" | "secondary";
    icon: ReactNode;
  }[];

  const dismiss = async () => {
    setBusy(true);
    try {
      // Acknowledge every pending success scout, not just the one shown: several
      // auto-books can pile up unacknowledged while the UI only ever surfaces the
      // newest, so a single "Great" clears them all instead of revealing the next.
      await api.acknowledgeAllRoomScouts();
      await onDismiss();
    } catch (e: any) {
      toast.danger(t("scout.acknowledgeFailed"), { description: e.message });
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Card: 480×600 mockup — image + dark gradients, heading top, room bottom. */}
      <div className="relative h-[600px] w-full overflow-hidden rounded-2xl bg-default-100">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={bg} alt={roomName} className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent from-50% to-black/90" />

        {/* Heading (top), over its own dark-to-transparent gradient. */}
        <div className="absolute inset-x-0 top-0 flex flex-col gap-1 bg-gradient-to-b from-black/80 to-transparent p-6 text-white">
          <p className="whitespace-pre-line text-2xl font-bold leading-8">
            {t("scout.foundHeading")}
          </p>
          <p className="text-base leading-6">{t("scout.foundSubtitle")}</p>
        </div>

        {/* Room details (bottom), centered like the booking modal banner. */}
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 p-6">
          <div className="w-full text-center text-white">
            <p className="text-xl font-bold leading-8">
              {roomName}
              {time && <span> • {time}</span>}
            </p>
            {email && <p className="text-sm font-medium leading-5">{email}</p>}
          </div>
          {chips.length > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-1">
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

      <Button className="w-full rounded-full" onPress={dismiss} isPending={busy}>
        {t("scout.great")}
      </Button>
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
