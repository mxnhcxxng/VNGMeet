import { useEffect, useState } from "react";

import { showToast } from "zmp-sdk";

import ChevronLeft from "@gravity-ui/icons/ChevronLeft";
import PlanetEarth from "@gravity-ui/icons/PlanetEarth";
import Clock from "@gravity-ui/icons/Clock";
import MapPin from "@gravity-ui/icons/MapPin";
import Persons from "@gravity-ui/icons/Persons";
import ArrowShapeTurnUpRight from "@gravity-ui/icons/ArrowShapeTurnUpRight";
import Binoculars from "@gravity-ui/icons/Binoculars";

import MapModal from "@/components/map-modal";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { roomFlag } from "@/services/room-flags";
import { composeDirectionsText, shareDirections } from "@/services/share";
import { useT } from "@/services/settings";
import type { TFunction, TranslationKey } from "@/services/i18n";
import type { BookingStatus, UpcomingEvent } from "@/types";

// Trạng thái đặt phòng → chip (nhãn + màu). Dùng chung style .history-chip với
// màn "Lịch sử". "ok" = đã gửi, đang chờ phòng phản hồi → hiện "Chờ phản hồi".
const STATUS_CHIP: Record<
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

// CTA cuối màn phụ thuộc trạng thái lượt đặt:
//  - success / ongoing: phòng đang là của mình → chia sẻ đường đi.
//  - failed: đặt hụt → săn ngay phòng tương tự cho đúng khung giờ đó.
//  - finished / canceled: buổi họp đã xong/huỷ → săn cho tuần sau (ngày +7).
//  - ok / pending: đang chờ phòng phản hồi → chưa có hành động nào.
const SHARE_STATUSES: BookingStatus[] = ["success", "ongoing"];
// addDays truyền cho buildScoutPrefill khi mở màn "Săn phòng".
const SCOUT_CTA: Partial<
  Record<BookingStatus, { labelKey: TranslationKey; addDays: number }>
> = {
  failed: { labelKey: "detail.scoutSimilar", addDays: 0 },
  finished: { labelKey: "detail.scoutNextWeek", addDays: 7 },
  canceled: { labelKey: "detail.scoutNextWeek", addDays: 7 },
};

// "2026-07-24" -> "24/07"
function formatDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return d && m ? `${d}/${m}` : iso;
}

// "2026-07-24" -> "T5" / "Thu" (thứ dạng ngắn, dùng chung key với màn "Lịch sử").
function weekdayLabel(iso: string, t: TFunction): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? ""
    : t(`weekday.${d.getDay()}` as TranslationKey);
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
  // Trạng thái lượt đặt để hiện chip dưới tiêu đề (Figma 317-9943). Home mở từ
  // lịch sắp tới nên luôn "success"; Lịch sử truyền đúng status của lượt đặt.
  status?: BookingStatus;
  // Mở màn "Săn phòng" điền sẵn theo lượt đặt này (chỉ "Lịch sử" truyền vào);
  // addDays = 0 (săn phòng tương tự) hoặc 7 (săn cho tuần sau).
  onScout?: (addDays: number) => void;
  // Đang có phiên săn chạy → khoá CTA săn phòng (backend chỉ cho 1 phiên/người).
  scoutDisabled?: boolean;
  onClose: () => void;
};

