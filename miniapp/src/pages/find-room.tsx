import { useEffect, useMemo, useRef, useState } from "react";

import ChevronLeft from "@gravity-ui/icons/ChevronLeft";
import ChevronRight from "@gravity-ui/icons/ChevronRight";
import Clock from "@gravity-ui/icons/Clock";
import HeartFill from "@gravity-ui/icons/HeartFill";
import PersonFill from "@gravity-ui/icons/PersonFill";
import PlanetEarth from "@gravity-ui/icons/PlanetEarth";

import BookingModal from "@/components/booking-modal";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { api, AuthError } from "@/services/api";
import { roomFlag } from "@/services/room-flags";
import { useT } from "@/services/settings";
import type { TFunction, TranslationKey } from "@/services/i18n";
import type { FreeRoom, ScheduleResponse, ScheduleRoom } from "@/types";

// Số ngày nạp về — khớp RANGE_DAYS của web (today .. today+15, tới ~10/8).
const DAYS = 16;
// Chiều cao 1 hàng giờ (px) — phải KHỚP --fr-row-h trong app.scss (dùng cho
// auto-scroll về khung giờ làm việc + định vị thanh "now").
const ROW_H = 44;
// Chiều cao hàng tiêu đề phòng (px) — phải KHỚP --fr-head-h trong app.scss.
const HEAD_H = 52;
// Booking hẹn giờ (scheduled) tối đa 3 tiếng — backend chặn quá mốc này, nên
// giới hạn luôn khi kéo chọn ở ngày scheduled (khớp web).
const SCHED_MAX_MINUTES = 3 * 60;

// Ngày "scheduled" (ngoài cửa sổ Graph): trạng thái ô ≥ 3. Ô trống scheduled = 3.
function isScheduleStatus(status: number): boolean {
  return status >= 3;
}

