import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import ChevronLeft from "@gravity-ui/icons/ChevronLeft";
import Compass from "@gravity-ui/icons/Compass";

import RoomDirectionDetail from "@/components/room-direction-detail";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { api, AuthError } from "@/services/api";
import { roomFlag } from "@/services/room-flags";
import { useT } from "@/services/settings";
import type { DirectoryRoom } from "@/types";

// Cache cấp module: mở lại màn "Chỉ đường" render ngay từ cache rồi nạp ngầm
// (sống trong phiên, mất khi reload app).
let cachedRooms: DirectoryRoom[] | null = null;

// Khớp case-insensitive với cột office của meeting_room_metadata.
function officeKey(office?: string | null): string {
  return (office ?? "").trim().toLowerCase();
}

// Nhãn hiển thị cho office (chuẩn hoá hoa/thường): tnr → TNR, campus → Campus.
// Giá trị lạ thì giữ nguyên. Dùng chung cho fallback vị trí ở list + chi tiết.
const OFFICE_LABELS: Record<string, string> = {
  campus: "Campus",
  tnr: "TNR",
  sala: "Sala",
};
export function officeLabel(office?: string | null): string {
  const raw = (office ?? "").trim();
  return OFFICE_LABELS[raw.toLowerCase()] ?? raw;
}

// Vị trí hiển thị 1 dòng, vd "Tầng 3 - Toà V1" (song ngữ qua common.floor/building).
function locationLine(
  room: DirectoryRoom,
  t: ReturnType<typeof useT>,
): string {
  const floor = (room.floor ?? "").trim();
  const building = (room.building ?? "").trim();
  const parts: string[] = [];
  if (floor) parts.push(t("common.floor", { floor }));
  if (building) parts.push(t("common.building", { building }));
  return parts.join(" - ") || officeLabel(room.office);
}

// Chữ cái nhóm cho 1 phòng (A, B, ...). Không phải chữ cái → nhóm "#".
function groupLetter(name: string): string {
  const c = (name.trim()[0] ?? "").toUpperCase();
  return /[A-Z]/.test(c) ? c : "#";
}

type Props = {
  // Office của user đang đăng nhập — danh sách luôn lọc theo office này.
  office?: string | null;
  onClose: () => void;
};