// Màn "Chi tiết lịch họp": push từ phải sang trái (slide-in RTL). Gồm map, thông
// tin cơ bản (ngày/giờ/vị trí/người tham dự) và mô tả cuộc họp. Khớp Figma 317-9943.
export default function MeetingDetail({
  event,
  status,
  onScout,
  scoutDisabled,
  onClose,
}: Props) {
  const t = useT();
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

  const title = event.subject || event.room_name || t("common.meeting");
  const flag = roomFlag(event.room_name);
  // Dòng ngày/giờ mở đầu bằng thứ: "T5 • 24/07 • 14:00 - 15:00".
  const weekday = weekdayLabel(event.date, t);
  const dateTime = `${weekday ? `${weekday} • ` : ""}${formatDate(event.date)} • ${
    event.start_time
  } - ${event.end_time}`;
  const attendees = (event.attendees ?? [])
    .map(stripAttendeeDomain)
    .filter(Boolean);
  const extraCount = attendees.length - ATTENDEES_PREVIEW;
  const visibleAttendees =
    showAllAttendees || extraCount <= 0
      ? attendees
      : attendees.slice(0, ATTENDEES_PREVIEW);
  const description = (event.body ?? "").trim();
  const chip = status ? STATUS_CHIP[status] : null;
  // Không truyền status (mở từ "Lịch sắp tới") coi như lượt đặt thành công.
  const canShare = !status || SHARE_STATUSES.includes(status);
  const scoutCta = !canShare && status && onScout ? SCOUT_CTA[status] : null;

  // Chia sẻ đường đi tới phòng họp: ưu tiên ảnh sơ đồ, không có thì chia sẻ text.
  async function handleShare() {
    const roomName = event.room_name || title;
    const text = composeDirectionsText({
      intro: t("dir.shareIntro", { room: roomName }),
      location: event.location,
    });
    const ok = await shareDirections({ text, map: event.map });
    if (!ok) void showToast({ message: t("dir.shareFailed") });
  }

  return (
    <div
      className={`mtg-detail${entered && !leaving ? " is-open" : ""}`}
      role="dialog"
      aria-label={t("detail.title")}
      {...swipeBack}
    >
      <header className="mtg-detail__header">
        <button
          className="mtg-detail__back"
          type="button"
          aria-label={t("common.back")}
          onClick={handleClose}
        >
          <ChevronLeft width={24} height={24} />
        </button>
        <span className="mtg-detail__header-title">{t("detail.title")}</span>
      </header>

      <div className="mtg-detail__scroll">
        <section className="mtg-detail__card">
          <div className="mtg-detail__head">
            <div className="mtg-detail__heading">
              <h1 className="mtg-detail__title">{title}</h1>
              {chip && (
                <span className={`history-chip ${chip.className}`}>
                  {t(chip.labelKey)}
                </span>
              )}
            </div>

            {event.map && (
              <button
                className="mtg-detail__map"
                type="button"
                aria-label={t("detail.viewMap")}
                onClick={() => setMapOpen(true)}
              >
                <img src={event.map} alt={t("detail.mapAlt")} />
              </button>
            )}
          </div>

          <div className="mtg-detail__info">
            {event.room_name && event.room_name !== title && (
              <div className="mtg-detail__row">
                <PlanetEarth width={16} height={16} />
                <span>
                  {flag && `${flag} `}
                  {event.room_name}
                </span>
              </div>
            )}
            <div className="mtg-detail__row">
              <Clock width={16} height={16} />
              <span>{dateTime}</span>
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
                        {t("detail.others", { count: extraCount })}
                      </button>
                    </>
                  )}
                </span>
              </div>
            )}
          </div>
        </section>

        <section className="mtg-detail__card mtg-detail__desc">
          <h2 className="mtg-detail__desc-title">{t("detail.descTitle")}</h2>
          {description ? (
            <p className="mtg-detail__desc-body">{description}</p>
          ) : (
            <p className="mtg-detail__desc-empty">{t("detail.descEmpty")}</p>
          )}
        </section>
      </div>

      {(canShare || scoutCta) && (
        <footer className="mtg-detail__footer">
          {canShare ? (
            <button
              className="mtg-detail__share"
              type="button"
              onClick={handleShare}
            >
              <ArrowShapeTurnUpRight width={18} height={18} />
              {t("dir.share")}
            </button>
          ) : (
            <>
              {scoutDisabled && (
                <p className="mtg-detail__footer-note">{t("detail.scoutBusy")}</p>
              )}
              <button
                className="mtg-detail__share"
                type="button"
                disabled={scoutDisabled}
                onClick={() => onScout?.(scoutCta!.addDays)}
              >
                <Binoculars width={18} height={18} />
                {t(scoutCta!.labelKey)}
              </button>
            </>
          )}
        </footer>
      )}

      {mapOpen && event.map && (
        <MapModal src={event.map} onClose={() => setMapOpen(false)} />
      )}
    </div>
  );
}