function isoToDate(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}
// Nhãn thứ trong tuần theo index getDay() (0 = CN) — dịch theo ngôn ngữ hiện tại.
function weekdayLabel(iso: string, t: TFunction): string {
  return t(`weekday.${isoToDate(iso).getDay()}` as TranslationKey);
}
function dayNumber(iso: string): string {
  return String(isoToDate(iso).getDate());
}
function isWeekend(iso: string): boolean {
  const d = isoToDate(iso).getDay();
  return d === 0 || d === 6;
}
// Date -> "yyyy-mm-dd" theo giờ máy (không dùng UTC để không lệch ngày).
function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function minutesToLabel(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(
    mins % 60,
  ).padStart(2, "0")}`;
}
// "09:00" + 30 phút -> "09:30".
function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  return minutesToLabel(h * 60 + m + minutes);
}

// Trống & đặt được: 0 (instant) hoặc 3 (scheduled). Khớp isFreeStatus bản web.
function isFree(status: number): boolean {
  return status === 0 || status === 3;
}

type CellKind = "free" | "busy" | "mine" | "pending";

// Gộp 10 mã trạng thái về 4 nhóm hiển thị trên mobile.
function cellKind(status: number): CellKind {
  if (isFree(status)) return "free";
  if (status === 6 || status === 7) return "pending";
  if (status === 2 || status === 5 || status === 8 || status === 9)
    return "mine";
  return "busy"; // 1, 4 = người khác đặt
}

// Cỡ sức chứa (khớp web): capacity số → nhóm; hoặc dùng capacity_size sẵn có.
type CapSize = "small" | "medium" | "large";
// Khoảng số người (không đổi theo ngôn ngữ); nhãn "Nhỏ/Vừa/Lớn" dịch qua cap.*.
const CAP_RANGE: Record<CapSize, string> = {
  small: "≤4",
  medium: "5–12",
  large: "13+",
};
function capacitySize(room: ScheduleRoom): CapSize | null {
  if (typeof room.capacity === "number") {
    if (room.capacity <= 4) return "small";
    if (room.capacity <= 12) return "medium";
    return "large";
  }
  return room.capacity_size ?? null;
}

// ------------------------------------------------------------------ //
// Sort thông minh — port từ web (frontend/components/BrowseRooms.tsx)
// ------------------------------------------------------------------ //
const CAPACITY_RANK: Record<CapSize, number> = { medium: 0, large: 1, small: 2 };
function capacityRank(room: ScheduleRoom): number {
  const size = capacitySize(room);
  return size ? CAPACITY_RANK[size] : 3;
}
function numericFloor(floor?: string | null): number | null {
  const m = String(floor ?? "").match(/-?\d+/);
  return m ? Number(m[0]) : null;
}
// Độ "gần user" theo toà + tầng (tuple nhỏ hơn = gần user hơn).
function locationRank(
  room: ScheduleRoom,
  userBuilding?: string,
  userFloor?: string,
): number[] {
  const rb = (room.building ?? "").trim().toLowerCase();
  const pb = (userBuilding ?? "").trim().toLowerCase();
  const sameBuilding = Boolean(rb && pb && rb === pb);
  const uf = numericFloor(userFloor);
  const rf = numericFloor(room.floor);
  const hasFloor = uf !== null && rf !== null;
  const sameFloor = hasFloor && rf === uf;
  if (sameBuilding && sameFloor) return [0, 0, 0];
  if (!sameBuilding && sameFloor) return [1, 0, 0];
  if (sameBuilding && hasFloor) {
    const gap = Math.abs((rf as number) - (uf as number));
    return [2, gap, (rf as number) > (uf as number) ? 1 : 0];
  }
  if (!sameBuilding && hasFloor) {
    const gap = Math.abs((rf as number) - (uf as number));
    return [3, gap, (rf as number) > (uf as number) ? 1 : 0];
  }
  return [4, Number.MAX_SAFE_INTEGER, 1];
}
// Xếp theo số chỗ trống từ slot hiện tại tới cuối ngày (chỉ có ý nghĩa khi xem
// hôm nay — `info` khác null). Trả tuple so sánh element-wise.
function availabilityRank(
  room: ScheduleRoom,
  dayIndex: number,
  info: { current: number; total: number } | null,
): number[] {
  if (!info) return [0, 0, 0];
  const { current, total } = info;
  let free = 0;
  for (let i = current; i < total; i += 1) {
    if (isFree(room.grid[i]?.[dayIndex] ?? 1)) free += 1;
  }
  const freeCurrent = isFree(room.grid[current]?.[dayIndex] ?? 1) ? 0 : 1;
  const freeNext = isFree(room.grid[current + 1]?.[dayIndex] ?? 1) ? 0 : 1;
  // Âm hoá free để "nhiều trống hơn" xếp trước (thứ tự tăng dần).
  return [-free, freeNext, freeCurrent];
}

type Props = {
  onClose: () => void;
};

// Vùng chọn: 1 phòng + khoảng slot liên tiếp [lo..hi] (chỉ số vào `times`).
type Selection = { roomEmail: string; lo: number; hi: number };

// Màn "Tìm phòng" (Figma 380-2214): trượt từ PHẢI vào, có nút back → swipe-back.
// Lưới lịch phòng (phòng = cột, giờ = hàng) đọc từ /api/availability giống web.
// Chọn ô trống: bấm ô nào dính ô đó; bấm ô trống ngay sát trên/dưới để nối thêm
// (từng ô một), bấm lại ô ở mép để bỏ bớt → nút "Đặt phòng" đặt cả khoảng.
export default function FindRoom({ onClose }: Props) {
  const t = useT();
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const [data, setData] = useState<ScheduleResponse | null>(null);
  const [office, setOffice] = useState<string>("");
  const [userBuilding, setUserBuilding] = useState<string>("");
  const [userFloor, setUserFloor] = useState<string>("");
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [dayIndex, setDayIndex] = useState(0);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [booking, setBooking] = useState<{
    room: FreeRoom;
    schedule: boolean;
  } | null>(null);
  // Giờ hiện tại (cập nhật mỗi phút) — dùng cho sort "phòng trống ngay bây giờ".
  const [now, setNow] = useState(() => new Date());

  const gridWrapRef = useRef<HTMLDivElement>(null);
  const didAutoScroll = useRef(false);
  // Nút ngày đang chọn — dùng để cuộn dải ngày sao cho nó luôn nằm trong tầm nhìn.
  const activeDayRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  function handleClose() {
    setLeaving(true);
    window.setTimeout(onClose, 260); // khớp thời lượng slide-out
  }

  // Tắt swipe-back khi form đặt phòng đang mở (nó tự có swipe-back riêng).
  const swipeBack = useSwipeBack(handleClose, !booking);

  async function load() {
    setLoading(true);
    setError(false);
    try {
      // Hồ sơ (office/toà/tầng + phòng ưa thích) và lịch phòng nạp song song.
      const [me, res] = await Promise.all([
        api.me().catch(() => null),
        api.availability(DAYS),
      ]);
      setData(res);
      setOffice((me?.profile?.office ?? "").trim());
      setUserBuilding((me?.profile?.building ?? "").trim());
      setUserFloor((me?.profile?.floor ?? "").trim());
      setFavorites(
        new Set(
          (me?.profile?.preferred_rooms ?? []).map((e) => e.trim().toLowerCase()),
        ),
      );
    } catch (e) {
      if (!(e instanceof AuthError)) setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Đổi ngày thì bỏ ô đang chọn (ô thuộc ngày cũ).
  function selectDay(index: number) {
    setDayIndex(index);
    setSelected(null);
  }

  // Luôn cuộn nút ngày đang chọn vào tầm nhìn (căn giữa) — bấm next/prev liên
  // tục cũng không để ngày chọn trôi ra ngoài màn hình. block:nearest để không
  // cuộn dọc; chỉ dải ngày (overflow-x) cuộn ngang.
  useEffect(() => {
    activeDayRef.current?.scrollIntoView({
      block: "nearest",
      inline: "center",
      behavior: "smooth",
    });
  }, [dayIndex, data]);

  // Chỉ số giờ trong khung giờ làm việc (business window) từ nhãn giờ.
  const businessIndexByTime = useMemo(() => {
    const map = new Map<string, number>();
    (data?.times ?? []).forEach((t, i) => map.set(t, i));
    return map;
  }, [data]);

  // Slot hiện tại (chỉ khi đang xem hôm nay & trong giờ làm việc) → sort ưu tiên.
  const currentRange = useMemo(() => {
    if (!data) return null;
    if (data.days[dayIndex] !== localIso(now)) return null;
    const mins = now.getHours() * 60 + now.getMinutes();
    const slot = Math.floor(mins / data.slotMinutes) * data.slotMinutes;
    const cur = businessIndexByTime.get(minutesToLabel(slot));
    return cur === undefined ? null : { current: cur, total: data.times.length };
  }, [data, dayIndex, now, businessIndexByTime]);

  // Ngày có lịch (user tổ chức/được mời) → chấm xanh trên dải chọn ngày (như web).
  const bookedDates = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.rooms ?? [])
      for (const m of r.meetings ?? []) set.add(m.date);
    return set;
  }, [data]);

  // Lưới đủ 24h: 00:00 → 23:xx theo slotMinutes. Hàng trong khung giờ làm việc
  // map vào grid của API; ngoài khung thì tô xám, không đặt được (giống web).
  const slotMinutes = data?.slotMinutes ?? 30;
  const allTimes = useMemo(() => {
    const count = Math.floor((24 * 60) / slotMinutes);
    return Array.from({ length: count }, (_, i) => minutesToLabel(i * slotMinutes));
  }, [slotMinutes]);

  // Thanh "now": chỉ hiện khi đang xem hôm nay. Vị trí = tiêu đề + số phút từ
  // 0h quy ra pixel (mỗi slot cao ROW_H). Cập nhật theo `now` (mỗi phút).
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const showNow = !!data && data.days[dayIndex] === localIso(now);
  const nowLabel = minutesToLabel(nowMinutes);
  const nowTop = HEAD_H + (nowMinutes / slotMinutes) * ROW_H;

  // Phòng: lọc theo office của user, rồi xếp theo sort thông minh (port từ web).
  const rooms = useMemo(() => {
    if (!data) return [];
    const base = office
      ? data.rooms.filter((r) => (r.office ?? "") === office)
      : data.rooms;
    const day = data.days[dayIndex];
    // Phòng mà user có lịch trong ngày đang xem → lên đầu.
    const myMeetingEmails = new Set(
      base
        .filter((r) => (r.meetings ?? []).some((m) => m.date === day))
        .map((r) => r.email.toLowerCase()),
    );
    return base
      .map((room, index) => ({ room, index }))
      .sort((a, b) => {
        const myDiff =
          Number(!myMeetingEmails.has(a.room.email.toLowerCase())) -
          Number(!myMeetingEmails.has(b.room.email.toLowerCase()));
        if (myDiff) return myDiff;

        const av = availabilityRank(a.room, dayIndex, currentRange);
        const bv = availabilityRank(b.room, dayIndex, currentRange);
        for (let i = 0; i < av.length; i += 1) {
          const d = av[i] - bv[i];
          if (d) return d;
        }

        const favDiff =
          Number(!favorites.has(a.room.email.toLowerCase())) -
          Number(!favorites.has(b.room.email.toLowerCase()));
        if (favDiff) return favDiff;

        const capDiff = capacityRank(a.room) - capacityRank(b.room);
        if (capDiff) return capDiff;

        const al = locationRank(a.room, userBuilding, userFloor);
        const bl = locationRank(b.room, userBuilding, userFloor);
        for (let i = 0; i < al.length; i += 1) {
          const d = al[i] - bl[i];
          if (d) return d;
        }

        return (
          a.room.name.localeCompare(b.room.name, "vi") || a.index - b.index
        );
      })
      .map((x) => x.room);
  }, [data, office, dayIndex, currentRange, favorites, userBuilding, userFloor]);

  // grid-template-columns: cột giờ cố định + N cột phòng.
  const gridCols = `var(--fr-time-col) repeat(${rooms.length}, var(--fr-room-col))`;

  // Auto-scroll khi mở lần đầu (khớp web): trước 13h neo ở ~9h, từ 13h trở đi neo
  // ở ~13h. Cuộn tới 1 hàng trước mốc neo để có chút ngữ cảnh phía trên.
  useEffect(() => {
    if (loading || didAutoScroll.current || !data || rooms.length === 0) return;
    const el = gridWrapRef.current;
    if (!el) return;
    const cur = now.getHours() * 60 + now.getMinutes();
    const anchorMinutes = cur < 13 * 60 ? 9 * 60 : 13 * 60;
    const anchorBlock = Math.floor(anchorMinutes / slotMinutes);
    el.scrollTop = Math.max(0, (anchorBlock - 1) * ROW_H);
    didAutoScroll.current = true;
  }, [loading, data, rooms.length, slotMinutes, now]);

  // Bấm 1 ô trống (business index bi): chọn từng ô, nối/bỏ theo mép khoảng chọn.
  // Không còn guard delay — double-tap đã tắt bằng touch-action ở toàn màn.
  function onSelect(room: ScheduleRoom, bi: number) {
    // Ngày scheduled → chặn kéo dài quá 3 tiếng (backend từ chối).
    const scheduleDay = isScheduleStatus(room.grid[bi]?.[dayIndex] ?? 0);
    const overCap = (lo: number, hi: number) =>
      scheduleDay && (hi - lo + 1) * slotMinutes > SCHED_MAX_MINUTES;
    setSelected((cur) => {
      if (!cur || cur.roomEmail !== room.email) {
        return { roomEmail: room.email, lo: bi, hi: bi };
      }
      const { lo, hi } = cur;
      // Nối thêm ô sát trên/dưới; bỏ qua nếu vượt trần 3h (ngày scheduled).
      if (bi === lo - 1) return overCap(bi, hi) ? cur : { ...cur, lo: bi };
      if (bi === hi + 1) return overCap(lo, bi) ? cur : { ...cur, hi: bi };
      if (bi === lo && lo === hi) return null; // bấm lại ô đơn → bỏ hết
      if (bi === lo) return { ...cur, lo: lo + 1 }; // bỏ bớt ô ở mép trên
      if (bi === hi) return { ...cur, hi: hi - 1 }; // bỏ bớt ô ở mép dưới
      if (bi > lo && bi < hi) return cur; // ô giữa → giữ nguyên
      return { roomEmail: room.email, lo: bi, hi: bi }; // ô rời → bắt đầu lại
    });
  }

  // Mở form đặt phòng cho khoảng đang chọn.
  function openBooking() {
    if (!selected || !data) return;
    const room = rooms.find((r) => r.email === selected.roomEmail);
    if (!room) return;
    const startTime = data.times[selected.lo];
    const endTime = addMinutes(data.times[selected.hi], slotMinutes);
    const schedule = isScheduleStatus(room.grid[selected.lo]?.[dayIndex] ?? 0);
    setBooking({
      room: {
        name: room.name,
        email: room.email,
        building: room.building,
        floor: room.floor,
        image: room.thumbnail_link,
        start_time: startTime,
        end_time: endTime,
      },
      schedule,
    });
  }

  // Thông tin ô đang chọn (tên phòng + khoảng giờ) cho bottom bar.
  const selectedInfo = useMemo(() => {
    if (!selected || !data) return null;
    const room = rooms.find((r) => r.email === selected.roomEmail);
    if (!room) return null;
    return {
      name: room.name,
      time: `${data.times[selected.lo]} - ${addMinutes(
        data.times[selected.hi],
        slotMinutes,
      )}`,
    };
  }, [selected, data, rooms, slotMinutes]);

  return (
    <div
      className={`fr${entered && !leaving ? " is-open" : ""}`}
      role="dialog"
      aria-label={t("find.title")}
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
        <span className="mtg-detail__header-title">{t("find.title")}</span>
      </header>

      {/* Dải chọn ngày (T2 27 · T3 28 ...) — cuộn ngang, chevron chuyển ngày,
          chấm xanh ở ngày có lịch. */}
      <div className="fr__days">
        <button
          className="fr__day-nav"
          type="button"
          aria-label={t("find.prevDay")}
          disabled={dayIndex <= 0}
          onClick={() => selectDay(Math.max(0, dayIndex - 1))}
        >
          <ChevronLeft width={16} height={16} />
        </button>
        <div className="fr__day-strip">
          {(data?.days ?? []).map((iso, i) => (
            <button
              key={iso}
              type="button"
              ref={i === dayIndex ? activeDayRef : null}
              className={`fr__day${i === dayIndex ? " is-active" : ""}${
                isWeekend(iso) ? " is-weekend" : ""
              }`}
              onClick={() => selectDay(i)}
            >
              <span className="fr__day-wd">{weekdayLabel(iso, t)}</span>
              <span className="fr__day-num">{dayNumber(iso)}</span>
              <span
                className={`fr__day-dot${bookedDates.has(iso) ? " is-on" : ""}`}
              />
            </button>
          ))}
        </div>
        <button
          className="fr__day-nav"
          type="button"
          aria-label={t("find.nextDay")}
          disabled={!data || dayIndex >= data.days.length - 1}
          onClick={() =>
            data && selectDay(Math.min(data.days.length - 1, dayIndex + 1))
          }
        >
          <ChevronRight width={16} height={16} />
        </button>
      </div>

      {/* Lưới lịch phòng */}
      <div className="fr__body">
        {loading ? (
          <div className="fr__state">{t("find.loading")}</div>
        ) : error ? (
          <div className="fr__state">
            {t("find.loadFailed")}
            <button className="fr__retry" type="button" onClick={() => void load()}>
              {t("common.retry")}
            </button>
          </div>
        ) : rooms.length === 0 ? (
          <div className="fr__state">{t("find.noRooms")}</div>
        ) : (
          <div className="fr__grid-wrap" ref={gridWrapRef}>
            <div className="fr__grid" style={{ gridTemplateColumns: gridCols }}>
              {/* Hàng tiêu đề: góc "Giờ" + tên phòng (tim + cờ + sức chứa) */}
              <div className="fr__corner">{t("find.hour")}</div>
              {rooms.map((r) => {
                const fav = r.email
                  ? favorites.has(r.email.toLowerCase())
                  : false;
                const flag = roomFlag(r.name);
                const cap = capacitySize(r);
                return (
                  <div key={r.email} className="fr__rhead" title={r.name}>
                    <div className="fr__rhead-top">
                      {fav && (
                        <HeartFill
                          className="fr__rhead-heart"
                          width={14}
                          height={14}
                        />
                      )}
                      {flag && <span className="fr__rhead-flag">{flag}</span>}
                      <span className="fr__rhead-name">{r.name}</span>
                    </div>
                    {cap && (
                      <div className="fr__rhead-cap">
                        <span>
                          {t(`cap.${cap}` as TranslationKey)} ({CAP_RANGE[cap]}
                        </span>
                        <PersonFill width={10} height={10} />
                        <span>)</span>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Các hàng theo mốc giờ (đủ 24h) */}
              {allTimes.map((t) => {
                const bi = businessIndexByTime.get(t);
                const onHour = t.endsWith(":00");
                return (
                  <TimeRow
                    key={t}
                    time={t}
                    onHour={onHour}
                    businessIndex={bi}
                    rooms={rooms}
                    dayIndex={dayIndex}
                    selected={selected}
                    onSelect={onSelect}
                  />
                );
              })}

              {/* Thanh "now" — nhãn giờ sticky trái + đường ngang xuyên các cột */}
              {showNow && (
                <div className="fr__now" style={{ top: nowTop }} aria-hidden>
                  <div className="fr__now-gutter">
                    <span className="fr__now-pill">{nowLabel}</span>
                  </div>
                  <span className="fr__now-line" />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom bar — 2 state (Figma 381-32330): chưa chọn hiện gợi ý, đã chọn
          hiện phòng + khoảng giờ. Nút luôn màu xanh. */}
      <div className="fr__actions">
        {selectedInfo ? (
          <div className="fr__actions-info">
            <div className="fr__info-item">
              <PlanetEarth className="fr__info-icon" width={16} height={16} />
              <span className="fr__info-text">{selectedInfo.name}</span>
            </div>
            <div className="fr__info-item">
              <Clock className="fr__info-icon" width={16} height={16} />
              <span className="fr__info-text">{selectedInfo.time}</span>
            </div>
          </div>
        ) : (
          <div className="fr__actions-hint">{t("find.hint")}</div>
        )}
        <button className="fr__book-btn" type="button" onClick={openBooking}>
          {t("common.continue")}
        </button>
      </div>

      {booking && data && (
        <BookingModal
          room={booking.room}
          date={data.days[dayIndex]}
          schedule={booking.schedule}
          onClose={() => setBooking(null)}
          onBooked={() => {
            setSelected(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

// Một hàng giờ: nhãn giờ (sticky trái, chỉ hiện ở mốc tròn giờ) + ô mỗi phòng.
function TimeRow({
  time,
  onHour,
  businessIndex,
  rooms,
  dayIndex,
  selected,
  onSelect,
}: {
  time: string;
  onHour: boolean;
  businessIndex: number | undefined;
  rooms: ScheduleRoom[];
  dayIndex: number;
  selected: Selection | null;
  onSelect: (room: ScheduleRoom, businessIndex: number) => void;
}) {
  // Điểm bắt đầu chạm — để phân biệt "tap" với "kéo cuộn", và để KHÔNG phụ thuộc
  // vào sự kiện click (webview hay gộp 2 tap nhanh gần nhau thành double-tap →
  // cú thứ 2 rơi lại ô đầu). Dùng pointer event: mỗi lần chạm là 1 pointerup
  // đúng ô đang chạm, không bị gộp.
  const tapStart = useRef<{ x: number; y: number } | null>(null);
  return (
    <>
      <div className="fr__time">{onHour ? time : ""}</div>
      {rooms.map((r) => {
        // Ngoài khung giờ làm việc → ô xám, không tương tác.
        if (businessIndex === undefined) {
          return (
            <div key={r.email} className="fr__cell fr__cell--off" aria-disabled />
          );
        }
        const bi = businessIndex;
        const status = r.grid[bi]?.[dayIndex] ?? 1;
        const kind = cellKind(status);
        if (kind === "free") {
          const inSel =
            selected && selected.roomEmail === r.email
              ? bi >= selected.lo && bi <= selected.hi
              : false;
          const isFirst = inSel && bi === selected!.lo;
          const isLast = inSel && bi === selected!.hi;
          const cls = [
            "fr__cell",
            "fr__cell--free",
            inSel ? "is-selected" : "",
            isFirst ? "is-sel-first" : "",
            isLast ? "is-sel-last" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={r.email}
              type="button"
              className={cls}
              onPointerDown={(e) => {
                tapStart.current = { x: e.clientX, y: e.clientY };
              }}
              onPointerUp={(e) => {
                const s = tapStart.current;
                tapStart.current = null;
                if (!s) return;
                // Di chuyển nhiều = kéo cuộn, không phải tap → bỏ qua.
                if (
                  Math.abs(e.clientX - s.x) > 10 ||
                  Math.abs(e.clientY - s.y) > 10
                )
                  return;
                onSelect(r, bi);
              }}
              onPointerCancel={() => {
                tapStart.current = null;
              }}
            />
          );
        }
        return (
          <div key={r.email} className={`fr__cell fr__cell--${kind}`} aria-disabled />
        );
      })}
    </>
  );
}
