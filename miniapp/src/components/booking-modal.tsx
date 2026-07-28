import { useEffect, useState } from "react";
import { Button, Input, useSnackbar } from "zmp-ui";

import ChevronLeft from "@gravity-ui/icons/ChevronLeft";
import MapPin from "@gravity-ui/icons/MapPin";
import Check from "@gravity-ui/icons/Check";
import CircleInfo from "@gravity-ui/icons/CircleInfo";

import { api, AuthError, LinkRequiredError } from "@/services/api";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { useDisplayName } from "@/services/auth";
import { useT } from "@/services/settings";
import type { TFunction } from "@/services/i18n";
import type { FreeRoom } from "@/types";

type Props = {
  room: FreeRoom;
  date: string; // ISO yyyy-mm-dd của ngày đang đặt (freeRooms.day)
  onClose: () => void;
  onBooked?: () => void;
  // Nút "Về màn hình chính" ở màn success. Nếu modal mở từ một màn trung gian
  // (vd Tìm phòng), truyền hàm đóng toàn bộ stack về home. Không truyền →
  // mặc định chỉ đóng modal (dùng khi modal mở thẳng từ home).
  onBackHome?: () => void;
  // true = ngày ngoài cửa sổ Graph → đặt hẹn giờ (scheduled), backend tự đặt lúc
  // 00:00 ngày mục tiêu. Đổi tiêu đề/chú thích/màn thành công cho phù hợp.
  schedule?: boolean;
};

function roomLocation(room: FreeRoom, t: TFunction): string {
  const parts: string[] = [];
  if (room.floor) parts.push(t("common.floor", { floor: room.floor }));
  if (room.building) parts.push(t("common.building", { building: room.building }));
  return parts.join(" - ");
}

