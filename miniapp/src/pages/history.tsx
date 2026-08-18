import { useEffect, useState } from "react";

import PlanetEarth from "@gravity-ui/icons/PlanetEarth";
import Clock from "@gravity-ui/icons/Clock";
import MapPin from "@gravity-ui/icons/MapPin";
import ClockArrowRotateLeft from "@gravity-ui/icons/ClockArrowRotateLeft";

import MeetingDetail from "@/components/meeting-detail";
import SwipeViews from "@/components/swipe-views";
import EmptyIllustration from "@/components/empty-illustration";
import RoomScout, {
  buildScoutPrefill,
  loadHasActiveScout,
  peekHasActiveScout,
} from "@/pages/room-scout";
import { api, AuthError } from "@/services/api";
import {
  findRoom,
  loadRoomDirectory,
  peekRoomDirectory,
} from "@/services/room-directory";
import { roomFlag } from "@/services/room-flags";
import { useT } from "@/services/settings";
import type { TFunction, TranslationKey } from "@/services/i18n";
import type {
  BookingHistoryItem,
  BookingStatus,
  CapacitySize,
  ScoutPrefill,
  UpcomingEvent,
} from "@/types";

// Key dịch nhãn + class màu chip trạng thái — khớp màu bản web (frontend
// BookingHistory: success/ongoing=xanh lá, ok/pending=vàng, failed=đỏ,
// finished=xanh dương, canceled=xám).
const STATUS_META: Record<
  BookingStatus,
  { labelKey: TranslationKey; className: string }
> = {
  success: { labelKey: "status.success", className: "history-chip--success" },
  ok: { labelKey: "status.awaiting", className: "history-chip--pending" },
  pending: { labelKey: "status.pending", className: "history-chip--pending" },
  ongoing: { labelKey: "status.ongoing", className: "history-chip--success" },
  finished: { labelKey: "status.finished", className: "history-chip--finished" },
  failed: { labelKey: "status.failed", className: "history-chip--failed" },
  canceled: { labelKey: "status.canceled", className: "history-chip--canceled" },
};

// Bộ lọc: tất cả / sắp tới / đã qua ("Sắp tới" là tab mặc định).
type TabKey = "all" | "upcoming" | "past";
const TABS: { key: TabKey; labelKey: TranslationKey }[] = [
  { key: "all", labelKey: "history.all" },
  { key: "upcoming", labelKey: "history.upcoming" },
  { key: "past", labelKey: "history.past" },
];
const DEFAULT_TAB: TabKey = "upcoming";

// Lượt đặt "có thật" (phòng đã/đang giữ, hoặc còn đang chờ): chia sang Sắp tới /
// Đã qua theo MỐC THỜI GIAN, nên lịch hôm nay chưa họp xong vẫn nằm ở "Sắp tới".
// failed/canceled không thuộc tab nào ngoài "Tất cả".
const LISTED_STATUSES: BookingStatus[] = [
  "success",
  "ongoing",
  "pending",
  "ok",
  "finished",
];

// "2026-07-22" -> "22/7" (khớp Figma: bỏ số 0 ở đầu, 1 dấu gạch).
function formatShortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return d && m ? `${Number(d)}/${Number(m)}` : iso;
}

// "2026-07-22" -> "T3" / "Tue" (thứ dạng ngắn, dùng chung key với dải chọn ngày
// của màn "Tìm phòng"). Trả "" nếu ngày không đọc được.
function weekdayLabel(iso: string, t: TFunction): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? ""
    : t(`weekday.${d.getDay()}` as TranslationKey);
}

// "14:00:00" / "14:00" -> "14:00".
function hhmm(time?: string | null): string {
  return (time || "").slice(0, 5);
}

