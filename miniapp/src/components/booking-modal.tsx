import { useEffect, useState } from "react";
import { Button, Input, useSnackbar } from "zmp-ui";

import ChevronLeft from "@gravity-ui/icons/ChevronLeft";
import MapPin from "@gravity-ui/icons/MapPin";
import Check from "@gravity-ui/icons/Check";
import CircleInfo from "@gravity-ui/icons/CircleInfo";

import { api, AuthError, LinkRequiredError } from "@/services/api";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { useDisplayName } from "@/services/auth";
import type { FreeRoom } from "@/types";

// Chú thích cho booking hẹn giờ (scheduled) — copy nguyên văn từ bản web
// (frontend/lib/i18n.ts: booking.scheduleInfo1 / scheduleInfo2).
const SCHEDULE_INFO_1 =
  "Hệ thống sẽ tự động đặt vào lúc 12:00 đêm. Tuy nhiên, do nhu cầu sử dụng cao và số lượng phòng có hạn nên kết quả đặt phòng sẽ không được đảm bảo.";
const SCHEDULE_INFO_2 =
  "Để đảm bảo tính công bằng, mỗi người chỉ được có 1 lịch hẹn giờ đặt phòng đang chờ xử lý tại một thời điểm, với thời lượng đặt tối đa 3 tiếng.";

type Props = {
  room: FreeRoom;
  date: string; // ISO yyyy-mm-dd của ngày đang đặt (freeRooms.day)
  onClose: () => void;
  onBooked?: () => void;
  // true = ngày ngoài cửa sổ Graph → đặt hẹn giờ (scheduled), backend tự đặt lúc
  // 00:00 ngày mục tiêu. Đổi tiêu đề/chú thích/màn thành công cho phù hợp.
  schedule?: boolean;
};

function roomLocation(room: FreeRoom): string {
  const parts: string[] = [];
  if (room.floor) parts.push(`Tầng ${room.floor}`);
  if (room.building) parts.push(`Toà ${room.building}`);
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
  schedule = false,
}: Props) {
  const displayName = useDisplayName();
  const { openSnackbar } = useSnackbar();

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
    const prefix = schedule ? "Cuộc họp đã lên lịch" : "Cuộc họp";
    setSubject(displayName ? `${prefix} của ${displayName}` : prefix);
  }, [displayName, schedule]);

  function handleClose() {
    if (loading) return;
    setLeaving(true);
    window.setTimeout(onClose, 260);
  }

  // Swipe-back chỉ bật ở màn form (có nút back); tắt khi đang gọi API hoặc ở màn
  // success (không có nút back).
  const swipeBack = useSwipeBack(handleClose, !booked && !loading);

  const location = roomLocation(room);

  async function submit() {
    if (!subject.trim()) {
      openSnackbar({ text: "Vui lòng nhập tiêu đề cuộc họp.", type: "warning" });
      return;
    }
    if (!room.email) {
      openSnackbar({ text: "Phòng không hợp lệ.", type: "error" });
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
        openSnackbar({
          text: "Phiên đã hết hạn, đang xác thực lại...",
          type: "warning",
        });
      } else if (e instanceof LinkRequiredError || msg.startsWith("403")) {
        // 403 = chưa liên kết Microsoft (backend đã đổi từ 401 sang 403 để không
        // làm miniapp xoá session Zalo + đăng nhập lại).
        openSnackbar({
          text: "Tài khoản chưa liên kết Microsoft nên chưa thể đặt phòng. Vui lòng liên kết Microsoft rồi thử lại.",
          type: "error",
        });
      } else {
        openSnackbar({ text: "Đặt phòng thất bại, thử lại nhé.", type: "error" });
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
            ? "Đã tạo lịch hẹn giờ"
            : "Đặt phòng thành công"
          : schedule
            ? "Hẹn giờ đặt phòng"
            : "Đặt phòng họp"
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
                {schedule ? "Đã tạo lịch hẹn giờ" : "Đặt phòng thành công"}
              </div>
              <div className="booking-success__subtitle">
                {schedule
                  ? "Hệ thống sẽ tự động đặt vào 12:00 đêm. Vui lòng kiểm tra lại lịch trong Outlook sau đó."
                  : "Vui lòng kiểm tra lại lịch trong Outlook"}
              </div>
            </div>
          </div>
          <div className="booking-modal__actions">
            <Button fullWidth onClick={handleClose}>
              Trở về màn hình chính
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
              aria-label="Quay lại"
              onClick={handleClose}
            >
              <ChevronLeft width={24} height={24} />
            </button>
            <span className="mtg-detail__header-title">
              {schedule ? "Hẹn giờ đặt phòng" : "Đặt phòng họp"}
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
              <div className="booking-modal__sched-note">{SCHEDULE_INFO_1}</div>
            )}

            <div className="booking-modal__form">
              <Input
                label="Tiêu đề cuộc họp"
                placeholder="Nhập tiêu đề cuộc họp"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />

              <div className="booking-modal__row">
                <Input
                  label="Giờ bắt đầu"
                  value={room.start_time}
                  disabled
                  readOnly
                />
                <Input
                  label="Giờ kết thúc"
                  value={room.end_time}
                  disabled
                  readOnly
                />
              </div>

              <Input
                label="Domain người tham dự"
                placeholder="VD: cuongdm4, huyennn, anhdt11"
                value={attendees}
                onChange={(e) => setAttendees(e.target.value)}
              />

              <Input.TextArea
                label="Mô tả"
                placeholder="Mô tả cuộc họp"
                rows={5}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />

              {schedule && (
                <div className="booking-modal__sched-info">
                  <CircleInfo width={16} height={16} />
                  <span>{SCHEDULE_INFO_2}</span>
                </div>
              )}
            </div>
          </div>

          <div className="booking-modal__actions">
            <Button fullWidth onClick={() => void submit()} loading={loading}>
              Đặt phòng
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
