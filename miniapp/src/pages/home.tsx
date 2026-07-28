import { useCallback, useEffect, useRef, useState } from "react";

import Magnifier from "@gravity-ui/icons/Magnifier";
import Binoculars from "@gravity-ui/icons/Binoculars";
import MapPin from "@gravity-ui/icons/MapPin";
import Comment from "@gravity-ui/icons/Comment";
import PlanetEarth from "@gravity-ui/icons/PlanetEarth";
import Clock from "@gravity-ui/icons/Clock";
import PersonFill from "@gravity-ui/icons/PersonFill";
import ArrowsRotateRight from "@gravity-ui/icons/ArrowsRotateRight";

import logo from "@/static/logo.png";
import MeetingDetail from "@/components/meeting-detail";
import SwipeViews from "@/components/swipe-views";
import BookingModal from "@/components/booking-modal";
import FindRoom from "@/pages/find-room";
import RoomScout from "@/pages/room-scout";
import Directions from "@/pages/directions";
import { useDisplayName } from "@/services/auth";
import { api, AuthError } from "@/services/api";
import { roomFlag } from "@/services/room-flags";
import { openChatbot } from "@/services/chatbot";
import { useT } from "@/services/settings";
import type { TranslationKey } from "@/services/i18n";
import type {
  CapacitySize,
  FreeRoom,
  FreeRoomsResponse,
  MeResponse,
  UpcomingEvent,
} from "@/types";

// "2026-07-24" -> "24/07"
function formatDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return d && m ? `${d}/${m}` : iso;
}

// 30 -> "0.5h", 60 -> "1h", 90 -> "1.5h", ...
function durationLabel(minutes: number): string {
  return `${minutes / 60}h`;
}

// Cỡ sức chứa (khớp find-room): capacity số → nhóm; hoặc dùng capacity_size sẵn.
const CAP_RANGE: Record<CapacitySize, string> = {
  small: "≤4",
  medium: "5–12",
  large: "13+",
};
function capacitySize(room: FreeRoom): CapacitySize | null {
  if (typeof room.capacity === "number") {
    if (room.capacity <= 4) return "small";
    if (room.capacity <= 12) return "medium";
    return "large";
  }
  return room.capacity_size ?? null;
}

const DEFAULT_DURATION = 60; // tab "1h" chọn sẵn (khớp Figma)

// Cache cấp module (sống qua việc chuyển tab dưới, mất khi reload app): quay lại
// Home render ngay từ cache rồi revalidate ngầm — không nháy skeleton.
let cachedEvent: UpcomingEvent | null = null;
let cachedEventLoaded = false;
let cachedFreeRooms: FreeRoomsResponse | null = null;

// Màn Home theo Figma (node 286-9472). Icon dùng bộ @gravity-ui/icons y hệt bản
// web, font Inter. "Lịch sắp tới" + "Phòng trống" lấy từ BE.
type Props = {
  me: MeResponse | null;
};

