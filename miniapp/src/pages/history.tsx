import { useEffect, useState } from "react";

import PlanetEarth from "@gravity-ui/icons/PlanetEarth";
import Clock from "@gravity-ui/icons/Clock";
import MapPin from "@gravity-ui/icons/MapPin";
import ClockArrowRotateLeft from "@gravity-ui/icons/ClockArrowRotateLeft";

import MeetingDetail from "@/components/meeting-detail";
import { api, AuthError } from "@/services/api";
import type { BookingHistoryItem, BookingStatus, UpcomingEvent } from "@/types";

// Nhãn + class màu chip trạng thái — khớp label & màu bản web (frontend
// BookingHistory: success=xanh lá, ok/pending=vàng, failed=đỏ, canceled=xám).
const STATUS_META: Record<BookingStatus, { label: string; className: string }> =
  {
    success: { label: "Thành công", className: "history-chip--success" },
    ok: { label: "Chờ phản hồi", className: "history-chip--pending" },
    pending: { label: "Đang chờ", className: "history-chip--pending" },
    failed: { label: "Thất bại", className: "history-chip--failed" },
    canceled: { label: "Đã hủy", className: "history-chip--canceled" },
  };

// Bộ lọc theo thời gian (Figma 346-1292): tất cả / sắp tới / đã qua.
type TabKey = "all" | "upcoming" | "past";
const TABS: { key: TabKey; label: string }[] = [
  { key: "all", label: "Tất cả" },
  { key: "upcoming", label: "Sắp tới" },
  { key: "past", label: "Đã qua" },
];

// "2026-07-22" -> "22/7" (khớp Figma: bỏ số 0 ở đầu, 1 dấu gạch).
function formatShortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return d && m ? `${Number(d)}/${Number(m)}` : iso;
}

// "14:00:00" / "14:00" -> "14:00".
function hhmm(time?: string | null): string {
  return (time || "").slice(0, 5);
}

// Cuộc họp đã kết thúc? (dùng phân loại "sắp tới" vs "đã qua").
function isPast(item: BookingHistoryItem): boolean {
  const end = new Date(`${item.date}T${hhmm(item.end_time)}:00`);
  return !Number.isNaN(end.getTime()) && end.getTime() < Date.now();
}

// Dựng UpcomingEvent để mở màn "Chi tiết lịch họp" (dùng chung component với
// mục "Lịch sắp tới" ngoài Home).
function toEvent(item: BookingHistoryItem): UpcomingEvent {
  return {
    room_name: item.room_name,
    room_email: item.room_email,
    date: item.date,
    start_time: hhmm(item.start_time),
    end_time: hhmm(item.end_time),
    subject: item.subject,
    location: item.location,
    image: item.image,
    office: item.office,
    map: item.map,
    attendees: item.attendees,
    body: item.body,
  };
}

// Tab "Lịch sử đặt phòng" (Figma 346-1292): header xanh + tab lọc + danh sách
// thẻ lịch sử (nối BE qua GET /api/bookings). Bấm 1 thẻ → màn chi tiết lịch họp.
export default function HistoryPage() {
  const [items, setItems] = useState<BookingHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<TabKey>("all");
  const [selected, setSelected] = useState<BookingHistoryItem | null>(null);

  async function load() {
    setLoading(true);
    setError(false);
    try {
      const { bookings } = await api.bookingHistory();
      setItems(bookings);
    } catch (e) {
      if (!(e instanceof AuthError)) setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const filtered = items.filter((item) =>
    tab === "all" ? true : tab === "past" ? isPast(item) : !isPast(item),
  );

  return (
    <div className="history">
      <header className="history__header">
        <span className="history__header-title">Lịch sử đặt phòng</span>
      </header>

      <div className="history__tabs">
        {TABS.map((tabItem) => (
          <button
            key={tabItem.key}
            type="button"
            className={`history-tab${tab === tabItem.key ? " is-active" : ""}`}
            onClick={() => setTab(tabItem.key)}
          >
            {tabItem.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="history__list">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={`skeleton-${i}`} className="history-card">
              <div className="history-card__media skeleton" />
              <div className="history-card__body">
                <div className="skeleton skeleton--line skeleton--name" />
                <div className="skeleton skeleton--line skeleton--time" />
                <div className="skeleton skeleton--line skeleton--time" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="history__empty">
          <ClockArrowRotateLeft width={40} height={40} />
          <div className="history__empty-title">Không tải được lịch sử</div>
          <button className="fr__retry" type="button" onClick={() => void load()}>
            Thử lại
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="history__empty">
          <ClockArrowRotateLeft width={40} height={40} />
          <div className="history__empty-title">Chưa có lịch sử</div>
          <div>Các phòng bạn đã đặt sẽ hiển thị ở đây.</div>
        </div>
      ) : (
        <div className="history__list">
          {filtered.map((item) => {
            const status = STATUS_META[item.status] ?? STATUS_META.pending;
            return (
              <div
                key={item.id}
                className="history-card"
                role="button"
                tabIndex={0}
                onClick={() => setSelected(item)}
              >
                <div
                  className="history-card__media"
                  style={
                    item.image
                      ? { backgroundImage: `url(${item.image})` }
                      : undefined
                  }
                />
                <div className="history-card__body">
                  <div className="history-card__title">
                    {item.subject || "Cuộc họp"}
                  </div>
                  <span className={`history-chip ${status.className}`}>
                    {status.label}
                  </span>
                  <div className="history-card__info">
                    {item.room_name && (
                      <div className="history-card__row">
                        <PlanetEarth width={16} height={16} />
                        <span>{item.room_name}</span>
                      </div>
                    )}
                    <div className="history-card__row">
                      <Clock width={16} height={16} />
                      <span>
                        {formatShortDate(item.date)} • {hhmm(item.start_time)} -{" "}
                        {hhmm(item.end_time)}
                      </span>
                    </div>
                    {item.location && (
                      <div className="history-card__row">
                        <MapPin width={16} height={16} />
                        <span>{item.location}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selected && (
        <MeetingDetail
          event={toEvent(selected)}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
