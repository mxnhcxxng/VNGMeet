"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Key } from "react";
import {
  Button,
  Chip,
  EmptyState,
  ListBox,
  ListBoxItem,
  Pagination,
  Select,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableContent,
  TableHeader,
  TableRow,
  Tooltip,
  toast,
} from "@heroui/react";
import {
  ArrowsRotateRight,
  Ban,
  Binoculars,
  Clock,
  Comments,
  Magnifier,
  Pencil,
} from "@gravity-ui/icons";
import { api, type Booking } from "@/lib/api";
import { roomFlag } from "@/lib/roomFlags";
import { useT } from "@/app/providers";
import type { TFunction, TranslationKey } from "@/lib/i18n";
import { EditBookingModal } from "./EditBookingModal";
import { patchUrlParams, readUrlParams } from "@/lib/urlState";

const STATUS_COLOR: Record<
  Booking["status"],
  "success" | "warning" | "danger" | "default"
> = {
  success: "success",
  ok: "warning",
  pending: "warning",
  failed: "danger",
  canceled: "default",
};

const STATUS_LABEL_KEY: Record<Booking["status"], TranslationKey> = {
  success: "bh.statusSuccess",
  ok: "bh.statusAwaiting",
  pending: "bh.statusPending",
  failed: "bh.statusFailed",
  canceled: "bh.statusCanceled",
};

const PAGE_SIZE_OPTS = [
  { value: "10", label: "10" },
  { value: "20", label: "20" },
  { value: "50", label: "50" },
];

// Background poll cadence. Matches the backend calendar-sync throttle (~1/min),
// so polling faster wouldn't surface fresher room responses anyway.
const REFRESH_INTERVAL_MS = 60 * 1000;

// Module-level cache so switching tabs doesn't refetch every time. Survives
// remounts within a session; cleared on full reload. Call clearBookingHistoryCache()
// on logout to drop another user's data.
let cachedBookings: Booking[] | null = null;

type SortState = { column: string; direction: "ascending" | "descending" };

// Default sort mirrors the backend default (newest first).
const DEFAULT_SORT: SortState = { column: "date", direction: "descending" };
let cachedSort: SortState = DEFAULT_SORT;

export function clearBookingHistoryCache() {
  cachedBookings = null;
  cachedSort = DEFAULT_SORT;
}

type Option = { value: string; label: string };

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Option[];
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="whitespace-nowrap text-sm text-[#71717a] dark:text-[#94979c]">{label}</span>
      <Select
        aria-label={label}
        variant="secondary"
        selectedKey={value}
        onSelectionChange={(k) => onChange(String(k))}
      >
        <Select.Trigger className="min-w-[110px]">
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

// Build a compact page list with ellipses, e.g. [1, '...', 4, 5, 6, '...', 12].
function pageList(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const window: number[] = [];
  for (
    let i = Math.max(2, current - 1);
    i <= Math.min(total - 1, current + 1);
    i++
  )
    window.push(i);
  const out: (number | "…")[] = [1];
  if (window[0] > 2) out.push("…");
  out.push(...window);
  if (window[window.length - 1] < total - 1) out.push("…");
  out.push(total);
  return out;
}

// A booking is "past" once its end datetime is before now — those can no longer
// be edited or cancelled.
function isPastBooking(b: Booking): boolean {
  const end = new Date(`${b.date}T${b.end_time}:00`);
  if (Number.isNaN(end.getTime())) return false;
  return end.getTime() < Date.now();
}

// Replaces the (hidden) booking-type and method columns with small orange icons
// shown beside the subject. Type and method are independent, so a booking can
// carry two icons: a clock (scheduled) or binoculars (scout) for the type, plus
// a comment bubble when it was created via the chatbot. Instant / manual add no
// icon. Each icon keeps its own label available on hover so no info is lost.
function bookingIndicators(
  b: Booking,
  t: TFunction
): { key: string; Icon: typeof Clock; label: string }[] {
  const out: { key: string; Icon: typeof Clock; label: string }[] = [];
  if (b.booking_type === "scheduled")
    out.push({ key: "type", Icon: Clock, label: t("bh.typeScheduled") });
  else if (b.booking_type === "scout")
    out.push({ key: "type", Icon: Binoculars, label: t("bh.typeScout") });
  if (b.method === "chatbot")
    out.push({ key: "method", Icon: Comments, label: t("bh.methodChatbot") });
  return out;
}

