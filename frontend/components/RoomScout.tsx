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
  Calendar as CalendarIcon,
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

// Same-day scouting can only start within business hours. Future dates remain
// selectable after 18:00 because their scan windows have not started yet.
const SCOUT_CUTOFF_HOUR = 18;
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

// Default start = the nearest selectable slot at or after the current time.
// Falls back to the first slot when the current time is past business hours.
function defaultStartTime() {
  const options = TIME_OPTIONS.slice(0, -1);
  if (options.length === 0) return "";
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

  // When the signed-in token lacks Mail.Send we can't run a scout, so we guide
  // the user through granting the permission instead of showing the form.
  const showGuide = !loading && !activeScout && !canSendMail;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex min-h-full w-full flex-col items-center justify-center px-6 py-10">
        <div className={`w-full ${showGuide ? "max-w-[640px]" : "max-w-[480px]"}`}>
          {loading ? (
            <ScoutFormSkeleton />
          ) : activeScout ? (
            <ScoutingCard
              scout={activeScout}
              thumbnails={roomThumbnails}
              officeOptions={officeOptions}
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
        <Field labelWidth="w-20" />
        <Field labelWidth="w-24" />
        <div className="mt-2 h-10 w-full animate-pulse rounded-full bg-default" />
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
  const [scoutDate, setScoutDate] = useState(() => localDateAfter(0));
  const [startTime, setStartTime] = useState(() => defaultStartTime());
  const [endTime, setEndTime] = useState("");
  const [duration, setDuration] = useState("");
  const [capacities, setCapacities] = useState<CapacitySize[]>([]);
  const [ignoreLunch, setIgnoreLunch] = useState(false);
  const [saving, setSaving] = useState(false);
  // Re-evaluate the after-hours cutoff each minute so the form locks at 18:00.
  const [nowMs, setNowMs] = useState(() => Date.now());
  // The custom DatePicker trigger has no DateInput for react-aria to anchor the
  // popover against, so wire the trigger ref (matches BrowseRooms' date picker).
  const dateTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setOffice(userOffice || "");
  }, [userOffice]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const today = localDateAfter(0);
  const maxScoutDate = localDateAfter(SCOUT_MAX_ADVANCE_DAYS);
  const afterHours =
    scoutDate === today && new Date(nowMs).getHours() >= SCOUT_CUTOFF_HOUR;

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
    if (afterHours) {
      toast.warning(t("scout.afterHoursNote"));
      return;
    }
    setSaving(true);
    try {
      await api.createRoomScout({
        scout_date: scoutDate,
        duration_minutes: Number(duration),
        capacity_sizes: capacities,
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
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
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

        {afterHours && (
          <div className="flex items-center gap-2 rounded-xl bg-[#fee7de] p-3 text-sm leading-6 text-[#535862] dark:bg-[#3B1202] dark:text-[#fee7de]">
            <CircleInfo className="size-4 shrink-0 text-[#F05A22]" />
            <span>{t("scout.afterHoursNote")}</span>
          </div>
        )}

        <Button
          className="mt-2 w-full rounded-full"
          onPress={submit}
          isPending={saving}
          isDisabled={afterHours}
        >
          {t("scout.start")}
        </Button>
      </div>
    </div>
  );
}

function ScoutingCard({
  scout,
  thumbnails,
  officeOptions,
  onChanged,
}: {
  scout: RoomScoutRow;
  thumbnails: string[];
  officeOptions: UserProfileOption[];
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
        <DetailRow
            label={t("scout.office")}
            value={
              scout.office
                ? (officeOptions.find((o) => o.value === scout.office)?.label ?? scout.office)
                : t("scout.allOffices")
            }
          />
        <DetailRow label={t("scout.duration")} value={durationLabel(t, scout.duration_minutes)} />
        <DetailRow
          label={t("scout.date")}
          value={scout.scout_date ? formatDmy(scout.scout_date) : "-"}
        />
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

      <div className="mt-4 flex items-start gap-1.5 text-sm leading-5 text-default-500">
        <CircleInfo className="mt-0.5 size-4 shrink-0 text-[#F05A22]" />
        <span>{t("scout.endsAtMidnightNote")}</span>
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
