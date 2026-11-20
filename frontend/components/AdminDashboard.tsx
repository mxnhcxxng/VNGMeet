"use client";

// Admin dashboard (/admin). Data comes from backend/app/admin.py; this file only
// lays it out. Charts are hand-rolled SVG/CSS (no chart library in the app):
// fixed categorical slots for booking types (above the axis) and for who
// cancelled (below it), and status colors only for health — each with an
// icon/label, never color alone.

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Button,
  Chip,
  DateRangePicker,
  ListBox,
  ListBoxItem,
  RangeCalendar,
  Select,
  Spinner,
  Tabs,
} from "@heroui/react";
import { parseDate } from "@internationalized/date";
import { I18nProvider } from "react-aria-components";
import {
  ArrowsRotateRight,
  Calendar as CalendarIcon,
  CircleCheckFill,
  CircleExclamationFill,
  TriangleExclamationFill,
} from "@gravity-ui/icons";
import {
  api,
  type AdminActivityRow,
  type AdminBookingType,
  type AdminCancelKind,
  type AdminKpi,
  type AdminLevel,
  type AdminOverview,
  type AdminGranularity,
  type AdminWeekday,
} from "@/lib/api";
import { BrandIcon } from "@/components/BrandIcon";
import { useLanguage, useT } from "@/app/providers";
import type { TFunction, TranslationKey } from "@/lib/i18n";

const TEXT = "text-[#181d27] dark:text-[#f7f7f7]";
const MUTED = "text-[#71717a] dark:text-[#94979c]";
const CARD = "rounded-2xl bg-white p-4 shadow-sm dark:bg-[#13161b]";

const TYPES: AdminBookingType[] = ["instant", "scheduled", "scout"];
const TYPE_COLOR: Record<AdminBookingType, string> = {
  instant: "var(--viz-s1)",
  scheduled: "var(--viz-s2)",
  scout: "var(--viz-s3)",
};
const CANCEL_KINDS: AdminCancelKind[] = ["user", "outlook", "auto", "unknown"];
const CANCEL_COLOR: Record<AdminCancelKind, string> = {
  user: "var(--viz-c-user)",
  outlook: "var(--viz-c-outlook)",
  auto: "var(--viz-c-auto)",
  unknown: "var(--viz-c-unknown)",
};

// Validated reference palette: categorical slots 1–3 for booking types, slots
// 4/5/7 for who cancelled (validated as their own adjacent stack, both modes;
// light mode sits under 3:1 so every value is also in tooltips and the outcome
// list), a neutral gray for "unknown", and the fixed status colors.
const VIZ_STYLE = `
.admin-viz {
  --viz-s1: #2a78d6; --viz-s2: #eb6834; --viz-s3: #1baf7a;
  --viz-c-user: #eda100; --viz-c-outlook: #e87ba4; --viz-c-auto: #6250d6; --viz-c-unknown: #a4a7ae; --viz-declined: #e34948;
  --viz-grid: #e9e9eb; --viz-axis: #a4a7ae; --viz-track: #f0efec; --viz-surface: #ffffff;
  --viz-good: #0ca30c; --viz-warning: #fab219; --viz-critical: #d03b3b;
}
html.dark .admin-viz {
  --viz-s1: #3987e5; --viz-s2: #d95926; --viz-s3: #199e70;
  --viz-c-user: #c98500; --viz-c-outlook: #d55181; --viz-c-auto: #9085e9; --viz-c-unknown: #5d6068; --viz-declined: #e66767;
  --viz-grid: #2a2f38; --viz-axis: #5d6068; --viz-track: #22262f; --viz-surface: #13161b;
}`;

// --------------------------------------------------------------------------- //
// Formatting
// --------------------------------------------------------------------------- //
function pct(value: number | null | undefined, digits = 0): string {
  return value == null ? "—" : `${(value * 100).toFixed(digits)}%`;
}

