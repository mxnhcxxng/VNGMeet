"use client";

// Admin dashboard (/admin). Data comes from backend/app/admin.py; this file only
// lays it out. Charts are hand-rolled SVG/CSS (no chart library in the app):
// fixed categorical slots for booking types, one blue ramp for the heatmap, and
// status colors only for health — each with an icon/label, never color alone.

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Button, Spinner } from "@heroui/react";
import {
  ArrowRotateRight,
  CircleCheckFill,
  CircleExclamationFill,
  TriangleExclamationFill,
} from "@gravity-ui/icons";
import {
  api,
  type AdminActivityRow,
  type AdminBookingType,
  type AdminHeatmap,
  type AdminKpi,
  type AdminLevel,
  type AdminOverview,
  type AdminRoomSize,
} from "@/lib/api";
import { BrandIcon } from "@/components/BrandIcon";
import { useLanguage, useT } from "@/app/providers";
import type { TFunction, TranslationKey } from "@/lib/i18n";

const TEXT = "text-[#181d27] dark:text-[#f7f7f7]";
const MUTED = "text-[#71717a] dark:text-[#94979c]";
const CARD = "rounded-2xl bg-white p-5 shadow-sm dark:bg-[#0c0e12]";

const RANGES = [7, 30, 90] as const;
const SIZES: AdminRoomSize[] = ["small", "medium", "large"];
const TYPES: AdminBookingType[] = ["instant", "scheduled", "scout"];
const TYPE_COLOR: Record<AdminBookingType, string> = {
  instant: "var(--viz-s1)",
  scheduled: "var(--viz-s2)",
  scout: "var(--viz-s3)",
};
const HEAT_STEPS = 7;