// Màn "Chỉ đường" (Figma 392-12167): overlay push từ phải. Danh sách phòng luôn
// lọc theo office của user, nhóm theo chữ cái đầu, mỗi dòng có ảnh + tên (kèm cờ)
// + vị trí + nút chỉ đường. Bấm dòng hoặc nút → mở màn chi tiết (có sơ đồ + hướng
// dẫn đường đi).
export default function Directions({ office, onClose }: Props) {
  const t = useT();
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const [rooms, setRooms] = useState<DirectoryRoom[] | null>(cachedRooms);
  const [loading, setLoading] = useState(cachedRooms === null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<DirectoryRoom | null>(null);
  // Chữ cái đang chạm trên thanh A-Z (hiện bong bóng + tô sáng); null = không chạm.
  const [activeLetter, setActiveLetter] = useState<string | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  // Ref tới từng section nhóm chữ cái để cuộn nhanh tới đầu nhóm.
  const groupRefs = useRef<Map<string, HTMLElement>>(new Map());

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  function handleClose() {
    setLeaving(true);
    window.setTimeout(onClose, 260); // khớp thời lượng slide-out
  }

  // Tắt swipe-back khi màn chi tiết đang mở (nó tự có swipe-back riêng).
  const swipeBack = useSwipeBack(handleClose, !selected);

  async function load() {
    if (cachedRooms === null) setLoading(true);
    setError(false);
    try {
      const { rooms } = await api.roomsDirectory();
      cachedRooms = rooms;
      setRooms(rooms);
    } catch (e) {
      if (!(e instanceof AuthError)) setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Cuộn danh sách sao cho đầu nhóm `letter` lên sát mép trên vùng cuộn.
  function scrollToLetter(letter: string) {
    const body = bodyRef.current;
    const el = groupRefs.current.get(letter);
    if (body && el) body.scrollTop = el.offsetTop;
  }

  // Chữ cái ứng với vị trí ngón tay trên thanh A-Z (theo tỉ lệ Y trong thanh) —
  // dùng tỉ lệ thay vì elementFromPoint để kéo mượt, không kẹt ở khe giữa chữ.
  function letterAtY(clientY: number, letters: string[]): string | null {
    const rail = railRef.current;
    if (!rail || letters.length === 0) return null;
    const rect = rail.getBoundingClientRect();
    const ratio = (clientY - rect.top) / rect.height;
    const idx = Math.max(
      0,
      Math.min(letters.length - 1, Math.floor(ratio * letters.length)),
    );
    return letters[idx] ?? null;
  }

  function onRailTouch(e: React.TouchEvent, letters: string[]) {
    const touch = e.touches[0];
    if (!touch) return;
    const letter = letterAtY(touch.clientY, letters);
    if (letter && letter !== activeLetter) {
      setActiveLetter(letter);
      scrollToLetter(letter);
    }
  }

  // Phòng thuộc office của user, nhóm theo chữ cái đầu; nhóm & phòng đều sort A→Z.
  // office rỗng (chưa có hồ sơ) → hiện tất cả để không trống trơn.
  const groups = useMemo(() => {
    const target = officeKey(office);
    const list = (rooms ?? []).filter(
      (r) => !target || officeKey(r.office) === target,
    );
    const byLetter = new Map<string, DirectoryRoom[]>();
    for (const r of list) {
      const letter = groupLetter(r.name);
      const arr = byLetter.get(letter);
      if (arr) arr.push(r);
      else byLetter.set(letter, [r]);
    }
    return [...byLetter.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([letter, items]) => ({
        letter,
        items: items.sort((a, b) => a.name.localeCompare(b.name, "vi")),
      }));
  }, [rooms, office]);

  return (
    <div
      className={`dir${entered && !leaving ? " is-open" : ""}`}
      role="dialog"
      aria-label={t("dir.title")}
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
        <span className="mtg-detail__header-title">{t("dir.title")}</span>
      </header>

      <div className="dir__body" ref={bodyRef}>
        {loading ? (
          <div className="dir__state">{t("dir.loading")}</div>
        ) : error ? (
          <div className="dir__state">
            {t("dir.loadFailed")}
            <button className="dir__retry" type="button" onClick={() => void load()}>
              {t("common.retry")}
            </button>
          </div>
        ) : groups.length === 0 ? (
          <div className="dir__state">{t("dir.empty")}</div>
        ) : (
          groups.map((group) => (
            <section
              key={group.letter}
              className="dir__group"
              ref={(el) => {
                const m = groupRefs.current;
                if (el) m.set(group.letter, el);
                else m.delete(group.letter);
              }}
            >
              <div className="dir__group-letter">{group.letter}</div>
              <div className="dir__list">
                {group.items.map((room) => {
                  const flag = roomFlag(room.name);
                  return (
                    <div
                      key={room.email || room.name}
                      className="dir-row"
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelected(room)}
                    >
                      <div
                        className="dir-row__media"
                        style={
                          room.image
                            ? { backgroundImage: `url(${room.image})` }
                            : undefined
                        }
                      />
                      <div className="dir-row__info">
                        <div className="dir-row__name">
                          {flag && `${flag} `}
                          {room.name}
                        </div>
                        <div className="dir-row__loc">{locationLine(room, t)}</div>
                      </div>
                      <button
                        className="dir-row__go"
                        type="button"
                        aria-label={t("dir.viewDirections")}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelected(room);
                        }}
                      >
                        <Compass width={20} height={20} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </div>

      {/* Thanh quick-select A-Z bên phải (như danh bạ Zalo): chạm/kéo để nhảy
          tới nhóm chữ cái. Chỉ hiện các chữ cái đang có phòng. */}
      {!loading && !error && groups.length > 0 && (
        <div
          className="dir__rail"
          ref={railRef}
          onTouchStart={(e) => onRailTouch(e, groups.map((g) => g.letter))}
          onTouchMove={(e) => onRailTouch(e, groups.map((g) => g.letter))}
          onTouchEnd={() =>
            window.setTimeout(() => setActiveLetter(null), 400)
          }
        >
          {groups.map((group) => (
            <button
              key={group.letter}
              type="button"
              className={`dir__rail-letter${
                activeLetter === group.letter ? " is-active" : ""
              }`}
              onClick={() => scrollToLetter(group.letter)}
            >
              {group.letter}
            </button>
          ))}
        </div>
      )}

      {activeLetter && <div className="dir__rail-bubble">{activeLetter}</div>}

      {selected && (
        <RoomDirectionDetail
          room={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
