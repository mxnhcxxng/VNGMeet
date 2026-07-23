import { useEffect, useState } from "react";

import ChevronLeft from "@gravity-ui/icons/ChevronLeft";
import Calendar from "@gravity-ui/icons/Calendar";
import Clock from "@gravity-ui/icons/Clock";
import MapPin from "@gravity-ui/icons/MapPin";
import Persons from "@gravity-ui/icons/Persons";

import MapModal from "@/components/map-modal";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import type { UpcomingEvent } from "@/types";

// "2026-07-24" -> "24/07"
function formatDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return d && m ? `${d}/${m}` : iso;
}

const ATTENDEE_EMAIL_DOMAIN = "@vng.com.vn";

// "cuongdm4@vng.com.vn" -> "cuongdm4" (địa chỉ ngoài domain giữ nguyên).
function stripAttendeeDomain(email: string): string {
  const value = (email || "").trim();
  return value.toLowerCase().endsWith(ATTENDEE_EMAIL_DOMAIN)
    ? value.slice(0, -ATTENDEE_EMAIL_DOMAIN.length)
    : value;
}

const ATTENDEES_PREVIEW = 3; // hiện 3 người đầu, còn lại gộp "+N others"

type Props = {
  event: UpcomingEvent;
  onClose: () => void;
};

// Màn "Chi tiết lịch họp": push từ phải sang trái (slide-in RTL). Gồm map, thông
// tin cơ bản (ngày/giờ/vị trí/người tham dự) và mô tả cuộc họp. Khớp Figma 317-9943.
export default function MeetingDetail({ event, onClose }: Props) {
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [showAllAttendees, setShowAllAttendees] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);

  // Slide-in sau khi mount (transition từ translateX(100%) -> 0).
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  function handleClose() {
    setLeaving(true);
    window.setTimeout(onClose, 260); // khớp thời lượng transition slide-out
  }

  // Vuốt từ mép trái để back về màn home (đóng overlay). Tắt khi map modal đang mở.
  const swipeBack = useSwipeBack(handleClose, !mapOpen);

  const title = event.subject || event.room_name || "Cuộc họp";
  const attendees = (event.attendees ?? [])
    .map(stripAttendeeDomain)
    .filter(Boolean);
  const extraCount = attendees.length - ATTENDEES_PREVIEW;
  const visibleAttendees =
    showAllAttendees || extraCount <= 0
      ? attendees
      : attendees.slice(0, ATTENDEES_PREVIEW);
  const description = (event.body ?? "").trim();

  return (
    <div
      className={`mtg-detail${entered && !leaving ? " is-open" : ""}`}
      role="dialog"
      aria-label="Chi tiết lịch họp"
      {...swipeBack}
    >
      <header className="mtg-detail__header">
        <button
          className="mtg-detail__back"
          type="button"
          aria-label="Quay lại"
          onClick={handleClose}
        >
          <ChevronLeft width={24} height={24} />
        </button>
        <span className="mtg-detail__header-title">Chi tiết lịch họp</span>
      </header>

      <div className="mtg-detail__scroll">
        <section className="mtg-detail__card">
          <div className="mtg-detail__heading">
            <h1 className="mtg-detail__title">{title}</h1>
            {event.room_name && event.room_name !== title && (
              <div className="mtg-detail__subtitle">{event.room_name}</div>
            )}
          </div>

          {event.map && (
            <button
              className="mtg-detail__map"
              type="button"
              aria-label="Xem sơ đồ chỉ đường"
              onClick={() => setMapOpen(true)}
            >
              <img src={event.map} alt="Sơ đồ chỉ đường" />
            </button>
          )}

          <div className="mtg-detail__info">
            <div className="mtg-detail__row">
              <Calendar width={16} height={16} />
              <span>{formatDate(event.date)}</span>
            </div>
            <div className="mtg-detail__row">
              <Clock width={16} height={16} />
              <span>
                {event.start_time} - {event.end_time}
              </span>
            </div>
            {event.location && (
              <div className="mtg-detail__row">
                <MapPin width={16} height={16} />
                <span>{event.location}</span>
              </div>
            )}
            {attendees.length > 0 && (
              <div className="mtg-detail__row mtg-detail__row--attendees">
                <Persons width={16} height={16} />
                <span className="mtg-detail__attendees">
                  {visibleAttendees.join(", ")}
                  {!showAllAttendees && extraCount > 0 && (
                    <>
                      {"  "}
                      <button
                        type="button"
                        className="mtg-detail__more"
                        onClick={() => setShowAllAttendees(true)}
                      >
                        +{extraCount} others
                      </button>
                    </>
                  )}
                </span>
              </div>
            )}
          </div>
        </section>

        <section className="mtg-detail__card mtg-detail__desc">
          <h2 className="mtg-detail__desc-title">Mô tả cuộc họp</h2>
          {description ? (
            <p className="mtg-detail__desc-body">{description}</p>
          ) : (
            <p className="mtg-detail__desc-empty">Không có mô tả cuộc họp</p>
          )}
        </section>
      </div>

      {mapOpen && event.map && (
        <MapModal src={event.map} onClose={() => setMapOpen(false)} />
      )}
    </div>
  );
}