// Validated reference palette: categorical slots 1–3 (all-pairs safe), a blue
// sequential ramp (reversed on dark so "near zero" recedes into the surface),
// and the fixed status colors.
const VIZ_STYLE = `
.admin-viz {
  --viz-s1: #2a78d6; --viz-s2: #eb6834; --viz-s3: #1baf7a;
  --viz-grid: #e9e9eb; --viz-track: #f0efec; --viz-surface: #ffffff;
  --viz-good: #0ca30c; --viz-warning: #fab219; --viz-critical: #d03b3b;
  --viz-h0: #cde2fb; --viz-h1: #9ec5f4; --viz-h2: #6da7ec; --viz-h3: #3987e5;
  --viz-h4: #256abf; --viz-h5: #184f95; --viz-h6: #0d366b;
}
html.dark .admin-viz {
  --viz-s1: #3987e5; --viz-s2: #d95926; --viz-s3: #199e70;
  --viz-grid: #22262f; --viz-track: #1a1d23; --viz-surface: #0c0e12;
  --viz-h0: #104281; --viz-h1: #184f95; --viz-h2: #256abf; --viz-h3: #2a78d6;
  --viz-h4: #5598e7; --viz-h5: #86b6ef; --viz-h6: #cde2fb;
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
      className="pointer-events-none fixed z-[200] max-w-[240px] rounded-lg border border-[color:var(--separator)] bg-white px-3 py-2 text-xs shadow-lg dark:bg-[#13161b]"
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
function Section({ title, hint, children, className = "" }: { title: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`${CARD} flex min-w-0 flex-col gap-4 ${className}`}>
      <header>
        <h2 className={`text-base font-semibold ${TEXT}`}>{title}</h2>
        {hint && <p className={`mt-0.5 text-xs ${MUTED}`}>{hint}</p>}
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
    <div className={`${CARD} flex flex-col gap-2 !p-4`}>
      <span className={`text-sm ${MUTED}`}>{title}</span>
      <span className={`flex items-center gap-1.5 text-base font-semibold ${TEXT}`}>
        <Icon width={16} height={16} style={{ color: LEVEL_COLOR[level] }} aria-hidden />
        {t(`admin.level.${level}` as TranslationKey)}
      </span>
      <span className={`text-xs ${MUTED}`}>{detail}</span>
    </div>
  );
}

/** Weekly sparkline; nulls (no data that week) break the line. The last week is
 *  still in progress, so it's drawn dashed with a hollow marker. */
function Sparkline({
  series,
  weeks,
  format,
  tip,
  dayLabel,
}: {
  series: (number | null)[];
  weeks: string[];
  format: (v: number) => string;
  tip: TipApi;
  dayLabel: (iso: string) => string;
}) {
  const W = 120;
  const H = 32;
  const values = series.filter((v): v is number => v != null);
  if (!values.length) return <div style={{ height: H }} />;
  const max = Math.max(...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const step = W / Math.max(series.length - 1, 1);
  const pts = series.map((v, i) => (v == null ? null : [i * step, H - 3 - ((v - min) / span) * (H - 6)]));
  const segments: string[] = [];
  let current = "";
  pts.slice(0, -1).forEach((p) => {
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
      {last && beforeLast && (
        <path
          d={`M${beforeLast[0]},${beforeLast[1]}L${last[0]},${last[1]}`}
          fill="none"
          stroke="var(--viz-s1)"
          strokeWidth={2}
          strokeDasharray="3 3"
        />
      )}
      {last && <circle cx={last[0]} cy={last[1]} r={3} fill="var(--viz-surface)" stroke="var(--viz-s1)" strokeWidth={2} />}
      {series.map((v, i) => (
        <rect
          key={weeks[i]}
          x={i * step - step / 2}
          y={0}
          width={step}
          height={H}
          fill="transparent"
          onPointerMove={(e) => tip.show(e, <TipRow label={dayLabel(weeks[i])} value={v == null ? "—" : format(v)} />)}
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
  days,
  weeks,
  tip,
  dayLabel,
}: {
  t: TFunction;
  label: string;
  kpi: AdminKpi;
  format: (v: number) => string;
  days: number;
  weeks: string[];
  tip: TipApi;
  dayLabel: (iso: string) => string;
}) {
  const delta = kpi.value != null && kpi.prev != null ? kpi.value - kpi.prev : null;
  return (
    <div className={`${CARD} flex flex-col gap-3 !p-4`}>
      <span className={`text-sm ${MUTED}`}>{label}</span>
      <div className="flex items-end justify-between gap-3">
        <span className={`text-2xl font-semibold tabular-nums ${TEXT}`}>{kpi.value == null ? "—" : format(kpi.value)}</span>
        <Sparkline series={kpi.series} weeks={weeks} format={format} tip={tip} dayLabel={dayLabel} />
      </div>
      <div className={`flex justify-between gap-3 text-xs tabular-nums ${MUTED}`}>
        <span>
          {delta != null && (
            <>
              {delta > 0 ? "▲" : delta < 0 ? "▼" : "•"} {format(Math.abs(delta))} {t("admin.kpi.vsPrev", { days })}
            </>
          )}
        </span>
        <span className="shrink-0 text-[10px]">{t("admin.kpi.weekly")}</span>
      </div>
    </div>
  );
}

function StackedBars({ data, t, tip, day }: { data: AdminOverview["bookingsByDay"]; t: TFunction; tip: TipApi; day: (iso: string) => string }) {
  const totals = data.map((d) => TYPES.reduce((sum, type) => sum + d[type], 0));
  const max = Math.max(1, ...totals);
  if (!totals.some(Boolean)) return <Empty t={t} />;
  const labelEvery = Math.ceil(data.length / 8);
  return (
    <div className="flex flex-col gap-3">
      <Legend items={TYPES.map((type) => ({ color: TYPE_COLOR[type], label: t(`admin.type.${type}` as TranslationKey) }))} />
      <div className="relative h-48">
        {[0.5, 1].map((f) => (
          <div key={f} className="absolute inset-x-0 border-t border-[color:var(--viz-grid)]" style={{ bottom: `${f * 100}%` }}>
            <span className={`absolute -top-2 right-0 bg-white pl-1 text-[10px] tabular-nums dark:bg-[#0c0e12] ${MUTED}`}>
              {Math.round(max * f)}
            </span>
          </div>
        ))}
        <div className="absolute inset-0 flex items-end gap-[2px] pr-6">
          {data.map((d, i) => (
            <div
              key={d.date}
              className="flex h-full min-w-0 flex-1 cursor-default flex-col justify-end gap-[2px]"
              onPointerMove={(e) =>
                tip.show(
                  e,
                  <div className="flex flex-col gap-1">
                    <span className={`font-medium ${TEXT}`}>{day(d.date)}</span>
                    {TYPES.map((type) => (
                      <TipRow key={type} color={TYPE_COLOR[type]} label={t(`admin.type.${type}` as TranslationKey)} value={String(d[type])} />
                    ))}
                  </div>,
                )
              }
              onPointerLeave={tip.hide}
            >
              {/* Stacked bottom-up in TYPES order; only the top segment gets the rounded end. */}
              {[...TYPES].reverse().map((type) =>
                d[type] ? (
                  <div
                    key={type}
                    style={{
                      height: `${(d[type] / max) * 100}%`,
                      background: TYPE_COLOR[type],
                      borderRadius: TYPES.slice(TYPES.indexOf(type) + 1).every((x) => !d[x]) ? "4px 4px 0 0" : 0,
                    }}
                  />
                ) : null,
              )}
              <span className="sr-only">{totals[i]}</span>
            </div>
          ))}
        </div>
      </div>
      <div className={`flex gap-[2px] pr-6 text-[10px] ${MUTED}`}>
        {data.map((d, i) => (
          <span key={d.date} className="min-w-0 flex-1 truncate text-center">
            {i % labelEvery === 0 ? day(d.date) : ""}
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
// Heatmap
// --------------------------------------------------------------------------- //
function heatColor(value: number | null): string {
  if (value == null) return "var(--viz-track)";
  const step = Math.min(HEAT_STEPS - 1, Math.floor(value * HEAT_STEPS));
  return `var(--viz-h${step})`;
}

function Heatmap({ office, t, tip, fmt }: { office: string | null; t: TFunction; tip: TipApi; fmt: ReturnType<typeof useFormat> }) {
  const [size, setSize] = useState<AdminRoomSize | null>(null);
  const [data, setData] = useState<AdminHeatmap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .adminHeatmap(office, size)
      .then((d) => alive && setData(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [office, size]);

  return (
    <Section
      title={t("admin.heat.title")}
      hint={t("admin.heat.hint", { rooms: data?.roomCount ?? 0 })}
      className="lg:col-span-2"
    >
      <div className="flex flex-wrap gap-1.5">
        {[null, ...SIZES].map((s) => (
          <Chip key={s ?? "all"} active={size === s} onPress={() => setSize(s)}>
            {t(s ? (`admin.size.${s}` as TranslationKey) : "admin.size.all")}
          </Chip>
        ))}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {!data && !error && <Spinner size="sm" />}
      {data && !data.days.length && <Empty t={t} />}
      {data && data.days.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="flex flex-col gap-3 overflow-x-auto">
            <div
              className="grid min-w-[420px] gap-[2px]"
              style={{ gridTemplateColumns: `72px repeat(${data.hours.length}, minmax(0, 1fr))` }}
            >
              <span />
              {data.hours.map((h) => (
                <span key={h} className={`text-center text-[10px] tabular-nums ${MUTED}`}>
                  {h}h
                </span>
              ))}
              {data.days.map((d) => (
                <div key={d.date} className="contents">
                  <span className={`flex items-center text-xs tabular-nums ${MUTED}`}>
                    {t(`admin.weekday.${d.weekday}` as TranslationKey)} {fmt.day(d.date)}
                  </span>
                  {d.cells.map((v, i) => (
                    <div
                      key={i}
                      className="h-7 rounded-[4px]"
                      style={{ background: heatColor(v) }}
                      onPointerMove={(e) =>
                        tip.show(
                          e,
                          <div className="flex flex-col gap-1">
                            <span className={`font-medium ${TEXT}`}>
                              {t(`admin.weekday.${d.weekday}` as TranslationKey)} {fmt.day(d.date)} · {data.hours[i]}:00
                            </span>
                            <TipRow color={heatColor(v)} label={t("admin.heat.legend")} value={pct(v)} />
                          </div>,
                        )
                      }
                      onPointerLeave={tip.hide}
                    />
                  ))}
                </div>
              ))}
            </div>
            <div className={`flex items-center gap-2 text-[10px] ${MUTED}`}>
              <span>{t("admin.heat.legend")}</span>
              <span>0%</span>
              <div className="flex gap-[2px]">
                {Array.from({ length: HEAT_STEPS }, (_, i) => (
                  <span key={i} className="inline-block h-2.5 w-5 rounded-sm" style={{ background: `var(--viz-h${i})` }} />
                ))}
              </div>
              <span>100%</span>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <span className={`text-sm font-medium ${TEXT}`}>{t("admin.heat.rooms")}</span>
            <BarList
              max={1}
              rows={data.rooms.slice(0, 8).map((r) => ({
                key: r.name ?? "",
                label: r.name ?? "—",
                sub: r.office,
                value: r.busy ?? 0,
                display: pct(r.busy),
              }))}
            />
          </div>
        </div>
      )}
    </Section>
  );
}

function Chip({ active, onPress, children }: { active: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-pressed={active}
      className={`h-8 rounded-full px-3 text-sm font-medium transition-colors ${
        active
          ? "bg-[#181d27] text-white dark:bg-[#f7f7f7] dark:text-[#181d27]"
          : "bg-[#ebebec] text-[#181d27] hover:bg-[#e0e0e1] dark:bg-[#22262f] dark:text-[#f7f7f7] dark:hover:bg-[#2a2f38]"
      }`}
    >
      {children}
    </button>
  );
}

// --------------------------------------------------------------------------- //
// Page
// --------------------------------------------------------------------------- //
type Phase = "loading" | "unauthenticated" | "forbidden" | "ready";

export function AdminDashboard() {
  const t = useT();
  const fmt = useFormat();
  const tip = useTip();
  const [phase, setPhase] = useState<Phase>("loading");
  const [days, setDays] = useState<(typeof RANGES)[number]>(7);
  const [office, setOffice] = useState<string | null>(null);
  const [data, setData] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .adminMe()
      .then(() => setPhase("ready"))
      .catch((e: Error) => setPhase(e.message === "UNAUTHENTICATED" ? "unauthenticated" : "forbidden"));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .adminOverview(days, office)
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [days, office]);

  useEffect(() => {
    if (phase === "ready") load();
  }, [phase, load]);

  const count = (v: number) => fmt.num(Math.round(v));
  const rate = (v: number) => pct(v);

  return (
    <div className="admin-viz min-h-[100dvh] bg-[#f0f0f1] dark:bg-[#13161b]">
      <style>{VIZ_STYLE}</style>
      <TipLayer tip={tip.tip} />
      <main className="mx-auto flex w-full max-w-[1280px] flex-col gap-4 px-4 py-6 sm:px-6 sm:py-10">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <BrandIcon size={36} />
            <div>
              <h1 className={`text-xl font-semibold ${TEXT}`}>{t("admin.title")}</h1>
              <p className={`text-sm ${MUTED}`}>
                {data ? t("admin.updated", { time: fmt.time(data.generatedAt) }) : t("admin.subtitle")}
              </p>
            </div>
          </div>
          {phase === "ready" && (
            <div className="flex flex-wrap items-center gap-2">
              {RANGES.map((r) => (
                <Chip key={r} active={days === r} onPress={() => setDays(r)}>
                  {t("admin.range", { days: r })}
                </Chip>
              ))}
              <select
                value={office ?? ""}
                onChange={(e) => setOffice(e.target.value || null)}
                className="h-8 rounded-full border-0 bg-[#ebebec] px-3 text-sm font-medium text-[#181d27] dark:bg-[#22262f] dark:text-[#f7f7f7]"
              >
                <option value="">{t("admin.office.all")}</option>
                {(data?.offices ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="secondary" className="rounded-full" onPress={load} isDisabled={loading}>
                {loading ? <Spinner size="sm" /> : <ArrowRotateRight width={14} height={14} />}
                {t("admin.refresh")}
              </Button>
            </div>
          )}
        </header>

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
              {phase === "unauthenticated" && (
                <Button className="mt-4 w-full rounded-full" onPress={() => window.location.assign("/")}>
                  {t("admin.goLogin")}
                </Button>
              )}
            </div>
          </div>
        )}
        {phase === "ready" && error && <p className="text-sm text-danger">{t("admin.loadError", { error })}</p>}
        {phase === "ready" && !data && !error && (
          <div className="flex justify-center py-20">
            <Spinner />
          </div>
        )}

        {phase === "ready" && data && (
          <>
            {/* 1. System health — always system-wide. */}
            <h2 className={`sr-only`}>{t("admin.health.title")}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <HealthCard
                t={t}
                title={t("admin.health.availability")}
                level={data.health.availability.level}
                detail={
                  data.health.availability.ageMinutes == null
                    ? t("admin.health.availabilityNever")
                    : t("admin.health.availabilityAge", { minutes: Math.round(data.health.availability.ageMinutes) })
                }
              />
              <HealthCard
                t={t}
                title={t("admin.health.tokens")}
                level={data.health.tokenPool.level}
                detail={t("admin.health.tokensDetail", {
                  active: data.health.tokenPool.active,
                  expired: data.health.tokenPool.expired,
                  invalid: data.health.tokenPool.invalid,
                })}
              />
              <HealthCard
                t={t}
                title={t("admin.health.failures")}
                level={data.health.failures24h.level}
                detail={t("admin.health.failuresDetail", {
                  failed: data.health.failures24h.failed,
                  total: data.health.failures24h.total,
                })}
              />
              <HealthCard
                t={t}
                title={t("admin.health.stuck")}
                level={data.health.stuckPending.level}
                detail={`${data.health.stuckPending.count} · ${t("admin.health.stuckDetail")}`}
              />
            </div>

            {/* KPIs */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {(
                [
                  ["activeUsers", count],
                  ["bookings", count],
                  ["successRate", rate],
                  ["chatToBooking", rate],
                ] as const
              ).map(([key, format]) => (
                <KpiTile
                  key={key}
                  t={t}
                  label={t(`admin.kpi.${key}`)}
                  kpi={data.kpis[key]}
                  format={format}
                  days={days}
                  weeks={data.weeks}
                  tip={tip}
                  dayLabel={fmt.day}
                />
              ))}
            </div>

            {/* 3. Rooms */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Section
                title={t("admin.bookings.title")}
                hint={t("admin.bookings.total", { count: data.kpis.bookings.value ?? 0 })}
                className="lg:col-span-2"
              >
                <StackedBars data={data.bookingsByDay} t={t} tip={tip} day={fmt.day} />
                <div className="flex flex-wrap gap-x-6 gap-y-3 border-t border-[color:var(--separator)] pt-4">
                  {(["success", "failed", "canceled", "pending"] as const).map((s) => (
                    <Stat key={s} label={t(`admin.status.${s}`)} value={fmt.num(data.statusCounts[s])} />
                  ))}
                  {(["manual", "chatbot"] as const).map((m) => (
                    <Stat key={m} label={t(`admin.method.${m}`)} value={fmt.num(data.methods[m])} />
                  ))}
                </div>
              </Section>
              <Section title={t("admin.rooms.top")}>
                {data.topRooms.length ? (
                  <BarList
                    max={data.topRooms[0]?.count ?? 0}
                    rows={data.topRooms.map((r) => ({
                      key: r.name ?? "",
                      label: r.name ?? "—",
                      sub: office ? null : r.office,
                      value: r.count,
                      display: fmt.num(r.count),
                    }))}
                  />
                ) : (
                  <Empty t={t} />
                )}
                <h3 className={`mt-2 text-sm font-medium ${TEXT}`}>{t("admin.rooms.least")}</h3>
                <ul className="flex flex-col gap-1 text-sm">
                  {data.leastRooms.slice(0, 5).map((r) => (
                    <li key={r.name} className="flex justify-between gap-3">
                      <span className={`truncate ${TEXT}`}>
                        {r.name}
                        {!office && r.office && <span className={`ml-1.5 text-xs ${MUTED}`}>{r.office}</span>}
                      </span>
                      <span className={`tabular-nums ${MUTED}`}>{fmt.num(r.count)}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Heatmap office={office} t={t} tip={tip} fmt={fmt} />
            </div>

            {/* 2. Users */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Section title={t("admin.users.title")}>
                <div className="grid grid-cols-2 gap-4">
                  <Stat label={t("admin.users.total")} value={fmt.num(data.users.total)} />
                  <Stat label={t("admin.users.zalo")} value={fmt.num(data.users.zaloLinked)} />
                  <Stat label={t("admin.users.botLinks")} value={fmt.num(data.users.botLinks)} />
                  <Stat label={t("admin.users.revocations")} value={fmt.num(data.users.revocations)} />
                </div>
                <h3 className={`text-sm font-medium ${TEXT}`}>{t("admin.users.newPerWeek")}</h3>
                <BarList
                  max={Math.max(...data.users.newByWeek)}
                  rows={data.weeks.map((w, i) => ({
                    key: w,
                    label: fmt.day(w),
                    value: data.users.newByWeek[i],
                    display: fmt.num(data.users.newByWeek[i]),
                  }))}
                />
              </Section>
              <Section title={t("admin.users.retention")} hint={t("admin.users.retentionHint")}>
                <BarList
                  max={1}
                  color="var(--viz-s3)"
                  rows={data.users.retention.map((r) => ({
                    key: r.week,
                    label: fmt.day(r.week),
                    sub: r.partial ? t("admin.users.partial") : t("admin.users.retentionRow", { returned: r.returned, cohort: r.cohort }),
                    value: r.cohort ? r.returned / r.cohort : 0,
                    display: r.cohort ? pct(r.returned / r.cohort) : "—",
                  }))}
                />
              </Section>
              <Section title={t("admin.users.byOffice")}>
                <BarList
                  max={data.users.byOffice[0]?.count ?? 0}
                  rows={data.users.byOffice.map((o) => ({
                    key: o.office ?? "none",
                    label: o.office ?? t("admin.users.noOffice"),
                    value: o.count,
                    display: fmt.num(o.count),
                  }))}
                />
              </Section>
            </div>

            {/* 4. Chatbot & Room Scout */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Section title={t("admin.chat.title")}>
                <div className="grid grid-cols-3 gap-4">
                  <Stat label={t("admin.chat.conversations")} value={fmt.num(data.chatbot.conversations)} />
                  <Stat label={t("admin.chat.bookings")} value={fmt.num(data.chatbot.chatbotBookings)} />
                  <Stat label={t("admin.kpi.chatToBooking")} value={pct(data.chatbot.rate)} />
                </div>
                <FeedbackBar fb={data.chatbot.feedback} t={t} tip={tip} />
                <h3 className={`text-sm font-medium ${TEXT}`}>{t("admin.chat.recentNegative")}</h3>
                {data.chatbot.recentNegative.length ? (
                  <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto">
                    {data.chatbot.recentNegative.map((m, i) => (
                      <li key={`${m.at}-${i}`} className="rounded-xl bg-[#f5f5f5] p-3 text-sm dark:bg-[#13161b]">
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
              <Section title={t("admin.scout.title")}>
                <div className="grid grid-cols-2 gap-4">
                  <Stat label={t("admin.scout.total")} value={fmt.num(data.scouts.total)} />
                  <Stat
                    label={t("admin.scout.successRate")}
                    value={pct(data.scouts.successRate)}
                    hint={t("admin.scout.successHint")}
                  />
                </div>
                <div className={`flex flex-wrap gap-x-4 gap-y-1 text-xs ${MUTED}`}>
                  {Object.entries(data.scouts.byStatus).map(([s, n]) => (
                    <span key={s}>
                      {t(`admin.scout.status.${s}` as TranslationKey)}: <span className={`tabular-nums ${TEXT}`}>{n}</span>
                    </span>
                  ))}
                </div>
                <h3 className={`text-sm font-medium ${TEXT}`}>{t("admin.scout.bySize")}</h3>
                {data.scouts.demandBySize.length ? (
                  <ul className="flex flex-col gap-2">
                    {data.scouts.demandBySize.map((d) => {
                      const max = data.scouts.demandBySize[0].count || 1;
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
                ) : (
                  <Empty t={t} />
                )}
                <Legend
                  items={[
                    { color: "var(--viz-s1)", label: t("admin.scout.status.success") + " / " + t("admin.scout.status.active") },
                    { color: "var(--viz-s2)", label: t("admin.scout.unmet") },
                  ]}
                />
                <h3 className={`text-sm font-medium ${TEXT}`}>{t("admin.scout.byHour")}</h3>
                <HourColumns data={data.scouts.demandByHour} tip={tip} label={t("admin.scout.requested")} />
              </Section>
            </div>

            {/* Issues */}
            <Section title={t("admin.issues.failures")}>
              <ActivityTable rows={data.recentFailures} t={t} fmt={fmt} />
            </Section>
            <Section title={t("admin.issues.stuck")}>
              <ActivityTable rows={data.health.stuckPending.rows} t={t} fmt={fmt} />
            </Section>
          </>
        )}
      </main>
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