// Modal đặt phòng (Figma 317-11817): trượt từ PHẢI vào, có nút back → hỗ trợ
// swipe-back. Trường giờ (bắt đầu/kết thúc) bị disabled. Dùng ZaUI Input +
// Input.TextArea. Đặt thành công → hiện màn "Đặt phòng thành công" (317-32951),
// màn này KHÔNG có nút back nên KHÔNG swipe-back được.
export default function BookingModal({
  room,
  date,
  onClose,
  onBooked,
  onBackHome,
  schedule = false,
}: Props) {
  const displayName = useDisplayName();
  const { openSnackbar } = useSnackbar();
  const t = useT();

  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [booked, setBooked] = useState(false); // đã đặt thành công → màn success
  const [subject, setSubject] = useState("");
  const [attendees, setAttendees] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Tự điền tiêu đề. Hẹn giờ → "Cuộc họp đã lên lịch của <tên>".
  useEffect(() => {
    if (displayName) {
      setSubject(
        t(schedule ? "booking.subjectScheduled" : "booking.subjectInstant", {
          name: displayName,
        }),
      );
    } else {
      setSubject(
        t(
          schedule
            ? "booking.subjectScheduledNoName"
            : "booking.subjectInstantNoName",
        ),
      );
    }
  }, [displayName, schedule, t]);

  function handleClose() {
    if (loading) return;
    setLeaving(true);
    window.setTimeout(onClose, 260);
  }

  // Swipe-back chỉ bật ở màn form (có nút back); tắt khi đang gọi API hoặc ở màn
  // success (không có nút back).
  const swipeBack = useSwipeBack(handleClose, !booked && !loading);

  const location = roomLocation(room, t);

  async function submit() {
    if (!subject.trim()) {
      openSnackbar({ text: t("booking.titleRequired"), type: "warning" });
      return;
    }
    if (!room.email) {
      openSnackbar({ text: t("booking.invalidRoom"), type: "error" });
      return;
    }
    setLoading(true);
    try {
      await api.book({
        room_email: room.email,
        room_name: room.name,
        date,
        start_time: room.start_time,
        end_time: room.end_time,
        subject: subject.trim(),
        attendees: attendees
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean),
        body: notes.trim() || undefined,
      });
      onBooked?.();
      setLoading(false);
      setBooked(true); // chuyển sang màn success
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof AuthError) {
        openSnackbar({ text: t("booking.sessionReauth"), type: "warning" });
      } else if (e instanceof LinkRequiredError || msg.startsWith("403")) {
        // 403 = chưa liên kết Microsoft (backend đã đổi từ 401 sang 403 để không
        // làm miniapp xoá session Zalo + đăng nhập lại).
        openSnackbar({ text: t("booking.notLinked"), type: "error" });
      } else {
        openSnackbar({ text: t("booking.failed"), type: "error" });
      }
      setLoading(false);
    }
  }

  return (
    <div
      className={`booking-modal${entered && !leaving ? " is-open" : ""}`}
      role="dialog"
      aria-label={
        booked
          ? schedule
            ? t("booking.successScheduledTitle")
            : t("booking.successInstantTitle")
          : schedule
            ? t("booking.scheduledHeader")
            : t("booking.instantHeader")
      }
      {...(booked ? {} : swipeBack)}
    >
      {booked ? (
        // --- Màn success (không nút back, không swipe-back) ---
        <div className="booking-success">
          <div className="booking-success__body">
            <div className="booking-success__check">
              <Check width={40} height={40} />
            </div>
            <div className="booking-success__text">
              <div className="booking-success__title">
                {schedule
                  ? t("booking.successScheduledTitle")
                  : t("booking.successInstantTitle")}
              </div>
              <div className="booking-success__subtitle">
                {schedule
                  ? t("booking.successScheduledSub")
                  : t("booking.successInstantSub")}
              </div>
            </div>
          </div>
          <div className="booking-modal__actions">
            <Button fullWidth onClick={onBackHome ?? handleClose}>
              {t("booking.backHome")}
            </Button>
          </div>
        </div>
      ) : (
        // --- Màn form đặt phòng ---
        <>
          <header className="mtg-detail__header">
            <button
              className="mtg-detail__back"
              type="button"
              aria-label={t("common.back")}
              onClick={handleClose}
            >
              <ChevronLeft width={24} height={24} />
            </button>
            <span className="mtg-detail__header-title">
              {schedule ? t("booking.scheduledHeader") : t("booking.instantHeader")}
            </span>
          </header>

          <div className="booking-modal__scroll">
            <div
              className="booking-modal__banner"
              style={
                room.image
                  ? { backgroundImage: `url(${room.image})` }
                  : undefined
              }
            >
              <div className="booking-modal__banner-overlay" />
              <div className="booking-modal__banner-body">
                <div className="booking-modal__room-name">{room.name}</div>
                {location && (
                  <div className="booking-modal__room-loc">
                    <MapPin width={16} height={16} />
                    <span>{location}</span>
                  </div>
                )}
              </div>
            </div>

            {schedule && (
              <div className="booking-modal__sched-note">
                {t("booking.scheduleInfo1")}
              </div>
            )}

            <div className="booking-modal__form">
              <Input
                label={t("booking.meetingTitle")}
                placeholder={t("booking.meetingTitlePlaceholder")}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />

              <div className="booking-modal__row">
                <Input
                  label={t("booking.startTime")}
                  value={room.start_time}
                  disabled
                  readOnly
                />
                <Input
                  label={t("booking.endTime")}
                  value={room.end_time}
                  disabled
                  readOnly
                />
              </div>

              <Input
                label={t("booking.attendees")}
                placeholder={t("booking.attendeesPlaceholder")}
                value={attendees}
                onChange={(e) => setAttendees(e.target.value)}
              />

              <Input.TextArea
                label={t("booking.description")}
                placeholder={t("booking.descriptionPlaceholder")}
                rows={5}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />

              {schedule && (
                <div className="booking-modal__sched-info">
                  <CircleInfo width={16} height={16} />
                  <span>{t("booking.scheduleInfo2")}</span>
                </div>
              )}
            </div>
          </div>

          <div className="booking-modal__actions">
            <Button fullWidth onClick={() => void submit()} loading={loading}>
              {t("booking.book")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