function useFormat() {
  const { language } = useLanguage();
  const locale = language === "vi" ? "vi-VN" : "en-GB";
  return useMemo(
    () => ({
      num: (n: number) => n.toLocaleString(locale),
      day: (iso: string) =>
        new Date(`${iso}T00:00:00`).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" }),
      dayYear: (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`,
      // "05/2026" in both languages (vi-VN would spell it "tháng 05, 2026").
      month: (iso: string) => `${iso.slice(5, 7)}/${iso.slice(0, 4)}`,
      dateTime: (iso: string | null) =>
        iso
          ? new Date(iso).toLocaleString(locale, {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "—",
      time: (iso: string) => new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
    }),
    [locale],
  );
}

// --------------------------------------------------------------------------- //
// Hover tooltip — one per page, follows the pointer.
// --------------------------------------------------------------------------- //
type Tip = { x: number; y: number; content: ReactNode } | null;

function useTip() {
  const [tip, setTip] = useState<Tip>(null);
  const show = useCallback(
    (e: React.PointerEvent | React.MouseEvent, content: ReactNode) =>
      setTip({ x: e.clientX, y: e.clientY, content }),
    [],
  );
  const hide = useCallback(() => setTip(null), []);
  return { tip, show, hide };
}
type TipApi = ReturnType<typeof useTip>;

function TipLayer({ tip }: { tip: Tip }) {
  if (!tip) return null;
  const flip = typeof window !== "undefined" && tip.x > window.innerWidth - 240;
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-[200] max-w-[240px] rounded-lg border border-[color:var(--separator)] bg-white px-3 py-2 text-xs shadow-lg dark:bg-[#1a1d23]"
      style={{
        left: flip ? undefined : tip.x + 12,
        right: flip ? window.innerWidth - tip.x + 12 : undefined,
        top: tip.y + 12,
      }}
    >
      {tip.content}
    </div>
  );
}

function TipRow({ color, label, value }: { color?: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className={`flex items-center gap-1.5 ${MUTED}`}>
        {color && <span className="inline-block size-2 rounded-full" style={{ background: color }} />}
        {label}
      </span>
      <span className={`font-medium tabular-nums ${TEXT}`}>{value}</span>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Building blocks
// --------------------------------------------------------------------------- //
function Section({
  title,
  hint,
  action,
  badge,
  children,
  className = "",
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  /** Scope that differs from the page's period, e.g. "Right now". */
  badge?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`${CARD} flex min-w-0 flex-col gap-4 ${className}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className={`flex flex-wrap items-center gap-2 text-base font-semibold ${TEXT}`}>
            {title}
            {badge && <Badge>{badge}</Badge>}
          </h2>
          {hint && <p className={`mt-0.5 text-xs ${MUTED}`}>{hint}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function Empty({ t }: { t: TFunction }) {
  return <p className={`py-6 text-center text-sm ${MUTED}`}>{t("admin.empty")}</p>;
}

function Legend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <ul className={`flex flex-wrap gap-x-4 gap-y-1 text-xs ${MUTED}`}>
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

const LEVEL_ICON = {
  ok: CircleCheckFill,
  warn: TriangleExclamationFill,
  down: CircleExclamationFill,
} as const;
const LEVEL_COLOR: Record<AdminLevel, string> = {
  ok: "var(--viz-good)",
  warn: "var(--viz-warning)",
  down: "var(--viz-critical)",
};

function HealthCard({ t, title, level, detail }: { t: TFunction; title: string; level: AdminLevel; detail: string }) {
  const Icon = LEVEL_ICON[level];
  return (
    <div className={`${CARD} flex flex-col gap-2`}>
      <span className={`text-sm ${MUTED}`}>{title}</span>
      <span className={`flex items-center gap-1.5 text-base font-semibold ${TEXT}`}>
        <Icon width={16} height={16} style={{ color: LEVEL_COLOR[level] }} aria-hidden />
        {t(`admin.level.${level}` as TranslationKey)}
      </span>
      <span className={`text-xs ${MUTED}`}>{detail}</span>
    </div>
  );
}

/** Sparkline, one point per bucket of the period; nulls (no data) break the
 *  line. When the period reaches today the last bucket is still filling up, so
 *  it's drawn dashed with a hollow marker. */
function Sparkline({
  series,
  buckets,
  lastPartial,
  format,
  tip,
  bucketTitle,
}: {
  series: (number | null)[];
  buckets: string[];
  lastPartial: boolean;
  format: (v: number) => string;
  tip: TipApi;
  bucketTitle: (iso: string) => string;
}) {
  const W = 120;
  const H = 32;
  const values = series.filter((v): v is number => v != null);
  if (series.length < 2 || !values.length) return <div style={{ height: H }} />;
  const max = Math.max(...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const step = W / Math.max(series.length - 1, 1);
  const pts = series.map((v, i) => (v == null ? null : [i * step, H - 3 - ((v - min) / span) * (H - 6)]));
  const solid = lastPartial ? pts.slice(0, -1) : pts;
  const segments: string[] = [];
  let current = "";
  solid.forEach((p) => {
    if (!p) {
      if (current) segments.push(current);
      current = "";
      return;
    }
    current += `${current ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  });
  if (current) segments.push(current);
  const last = pts[pts.length - 1];
  const beforeLast = pts[pts.length - 2];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="overflow-visible" aria-hidden>
      {segments.map((d) => (
        <path key={d} d={d} fill="none" stroke="var(--viz-s1)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {lastPartial && last && beforeLast && (
        <path
          d={`M${beforeLast[0]},${beforeLast[1]}L${last[0]},${last[1]}`}
          fill="none"
          stroke="var(--viz-s1)"
          strokeWidth={2}
          strokeDasharray="3 3"
        />
      )}
      {last && (
        <circle
          cx={last[0]}
          cy={last[1]}
          r={3}
          fill={lastPartial ? "var(--viz-surface)" : "var(--viz-s1)"}
          stroke="var(--viz-s1)"
          strokeWidth={2}
        />
      )}
      {series.map((v, i) => (
        <rect
          key={buckets[i]}
          x={i * step - step / 2}
          y={0}
          width={step}
          height={H}
          fill="transparent"
          onPointerMove={(e) => tip.show(e, <TipRow label={bucketTitle(buckets[i])} value={v == null ? "—" : format(v)} />)}
          onPointerLeave={tip.hide}
        />
      ))}
    </svg>
  );
}

function KpiTile({
  t,
  label,
  kpi,
  format,
  buckets,
  lastPartial,
  granLabel,
  bucketTitle,
  compareTitle,
  tip,
}: {
  t: TFunction;
  label: string;
  kpi: AdminKpi;
  /** Tooltip naming both periods' dates, e.g. "14/11 – 20/11 vs 07/11 – 13/11". */
  compareTitle: string;
  format: (v: number) => string;
  buckets: string[];
  lastPartial: boolean;
  granLabel: string;
  bucketTitle: (iso: string) => string;
  tip: TipApi;
}) {
  const delta = kpi.value != null && kpi.prev != null ? kpi.value - kpi.prev : null;
  return (
    <div className={`${CARD} flex flex-col gap-3`}>
      <span className={`text-sm ${MUTED}`}>{label}</span>
      <div className="flex items-end justify-between gap-3">
        <span className={`text-2xl font-semibold tabular-nums ${TEXT}`}>{kpi.value == null ? "—" : format(kpi.value)}</span>
        <Sparkline
          series={kpi.series}
          buckets={buckets}
          lastPartial={lastPartial}
          format={format}
          tip={tip}
          bucketTitle={bucketTitle}
        />
      </div>
      <div className={`flex justify-between gap-3 text-xs tabular-nums ${MUTED}`}>
        <span title={compareTitle} className="cursor-help">
          {delta != null && (
            <>
              {delta > 0 ? "▲" : delta < 0 ? "▼" : "•"} {format(Math.abs(delta))} {t("admin.kpi.vsPrevPeriod")}
            </>
          )}
        </span>
        <span className="shrink-0 text-[10px]">{t("admin.kpi.by", { gran: granLabel.toLowerCase() })}</span>
      </div>
    </div>
  );
}

type BarSeries = { key: string; label: string; color: string };
type DivergingColumn = {
  key: string;
  /** Axis label under the column. */
  label: string;
  /** Tooltip heading. */
  title: string;
  up: Record<string, number>;
  down: Record<string, number>;
};

/** Stacked columns around a zero line: `up` series grow above it, `down`
 *  series (cancellations) below it, both on one scale. Series stack outward in
 *  the order given; only the outermost segment gets the rounded end. */
function DivergingBars({
  data,
  up,
  down,
  t,
  tip,
}: {
  data: DivergingColumn[];
  up: BarSeries[];
  down: BarSeries[];
  t: TFunction;
  tip: TipApi;
}) {
  const sum = (values: Record<string, number>, series: BarSeries[]) =>
    series.reduce((total, s) => total + (values[s.key] ?? 0), 0);
  const maxUp = Math.max(0, ...data.map((d) => sum(d.up, up)));
  const maxDown = Math.max(0, ...data.map((d) => sum(d.down, down)));
  if (!maxUp && !maxDown) return <Empty t={t} />;
  const scale = maxUp + maxDown;
  const upShare = (maxUp / scale) * 100;
  const labelEvery = Math.ceil(data.length / 8);

  const segments = (values: Record<string, number>, series: BarSeries[], dir: "up" | "down") => {
    const present = series.filter((s) => values[s.key]);
    return present.map((s, i) => {
      const outermost = i === present.length - 1;
      return (
        <div
          key={s.key}
          className="shrink-0"
          style={{
            height: `${(values[s.key] / (dir === "up" ? maxUp : maxDown)) * 100}%`,
            background: s.color,
            borderRadius: outermost ? (dir === "up" ? "4px 4px 0 0" : "0 0 4px 4px") : 0,
          }}
        />
      );
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {up.length + down.length > 1 && <Legend items={[...up, ...down].map((s) => ({ color: s.color, label: s.label }))} />}
      <div className="relative h-56 pr-8">
        {/* Axis labels: the largest stack on each side, and the zero line. */}
        {maxUp > 0 && (
          <span className={`absolute right-0 top-0 text-[10px] tabular-nums ${MUTED}`}>{maxUp}</span>
        )}
        {maxDown > 0 && (
          <span className={`absolute bottom-0 right-0 text-[10px] tabular-nums ${MUTED}`}>−{maxDown}</span>
        )}
        <span
          className={`absolute right-0 -translate-y-1/2 text-[10px] tabular-nums ${MUTED}`}
          style={{ top: `${upShare}%` }}
        >
          0
        </span>
        <div
          className="absolute inset-x-0 border-t border-[color:var(--viz-axis)]"
          style={{ top: `${upShare}%`, right: "2rem" }}
        />
        <div className="flex h-full gap-[2px]">
          {data.map((d) => (
            <div
              key={d.key}
              className="flex h-full min-w-0 flex-1 cursor-default flex-col"
              onPointerMove={(e) =>
                tip.show(
                  e,
                  <div className="flex flex-col gap-1">
                    <span className={`font-medium ${TEXT}`}>{d.title}</span>
                    {up.map((s) => (
                      <TipRow key={s.key} color={s.color} label={s.label} value={String(d.up[s.key] ?? 0)} />
                    ))}
                    {down.length > 0 && <div className="my-0.5 border-t border-[color:var(--separator)]" />}
                    {down.map((s) => (
                      <TipRow key={s.key} color={s.color} label={s.label} value={String(d.down[s.key] ?? 0)} />
                    ))}
                  </div>,
                )
              }
              onPointerLeave={tip.hide}
            >
              <div className="flex flex-col-reverse gap-[2px] pb-px" style={{ height: `${upShare}%` }}>
                {maxUp > 0 && segments(d.up, up, "up")}
              </div>
              <div className="flex flex-col gap-[2px] pt-px" style={{ height: `${100 - upShare}%` }}>
                {maxDown > 0 && segments(d.down, down, "down")}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className={`flex h-3 gap-[2px] pr-8 text-[10px] ${MUTED}`}>
        {data.map((d, i) => (
          <span key={d.key} className="relative min-w-0 flex-1">
            {i % labelEvery === 0 && (
              <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap tabular-nums">{d.label}</span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

function BarList({ rows, max, color = "var(--viz-s1)", tip, label }: {
  rows: { key: string; label: string; sub?: string | null; value: number; display: string }[];
  max: number;
  color?: string;
  tip?: TipApi;
  label?: string;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li
          key={row.key}
          className="flex flex-col gap-1"
          onPointerMove={tip ? (e) => tip.show(e, <TipRow label={label ?? row.label} value={row.display} />) : undefined}
          onPointerLeave={tip?.hide}
        >
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className={`truncate ${TEXT}`}>
              {row.label}
              {row.sub && <span className={`ml-1.5 text-xs ${MUTED}`}>{row.sub}</span>}
            </span>
            <span className={`shrink-0 tabular-nums ${MUTED}`}>{row.display}</span>
          </div>
          <div className="h-1.5 rounded-full bg-[color:var(--viz-track)]">
            <div
              className="h-full rounded-full"
              style={{ width: `${max ? Math.max((row.value / max) * 100, row.value ? 2 : 0) : 0}%`, background: color }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`text-xs ${MUTED}`}>{label}</span>
      <span className={`text-xl font-semibold tabular-nums ${TEXT}`}>{value}</span>
      {hint && <span className={`text-[11px] ${MUTED}`}>{hint}</span>}
    </div>
  );
}

function ActivityTable({ rows, t, fmt }: { rows: AdminActivityRow[]; t: TFunction; fmt: ReturnType<typeof useFormat> }) {
  if (!rows.length) return <p className={`text-sm ${MUTED}`}>{t("admin.issues.none")}</p>;
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className={`text-xs ${MUTED}`}>
          <tr>
            {(["time", "user", "room", "slot", "type", "error"] as const).map((col) => (
              <th key={col} className="px-1 pb-2 font-medium">
                {t(`admin.col.${col}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={TEXT}>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-[color:var(--separator)] align-top">
              <td className="whitespace-nowrap px-1 py-2 tabular-nums">{fmt.dateTime(row.createdAt)}</td>
              <td className="px-1 py-2">{row.email?.split("@")[0] ?? "—"}</td>
              <td className="px-1 py-2">{row.room ?? "—"}</td>
              <td className="whitespace-nowrap px-1 py-2 tabular-nums">
                {row.date ? fmt.day(row.date) : "—"} {row.startTime ?? ""}
              </td>
              <td className={`whitespace-nowrap px-1 py-2 ${MUTED}`}>
                {row.bookingType ? t(`admin.type.${row.bookingType}` as TranslationKey) : "—"}
                {row.method === "chatbot" ? ` · ${t("admin.method.chatbot")}` : ""}
              </td>
              <td className={`px-1 py-2 text-xs ${MUTED}`}>{row.error ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Page
// --------------------------------------------------------------------------- //
type Phase = "loading" | "unauthenticated" | "forbidden" | "ready";

// --------------------------------------------------------------------------- //
// Period: one for the whole page, compared with the equally long one before it.
// --------------------------------------------------------------------------- //
const PRESETS = ["today", "7d", "30d", "thisMonth", "lastMonth", "3m", "12m", "custom"] as const;
type Preset = (typeof PRESETS)[number];
type Period = { from: string; to: string };
const GRANULARITIES: AdminGranularity[] = ["hour", "day", "week", "month", "year"];
const MAX_PERIOD_DAYS = 731;

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shiftDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

function shiftMonths(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return isoDay(d);
}

function presetPeriod(preset: Exclude<Preset, "custom">, today: string): Period {
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: shiftDays(today, -6), to: today };
    case "30d":
      return { from: shiftDays(today, -29), to: today };
    case "thisMonth":
      return { from: `${today.slice(0, 8)}01`, to: today };
    case "lastMonth": {
      const first = shiftMonths(`${today.slice(0, 8)}01`, -1);
      return { from: first, to: shiftDays(`${today.slice(0, 8)}01`, -1) };
    }
    case "3m":
      return { from: shiftDays(shiftMonths(today, -3), 1), to: today };
    case "12m":
      return { from: shiftDays(shiftMonths(today, -12), 1), to: today };
  }
}

function spanDays({ from, to }: Period): number {
  return Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000) + 1;
}

/** Mirrors backend `allowed_granularities` / `default_granularity`. */
function allowedGranularities(span: number): AdminGranularity[] {
  const out = GRANULARITIES.filter(
    (g) =>
      (g === "hour" && span <= 3) ||
      (g === "day" && span <= 92) ||
      (g === "week" && span >= 14) ||
      (g === "month" && span >= 60) ||
      (g === "year" && span >= 365),
  );
  return out.length ? out : ["day"];
}

function defaultGranularity(span: number): AdminGranularity {
  if (span === 1) return "hour";
  return span <= 31 ? "day" : span <= 92 ? "week" : "month";
}

// --------------------------------------------------------------------------- //
// Sub-tabs, mirrored into /dashboard/<tab> so a tab can be linked.
// --------------------------------------------------------------------------- //
const TABS = ["overview", "bookings", "users", "chat", "scout", "issues"] as const;
type DashTab = (typeof TABS)[number];

function tabFromPath(pathname: string): DashTab {
  const segment = pathname.split("/").filter(Boolean)[1];
  return (TABS as readonly string[]).includes(segment ?? "") ? (segment as DashTab) : "overview";
}

/** Labelled dropdown, same shape as Booking History's filters. */
function FilterSelect<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className={`whitespace-nowrap text-sm ${MUTED}`}>{label}</span>
      <Select aria-label={label} variant="secondary" selectedKey={value} onSelectionChange={(k) => onChange(String(k) as T)}>
        <Select.Trigger className="min-w-[140px]">
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {options.map((o) => (
              <ListBoxItem key={o.value} id={o.value}>
                {o.label}
              </ListBoxItem>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
    </div>
  );
}

/** Custom period: HeroUI range picker with the app's calendar trigger style. */
function PeriodPicker({
  value,
  max,
  onChange,
  label,
  format,
}: {
  value: Period;
  max: string;
  onChange: (p: Period) => void;
  label: string;
  format: (iso: string) => string;
}) {
  // The custom trigger has no DateInput for react-aria to anchor the popover to.
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <I18nProvider locale="en-GB">
      <DateRangePicker
        aria-label={label}
        value={{ start: parseDate(value.from), end: parseDate(value.to) }}
        maxValue={parseDate(max)}
        onChange={(range) => range && onChange({ from: range.start.toString(), to: range.end.toString() })}
      >
        <DateRangePicker.Trigger
          ref={triggerRef}
          className="flex min-h-9 items-center gap-2 rounded-field bg-[var(--default)] px-3 py-2 text-sm font-medium text-[var(--foreground)] outline-none transition-colors hover:bg-[var(--default-hover)]"
        >
          <CalendarIcon width={16} height={16} className="shrink-0 text-default-500" />
          <span className="tabular-nums">
            {format(value.from)} – {format(value.to)}
          </span>
        </DateRangePicker.Trigger>
        <DateRangePicker.Popover triggerRef={triggerRef} placement="bottom start" className="!max-w-none !min-w-fit w-fit">
          <RangeCalendar firstDayOfWeek="mon" maxValue={parseDate(max)}>
            <RangeCalendar.Header>
              <RangeCalendar.Heading className="text-left first-letter:uppercase" />
              <div className="flex items-center gap-1">
                <RangeCalendar.NavButton slot="previous" />
                <RangeCalendar.NavButton slot="next" />
              </div>
            </RangeCalendar.Header>
            <RangeCalendar.Grid>
              <RangeCalendar.GridHeader>{(day) => <RangeCalendar.HeaderCell>{day}</RangeCalendar.HeaderCell>}</RangeCalendar.GridHeader>
              <RangeCalendar.GridBody>{(date) => <RangeCalendar.Cell date={date} />}</RangeCalendar.GridBody>
            </RangeCalendar.Grid>
          </RangeCalendar>
        </DateRangePicker.Popover>
      </DateRangePicker>
    </I18nProvider>
  );
}

export function AdminDashboard() {
  const t = useT();
  const fmt = useFormat();
  const tip = useTip();
  const today = useMemo(() => isoDay(new Date()), []);
  const [phase, setPhase] = useState<Phase>("loading");
  const [preset, setPreset] = useState<Preset>("7d");
  const [custom, setCustom] = useState<Period>(() => presetPeriod("30d", today));
  // null = the period's default; a pick only lasts until the period changes.
  const [gran, setGran] = useState<AdminGranularity | null>(null);
  const [office, setOffice] = useState<string | null>(null);
  const [tab, setTab] = useState<DashTab>(() =>
    typeof window === "undefined" ? "overview" : tabFromPath(window.location.pathname),
  );
  const [data, setData] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const period = preset === "custom" ? custom : presetPeriod(preset, today);
  const span = spanDays(period);
  const periodValid = span >= 1 && span <= MAX_PERIOD_DAYS && period.to <= today;
  const grans = allowedGranularities(span);
  // A granularity that no longer fits the period falls back to the default.
  const activeGran = gran && grans.includes(gran) ? gran : defaultGranularity(span);

  useEffect(() => {
    api
      .adminMe()
      .then(() => setPhase("ready"))
      .catch((e: Error) => setPhase(e.message === "UNAUTHENTICATED" ? "unauthenticated" : "forbidden"));
  }, []);

  useEffect(() => {
    const onPop = () => setTab(tabFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const changeTab = (next: DashTab) => {
    setTab(next);
    const path = next === "overview" ? "/dashboard" : `/dashboard/${next}`;
    if (window.location.pathname !== path) window.history.pushState(window.history.state, "", path);
  };

  const load = useCallback(() => {
    if (!periodValid) return;
    setLoading(true);
    setError(null);
    api
      .adminOverview({ from: period.from, to: period.to, gran: activeGran, office })
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.from, period.to, activeGran, office, periodValid]);

  useEffect(() => {
    if (phase === "ready") load();
  }, [phase, load]);

  const count = (v: number) => fmt.num(Math.round(v));
  const rate = (v: number) => pct(v);
  // Axis label and tooltip heading for one bucket.
  const bucketColumn = (start: string) => {
    if (activeGran === "hour") {
      // "2026-11-20T14:00": label the hour; over several days, also the date.
      const day = start.slice(0, 10);
      const hour = start.slice(11, 16);
      const weekday = ((new Date(`${day}T00:00:00`).getDay() + 6) % 7) as AdminWeekday;
      return {
        key: start,
        label: span > 1 ? `${fmt.day(day)} ${hour.slice(0, 2)}h` : hour,
        title: `${t(`admin.weekday.${weekday}`)} ${fmt.day(day)} · ${hour}`,
      };
    }
    if (activeGran === "year") return { key: start, label: start.slice(0, 4), title: start.slice(0, 4) };
    if (activeGran === "month") return { key: start, label: fmt.month(start), title: fmt.month(start) };
    if (activeGran === "week") return { key: start, label: fmt.day(start), title: t("admin.gran.weekOf", { date: fmt.day(start) }) };
    const weekday = ((new Date(`${start}T00:00:00`).getDay() + 6) % 7) as AdminWeekday;
    return { key: start, label: fmt.day(start), title: `${t(`admin.weekday.${weekday}`)} ${fmt.day(start)}` };
  };
  const rangeLabel = (from: string, to: string) =>
    from === to ? fmt.dayYear(from) : `${fmt.dayYear(from)} – ${fmt.dayYear(to)}`;

  const health = data?.health;
  const healthCards = health
    ? [
        {
          key: "availability",
          title: t("admin.health.availability"),
          level: health.availability.level,
          detail:
            health.availability.ageMinutes == null
              ? t("admin.health.availabilityNever")
              : t("admin.health.availabilityAge", { minutes: Math.round(health.availability.ageMinutes) }),
        },
        {
          key: "tokens",
          title: t("admin.health.tokens"),
          level: health.tokenPool.level,
          detail: t("admin.health.tokensDetail", {
            active: health.tokenPool.active,
            expired: health.tokenPool.expired,
            invalid: health.tokenPool.invalid,
          }),
        },
        {
          key: "failures",
          title: t("admin.health.failures"),
          level: health.failures24h.level,
          detail: t("admin.health.failuresDetail", { failed: health.failures24h.failed, total: health.failures24h.total }),
        },
        {
          key: "stuck",
          title: t("admin.health.stuck"),
          level: health.stuckPending.level,
          detail: `${health.stuckPending.count} · ${t("admin.health.stuckDetail")}`,
        },
      ]
    : [];

  const bookingsChart = data && (
    <DivergingBars
      data={data.trend.map((b) => ({ ...bucketColumn(b.start), up: b.success, down: { ...b.canceled, declined: b.declined } }))}
      up={TYPES.map((type) => ({ key: type, label: t(`admin.type.${type}`), color: TYPE_COLOR[type] }))}
      down={[
        ...CANCEL_KINDS.map((kind) => ({ key: kind, label: t(`admin.cancel.${kind}`), color: CANCEL_COLOR[kind] })),
        { key: "declined", label: t("admin.outcome.declined"), color: "var(--viz-declined)" },
      ]}
      t={t}
      tip={tip}
    />
  );

  const scoutStats = data && (
    <div className="grid grid-cols-3 gap-4">
      <Stat label={t("admin.scout.total")} value={fmt.num(data.scouts.total)} />
      <Stat label={t("admin.scout.successRate")} value={pct(data.scouts.successRate)} hint={t("admin.scout.successHint")} />
      <Stat
        label={t("admin.scout.declines")}
        value={
          data.scouts.declinesBeforeFound.avg == null
            ? "—"
            : data.scouts.declinesBeforeFound.avg.toLocaleString(undefined, { maximumFractionDigits: 1 })
        }
        hint={t("admin.scout.declinesHint", {
          withDeclines: data.scouts.declinesBeforeFound.withDeclines,
          found: data.scouts.declinesBeforeFound.found,
          max: data.scouts.declinesBeforeFound.max,
        })}
      />
    </div>
  );

  const chatStats = data && (
    <div className="grid grid-cols-3 gap-4">
      <Stat label={t("admin.chat.conversations")} value={fmt.num(data.chatbot.conversations)} />
      <Stat label={t("admin.chat.bookings")} value={fmt.num(data.chatbot.chatbotBookings)} />
      <Stat label={t("admin.kpi.chatToBooking")} value={pct(data.chatbot.rate)} />
    </div>
  );

  const more = (target: DashTab) => (
    <Button size="sm" variant="ghost" className="shrink-0 rounded-full" onPress={() => changeTab(target)}>
      {t("admin.more")} →
    </Button>
  );

  return (
    <div className="admin-viz h-full overflow-y-auto bg-[#f0f0f1] dark:bg-[#0c0e12]">
      <style>{VIZ_STYLE}</style>
      <TipLayer tip={tip.tip} />

      {/* Filters + tabs: pinned while scrolling from `sm` up. */}
      <div className="z-20 border-b border-[color:var(--separator)] bg-[#f0f0f1]/95 backdrop-blur dark:bg-[#0c0e12]/95 sm:sticky sm:top-0">
        <div className="flex w-full flex-col gap-3 px-3 pt-3 sm:px-4 sm:pt-4">
          {phase === "ready" && (
            <>
              {/* Filters and refresh on one row. */}
              <div className="flex items-start gap-3">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2">
                  <FilterSelect
                    label={t("admin.period.label")}
                    value={preset}
                    onChange={(p) => {
                      setPreset(p);
                      setGran(null);
                    }}
                    options={PRESETS.map((p) => ({ value: p, label: t(`admin.period.${p}`) }))}
                  />
                  {preset === "custom" && (
                    <PeriodPicker
                      value={custom}
                      max={today}
                      onChange={(p) => {
                        setCustom(p);
                        setGran(null);
                      }}
                      label={t("admin.period.custom")}
                      format={fmt.dayYear}
                    />
                  )}
                  <FilterSelect
                    label={t("admin.office.label")}
                    value={office ?? ""}
                    onChange={(v) => setOffice(v || null)}
                    options={[
                      { value: "", label: t("admin.office.all") },
                      ...(data?.offices ?? []).map((o) => ({ value: o, label: o })),
                    ]}
                  />
                  <div className="flex items-center gap-2">
                    <span className={`whitespace-nowrap text-sm ${MUTED}`}>{t("admin.gran.label")}</span>
                    {/* Always all five, so the control never changes size; the ones that
                        don't fit the period are disabled and say why on hover. */}
                    <Tabs
                      selectedKey={activeGran}
                      disabledKeys={GRANULARITIES.filter((g) => !grans.includes(g))}
                      onSelectionChange={(k) => setGran(k as AdminGranularity)}
                    >
                      <Tabs.ListContainer>
                        <Tabs.List aria-label={t("admin.gran.label")}>
                          {GRANULARITIES.map((g) => (
                            <Tabs.Tab key={g} id={g} className="whitespace-nowrap">
                              <span title={grans.includes(g) ? undefined : t(`admin.gran.needs.${g}`)}>
                                {t(`admin.gran.${g}`)}
                              </span>
                              <Tabs.Indicator />
                            </Tabs.Tab>
                          ))}
                        </Tabs.List>
                      </Tabs.ListContainer>
                    </Tabs>
                  </div>
                </div>
                {/* When the data was built shows on hover (there's no subtitle for it any more). */}
                <span
                  className="ml-auto shrink-0"
                  title={data ? t("admin.updated", { time: fmt.time(data.generatedAt) }) : undefined}
                >
                  <Button
                    isIconOnly
                    size="sm"
                    variant="tertiary"
                    aria-label={t("admin.refresh")}
                    onPress={load}
                    isDisabled={loading || !periodValid}
                  >
                    {loading ? <Spinner size="sm" /> : <ArrowsRotateRight width={16} height={16} />}
                  </Button>
                </span>
              </div>
              {!periodValid && (
                <p className="text-xs text-danger">{t("admin.period.invalid", { max: MAX_PERIOD_DAYS })}</p>
              )}
              <Tabs variant="secondary" selectedKey={tab} onSelectionChange={(k) => changeTab(k as DashTab)}>
                <Tabs.ListContainer className="overflow-x-auto [scrollbar-width:none]">
                  <Tabs.List aria-label={t("admin.title")} className="w-fit">
                    {TABS.map((tb) => (
                      <Tabs.Tab key={tb} id={tb} className="whitespace-nowrap">
                        {t(`admin.tab.${tb}`)}
                        {tb === "issues" && health && healthCards.some((h) => h.level !== "ok") && (
                          <span
                            className="ml-1.5 inline-block size-1.5 rounded-full align-middle"
                            style={{ background: "var(--viz-critical)" }}
                            aria-label={t("admin.level.down")}
                          />
                        )}
                        <Tabs.Indicator />
                      </Tabs.Tab>
                    ))}
                  </Tabs.List>
                </Tabs.ListContainer>
              </Tabs>
            </>
          )}
        </div>
      </div>

      <div className="flex w-full flex-col gap-3 p-3 sm:gap-4 sm:p-4">
        {phase === "loading" && (
          <div className="flex justify-center py-20">
            <Spinner />
          </div>
        )}
        {(phase === "unauthenticated" || phase === "forbidden") && (
          <div className="flex justify-center py-16">
            <div className={`${CARD} flex w-full max-w-[400px] flex-col items-center gap-2 text-center`}>
              <BrandIcon size={40} />
              <p className={`mt-2 text-base font-semibold ${TEXT}`}>
                {t(phase === "forbidden" ? "admin.notAdmin" : "admin.loginRequired")}
              </p>
              <p className={`text-sm ${MUTED}`}>{t(phase === "forbidden" ? "admin.notAdminHint" : "admin.loginHint")}</p>
            </div>
          </div>
        )}
        {phase === "ready" && error && <p className="text-sm text-danger">{t("admin.loadError", { error })}</p>}
        {phase === "ready" && !data && !error && (
          <div className="flex justify-center py-20">
            <Spinner />
          </div>
        )}

        {phase === "ready" && data && health && (
          <>
            {tab === "overview" && (
              <>
                {/* Health: one line while everything is fine, the problems otherwise. */}
                {healthCards.every((h) => h.level === "ok") ? (
                  <div className={`${CARD} flex flex-wrap items-center justify-between gap-2 !py-3`}>
                    <span className={`flex items-center gap-2 text-sm font-medium ${TEXT}`}>
                      <CircleCheckFill width={16} height={16} style={{ color: "var(--viz-good)" }} aria-hidden />
                      {t("admin.health.allOk")}
                      <span className={`font-normal ${MUTED}`}>· {healthCards[0].detail}</span>
                    </span>
                    {more("issues")}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
                      {healthCards
                        .filter((h) => h.level !== "ok")
                        .map((h) => (
                          <HealthCard key={h.key} t={t} title={h.title} level={h.level} detail={h.detail} />
                        ))}
                    </div>
                    <div className="flex justify-end">{more("issues")}</div>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
                  {(
                    [
                      ["activeUsers", count],
                      ["bookings", count],
                      ["successRate", rate],
                      ["scoutSuccess", rate],
                    ] as const
                  ).map(([key, format]) => (
                    <KpiTile
                      key={key}
                      t={t}
                      label={t(`admin.kpi.${key}`)}
                      kpi={data.kpis[key]}
                      format={format}
                      buckets={data.buckets}
                      lastPartial={data.range.lastPartial}
                      granLabel={t(`admin.gran.${activeGran}`)}
                      bucketTitle={(b) => bucketColumn(b).title}
                      compareTitle={t("admin.period.summary", {
                        range: rangeLabel(period.from, period.to),
                        prev: rangeLabel(shiftDays(period.from, -span), shiftDays(period.from, -1)),
                      })}
                      tip={tip}
                    />
                  ))}
                </div>

                <Section title={t("admin.bookings.title")} hint={t("admin.bookings.hint")} action={more("bookings")}>
                  {bookingsChart}
                </Section>

                <div className="grid grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-2">
                  <Section title={t("admin.chat.title")} action={more("chat")}>
                    {chatStats}
                    <FeedbackBar fb={data.chatbot.feedback} t={t} tip={tip} />
                  </Section>
                  <Section title={t("admin.scout.title")} action={more("scout")}>
                    {scoutStats}
                  </Section>
                </div>
              </>
            )}

            {tab === "bookings" && (
              <>
                <Section title={t("admin.bookings.title")} hint={t("admin.bookings.hint")}>
                  {bookingsChart}
                </Section>
                <div className="grid grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-3">
                  <Section title={t("admin.outcome.title")}>
                    <BookingOutcomes outcomes={data.bookingOutcomes} t={t} fmt={fmt} />
                  </Section>
                  <Section title={t("admin.shame.title")} hint={t("admin.shame.hint")} className="lg:col-span-2">
                    <ShameTable rows={data.hallOfShame} t={t} fmt={fmt} />
                  </Section>
                </div>
              </>
            )}

            {tab === "users" && (
              <div className="grid grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-3">
                <Section title={t("admin.users.title")}>
                  <Stat label={t("admin.users.total")} value={fmt.num(data.users.total)} hint={t("admin.users.totalHint")} />
                  <h3 className={`text-sm font-medium ${TEXT}`}>{t("admin.users.new")}</h3>
                  <DivergingBars
                    data={data.trend.map((b) => ({ ...bucketColumn(b.start), up: { newUsers: b.newUsers }, down: {} }))}
                    up={[{ key: "newUsers", label: t("admin.users.new"), color: "var(--viz-s1)" }]}
                    down={[]}
                    t={t}
                    tip={tip}
                  />
                </Section>
                <Section
                  title={t("admin.users.retention")}
                  hint={t("admin.users.retentionHint")}
                  badge={t("admin.badge.last6m")}
                  className="lg:col-span-2"
                >
                  <CohortTable rows={data.users.retention} all={data.users.retentionAll} t={t} fmt={fmt} tip={tip} />
                </Section>
              </div>
            )}

            {tab === "chat" && (
              <div className="grid grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-2">
                <Section title={t("admin.chat.title")}>
                  {chatStats}
                  <FeedbackBar fb={data.chatbot.feedback} t={t} tip={tip} />
                  <h3 className={`text-sm font-medium ${TEXT}`}>{t("admin.chat.intents")}</h3>
                  <p className={`-mt-3 text-xs ${MUTED}`}>{t("admin.chat.intentsHint")}</p>
                  <BarList
                    max={Math.max(0, ...data.chatbot.intents.map((i) => i.count))}
                    rows={data.chatbot.intents.map((i) => ({
                      key: i.intent,
                      label: t(`admin.intent.${i.intent}`),
                      value: i.count,
                      display: `${fmt.num(i.count)} · ${pct(data.chatbot.conversations ? i.count / data.chatbot.conversations : null)}`,
                    }))}
                  />
                </Section>
                <Section title={t("admin.chat.recentNegative")}>
                  {data.chatbot.recentNegative.length ? (
                    <ul className="flex max-h-[560px] flex-col gap-2 overflow-y-auto">
                      {data.chatbot.recentNegative.map((m, i) => (
                        <li key={`${m.at}-${i}`} className="rounded-xl bg-[#f5f5f5] p-3 text-sm dark:bg-[#0c0e12]">
                          <div className={`mb-1 flex justify-between gap-3 text-xs ${MUTED}`}>
                            <span>{m.email?.split("@")[0] ?? "—"}</span>
                            <span className="tabular-nums">{fmt.dateTime(m.at)}</span>
                          </div>
                          <p className={`line-clamp-4 whitespace-pre-line ${TEXT}`}>{m.content}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className={`text-sm ${MUTED}`}>{t("admin.chat.noNegative")}</p>
                  )}
                </Section>
              </div>
            )}

            {tab === "scout" && (
              <div className="grid grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-3">
                <Section title={t("admin.scout.title")} className="lg:col-span-2">
                  {scoutStats}
                  <div className={`flex flex-wrap gap-x-4 gap-y-1 text-xs ${MUTED}`}>
                    {(["success", "canceled_user", "canceled_auto", "active"] as const).map((o) => (
                      <span key={o}>
                        {t(`admin.scout.outcome.${o}`)}:{" "}
                        <span className={`tabular-nums ${TEXT}`}>{fmt.num(data.scouts.outcomes[o])}</span>
                      </span>
                    ))}
                  </div>
                  <h3 className={`text-sm font-medium ${TEXT}`}>{t("admin.scout.byDay")}</h3>
                  <p className={`-mt-3 text-xs ${MUTED}`}>{t("admin.scout.byDayHint")}</p>
                  <DivergingBars
                    data={data.trend.map((b) => ({
                      ...bucketColumn(b.start),
                      up: { success: b.scouts.success },
                      down: { canceledUser: b.scouts.canceledUser, canceledAuto: b.scouts.canceledAuto },
                    }))}
                    up={[{ key: "success", label: t("admin.scout.outcome.success"), color: "var(--viz-s3)" }]}
                    down={[
                      { key: "canceledUser", label: t("admin.scout.outcome.canceled_user"), color: CANCEL_COLOR.user },
                      { key: "canceledAuto", label: t("admin.scout.outcome.canceled_auto"), color: CANCEL_COLOR.auto },
                    ]}
                    t={t}
                    tip={tip}
                  />
                </Section>
                <Section title={t("admin.scout.demand")}>
                  <h3 className={`text-sm font-medium ${TEXT}`}>{t("admin.scout.bySize")}</h3>
                  <SizeDemand rows={data.scouts.demandBySize} t={t} tip={tip} />
                  <h3 className={`text-sm font-medium ${TEXT}`}>{t("admin.scout.byHour")}</h3>
                  <HourColumns data={data.scouts.demandByHour} tip={tip} label={t("admin.scout.requested")} />
                </Section>
              </div>
            )}

            {tab === "issues" && (
              <>
                <div className="flex items-center gap-2">
                  <h2 className={`text-base font-semibold ${TEXT}`}>{t("admin.health.title")}</h2>
                  <Badge>{t("admin.badge.now")}</Badge>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
                  {healthCards.map((h) => (
                    <HealthCard key={h.key} t={t} title={h.title} level={h.level} detail={h.detail} />
                  ))}
                </div>
                <Section title={t("admin.issues.stuck")} badge={t("admin.badge.now")}>
                  <ActivityTable rows={health.stuckPending.rows} t={t} fmt={fmt} />
                </Section>
                <Section title={t("admin.issues.failures")} hint={t("admin.issues.failuresHint")}>
                  <ActivityTable rows={data.recentFailures} t={t} fmt={fmt} />
                </Section>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <Chip size="sm" color="default" variant="soft">
      {children}
    </Chip>
  );
}

function SizeDemand({
  rows,
  t,
  tip,
}: {
  rows: AdminOverview["scouts"]["demandBySize"];
  t: TFunction;
  tip: TipApi;
}) {
  if (!rows.length) return <Empty t={t} />;
  const max = rows[0].count || 1;
  return (
    <>
      <ul className="flex flex-col gap-2">
        {rows.map((d) => {
          const label = t(`admin.size.${d.size}` as TranslationKey);
          return (
            <li
              key={d.size}
              className="flex flex-col gap-1"
              onPointerMove={(e) =>
                tip.show(
                  e,
                  <div className="flex flex-col gap-1">
                    <span className={`font-medium ${TEXT}`}>{label}</span>
                    <TipRow color="var(--viz-s1)" label={t("admin.scout.requested")} value={String(d.count)} />
                    <TipRow color="var(--viz-s2)" label={t("admin.scout.unmet")} value={String(d.unmet)} />
                  </div>,
                )
              }
              onPointerLeave={tip.hide}
            >
              <div className="flex justify-between text-sm">
                <span className={TEXT}>{label}</span>
                <span className={`tabular-nums ${MUTED}`}>
                  {d.count} · {t("admin.scout.unmet")} {d.unmet}
                </span>
              </div>
              <div className="flex h-1.5 gap-[2px]">
                <div className="rounded-l-full" style={{ width: `${((d.count - d.unmet) / max) * 100}%`, background: "var(--viz-s1)" }} />
                <div className="rounded-r-full" style={{ width: `${(d.unmet / max) * 100}%`, background: "var(--viz-s2)" }} />
              </div>
            </li>
          );
        })}
      </ul>
      <Legend
        items={[
          { color: "var(--viz-s1)", label: t("admin.scout.outcome.success") + " / " + t("admin.scout.outcome.active") },
          { color: "var(--viz-s2)", label: t("admin.scout.unmet") },
        ]}
      />
    </>
  );
}

/** What happened to bookings in the range; doubles as the chart's table view. */
function BookingOutcomes({
  outcomes,
  t,
  fmt,
}: {
  outcomes: AdminOverview["bookingOutcomes"];
  t: TFunction;
  fmt: ReturnType<typeof useFormat>;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <Stat label={t("admin.outcome.success")} value={fmt.num(outcomes.success)} />
        <Stat label={t("admin.outcome.canceled")} value={fmt.num(outcomes.canceled.total)} />
      </div>
      <ul className="flex flex-col gap-1.5 border-l-2 border-[color:var(--separator)] pl-3 text-sm">
        {CANCEL_KINDS.map((kind) => (
          <li key={kind} className="flex items-center justify-between gap-3">
            <span className={`flex items-center gap-1.5 ${MUTED}`}>
              <span className="inline-block size-2.5 rounded-sm" style={{ background: CANCEL_COLOR[kind] }} />
              {t(`admin.cancel.${kind}`)}
            </span>
            <span className={`tabular-nums ${TEXT}`}>{fmt.num(outcomes.canceled[kind])}</span>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-2 gap-4 border-t border-[color:var(--separator)] pt-4">
        <Stat label={t("admin.outcome.failed")} value={fmt.num(outcomes.failed)} hint={t("admin.outcome.failedHint")} />
        <Stat
          label={t("admin.outcome.declined")}
          value={fmt.num(outcomes.declined)}
          hint={t("admin.outcome.declinedHint", { scout: outcomes.declinedScout })}
        />
      </div>
    </div>
  );
}

function FeedbackBar({ fb, t, tip }: { fb: { positive: number; negative: number }; t: TFunction; tip: TipApi }) {
  const total = fb.positive + fb.negative;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-sm">
        <span className={TEXT}>{t("admin.chat.feedback")}</span>
        <span className={`tabular-nums ${MUTED}`}>
          👍 {fb.positive} · 👎 {fb.negative}
        </span>
      </div>
      <div
        className="flex h-2 gap-[2px] rounded-full bg-[color:var(--viz-track)]"
        onPointerMove={(e) =>
          tip.show(
            e,
            <div className="flex flex-col gap-1">
              <TipRow color="var(--viz-s1)" label={t("admin.chat.positive")} value={`${fb.positive} (${pct(total ? fb.positive / total : null)})`} />
              <TipRow color="var(--viz-s2)" label={t("admin.chat.negative")} value={`${fb.negative} (${pct(total ? fb.negative / total : null)})`} />
            </div>,
          )
        }
        onPointerLeave={tip.hide}
      >
        {total > 0 && (
          <>
            <div className="rounded-l-full" style={{ width: `${(fb.positive / total) * 100}%`, background: "var(--viz-s1)" }} />
            <div className="rounded-r-full" style={{ width: `${(fb.negative / total) * 100}%`, background: "var(--viz-s2)" }} />
          </>
        )}
      </div>
      <Legend
        items={[
          { color: "var(--viz-s1)", label: t("admin.chat.positive") },
          { color: "var(--viz-s2)", label: t("admin.chat.negative") },
        ]}
      />
    </div>
  );
}

function HourColumns({ data, tip, label }: { data: { hour: number; count: number }[]; tip: TipApi; label: string }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-20 items-end gap-[2px]">
        {data.map((d) => (
          <div
            key={d.hour}
            className="flex h-full flex-1 items-end"
            onPointerMove={(e) => tip.show(e, <TipRow label={`${d.hour}:00 · ${label}`} value={String(d.count)} />)}
            onPointerLeave={tip.hide}
          >
            <div
              className="w-full rounded-t-[4px]"
              style={{ height: `${(d.count / max) * 100}%`, minHeight: d.count ? 2 : 0, background: "var(--viz-s1)" }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-[2px] text-[10px] text-[#71717a] dark:text-[#94979c]">
        {data.map((d) => (
          <span key={d.hour} className="flex-1 text-center tabular-nums">
            {d.hour % 2 === 0 ? d.hour : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Cohort triangle: one row per first-booking month, one column per month after,
 *  then each cohort's average; the last row pools every cohort. Cell shade is a
 *  single-hue ramp on the rate; the number is always printed. */
function CohortTable({
  rows,
  all,
  t,
  fmt,
  tip,
}: {
  rows: AdminOverview["users"]["retention"];
  all: AdminOverview["users"]["retentionAll"];
  t: TFunction;
  fmt: ReturnType<typeof useFormat>;
  tip: TipApi;
}) {
  if (!rows.some((r) => r.cohort)) return <Empty t={t} />;
  const offsets = rows[0]?.cells.map((_, i) => i + 1) ?? [];
  const allLabel = t("admin.users.cohortAll");

  const cell = (key: string, rate: number | null, opts: { partial?: boolean; title: string; detail: string }) => {
    const strength = rate ?? 0;
    return (
      <td
        key={key}
        className={`rounded-md px-2 py-1.5 text-center tabular-nums ${strength > 0.5 ? "text-white" : TEXT}`}
        style={{
          background:
            rate == null
              ? "var(--viz-track)"
              : `color-mix(in oklab, var(--viz-s1) ${Math.round(12 + strength * 88)}%, var(--viz-surface))`,
        }}
        onPointerMove={(e) =>
          tip.show(
            e,
            <div className="flex flex-col gap-1">
              <span className={`font-medium ${TEXT}`}>{opts.title}</span>
              <TipRow label={opts.detail} value={pct(rate, 1)} />
            </div>,
          )
        }
        onPointerLeave={tip.hide}
      >
        {pct(rate)}
        {opts.partial ? "*" : ""}
      </td>
    );
  };

  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[600px] border-separate border-spacing-[2px] text-sm">
        <thead className={`text-xs ${MUTED}`}>
          <tr>
            <th className="px-2 pb-1 text-left font-medium">{t("admin.users.cohort")}</th>
            <th className="px-2 pb-1 text-right font-medium">{t("admin.users.cohortSize")}</th>
            {offsets.map((k) => (
              <th key={k} className="px-2 pb-1 text-center font-medium tabular-nums">
                M+{k}
              </th>
            ))}
            <th className={`px-2 pb-1 text-center font-semibold ${TEXT}`}>{t("admin.users.cohortAvg")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.month}>
              <td className={`whitespace-nowrap px-2 py-1.5 tabular-nums ${TEXT}`}>{fmt.month(row.month)}</td>
              <td className={`px-2 py-1.5 text-right tabular-nums ${MUTED}`}>{fmt.num(row.cohort)}</td>
              {row.cells.map((c, i) =>
                !c || !row.cohort
                  ? <td key={i} />
                  : cell(String(i), c.rate, {
                      partial: c.partial,
                      title: `${fmt.month(row.month)} · M+${i + 1}`,
                      detail: t(c.partial ? "admin.users.partial" : "admin.users.retentionRow", {
                        returned: c.returned,
                        cohort: row.cohort,
                      }),
                    }),
              )}
              {row.cohort && row.avg != null
                ? cell("avg", row.avg, {
                    title: `${fmt.month(row.month)} · ${t("admin.users.cohortAvg")}`,
                    detail: t("admin.users.avgHint"),
                  })
                : <td />}
            </tr>
          ))}
          <tr>
            <td className={`whitespace-nowrap border-t border-[color:var(--separator)] px-2 py-1.5 font-semibold ${TEXT}`}>
              {allLabel}
            </td>
            <td className={`border-t border-[color:var(--separator)] px-2 py-1.5 text-right tabular-nums ${MUTED}`}>
              {fmt.num(all.cohort)}
            </td>
            {all.cells.map((c, i) =>
              !c
                ? <td key={i} className="border-t border-[color:var(--separator)]" />
                : cell(String(i), c.rate, {
                    title: `${allLabel} · M+${i + 1}`,
                    detail: t("admin.users.retentionRow", { returned: c.returned, cohort: c.users }),
                  }),
            )}
            {all.avg != null
              ? cell("avg", all.avg, { title: `${allLabel} · ${t("admin.users.cohortAvg")}`, detail: t("admin.users.avgHint") })
              : <td />}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function ShameTable({
  rows,
  t,
  fmt,
}: {
  rows: AdminOverview["hallOfShame"];
  t: TFunction;
  fmt: ReturnType<typeof useFormat>;
}) {
  if (!rows.length) return <p className={`text-sm ${MUTED}`}>{t("admin.shame.none")}</p>;
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[420px] text-left text-sm">
        <thead className={`text-xs ${MUTED}`}>
          <tr>
            <th className="w-8 px-1 pb-2 font-medium">#</th>
            <th className="px-1 pb-2 font-medium">{t("admin.col.user")}</th>
            <th className="px-1 pb-2 text-right font-medium">{t("admin.shame.auto")}</th>
            <th className="px-1 pb-2 text-right font-medium">{t("admin.shame.booked")}</th>
            <th className="px-1 pb-2 text-right font-medium">{t("admin.shame.rate")}</th>
          </tr>
        </thead>
        <tbody className={TEXT}>
          {rows.map((row, i) => (
            <tr key={row.email ?? i} className="border-t border-[color:var(--separator)]">
              <td className={`px-1 py-2 tabular-nums ${MUTED}`}>{i + 1}</td>
              <td className="px-1 py-2">{row.email ?? "—"}</td>
              <td className="px-1 py-2 text-right font-medium tabular-nums">{fmt.num(row.autoCanceled)}</td>
              <td className={`px-1 py-2 text-right tabular-nums ${MUTED}`}>{fmt.num(row.booked)}</td>
              <td className={`px-1 py-2 text-right tabular-nums ${MUTED}`}>{pct(row.rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
