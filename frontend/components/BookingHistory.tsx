"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Chip,
  ListBox,
  ListBoxItem,
  Pagination,
  Select,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableContent,
  TableHeader,
  TableRow,
} from "@heroui/react";
import { ArrowRotateRight } from "@gravity-ui/icons";
import { api, type Booking } from "@/lib/api";

const STATUS: Record<
  Booking["status"],
  { label: string; color: "success" | "warning" | "danger" }
> = {
  ok: { label: "Thành công", color: "success" },
  pending: { label: "Đang chờ", color: "warning" },
  failed: { label: "Thất bại", color: "danger" },
};

// Mock filter options — wire to the backend later.
const TIME_RANGE_OPTS = [
  { value: "all", label: "Tất cả" },
  { value: "this_week", label: "Tuần này" },
  { value: "this_month", label: "Tháng này" },
];
const STATUS_OPTS = [
  { value: "all", label: "All" },
  { value: "ok", label: "Thành công" },
  { value: "pending", label: "Đang chờ" },
  { value: "failed", label: "Thất bại" },
];
const TYPE_OPTS = [
  { value: "all", label: "All" },
  { value: "instant", label: "Tức thì" },
  { value: "scheduled", label: "Đặt lịch" },
];
const METHOD_OPTS = [
  { value: "all", label: "All" },
  { value: "manual", label: "Thủ công" },
  { value: "chatbot", label: "Chatbot" },
];
const PAGE_SIZE_OPTS = [
  { value: "10", label: "10" },
  { value: "20", label: "20" },
  { value: "50", label: "50" },
];

// Module-level cache so switching tabs doesn't refetch every time. Survives
// remounts within a session; cleared on full reload. Call clearBookingHistoryCache()
// on logout to drop another user's data.
let cachedBookings: Booking[] | null = null;

export function clearBookingHistoryCache() {
  cachedBookings = null;
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
      <span className="whitespace-nowrap text-sm text-[#71717a]">{label}</span>
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
  const [bookings, setBookings] = useState<Booking[]>(cachedBookings ?? []);
  const [loading, setLoading] = useState(cachedBookings === null);
  const [error, setError] = useState<string | null>(null);

  // Filters (mock — client-side for now, move to BE later).
  const [timeRange, setTimeRange] = useState("all");
  const [status, setStatus] = useState("all");
  const [bookingType, setBookingType] = useState("all");
  const [method, setMethod] = useState("all");

  // Pagination.
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.myBookings();
      cachedBookings = res.bookings;
      setBookings(res.bookings);
    } catch (e: any) {
      setError(
        e.message === "UNAUTHENTICATED"
          ? "Phiên đăng nhập hết hạn."
          : e.message
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (cachedBookings === null) load();
  }, [load]);

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

  // Reset to first page whenever the result set or page size changes.
  useEffect(() => {
    setPage(1);
  }, [status, bookingType, method, timeRange, pageSize]);

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const startIdx = (safePage - 1) * pageSize;
  const pageItems = filtered.slice(startIdx, startIdx + pageSize);
  const rangeStart = total === 0 ? 0 : startIdx + 1;
  const rangeEnd = Math.min(startIdx + pageSize, total);

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <FilterSelect
          label="Time range"
          value={timeRange}
          onChange={setTimeRange}
          options={TIME_RANGE_OPTS}
        />
        <FilterSelect
          label="Status"
          value={status}
          onChange={setStatus}
          options={STATUS_OPTS}
        />
        <FilterSelect
          label="Booking Type"
          value={bookingType}
          onChange={setBookingType}
          options={TYPE_OPTS}
        />
        <FilterSelect
          label="Booking Method"
          value={method}
          onChange={setMethod}
          options={METHOD_OPTS}
        />
        <Button
          isIconOnly
          size="sm"
          variant="secondary"
          aria-label="Làm mới"
          className="ml-auto rounded-full"
          onPress={load}
          isDisabled={loading}
        >
          <ArrowRotateRight width={16} height={16} />
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-danger-200 bg-danger-50 px-4 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <Spinner />
          <span className="text-sm text-default-500">Đang tải lịch sử...</span>
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-auto">
            <Table variant="secondary">
              <TableContent aria-label="Lịch sử đặt phòng">
                <TableHeader>
                  <TableColumn isRowHeader>Ngày</TableColumn>
                  <TableColumn>Phòng</TableColumn>
                  <TableColumn>Thời gian</TableColumn>
                  <TableColumn>Tiêu đề</TableColumn>
                  <TableColumn>Loại</TableColumn>
                  <TableColumn>Nguồn</TableColumn>
                  <TableColumn>Trạng thái</TableColumn>
                </TableHeader>
                <TableBody
                  items={pageItems}
                  renderEmptyState={() => (
                    <span className="text-sm text-default-500">
                      Chưa có booking nào.
                    </span>
                  )}
                >
                  {(b) => (
                    <TableRow id={b.id}>
                      <TableCell>{b.date}</TableCell>
                      <TableCell>{b.room_name || b.room_email}</TableCell>
                      <TableCell>
                        {b.start_time} – {b.end_time}
                      </TableCell>
                      <TableCell>{b.subject || "—"}</TableCell>
                      <TableCell>
                        {b.booking_type === "scheduled" ? "Đặt lịch" : "Tức thì"}
                      </TableCell>
                      <TableCell>
                        {b.method === "chatbot" ? "Chatbot" : "Thủ công"}
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="sm"
                          variant="soft"
                          color={STATUS[b.status]?.color ?? "warning"}
                        >
                          {STATUS[b.status]?.label ?? b.status}
                        </Chip>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </TableContent>
            </Table>
          </div>

          {/* Pagination bar — the Pagination root is the full-width row (summary left, content right). */}
          <Pagination>
            <Pagination.Summary>
              <div className="flex items-center gap-2 text-sm text-[#71717a]">
                <span>Showing</span>
                <Select
                  aria-label="Số dòng mỗi trang"
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
                  {rangeStart}-{rangeEnd} of {total} results
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
                    Previous
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
                    Next
                    <Pagination.NextIcon />
                  </Pagination.Next>
                </Pagination.Item>
              </Pagination.Content>
            </Pagination>
        </>
      )}
    </div>
  );
}
