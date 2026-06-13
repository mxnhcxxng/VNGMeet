"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Chip,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableContent,
  TableHeader,
  TableRow,
} from "@heroui/react";
import { api, type Booking } from "@/lib/api";

const STATUS: Record<
  Booking["status"],
  { label: string; color: "success" | "warning" | "danger" }
> = {
  ok: { label: "Thành công", color: "success" },
  pending: { label: "Đang chờ", color: "warning" },
  failed: { label: "Thất bại", color: "danger" },
};

// Module-level cache so switching tabs doesn't refetch every time. Survives
// remounts within a session; cleared on full reload. Call clearBookingHistoryCache()
// on logout to drop another user's data.
let cachedBookings: Booking[] | null = null;

export function clearBookingHistoryCache() {
  cachedBookings = null;
}

// Placeholder layout — uses HeroUI's table as-is. Styling to be refined later.
export function BookingHistory() {
  const [bookings, setBookings] = useState<Booking[]>(cachedBookings ?? []);
  const [loading, setLoading] = useState(cachedBookings === null);
  const [error, setError] = useState<string | null>(null);

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
    // Only fetch the first time; later tab switches reuse the cache. Use "Làm mới" to refresh.
    if (cachedBookings === null) load();
  }, [load]);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-[#18181b]">Lịch sử đặt phòng</h1>
        <Button size="sm" variant="outline" onPress={load} isDisabled={loading}>
          Làm mới
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
        <div className="min-h-0 flex-1 overflow-auto">
          <Table>
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
                items={bookings}
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
      )}
    </div>
  );
}
