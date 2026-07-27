import { useEffect, useState } from "react";

import PlanetEarth from "@gravity-ui/icons/PlanetEarth";
import Clock from "@gravity-ui/icons/Clock";
import MapPin from "@gravity-ui/icons/MapPin";
import ClockArrowRotateLeft from "@gravity-ui/icons/ClockArrowRotateLeft";

import MeetingDetail from "@/components/meeting-detail";
import SwipeViews from "@/components/swipe-views";
import { api, AuthError } from "@/services/api";
import { roomFlag } from "@/services/room-flags";
import { useT } from "@/services/settings";
import type { TranslationKey } from "@/services/i18n";
import type { BookingHistoryItem, BookingStatus, UpcomingEvent } from "@/types";

// Key dịch nhãn + class màu chip trạng thái — khớp màu bản web (frontend
// BookingHistory: success=xanh lá, ok/pending=vàng, failed=đỏ, canceled=xám).
const STATUS_META: Record<
  BookingStatus,
  { labelKey: TranslationKey; className: string }
> = {
  success: { labelKey: "status.success", className: "history-chip--success" },
  ok: { labelKey: "status.awaiting", className: "history-chip--pending" },
  pending: { labelKey: "status.pending", className: "history-chip--pending" },
  failed: { labelKey: "status.failed", className: "history-chip--failed" },
  canceled: { labelKey: "status.canceled", className: "history-chip--canceled" },
};

// Bộ lọc theo thời gian (Figma 346-1292): tất cả / sắp tới / đã qua.
type TabKey = "all" | "upcoming" | "past";
const TABS: { key: TabKey; labelKey: TranslationKey }[] = [
  { key: "all", labelKey: "history.all" },
  { key: "upcoming", labelKey: "history.upcoming" },
  { key: "past", labelKey: "history.past" },
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

// Cache cấp module: đổi tab dưới (Home/History/Account) làm unmount trang nên
// state mất; giữ ở đây để quay lại render tức thì rồi revalidate ngầm (giống web
// BookingHistory). Sống trong phiên, không persist khi reload app.
let cachedBookings: BookingHistoryItem[] | null = null;

// Tab "Lịch sử đặt phòng" (Figma 346-1292): header xanh + tab lọc + danh sách
// thẻ lịch sử (nối BE qua GET /api/bookings). Bấm 1 thẻ → màn chi tiết lịch họp.
export default function HistoryPage() {
  const t = useT();
  const [items, setItems] = useState<BookingHistoryItem[]>(cachedBookings ?? []);
  // Skeleton chỉ hiện lần đầu chưa có cache; có cache thì render ngay + nạp ngầm.
  const [loading, setLoading] = useState(cachedBookings === null);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<TabKey>("all");
  const [selected, setSelected] = useState<BookingHistoryItem | null>(null);

  async function load() {
    if (cachedBookings === null) setLoading(true);
    setError(false);
    try {
      const { bookings } = await api.bookingHistory();
      cachedBookings = bookings;
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

  const tabIndex = Math.max(
    0,
    TABS.findIndex((tabItem) => tabItem.key === tab),
  );

  function itemsFor(key: TabKey): BookingHistoryItem[] {
    return items.filter((item) =>
      key === "all" ? true : key === "past" ? isPast(item) : !isPast(item),
    );
  }

  function renderCard(item: BookingHistoryItem) {
    const status = STATUS_META[item.status] ?? STATUS_META.pending;
    const flag = roomFlag(item.room_name);
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
            item.image ? { backgroundImage: `url(${item.image})` } : undefined
          }
        />
        <div className="history-card__body">
          <div className="history-card__title">
            {item.subject || t("common.meeting")}
          </div>
          <span className={`history-chip ${status.className}`}>
            {t(status.labelKey)}
          </span>
          <div className="history-card__info">
            {item.room_name && (
              <div className="history-card__row">
                <PlanetEarth width={16} height={16} />
                <span>
                  {flag && `${flag} `}
                  {item.room_name}
                </span>
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
  }

  function renderPanel(key: TabKey) {
    const list = itemsFor(key);
    if (list.length === 0) {
      return (
        <div className="history__empty">
          <ClockArrowRotateLeft width={40} height={40} />
          <div className="history__empty-title">{t("history.empty")}</div>
          <div>{t("history.emptyHint")}</div>
        </div>
      );
    }
    return <div className="history__list">{list.map(renderCard)}</div>;
  }

  return (
    <div className="history">
      <header className="history__header">
        <span className="history__header-title">{t("history.title")}</span>
      </header>

      <div className="history__tabs">
        {TABS.map((tabItem) => (
          <button
            key={tabItem.key}
            type="button"
            className={`history-tab${tab === tabItem.key ? " is-active" : ""}`}
            onClick={() => setTab(tabItem.key)}
          >
            {t(tabItem.labelKey)}
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
          <div className="history__empty-title">{t("history.loadFailed")}</div>
          <button className="fr__retry" type="button" onClick={() => void load()}>
            {t("common.retry")}
          </button>
        </div>
      ) : (
        <SwipeViews
          autoHeight
          index={tabIndex}
          onIndexChange={(i) => setTab(TABS[i].key)}
        >
          {TABS.map((tabItem) => (
            <div key={tabItem.key}>{renderPanel(tabItem.key)}</div>
          ))}
        </SwipeViews>
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