export default function HomePage({ me }: Props) {
  const t = useT();
  const name = useDisplayName() ?? t("common.you");
  const [scrolled, setScrolled] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const [event, setEvent] = useState<UpcomingEvent | null>(cachedEvent);
  const [freeRooms, setFreeRooms] = useState<FreeRoomsResponse | null>(
    cachedFreeRooms,
  );
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const [refreshing, setRefreshing] = useState(false);
  // Loading lần đầu để hiện skeleton: event + phòng trống nạp xong thì tắt.
  const [eventLoading, setEventLoading] = useState(!cachedEventLoaded);
  const [roomsLoaded, setRoomsLoaded] = useState(cachedFreeRooms !== null);
  // Mở màn "Chi tiết lịch họp" (overlay push từ phải).
  const [detailOpen, setDetailOpen] = useState(false);
  // Mở màn "Tìm phòng" (overlay push từ phải).
  const [findOpen, setFindOpen] = useState(false);
  // Mở màn "Săn phòng" (overlay push từ phải).
  const [scoutOpen, setScoutOpen] = useState(false);
  // Mở màn "Chỉ đường" (overlay push từ phải).
  const [dirOpen, setDirOpen] = useState(false);
  // Phòng đang chọn để đặt (mở BookingModal).
  const [selectedRoom, setSelectedRoom] = useState<FreeRoom | null>(null);

  const actions = [
    {
      key: "find",
      label: t("action.find"),
      Icon: Magnifier,
      onClick: () => setFindOpen(true),
    },
    {
      key: "scout",
      label: t("action.scout"),
      Icon: Binoculars,
      onClick: () => setScoutOpen(true),
    },
    {
      key: "direction",
      label: t("action.direction"),
      Icon: MapPin,
      onClick: () => setDirOpen(true),
    },
    { key: "chatbot", label: t("action.chatbot"), Icon: Comment, onClick: openChatbot },
  ];

  // Chỉ gọi availability khi mở app hoặc bấm "Làm mới".
  const loadFreeRooms = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await api.freeRoomsToday();
      cachedFreeRooms = data;
      setFreeRooms(data);
    } catch (e) {
      if (!(e instanceof AuthError)) setFreeRooms(null);
    } finally {
      setRefreshing(false);
      setRoomsLoaded(true);
    }
  }, []);

  // Lịch sắp tới + phòng trống: nạp 1 lần khi vào app.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { event } = await api.upcomingBooking();
        cachedEvent = event;
        cachedEventLoaded = true;
        if (alive) setEvent(event);
      } catch (e) {
        if (!(e instanceof AuthError) && alive) setEvent(null);
      } finally {
        if (alive) setEventLoading(false);
      }
    })();
    void loadFreeRooms();
    return () => {
      alive = false;
    };
  }, [loadFreeRooms]);

  // Header sticky: cuộn qua đầu trang thì thêm nền xanh.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setScrolled(!entry.isIntersecting),
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const durations = freeRooms?.durations ?? [30, 60, 90, 120, 150, 180];
  // Vị trí tab đang chọn trong danh sách thời lượng (đồng bộ với SwipeViews).
  const durIndex = Math.max(0, durations.indexOf(duration));
  const roomsTitle = freeRooms?.isTomorrow
    ? t("home.freeTomorrow")
    : t("home.freeToday");
  // Tiêu đề card = tiêu đề cuộc họp; thiếu thì lùi về tên phòng.
  const eventTitle = event
    ? event.subject || event.room_name || t("common.meeting")
    : "";

  // Một thẻ phòng trống (hoặc ô giữ chỗ khi thiếu phòng → panel luôn 4 ô).
  function renderRoomCell(room: FreeRoom | null, i: number) {
    if (!room) {
      return (
        <div key={`ghost-${i}`} className="room-card room-card--ghost">
          <div className="room-card__media" />
          <div className="room-card__info">
            <div className="room-card__name"> </div>
            <div className="room-card__time"> </div>
          </div>
        </div>
      );
    }
    const cap = capacitySize(room);
    const flag = roomFlag(room.name);
    return (
      <div
        key={room.email || i}
        className="room-card"
        role="button"
        tabIndex={0}
        onClick={() => setSelectedRoom(room)}
      >
        <div
          className="room-card__media"
          style={room.image ? { backgroundImage: `url(${room.image})` } : undefined}
        >
          {cap && (
            <div className="room-chips">
              <span className="room-chip room-chip--onmedia room-chip--cap">
                <span>
                  {t(`cap.${cap}` as TranslationKey)} ({CAP_RANGE[cap]}
                </span>
                <PersonFill width={11} height={11} />
                <span>)</span>
              </span>
            </div>
          )}
        </div>
        <div className="room-card__info">
          <div className="room-card__name">
            {flag && `${flag} `}
            {room.name}
          </div>
          <div className="room-card__time">
            {room.start_time} - {room.end_time}
          </div>
        </div>
      </div>
    );
  }

  // Panel phòng trống cho 1 mốc thời lượng — luôn 4 ô để chiều cao không đổi.
  function renderRoomPanel(minutes: number) {
    const list = freeRooms?.byDuration[String(minutes)] ?? [];
    const cells: (FreeRoom | null)[] = Array.from(
      { length: 4 },
      (_, i) => list[i] ?? null,
    );
    return (
      <div className="room-panel">
        <div className="room-grid">{cells.map(renderRoomCell)}</div>
        {list.length === 0 && (
          <div className="room-panel__empty">
            {refreshing ? t("home.loadingRooms") : t("home.noRooms")}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="home">
      <div ref={sentinelRef} className="home__sentinel" />

      <header className={`home__topbar${scrolled ? " is-scrolled" : ""}`}>
        <img className="home__favicon" src={logo} alt="VNG Meet" />
      </header>

      <div className="home__hero">
        <div className="home__hero-body">
          <div className="home__greeting">{t("home.greeting", { name })}</div>

          <div className="menu-card">
            <div className="menu-card__title">
              {t("home.menuTitle")}{" "}
              <span className="menu-card__title-muted">
                {t("home.menuTitleMuted")}
              </span>
            </div>
            <div className="menu-card__sep" />
            <div className="menu-card__actions">
              {actions.map(({ key, label, Icon, onClick }) => (
                <button
                  key={key}
                  className="menu-action"
                  type="button"
                  onClick={onClick}
                >
                  <span className="menu-action__icon">
                    <Icon width={24} height={24} />
                  </span>
                  <span className="menu-action__label">{label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {eventLoading && (
        <section className="home-section">
          <div className="home-section__title">{t("home.upcoming")}</div>
          <div className="event-card skeleton skeleton--event" />
        </section>
      )}

      {!eventLoading && event && (
        <section className="home-section">
          <div className="home-section__title">{t("home.upcoming")}</div>
          <div
            className="event-card"
            role="button"
            tabIndex={0}
            onClick={() => setDetailOpen(true)}
            style={
              event.image
                ? { backgroundImage: `url(${event.image})` }
                : undefined
            }
          >
            <div className="event-card__overlay" />
            <div className="event-card__body">
              <div className="event-card__title">{eventTitle}</div>
              {event.room_name && event.room_name !== eventTitle && (
                <div className="event-card__row">
                  <PlanetEarth width={16} height={16} />
                  <span>
                    {roomFlag(event.room_name) && `${roomFlag(event.room_name)} `}
                    {event.room_name}
                  </span>
                </div>
              )}
              <div className="event-card__row">
                <Clock width={16} height={16} />
                <span>
                  {formatDate(event.date)} • {event.start_time} - {event.end_time}
                </span>
              </div>
              {event.location && (
                <div className="event-card__row">
                  <MapPin width={16} height={16} />
                  <span>{event.location}</span>
                </div>
              )}
              <button
                className="event-card__cta"
                type="button"
                onClick={() => setDetailOpen(true)}
              >
                {t("home.viewDetail")}
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="home-section">
        <div className="home-section__header">
          <div className="home-section__title">{roomsTitle}</div>
          <button
            className="home-section__refresh"
            type="button"
            onClick={() => void loadFreeRooms()}
            disabled={refreshing}
          >
            <span>{t("common.refresh")}</span>
            <ArrowsRotateRight
              width={16}
              height={16}
              className={refreshing ? "is-spinning" : undefined}
            />
          </button>
        </div>

        <div className="duration-tabs">
          {durations.map((m) => (
            <button
              key={m}
              type="button"
              className={`duration-tab${m === duration ? " is-active" : ""}`}
              onClick={() => setDuration(m)}
            >
              {durationLabel(m)}
            </button>
          ))}
        </div>

        {!roomsLoaded ? (
          // Skeleton lúc nạp lần đầu: 4 ô placeholder nhấp nháy.
          <div className="room-grid">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={`skeleton-${i}`} className="room-card">
                <div className="room-card__media skeleton" />
                <div className="room-card__info">
                  <div className="skeleton skeleton--line skeleton--name" />
                  <div className="skeleton skeleton--line skeleton--time" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <SwipeViews
            index={durIndex}
            onIndexChange={(i) => setDuration(durations[i])}
          >
            {durations.map((m) => (
              <div key={m}>{renderRoomPanel(m)}</div>
            ))}
          </SwipeViews>
        )}
      </section>

      {detailOpen && event && (
        <MeetingDetail
          event={event}
          status="success"
          onClose={() => setDetailOpen(false)}
        />
      )}

      {findOpen && <FindRoom onClose={() => setFindOpen(false)} />}

      {scoutOpen && <RoomScout onClose={() => setScoutOpen(false)} />}

      {dirOpen && (
        <Directions
          office={me?.profile?.office ?? null}
          onClose={() => setDirOpen(false)}
        />
      )}

      {selectedRoom && freeRooms && (
        <BookingModal
          room={selectedRoom}
          date={freeRooms.day}
          onClose={() => setSelectedRoom(null)}
          onBooked={() => void loadFreeRooms()}
        />
      )}
    </div>
  );
}
