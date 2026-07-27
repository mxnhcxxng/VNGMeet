import { useEffect, useState } from "react";

import ChevronLeft from "@gravity-ui/icons/ChevronLeft";
import MapPin from "@gravity-ui/icons/MapPin";
import Persons from "@gravity-ui/icons/Persons";

import MapModal from "@/components/map-modal";
import { officeLabel } from "@/pages/directions";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { roomFlag } from "@/services/room-flags";
import { useT } from "@/services/settings";
import type { TranslationKey } from "@/services/i18n";
import type { CapacitySize, DirectoryRoom } from "@/types";

// Khoảng số người theo cỡ sức chứa (khớp find-room / home).
const CAP_RANGE: Record<CapacitySize, string> = {
  small: "≤4",
  medium: "5–12",
  large: "13+",
};

// Cỡ sức chứa từ capacity số → nhóm, hoặc dùng capacity_size sẵn có.
function capacitySize(room: DirectoryRoom): CapacitySize | null {
  if (typeof room.capacity === "number") {
    if (room.capacity <= 4) return "small";
    if (room.capacity <= 12) return "medium";
    return "large";
  }
  return room.capacity_size ?? null;
}

type Props = {
  room: DirectoryRoom;
  onClose: () => void;
};

// Màn "Chi tiết phòng họp" cho luồng Chỉ đường (Figma 392-12499): push từ phải
// sang trái. Gồm tên phòng (kèm cờ), vị trí, sức chứa, ảnh sơ đồ (mở phóng to
// được) và phần hướng dẫn đường đi. Cùng bộ style với "Chi tiết lịch họp".
export default function RoomDirectionDetail({ room, onClose }: Props) {
  const t = useT();
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  function handleClose() {
    setLeaving(true);
    window.setTimeout(onClose, 260); // khớp thời lượng slide-out
  }

  // Vuốt mép trái để quay lại danh sách; tắt khi map modal đang mở.
  const swipeBack = useSwipeBack(handleClose, !mapOpen);

  const flag = roomFlag(room.name);
  const cap = capacitySize(room);
  const floor = (room.floor ?? "").trim();
  const building = (room.building ?? "").trim();
  const locationParts: string[] = [];
  if (floor) locationParts.push(t("common.floor", { floor }));
  if (building) locationParts.push(t("common.building", { building }));
  const location = locationParts.join(" - ") || officeLabel(room.office);
  const directions = (room.direction ?? "").trim();
  // Tách chỉ đường thành từng đoạn để hiện dạng bullet. Ưu tiên tách theo dòng
  // trống (ngăn đoạn); nếu không có thì tách theo từng dòng đơn.
  let steps = directions
    .split(/\n\s*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (steps.length < 2) {
    steps = directions
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return (
    <div
      className={`mtg-detail dir-detail${entered && !leaving ? " is-open" : ""}`}
      role="dialog"
      aria-label={t("dir.detailTitle")}
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
        <span className="mtg-detail__header-title">{t("dir.detailTitle")}</span>
      </header>

      <div className="mtg-detail__scroll">
        <section className="mtg-detail__card">
          <div className="mtg-detail__main">
            <h1 className="mtg-detail__title">
              {flag && `${flag} `}
              {room.name}
            </h1>

            <div className="mtg-detail__info">
              {location && (
                <div className="mtg-detail__row">
                  <MapPin width={16} height={16} />
                  <span>{location}</span>
                </div>
              )}
              {cap && (
                <div className="mtg-detail__row">
                  <Persons width={16} height={16} />
                  <span>
                    {t(`cap.${cap}` as TranslationKey)} ({CAP_RANGE[cap]})
                  </span>
                </div>
              )}
            </div>
          </div>

          {room.map && (
            <button
              className="mtg-detail__map"
              type="button"
              aria-label={t("detail.viewMap")}
              onClick={() => setMapOpen(true)}
            >
              <img src={room.map} alt={t("detail.mapAlt")} />
            </button>
          )}
        </section>

        <section className="mtg-detail__card mtg-detail__desc">
          <h2 className="mtg-detail__desc-title">{t("dir.directionsTitle")}</h2>
          {steps.length > 1 ? (
            <ul className="dir-detail__steps">
              {steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ul>
          ) : directions ? (
            <p className="mtg-detail__desc-body">{directions}</p>
          ) : (
            <p className="mtg-detail__desc-empty">{t("dir.directionsEmpty")}</p>
          )}
        </section>
      </div>

      {mapOpen && room.map && (
        <MapModal src={room.map} onClose={() => setMapOpen(false)} />
      )}
    </div>
  );
}
