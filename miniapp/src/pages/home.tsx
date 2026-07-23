import { useCallback, useEffect, useRef, useState } from "react";
import { openChat } from "zmp-sdk";

import Magnifier from "@gravity-ui/icons/Magnifier";
import Binoculars from "@gravity-ui/icons/Binoculars";
import MapPin from "@gravity-ui/icons/MapPin";
import Comment from "@gravity-ui/icons/Comment";
import Calendar from "@gravity-ui/icons/Calendar";
import Clock from "@gravity-ui/icons/Clock";
import ArrowsRotateRight from "@gravity-ui/icons/ArrowsRotateRight";

import favicon from "@/static/favicon-white.png";
import MeetingDetail from "@/components/meeting-detail";
import BookingModal from "@/components/booking-modal";
import { useDisplayName } from "@/services/auth";
import { api, AuthError } from "@/services/api";
import type { FreeRoom, FreeRoomsResponse, UpcomingEvent } from "@/types";

// Chatbot Zalo OA — bấm nút "Chatbot" mở cửa sổ chat với OA này.
const CHATBOT_OA_ID = "4092201589741480262";
const CHATBOT_URL = "https://zalo.me/4092201589741480262";

// Mở chat với OA qua zmp-sdk (chỉ chạy trong app Zalo); ngoài app thì fallback
// mở link zalo.me.
function openChatbot(): void {
  try {
    void openChat({ type: "oa", id: CHATBOT_OA_ID }).catch(() => {
      window.open(CHATBOT_URL, "_blank");
    });
  } catch {
    window.open(CHATBOT_URL, "_blank");
  }
}

// "2026-07-24" -> "24/07"
function formatDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return d && m ? `${d}/${m}` : iso;
}

// 30 -> "0.5h", 60 -> "1h", 90 -> "1.5h", ...
function durationLabel(minutes: number): string {
  return `${minutes / 60}h`;
}

const DEFAULT_DURATION = 60; // tab "1h" chọn sẵn (khớp Figma)

// Màn Home theo Figma (node 286-9472). Icon dùng bộ @gravity-ui/icons y hệt bản
// web, font Inter. "Lịch sắp tới" + "Phòng trống" lấy từ BE.
export default function HomePage() {
  const name = useDisplayName() ?? "bạn";
  const [scrolled, setScrolled] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const [event, setEvent] = useState<UpcomingEvent | null>(null);
  const [freeRooms, setFreeRooms] = useState<FreeRoomsResponse | null>(null);
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const [refreshing, setRefreshing] = useState(false);
  // Loading lần đầu để hiện skeleton: event + phòng trống nạp xong thì tắt.
  const [eventLoading, setEventLoading] = useState(true);
  const [roomsLoaded, setRoomsLoaded] = useState(false);
  // Mở màn "Chi tiết lịch họp" (overlay push từ phải).
  const [detailOpen, setDetailOpen] = useState(false);
  // Phòng đang chọn để đặt (mở BookingModal).
  const [selectedRoom, setSelectedRoom] = useState<FreeRoom | null>(null);

  const actions = [
    { key: "find", label: "Tìm phòng", Icon: Magnifier, onClick: undefined },
    { key: "scout", label: "Săn phòng", Icon: Binoculars, onClick: undefined },
    { key: "direction", label: "Chỉ đường", Icon: MapPin, onClick: undefined },
    { key: "chatbot", label: "Chatbot", Icon: Comment, onClick: openChatbot },
  ];

  // Chỉ gọi availability khi mở app hoặc bấm "Làm mới".
  const loadFreeRooms = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await api.freeRoomsToday();
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
  const rooms: FreeRoom[] = freeRooms?.byDuration[String(duration)] ?? [];
  // Luôn render đúng 4 ô để chiều cao panel không đổi khi đổi tab / khi trống.
  const cells: (FreeRoom | null)[] = Array.from(
    { length: 4 },
    (_, i) => rooms[i] ?? null,
  );
  const roomsTitle = freeRooms?.isTomorrow
    ? "Phòng trống ngày mai"
    : "Phòng trống hôm nay";

  return (
    <div className="home">
      <div ref={sentinelRef} className="home__sentinel" />

      <header className={`home__topbar${scrolled ? " is-scrolled" : ""}`}>
        <img className="home__favicon" src={favicon} alt="zMeeting" />
        <span className="home__appname">zMeeting</span>
      </header>

      <div className="home__hero">
        <div className="home__hero-body">
          <div className="home__greeting">Xin chào, {name}</div>

          <div className="menu-card">
            <div className="menu-card__title">
              Chọn một nhu cầu{" "}
              <span className="menu-card__title-muted">
                phù hợp nhất với bạn
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
          <div className="home-section__title">Lịch sắp tới</div>
          <div className="event-card skeleton skeleton--event" />
        </section>
      )}

      {!eventLoading && event && (
        <section className="home-section">
          <div className="home-section__title">Lịch sắp tới</div>
          <div
            className="event-card"
            style={
              event.image
                ? { backgroundImage: `url(${event.image})` }
                : undefined
            }
          >
            <div className="event-card__overlay" />
            <div className="event-card__body">
              <div className="event-card__title">
                {event.room_name || event.subject || "Cuộc họp"}
              </div>
              <div className="event-card__row">
                <Calendar width={16} height={16} />
                <span>{formatDate(event.date)}</span>
              </div>
              <div className="event-card__row">
                <Clock width={16} height={16} />
                <span>
                  {event.start_time} - {event.end_time}
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
                Xem chi tiết
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
            <span>Làm mới</span>
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
        <div className="room-panel">
          <div className="room-grid">
            {cells.map((room, i) =>
              room ? (
                <div
                  key={room.email || i}
                  className="room-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedRoom(room)}
                >
                  <div
                    className="room-card__media"
                    style={
                      room.image
                        ? { backgroundImage: `url(${room.image})` }
                        : undefined
                    }
                  >
                    {(room.building || room.floor) && (
                      <div className="room-chips">
                        {room.building && (
                          <span className="room-chip room-chip--onmedia">
                            {room.building}
                          </span>
                        )}
                        {room.floor && (
                          <span className="room-chip room-chip--onmedia">
                            Tầng {room.floor}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="room-card__info">
                    <div className="room-card__name">{room.name}</div>
                    <div className="room-card__time">
                      {room.start_time} - {room.end_time}
                    </div>
                  </div>
                </div>
              ) : (
                // Ô giữ chỗ (ẩn) để chiều cao panel không đổi.
                <div key={`ghost-${i}`} className="room-card room-card--ghost">
                  <div className="room-card__media" />
                  <div className="room-card__info">
                    <div className="room-card__name">{" "}</div>
                    <div className="room-card__time">{" "}</div>
                  </div>
                </div>
              ),
            )}
          </div>
          {rooms.length === 0 && (
            <div className="room-panel__empty">
              {refreshing
                ? "Đang tải phòng trống..."
                : "Không có phòng trống phù hợp"}
            </div>
          )}
        </div>
        )}
      </section>

      {detailOpen && event && (
        <MeetingDetail event={event} onClose={() => setDetailOpen(false)} />
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