function withinTimeRange(dateStr: string, range: string): boolean {
  if (range === "all") return true;
  const d = new Date(dateStr + "T00:00:00");
  if (Number.isNaN(d.getTime())) return true;
  const now = new Date();
  if (range === "this_month") {
    return (
      d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
    );
  }
  // this_week: Monday–Sunday containing today.
  const day = (now.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - day);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return d >= monday && d <= sunday;
}

// Placeholder layout — uses HeroUI's table as-is. Styling to be refined later.
export function BookingHistory() {
  const t = useT();
  const TIME_RANGE_OPTS = [
    { value: "all", label: t("bh.all") },
    { value: "this_week", label: t("bh.thisWeek") },
    { value: "this_month", label: t("bh.thisMonth") },
  ];
  const STATUS_OPTS = [
    { value: "all", label: t("bh.all") },
    { value: "success", label: t("bh.statusSuccess") },
    { value: "ok", label: t("bh.statusAwaiting") },
    { value: "pending", label: t("bh.statusPending") },
    { value: "failed", label: t("bh.statusFailed") },
    { value: "canceled", label: t("bh.statusCanceled") },
  ];
  const TYPE_OPTS = [
    { value: "all", label: t("bh.all") },
    { value: "instant", label: t("bh.typeInstant") },
    { value: "scheduled", label: t("bh.typeScheduled") },
    { value: "scout", label: t("bh.typeScout") },
  ];
  const METHOD_OPTS = [
    { value: "all", label: t("bh.all") },
    { value: "manual", label: t("bh.methodManual") },
    { value: "chatbot", label: t("bh.methodChatbot") },
  ];
  const [bookings, setBookings] = useState<Booking[]>(cachedBookings ?? []);
  const [loading, setLoading] = useState(cachedBookings === null);
  const [error, setError] = useState<string | null>(null);

  // Seed the filters / sort / pagination from the URL query once, so a shared
  // link or a refresh reproduces the same view. Reading window here is safe:
  // this screen only ever mounts on the client (it's gated behind auth), so it
  // is never part of the server-rendered HTML.
  const [initialParams] = useState(() => readUrlParams());

  // Filters (mock — client-side for now, move to BE later).
  const [timeRange, setTimeRange] = useState(
    () => initialParams.get("range") ?? "all",
  );
  const [status, setStatus] = useState(() => initialParams.get("status") ?? "all");
  const [bookingType, setBookingType] = useState(
    () => initialParams.get("type") ?? "all",
  );
  const [method, setMethod] = useState(() => initialParams.get("method") ?? "all");

  // Sorting is applied server-side (the API re-orders the rows). The ref lets
  // the stable `load` callback read the latest descriptor without re-creating.
  const [sortDescriptor, setSortDescriptor] = useState<SortState>(() => {
    const column = initialParams.get("sort");
    if (!column) return cachedSort;
    return {
      column,
      direction: initialParams.get("order") === "asc" ? "ascending" : "descending",
    };
  });
  const sortRef = useRef(sortDescriptor);
  sortRef.current = sortDescriptor;

  // Pagination.
  const [pageSize, setPageSize] = useState(() => {
    const n = Number(initialParams.get("size"));
    return PAGE_SIZE_OPTS.some((o) => Number(o.value) === n) ? n : 10;
  });
  const [page, setPage] = useState(() => {
    const n = Number(initialParams.get("page"));
    return Number.isInteger(n) && n >= 1 ? n : 1;
  });

  // Room thumbnails (email → thumbnail_link) so the edit card can show the photo.
  const [roomThumbs, setRoomThumbs] = useState<Record<string, string>>({});

  // Row actions.
  const [editing, setEditing] = useState<Booking | null>(null);
  const [canceling, setCanceling] = useState<Booking | null>(null);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = sortRef.current;
      const res = await api.myBookings({
        sort: s.column,
        order: s.direction === "ascending" ? "asc" : "desc",
      });
      cachedBookings = res.bookings;
      cachedSort = s;
      setBookings(res.bookings);
    } catch (e: any) {
      const expired = e.message === "UNAUTHENTICATED";
      setError(expired ? t("bh.sessionExpired") : e.message);
      toast.danger(t("bh.loadFailed"), {
        description: expired
          ? t("bh.loadFailedAuthDesc")
          : t("bh.loadFailedDesc"),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  // Silent background refetch — updates the rows in place without the skeleton or
  // the dimmed-loading state, so it never interrupts what the user is doing.
  const silentRefresh = useCallback(async () => {
    const s = sortRef.current;
    try {
      const res = await api.myBookings({
        sort: s.column,
        order: s.direction === "ascending" ? "asc" : "desc",
      });
      cachedBookings = res.bookings;
      setBookings(res.bookings);
    } catch {
      /* keep showing current rows; manual refresh surfaces errors */
    }
  }, []);

  useEffect(() => {
    if (cachedBookings === null) {
      load();
      return;
    }
    // Stale-while-revalidate: render the cached rows instantly, then refetch in
    // the background (no spinner) so statuses changed server-side — e.g. a booking
    // deleted in Outlook and auto-canceled by the calendar sync — show up on every
    // visit to this tab without needing a manual refresh.
    silentRefresh();
  }, [load, silentRefresh]);

  // Keep the list fresh while the tab stays open: async room responses (pending
  // -> success/failed, declined -> canceled) land without a manual refresh. Poll
  // on an interval and whenever the tab regains visibility, but only while
  // visible so a backgrounded tab doesn't hammer the API.
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") silentRefresh();
    };
    const interval = window.setInterval(refreshWhenVisible, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [silentRefresh]);

  // Load room thumbnails once so the edit card can render the room photo.
  useEffect(() => {
    api
      .rooms()
      .then((rooms) => {
        const map: Record<string, string> = {};
        for (const r of rooms) {
          if (r.thumbnail_link) map[r.email.toLowerCase()] = r.thumbnail_link;
        }
        setRoomThumbs(map);
      })
      .catch(() => {});
  }, []);

  const confirmCancel = useCallback(async () => {
    if (!canceling) return;
    setCancelLoading(true);
    setCancelError(null);
    try {
      await api.cancelBooking(canceling.id);
      setCanceling(null);
      toast.success(t("bh.canceled"), {
        description: t("bh.canceledDesc"),
      });
      await load();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const expired = msg === "UNAUTHENTICATED";
      setCancelError(
        expired ? t("bh.cancelErrorAuth") : t("bh.cancelErrorGeneric", { msg })
      );
      toast.danger(t("bh.cancelFailed"), {
        description: expired
          ? t("bh.cancelFailedAuthDesc")
          : t("bh.cancelFailedDesc"),
      });
    } finally {
      setCancelLoading(false);
    }
  }, [canceling, load]);

  const handleSortChange = useCallback(
    (desc: { column?: Key; direction?: "ascending" | "descending" }) => {
      const next: SortState = {
        column: String(desc.column ?? DEFAULT_SORT.column),
        direction: desc.direction ?? "ascending",
      };
      setSortDescriptor(next);
      sortRef.current = next;
      load();
    },
    [load]
  );

  const filtered = useMemo(
    () =>
      bookings.filter(
        (b) =>
          (status === "all" || b.status === status) &&
          (bookingType === "all" || b.booking_type === bookingType) &&
          (method === "all" || b.method === method) &&
          withinTimeRange(b.date, timeRange)
      ),
    [bookings, status, bookingType, method, timeRange]
  );

  // Reset to first page whenever the result set or page size changes — but skip
  // the very first run so a page hydrated from the URL isn't clobbered on mount.
  const filtersMountedRef = useRef(false);
  useEffect(() => {
    if (!filtersMountedRef.current) {
      filtersMountedRef.current = true;
      return;
    }
    setPage(1);
  }, [status, bookingType, method, timeRange, pageSize]);

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const startIdx = (safePage - 1) * pageSize;
  const pageItems = filtered.slice(startIdx, startIdx + pageSize);
  const rangeStart = total === 0 ? 0 : startIdx + 1;
  const rangeEnd = Math.min(startIdx + pageSize, total);

  // Mirror the current filters / sort / pagination back into the URL. Defaults
  // are written as null so they drop out and the URL stays clean. safePage (not
  // the raw page) keeps the URL in step with what's actually shown.
  useEffect(() => {
    patchUrlParams({
      status: status === "all" ? null : status,
      type: bookingType === "all" ? null : bookingType,
      method: method === "all" ? null : method,
      range: timeRange === "all" ? null : timeRange,
      sort:
        sortDescriptor.column === DEFAULT_SORT.column &&
        sortDescriptor.direction === DEFAULT_SORT.direction
          ? null
          : sortDescriptor.column,
      order:
        sortDescriptor.column === DEFAULT_SORT.column &&
        sortDescriptor.direction === DEFAULT_SORT.direction
          ? null
          : sortDescriptor.direction === "ascending"
            ? "asc"
            : "desc",
      size: pageSize === 10 ? null : String(pageSize),
      page: safePage <= 1 ? null : String(safePage),
    });
  }, [
    status,
    bookingType,
    method,
    timeRange,
    sortDescriptor,
    pageSize,
    safePage,
  ]);

  // Show the skeleton table only on the very first load. Subsequent refetches
  // (sort / refresh) keep the existing rows on screen and just dim them, so the
  // table doesn't flash an empty state on every sort.
  const initialLoading = loading && bookings.length === 0;
  // Placeholder rows for the loading skeleton — mirrors the page size (capped)
  // so the table fills roughly the same height it will once data arrives.
  const skeletonRows = useMemo(
    () =>
      Array.from({ length: Math.min(pageSize, 10) }, (_, i) => ({
        id: `skeleton-${i}`,
      })),
    [pageSize]
  );

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4">
        <FilterSelect
          label={t("bh.filterTimeRange")}
          value={timeRange}
          onChange={setTimeRange}
          options={TIME_RANGE_OPTS}
        />
        <FilterSelect
          label={t("bh.filterStatus")}
          value={status}
          onChange={setStatus}
          options={STATUS_OPTS}
        />
        <FilterSelect
          label={t("bh.filterType")}
          value={bookingType}
          onChange={setBookingType}
          options={TYPE_OPTS}
        />
        <FilterSelect
          label={t("bh.filterMethod")}
          value={method}
          onChange={setMethod}
          options={METHOD_OPTS}
        />
        <Button
          isIconOnly
          size="sm"
          variant="tertiary"
          aria-label={t("bh.refresh")}
          className="ml-auto rounded-full"
          onPress={load}
          isDisabled={loading}
        >
          <ArrowsRotateRight width={16} height={16} />
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-danger-200 bg-danger-50 px-4 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {initialLoading ? (
        <div className="min-h-0 flex-1 overflow-auto" aria-hidden>
          <Table variant="secondary">
            <TableContent aria-label={t("bh.tableLabel")}>
              <TableHeader>
                <TableColumn id="date" isRowHeader>
                  {t("bh.colDate")}
                </TableColumn>
                <TableColumn id="room">{t("bh.colRoom")}</TableColumn>
                <TableColumn id="time">{t("bh.colTime")}</TableColumn>
                <TableColumn id="subject">{t("bh.colSubject")}</TableColumn>
                <TableColumn id="status">{t("bh.colStatus")}</TableColumn>
                <TableColumn id="actions">{t("bh.colActions")}</TableColumn>
              </TableHeader>
              <TableBody items={skeletonRows}>
                {(row) => (
                  <TableRow id={row.id}>
                    <TableCell>
                      <div className="h-3 w-20 animate-pulse rounded-full bg-default" />
                    </TableCell>
                    <TableCell>
                      <div className="h-3 w-28 animate-pulse rounded-full bg-default" />
                    </TableCell>
                    <TableCell>
                      <div className="h-3 w-24 animate-pulse rounded-full bg-default" />
                    </TableCell>
                    <TableCell>
                      <div className="h-3 w-40 animate-pulse rounded-full bg-default" />
                    </TableCell>
                    <TableCell>
                      <div className="h-5 w-16 animate-pulse rounded-full bg-default" />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <div className="size-8 animate-pulse rounded-full bg-default" />
                        <div className="size-8 animate-pulse rounded-full bg-default" />
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </TableContent>
          </Table>
        </div>
      ) : (
        <>
          {total === 0 ? (
            <EmptyState className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 py-0 text-center">
              <Magnifier
                width={28}
                height={28}
                className="mb-2 text-[#a4a7ae] dark:text-[#94979c]"
              />
              <p className="text-base font-semibold text-[#181d27] dark:text-[#f7f7f7]">
                {t("bh.noResults")}
              </p>
              <p className="text-sm text-[#71717a] dark:text-[#94979c]">
                {t("bh.noResultsHint")}
              </p>
            </EmptyState>
          ) : (
            <div
              className={`min-h-0 flex-1 overflow-auto transition-opacity duration-200 ${
                loading ? "pointer-events-none opacity-60" : "opacity-100"
              }`}
            >
              <Table variant="secondary">
                <TableContent
                  aria-label={t("bh.tableLabel")}
                  sortDescriptor={sortDescriptor}
                  onSortChange={handleSortChange}
                >
                  <TableHeader>
                    <TableColumn id="date" isRowHeader allowsSorting>
                      {({ sortDirection }) => (
                        <Table.SortableColumnHeader sortDirection={sortDirection}>
                          {t("bh.colDate")}
                        </Table.SortableColumnHeader>
                      )}
                    </TableColumn>
                    <TableColumn id="room" allowsSorting>
                      {({ sortDirection }) => (
                        <Table.SortableColumnHeader sortDirection={sortDirection}>
                          {t("bh.colRoom")}
                        </Table.SortableColumnHeader>
                      )}
                    </TableColumn>
                    <TableColumn id="time" allowsSorting>
                      {({ sortDirection }) => (
                        <Table.SortableColumnHeader sortDirection={sortDirection}>
                          {t("bh.colTime")}
                        </Table.SortableColumnHeader>
                      )}
                    </TableColumn>
                    <TableColumn id="subject" allowsSorting>
                      {({ sortDirection }) => (
                        <Table.SortableColumnHeader sortDirection={sortDirection}>
                          {t("bh.colSubject")}
                        </Table.SortableColumnHeader>
                      )}
                    </TableColumn>
                    <TableColumn id="status" allowsSorting>
                      {({ sortDirection }) => (
                        <Table.SortableColumnHeader sortDirection={sortDirection}>
                          {t("bh.colStatus")}
                        </Table.SortableColumnHeader>
                      )}
                    </TableColumn>
                    <TableColumn id="actions">{t("bh.colActions")}</TableColumn>
                  </TableHeader>
                  <TableBody items={pageItems}>
                  {(b) => (
                    <TableRow id={b.id}>
                      <TableCell>{b.date}</TableCell>
                      <TableCell>
                        {roomFlag(b.room_name) && (
                          <span className="mr-2">{roomFlag(b.room_name)}</span>
                        )}
                        {b.room_name || b.room_email}
                      </TableCell>
                      <TableCell>
                        {b.start_time} – {b.end_time}
                      </TableCell>
                      <TableCell className="max-w-[200px]">
                        <div className="flex items-center gap-1.5">
                          {bookingIndicators(b, t).map(({ key, Icon, label }) => (
                            <Tooltip key={key} delay={200}>
                              <Tooltip.Trigger className="inline-flex shrink-0">
                                <Icon
                                  width={16}
                                  height={16}
                                  className="text-[#f97316]"
                                  aria-label={label}
                                />
                              </Tooltip.Trigger>
                              <Tooltip.Content>{label}</Tooltip.Content>
                            </Tooltip>
                          ))}
                          <span className="block truncate" title={b.subject || undefined}>
                            {b.subject || "—"}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="sm"
                          variant="soft"
                          color={STATUS_COLOR[b.status] ?? "warning"}
                        >
                          {STATUS_LABEL_KEY[b.status]
                            ? t(STATUS_LABEL_KEY[b.status])
                            : b.status}
                        </Chip>
                      </TableCell>
                      <TableCell>
                        {(() => {
                          const actionsDisabled =
                            b.status === "failed" ||
                            b.status === "canceled" ||
                            isPastBooking(b);
                          return (
                        <div className="flex items-center gap-1">
                          <Button
                            isIconOnly
                            size="sm"
                            variant="ghost"
                            aria-label={t("bh.editBooking")}
                            className="rounded-full"
                            isDisabled={actionsDisabled}
                            onPress={() => setEditing(b)}
                          >
                            <Pencil width={16} height={16} />
                          </Button>
                          <Button
                            isIconOnly
                            size="sm"
                            variant="ghost"
                            aria-label={t("bh.cancelBooking")}
                            className="rounded-full text-danger"
                            isDisabled={actionsDisabled}
                            onPress={() => {
                              setCancelError(null);
                              setCanceling(b);
                            }}
                          >
                            <Ban width={16} height={16} />
                          </Button>
                        </div>
                          );
                        })()}
                      </TableCell>
                    </TableRow>
                  )}
                  </TableBody>
                </TableContent>
              </Table>
            </div>
          )}

          {/* Pagination bar — the Pagination root is the full-width row (summary left, content right). */}
          <Pagination>
            <Pagination.Summary>
              <div className="flex items-center gap-2 text-sm text-[#71717a] dark:text-[#94979c]">
                <span>{t("bh.showing")}</span>
                <Select
                  aria-label={t("bh.rowsPerPage")}
                  variant="secondary"
                  selectedKey={String(pageSize)}
                  onSelectionChange={(k) => setPageSize(Number(k))}
                >
                  <Select.Trigger className="min-w-[72px]">
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {PAGE_SIZE_OPTS.map((o) => (
                        <ListBoxItem key={o.value} id={o.value}>
                          {o.label}
                        </ListBoxItem>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
                <span>
                  {t("bh.resultsRange", {
                    start: rangeStart,
                    end: rangeEnd,
                    total,
                  })}
                </span>
              </div>
            </Pagination.Summary>
            <Pagination.Content>
                <Pagination.Item>
                  <Pagination.Previous
                    onPress={() => setPage((p) => Math.max(1, p - 1))}
                    isDisabled={safePage <= 1}
                  >
                    <Pagination.PreviousIcon />
                    {t("bh.previous")}
                  </Pagination.Previous>
                </Pagination.Item>
                {pageList(safePage, totalPages).map((p, i) => (
                  <Pagination.Item key={`${p}-${i}`}>
                    {p === "…" ? (
                      <Pagination.Ellipsis />
                    ) : (
                      <Pagination.Link
                        isActive={p === safePage}
                        onPress={() => setPage(p)}
                      >
                        {p}
                      </Pagination.Link>
                    )}
                  </Pagination.Item>
                ))}
                <Pagination.Item>
                  <Pagination.Next
                    onPress={() => setPage((p) => Math.min(totalPages, p + 1))}
                    isDisabled={safePage >= totalPages}
                  >
                    {t("bh.next")}
                    <Pagination.NextIcon />
                  </Pagination.Next>
                </Pagination.Item>
              </Pagination.Content>
            </Pagination>
        </>
      )}

      <EditBookingModal
        isOpen={editing !== null}
        booking={editing}
        thumbnail={editing ? roomThumbs[editing.room_email.toLowerCase()] : undefined}
        onClose={() => setEditing(null)}
        onSaved={load}
      />

      {canceling && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !cancelLoading) setCanceling(null);
          }}
        >
          <div className="flex w-full max-w-[440px] flex-col gap-4 rounded-2xl bg-white p-6 shadow-2xl dark:bg-[#0c0e12]">
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-semibold text-default-900">{t("bh.cancelTitle")}</h2>
              <p className="text-sm text-default-500">
                {canceling.booking_type === "scheduled"
                  ? t("bh.cancelScheduledDesc")
                  : t("bh.cancelInstantDesc")}
              </p>
            </div>
            <div className="rounded-lg bg-default-100 px-3 py-2 text-sm text-default-700">
              <div className="font-medium">{canceling.room_name || canceling.room_email}</div>
              <div className="text-default-500">
                {canceling.date} · {canceling.start_time} – {canceling.end_time}
              </div>
            </div>
            {cancelError && <p className="text-sm text-danger">{cancelError}</p>}
            <div className="flex items-center justify-center gap-2 pt-2">
              <Button
                variant="tertiary"
                className="flex-1 rounded-full"
                onPress={() => setCanceling(null)}
                isDisabled={cancelLoading}
              >
                {t("bh.keepBooking")}
              </Button>
              <Button
                variant="danger"
                className="flex-1 rounded-full"
                onPress={confirmCancel}
                isPending={cancelLoading}
              >
                {t("bh.cancelBooking")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