// Lượt đặt đã xong chưa? Theo giờ kết thúc so với hiện tại; riêng "finished" là
// trạng thái cuối (trả phòng sớm thì end_time còn ở tương lai) nên luôn tính là
// đã qua.
function isDone(item: BookingHistoryItem): boolean {
  if (item.status === "finished") return true;
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
  const [tab, setTab] = useState<TabKey>(DEFAULT_TAB);
  const [selected, setSelected] = useState<BookingHistoryItem | null>(null);
  // Dữ liệu điền sẵn cho màn "Săn phòng" mở đè lên màn chi tiết; null = đang đóng.
  const [scoutPrefill, setScoutPrefill] = useState<ScoutPrefill | null>(null);
  // Đang có phiên săn chạy → khoá CTA săn phòng ở màn chi tiết (BE chỉ cho 1 phiên).
  const [hasActiveScout, setHasActiveScout] = useState(
    () => peekHasActiveScout() ?? false,
  );

  // Nạp trạng thái phiên săn: lúc mở tab và sau khi đóng màn "Săn phòng" (vừa tạo
  // hoặc vừa huỷ phiên thì CTA phải đổi theo).
  function refreshScoutState() {
    loadHasActiveScout().then(setHasActiveScout, () => {
      // Lỗi mạng/hết phiên: giữ trạng thái cũ, submit vẫn được backend chặn.
    });
  }

  // Mở màn "Săn phòng" từ chi tiết lượt đặt: lấy sức chứa của đúng phòng cũ trong
  // danh bạ phòng (có cache thì dùng ngay), thiếu thì để user tự chọn.
  async function openScout(item: BookingHistoryItem, addDays: number) {
    let capacity: CapacitySize | null = null;
    try {
      const rooms = peekRoomDirectory() ?? (await loadRoomDirectory());
      capacity =
        findRoom(rooms, item.room_email, item.room_name)?.capacity_size ?? null;
    } catch {
      // Không tải được danh bạ phòng — vẫn mở form, chỉ thiếu sức chứa.
    }
    setScoutPrefill(buildScoutPrefill(item, addDays, capacity));
  }

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
    refreshScoutState();
  }, []);

  const tabIndex = Math.max(
    0,
    TABS.findIndex((tabItem) => tabItem.key === tab),
  );

  function itemsFor(key: TabKey): BookingHistoryItem[] {
    if (key === "all") return items;
    return items.filter(
      (item) =>
        LISTED_STATUSES.includes(item.status) &&
        (key === "past" ? isDone(item) : !isDone(item)),
    );
  }

  function renderCard(item: BookingHistoryItem) {
    const status = STATUS_META[item.status] ?? STATUS_META.pending;
    const flag = roomFlag(item.room_name);
    // Lượt đặt không thành hiện thực → làm mờ ảnh phòng (xám + opacity).
    const dimmed = item.status === "failed" || item.status === "canceled";
    // Dòng ngày/giờ mở đầu bằng thứ: "T3 • 22/7 • 14:00 - 15:00".
    const weekday = weekdayLabel(item.date, t);
    const when = `${weekday ? `${weekday} • ` : ""}${formatShortDate(item.date)} • ${hhmm(
      item.start_time,
    )} - ${hhmm(item.end_time)}`;
    return (
      <div
        key={item.id}
        className="history-card"
        role="button"
        tabIndex={0}
        onClick={() => setSelected(item)}
      >
        <div
          className={`history-card__media${
            dimmed ? " history-card__media--dimmed" : ""
          }`}
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
              <span>{when}</span>
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
          <EmptyIllustration size={240} />
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
          status={selected.status}
          onScout={(addDays) => void openScout(selected, addDays)}
          scoutDisabled={hasActiveScout}
          onClose={() => setSelected(null)}
        />
      )}

      {/* Săn phòng đè lên màn chi tiết (z-index 66 > 60); back về lại chi tiết. */}
      {scoutPrefill && (
        <RoomScout
          prefill={scoutPrefill}
          onClose={() => {
            setScoutPrefill(null);
            refreshScoutState();
          }}
        />
      )}
    </div>
  );
}
