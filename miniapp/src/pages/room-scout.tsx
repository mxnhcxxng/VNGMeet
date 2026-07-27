import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Checkbox, DatePicker, Picker, useSnackbar } from "zmp-ui";

import ChevronLeft from "@gravity-ui/icons/ChevronLeft";
import ChevronDown from "@gravity-ui/icons/ChevronDown";
import Binoculars from "@gravity-ui/icons/Binoculars";
import Pencil from "@gravity-ui/icons/Pencil";
import Persons from "@gravity-ui/icons/Persons";
import CircleInfo from "@gravity-ui/icons/CircleInfo";

import { api, AuthError } from "@/services/api";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { useSettings, useT } from "@/services/settings";
import type { TFunction, TranslationKey } from "@/services/i18n";
import type { CapacitySize, RoomScout as RoomScoutRow, RoomScoutPayload } from "@/types";

// Săn tối đa 14 ngày tới — khớp SCOUT_MAX_ADVANCE_DAYS của web.
const SCOUT_MAX_ADVANCE_DAYS = 14;

const DURATION_VALUES = ["30", "60", "90", "120", "150", "180"] as const;
const DURATION_KEY: Record<string, TranslationKey> = {
  "30": "scout.dur30",
  "60": "scout.dur60",
  "90": "scout.dur90",
  "120": "scout.dur120",
  "150": "scout.dur150",
  "180": "scout.dur180",
};

const CAPACITY_VALUES: CapacitySize[] = ["small", "medium", "large"];
const CAPACITY_KEY: Record<CapacitySize, TranslationKey> = {
  small: "scout.capSmall",
  medium: "scout.capMedium",
  large: "scout.capLarge",
};

// Giờ làm việc 09:00–18:00, bước 30 phút (khớp slot_minutes của backend).
const TIME_OPTIONS = (() => {
  const out: string[] = [];
  for (let m = 9 * 60; m <= 18 * 60; m += 30) {
    out.push(
      `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`,
    );
  }
  return out;
})();

function timeToMinutes(value: string): number {
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m);
}

// Date -> "yyyy-mm-dd" theo giờ máy (không dùng UTC để không lệch ngày).
function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}
function isoToDate(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}
function localDateAfter(days: number): string {
  const value = new Date();
  value.setHours(12, 0, 0, 0);
  value.setDate(value.getDate() + days);
  return localIso(value);
}
// "2026-07-27" -> "27/07/2026"
function formatDmy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

// Giờ làm việc kết thúc 18:00. Mở form sau mốc này thì không còn slot đặt hôm nay
// nên mặc định nhảy sang ngày mai và về slot đầu (09:00) — khớp web.
function isAfterBusinessHours(): boolean {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() >= 18 * 60;
}
function defaultScoutDate(): string {
  return localDateAfter(isAfterBusinessHours() ? 1 : 0);
}
// Giờ bắt đầu mặc định = slot gần nhất ≥ hiện tại; sau giờ làm việc → 09:00.
function defaultStartTime(): string {
  const options = TIME_OPTIONS.slice(0, -1);
  if (options.length === 0) return "";
  if (isAfterBusinessHours()) return options[0];
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return options.find((tm) => timeToMinutes(tm) >= nowMinutes) ?? options[0];
}

function durationLabel(t: TFunction, minutes: number): string {
  const key = DURATION_KEY[String(minutes)];
  return key ? t(key) : t("scout.durFallback", { n: minutes });
}
function capacityLabel(t: TFunction, size?: CapacitySize | null): string {
  if (!size) return t("scout.capAny");
  return CAPACITY_KEY[size] ? t(CAPACITY_KEY[size]) : size;
}
// Khoảng số người cho chip màn thành công (khớp CAPACITY_RANGE của web/booking).
function capacityRange(size?: CapacitySize | null): string {
  if (size === "small") return "≤4";
  if (size === "medium") return "5–12";
  if (size === "large") return "13+";
  return "";
}
function pickRandom<T>(list: T[]): T | undefined {
  if (!list.length) return undefined;
  return list[Math.floor(Math.random() * list.length)];
}
function formatLastChecked(value?: string | null): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString([], {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  });
}

type Props = { onClose: () => void };

// Màn "Săn phòng" (Figma iPhone 17-9): trượt từ PHẢI vào, có nút back → swipe-back.
// Học fields + autofill từ bản web (frontend/components/RoomScout.tsx); các dropdown
// dùng ZaUI Picker (multi-column) + DatePicker thay cho Select của web.
// Vòng đời: form tạo → thẻ "đang săn" (sửa/huỷ) → thẻ "đã tìm thấy phòng".
export default function RoomScout({ onClose }: Props) {
  const t = useT();
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const [scouts, setScouts] = useState<RoomScoutRow[]>([]);
  const [userOffice, setUserOffice] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const load = useCallback(async () => {
    try {
      const [me, res] = await Promise.all([
        api.me().catch(() => null),
        api.roomScouts(),
      ]);
      setUserOffice((me?.profile?.office ?? "").trim());
      setScouts(res.scouts);
    } catch (e) {
      if (!(e instanceof AuthError)) {
        // Giữ trạng thái cũ; báo nhẹ để không kẹt màn trắng.
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeScout = useMemo(
    () => scouts.find((s) => s.status === "active") ?? null,
    [scouts],
  );

  // Rời chế độ sửa nếu phiên đang săn biến mất (vd hết hạn giữa chừng).
  useEffect(() => {
    if (!activeScout && editing) setEditing(false);
  }, [activeScout, editing]);

  // Phiên đã auto-book thành công, chưa xác nhận, ngày họp chưa qua → màn thành công.
  const successScout = useMemo(() => {
    const today = localDateAfter(0);
    return (
      scouts.find(
        (s) =>
          s.status === "success" &&
          !s.acknowledged_at &&
          (s.scout_date ?? "") >= today,
      ) ?? null
    );
  }, [scouts]);

  // Đang săn → auto-booker chạy nền mỗi phút; poll để màn tự lật sang thành công.
  useEffect(() => {
    if (!activeScout) return;
    const id = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(id);
  }, [activeScout, load]);

  function handleClose() {
    setLeaving(true);
    window.setTimeout(onClose, 260); // khớp thời lượng slide-out
  }

  // Màn thành công không có nút back → tắt swipe-back (giống booking success).
  // Khi đang mở màn edit (đè lên trên) cũng tắt swipe-back của màn nền.
  const showingSuccess = !loading && !activeScout && !!successScout;
  const swipeBack = useSwipeBack(handleClose, !showingSuccess && !editing);

  return (
    <>
      <div
        className={`scout${entered && !leaving ? " is-open" : ""}`}
        role="dialog"
        aria-label={t("scout.title")}
        {...(showingSuccess ? {} : swipeBack)}
      >
        {showingSuccess ? (
          <ScoutSuccessCard scout={successScout!} onDismiss={load} />
        ) : (
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
              <span className="mtg-detail__header-title">{t("scout.title")}</span>
            </header>

            {loading ? (
              <div className="scout__state">{t("scout.loading")}</div>
            ) : activeScout ? (
              <ScoutingCard
                scout={activeScout}
                onChanged={load}
                onEdit={() => setEditing(true)}
              />
            ) : (
              <ScoutForm userOffice={userOffice} onSaved={load} />
            )}
          </>
        )}
      </div>

      {/* Màn chỉnh sửa là 1 overlay riêng đẩy từ phải, đè lên màn "đang săn".
          Swipe/back = huỷ edit (quay lại màn đang săn), không đóng cả tính năng. */}
      {editing && activeScout && (
        <ScoutEditOverlay
          scout={activeScout}
          userOffice={userOffice}
          onSaved={async () => {
            setEditing(false);
            await load();
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </>
  );
}

// Overlay chỉnh sửa: tự quản slide-in/out + swipe-back (huỷ edit). Bọc header
// "Edit scouting" quanh ScoutForm ở chế độ edit.
function ScoutEditOverlay({
  scout,
  userOffice,
  onSaved,
  onCancel,
}: {
  scout: RoomScoutRow;
  userOffice: string;
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Trượt ra rồi mới gọi callback (khớp thời lượng transition 260ms).
  function finishThen(cb: () => void | Promise<void>) {
    setLeaving(true);
    window.setTimeout(() => void cb(), 260);
  }

  const swipeBack = useSwipeBack(() => finishThen(onCancel), true);

  return (
    <div
      className={`scout scout--layer${entered && !leaving ? " is-open" : ""}`}
      role="dialog"
      aria-label={t("scout.editTitle")}
      {...swipeBack}
    >
      <header className="mtg-detail__header">
        <button
          className="mtg-detail__back"
          type="button"
          aria-label={t("common.back")}
          onClick={() => finishThen(onCancel)}
        >
          <ChevronLeft width={24} height={24} />
        </button>
        <span className="mtg-detail__header-title">{t("scout.editTitle")}</span>
      </header>

      <ScoutForm
        mode="edit"
        scout={scout}
        userOffice={userOffice}
        onSaved={() => finishThen(onSaved)}
        onCancel={() => finishThen(onCancel)}
      />
    </div>
  );
}

// ------------------------------------------------------------------ //
// Form tạo / chỉnh sửa phiên săn phòng
// ------------------------------------------------------------------ //
function ScoutForm({
  userOffice,
  mode = "create",
  scout,
  onSaved,
  onCancel,
}: {
  userOffice: string;
  mode?: "create" | "edit";
  scout?: RoomScoutRow;
  onSaved: () => void | Promise<void>;
  onCancel?: () => void;
}) {
  const t = useT();
  const { language } = useSettings();
  const { openSnackbar } = useSnackbar();
  const isEdit = mode === "edit";

  const [scoutDate, setScoutDate] = useState(
    () => scout?.scout_date || defaultScoutDate(),
  );
  const [startTime, setStartTime] = useState(
    () => scout?.scout_start_time || defaultStartTime(),
  );
  const [endTime, setEndTime] = useState(scout?.scout_end_time || "");
  const [duration, setDuration] = useState(
    scout ? String(scout.duration_minutes) : "",
  );
  // Sức chứa cho chọn NHIỀU mức (multi-select) — khớp web. Seed từ phiên cũ.
  const [capacities, setCapacities] = useState<CapacitySize[]>(() =>
    scout?.capacity_sizes?.length
      ? scout.capacity_sizes
      : scout?.capacity_size
        ? [scout.capacity_size]
        : [],
  );
  const toggleCapacity = (size: CapacitySize) =>
    setCapacities((cur) =>
      cur.includes(size) ? cur.filter((s) => s !== size) : [...cur, size],
    );
  const [ignoreLunch, setIgnoreLunch] = useState(
    Boolean(scout?.ignore_lunch_break),
  );
  const [saving, setSaving] = useState(false);

  const today = localDateAfter(0);
  const maxScoutDate = localDateAfter(SCOUT_MAX_ADVANCE_DAYS);

  const durationOptions = useMemo(
    () =>
      DURATION_VALUES.map((v) => ({ value: v, displayName: durationLabel(t, Number(v)) })),
    [t],
  );
  const startOptions = useMemo(
    () => TIME_OPTIONS.slice(0, -1).map((tm) => ({ value: tm, displayName: tm })),
    [],
  );
  const endOptions = useMemo(() => {
    const after = startTime ? timeToMinutes(startTime) : -Infinity;
    return TIME_OPTIONS.filter((tm) => timeToMinutes(tm) > after).map((tm) => ({
      value: tm,
      displayName: tm,
    }));
  }, [startTime]);

  // Tuỳ chọn "bỏ qua giờ nghỉ trưa" chỉ có nghĩa khi khoảng chọn giao 12:00–13:00.
  const crossesLunch = useMemo(() => {
    if (!startTime || !endTime) return false;
    return timeToMinutes(startTime) < 13 * 60 && timeToMinutes(endTime) > 12 * 60;
  }, [startTime, endTime]);

  // Tự tick/bỏ tick khi khoảng chọn giao/không giao giờ trưa; bỏ qua lần chạy đầu
  // để giữ giá trị đã seed (tạo mới: false; sửa: lựa chọn đã lưu).
  const lunchFirstRun = useRef(true);
  useEffect(() => {
    if (lunchFirstRun.current) {
      lunchFirstRun.current = false;
      return;
    }
    setIgnoreLunch(crossesLunch);
  }, [crossesLunch]);

  const pickerAction = { text: t("scout.confirm"), close: true };
  const suffix = <ChevronDown width={18} height={18} className="scout__chevron" />;

  async function submit() {
    if (!scoutDate || scoutDate < today || scoutDate > maxScoutDate) {
      openSnackbar({ text: t("scout.chooseDate"), type: "warning" });
      return;
    }
    if (!duration) {
      openSnackbar({ text: t("scout.chooseDuration"), type: "warning" });
      return;
    }
    if (!startTime || !endTime) {
      openSnackbar({ text: t("scout.chooseRange"), type: "warning" });
      return;
    }
    if (capacities.length === 0) {
      openSnackbar({ text: t("scout.chooseCapacity"), type: "warning" });
      return;
    }
    if (timeToMinutes(endTime) - timeToMinutes(startTime) < Number(duration)) {
      openSnackbar({ text: t("scout.rangeTooShort"), type: "warning" });
      return;
    }
    const payload: RoomScoutPayload = {
      scout_date: scoutDate,
      duration_minutes: Number(duration),
      capacity_sizes: capacities,
      scout_start_time: startTime,
      scout_end_time: endTime,
      ignore_lunch_break: ignoreLunch,
      office: userOffice || null,
    };
    setSaving(true);
    try {
      if (isEdit && scout) {
        await api.updateRoomScout(scout.id, payload);
        openSnackbar({ text: t("scout.updated"), type: "success" });
      } else {
        await api.createRoomScout(payload);
        openSnackbar({
          text: t("scout.started"),
          type: "success",
        });
      }
      await onSaved();
    } catch (e) {
      openSnackbar({
        text: isEdit ? t("scout.updateFailed") : t("scout.startFailed"),
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="scout__scroll">
        <p className="scout__subtitle">{t("scout.subtitle")}</p>

        <div className="scout__form">
          {/* Ngày */}
          <div className="scout__field">
            <DatePicker
              label={t("scout.date")}
              title={t("scout.selectDate")}
              dateFormat="dd/mm/yyyy"
              columnsFormat="DD-MM-YYYY"
              locale={language === "vi" ? "vi-VN" : "en-US"}
              startDate={isoToDate(today)}
              endDate={isoToDate(maxScoutDate)}
              // Dùng defaultValue (đọc lúc mount) thay cho value: ZaUI Picker chỉ
              // lấy value ở lần khởi tạo, còn DatePicker set value qua effect sau
              // mount nên value KHÔNG hiển thị (ô trống). defaultValue = ngày đang
              // săn (edit) hoặc ngày mặc định (tạo mới) → autofill đúng.
              defaultValue={isoToDate(scoutDate)}
              onChange={(value) => {
                if (value instanceof Date && !Number.isNaN(value.getTime())) {
                  setScoutDate(localIso(value));
                }
              }}
              mask
              maskClosable
              action={pickerAction}
              suffix={suffix}
            />
          </div>

          {/* Thời lượng */}
          <div className="scout__field">
            <Picker
              label={t("scout.duration")}
              title={t("scout.selectDuration")}
              placeholder={t("scout.selectDuration")}
              data={[{ name: "duration", options: durationOptions }]}
              value={duration ? { duration } : undefined}
              onChange={(v) => setDuration(String(v.duration.value))}
              mask
              maskClosable
              action={pickerAction}
              suffix={suffix}
            />
          </div>

          {/* Khung giờ tìm phòng (bắt đầu / kết thúc) */}
          <div className="scout__field">
            <span className="scout__label">{t("scout.scoutRange")}</span>
            <div className="scout__range-row">
              <Picker
                title={t("scout.startTime")}
                placeholder={t("scout.startTime")}
                data={[{ name: "start", options: startOptions }]}
                value={startTime ? { start: startTime } : undefined}
                onChange={(v) => {
                  const next = String(v.start.value);
                  setStartTime(next);
                  if (endTime && timeToMinutes(endTime) <= timeToMinutes(next)) {
                    setEndTime("");
                  }
                }}
                mask
                maskClosable
                action={pickerAction}
                suffix={suffix}
              />
              <Picker
                title={t("scout.endTime")}
                placeholder={t("scout.endTime")}
                data={[{ name: "end", options: endOptions }]}
                value={endTime ? { end: endTime } : undefined}
                onChange={(v) => setEndTime(String(v.end.value))}
                mask
                maskClosable
                action={pickerAction}
                suffix={suffix}
              />
            </div>

            {crossesLunch && (
              <div className="scout__lunch">
                <Checkbox
                  value="ignore-lunch"
                  checked={ignoreLunch}
                  onChange={() => setIgnoreLunch((v) => !v)}
                  label={t("scout.ignoreLunch")}
                />
              </div>
            )}
          </div>

          {/* Sức chứa — chọn nhiều mức (multi-select) */}
          <div className="scout__field">
            <span className="scout__label">{t("scout.capacity")}</span>
            <div className="scout__caps">
              {CAPACITY_VALUES.map((size) => {
                const active = capacities.includes(size);
                return (
                  <button
                    key={size}
                    type="button"
                    className={`scout__cap-chip${active ? " is-active" : ""}`}
                    aria-pressed={active}
                    onClick={() => toggleCapacity(size)}
                  >
                    <span className="scout__cap-name">
                      {t(`cap.${size}` as TranslationKey)}
                    </span>
                    <span className="scout__cap-range">({capacityRange(size)})</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Chú thích tự dừng lúc 00:00 — chỉ khi săn ngày khác hôm nay. */}
          {scoutDate !== today && (
            <div className="scout__note">
              <CircleInfo width={16} height={16} />
              <span>{t("scout.endsAtMidnightNote")}</span>
            </div>
          )}
        </div>
      </div>

      <div className="scout__actions">
        {isEdit ? (
          <div className="scout__actions-row">
            <Button
              variant="secondary"
              type="neutral"
              fullWidth
              disabled={saving}
              onClick={() => onCancel?.()}
            >
              {t("scout.cancelEdit")}
            </Button>
            <Button fullWidth loading={saving} onClick={() => void submit()}>
              {t("scout.update")}
            </Button>
          </div>
        ) : (
          <Button fullWidth loading={saving} onClick={() => void submit()}>
            {t("scout.start")}
          </Button>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ //
// Thẻ "đang săn phòng" (Figma iPhone 17-10)
// ------------------------------------------------------------------ //
function ScoutingCard({
  scout,
  onChanged,
  onEdit,
}: {
  scout: RoomScoutRow;
  onChanged: () => void | Promise<void>;
  onEdit: () => void;
}) {
  const t = useT();
  const { openSnackbar } = useSnackbar();
  const [busy, setBusy] = useState(false);
  const differentDay =
    Boolean(scout.scout_date) && scout.scout_date !== localDateAfter(0);

  // Dấu ba chấm nhấp nháy: "." → ".." → "..." → lặp.
  const [dots, setDots] = useState(1);
  useEffect(() => {
    const id = window.setInterval(() => setDots((d) => (d % 3) + 1), 450);
    return () => window.clearInterval(id);
  }, []);

  // Ảnh phòng cho hero: nạp thumbnail của mọi phòng rồi crossfade ngẫu nhiên mỗi
  // 4s (giống ScoutingCard bản web). Nguồn ảnh lấy từ /availability.
  const [thumbs, setThumbs] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .availability(1)
      .then((res) => {
        if (!alive) return;
        const list = Array.from(
          new Set(
            res.rooms
              .map((r) => (r.thumbnail_link ?? "").trim())
              .filter(Boolean),
          ),
        );
        setThumbs(list);
      })
      .catch(() => {
        /* không có ảnh → hero giữ nền gradient + icon */
      });
    return () => {
      alive = false;
    };
  }, []);

  const [pair, setPair] = useState<{ cur?: string; prev?: string }>({});
  useEffect(() => {
    if (thumbs.length === 0) return;
    setPair((p) => (p.cur ? p : { cur: pickRandom(thumbs) }));
    if (thumbs.length < 2) return;
    const id = window.setInterval(() => {
      setPair((p) => ({ cur: pickRandom(thumbs) ?? p.cur, prev: p.cur }));
    }, 4000);
    return () => window.clearInterval(id);
  }, [thumbs]);

  const capacityText =
    (scout.capacity_sizes?.length
      ? scout.capacity_sizes
      : scout.capacity_size
        ? [scout.capacity_size]
        : []
    )
      .map((size) => capacityLabel(t, size))
      .join(", ") || t("scout.capAny");

  async function cancel() {
    setBusy(true);
    try {
      await api.stopRoomScout(scout.id, "canceled");
      openSnackbar({ text: t("scout.stopCancelled"), type: "success" });
      await onChanged();
    } catch (e) {
      openSnackbar({ text: t("scout.stopFailed"), type: "error" });
      setBusy(false);
    }
  }

  return (
    <>
      <div className="scout__scroll">
        <div className="scout__hero">
          {pair.prev && (
            <div
              className="scout__hero-img"
              style={{ backgroundImage: `url(${pair.prev})` }}
            />
          )}
          {pair.cur ? (
            <div
              key={pair.cur}
              className="scout__hero-img scout__hero-img--fade"
              style={{ backgroundImage: `url(${pair.cur})` }}
            />
          ) : (
            <Binoculars width={44} height={44} />
          )}
        </div>

        <h1 className="scout__scouting-title">
          {t("scout.scouting")}
          <span className="scout__dots">{".".repeat(dots)}</span>
        </h1>
        <p className="scout__subtitle">{t("scout.scoutingSubtitle")}</p>

        <dl className="scout__detail">
          <DetailRow
            label={t("scout.office")}
            value={scout.office || t("scout.allOffices")}
          />
          <DetailRow
            label={t("scout.date")}
            value={scout.scout_date ? formatDmy(scout.scout_date) : "-"}
          />
          <DetailRow
            label={t("scout.duration")}
            value={durationLabel(t, scout.duration_minutes)}
          />
          <DetailRow
            label={t("scout.scoutRangeLabel")}
            value={
              scout.scout_start_time && scout.scout_end_time
                ? `${scout.scout_start_time} - ${scout.scout_end_time}`
                : "-"
            }
          />
          <DetailRow label={t("scout.capacity")} value={capacityText} />
          <DetailRow
            label={t("scout.lastChecked")}
            value={formatLastChecked(scout.last_checked_at)}
          />
        </dl>

        {differentDay && (
          <div className="scout__note">
            <CircleInfo width={16} height={16} />
            <span>{t("scout.endsAtMidnightNote")}</span>
          </div>
        )}
      </div>

      <div className="scout__actions">
        <div className="scout__scouting-actions">
          <button
            type="button"
            className="scout__edit-btn"
            aria-label={t("scout.edit")}
            disabled={busy}
            onClick={onEdit}
          >
            <Pencil width={18} height={18} />
          </button>
          <div className="scout__grow">
            <Button
              variant="secondary"
              type="neutral"
              fullWidth
              loading={busy}
              onClick={() => void cancel()}
            >
              {t("scout.cancelScouting")}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="scout__detail-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

// ------------------------------------------------------------------ //
// Thẻ "đã tìm thấy phòng" (mockup web 480×600 — full-screen trên mobile)
// ------------------------------------------------------------------ //
function ScoutSuccessCard({
  scout,
  onDismiss,
}: {
  scout: RoomScoutRow;
  onDismiss: () => void | Promise<void>;
}) {
  const t = useT();
  const { openSnackbar } = useSnackbar();
  const [busy, setBusy] = useState(false);
  const room = scout.booked_room ?? null;
  const roomName = room?.name || scout.booked_room_email || t("scout.cardTitle");
  const email = room?.email || scout.booked_room_email || "";
  const time =
    scout.booked_start_time && scout.booked_end_time
      ? `${scout.booked_start_time} - ${scout.booked_end_time}`
      : "";
  const zoneText = [room?.building, room?.zone]
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .join(" ");
  const bg = room?.thumbnail_link || "";

  const chips = [
    room?.capacity_size
      ? { label: capacityRange(room.capacity_size), cap: true }
      : null,
    room?.floor ? { label: t("common.floor", { floor: String(room.floor) }), cap: false } : null,
    zoneText ? { label: zoneText, cap: false } : null,
  ].filter(Boolean) as { label: string; cap: boolean }[];

  async function dismiss() {
    setBusy(true);
    try {
      await api.acknowledgeAllRoomScouts();
      await onDismiss();
    } catch (e) {
      openSnackbar({ text: t("scout.acknowledgeFailed"), type: "error" });
      setBusy(false);
    }
  }

  return (
    <div className="scout__success">
      <div
        className="scout__success-bg"
        style={bg ? { backgroundImage: `url(${bg})` } : undefined}
      >
        <div className="scout__success-grad scout__success-grad--top" />
        <div className="scout__success-grad scout__success-grad--bottom" />

        <div className="scout__success-top">
          <p className="scout__success-heading">{t("scout.foundHeading")}</p>
          <p className="scout__success-sub">{t("scout.foundSubtitle")}</p>
        </div>

        <div className="scout__success-bottom">
          <p className="scout__success-room">
            {roomName}
            {time && <span> • {time}</span>}
          </p>
          {email && <p className="scout__success-email">{email}</p>}
          {chips.length > 0 && (
            <div className="scout__success-chips">
              {chips.map((chip) => (
                <span
                  key={chip.label}
                  className={`scout__chip${chip.cap ? " scout__chip--cap" : ""}`}
                >
                  {chip.cap && <Persons width={13} height={13} />}
                  {chip.label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="scout__actions">
        <Button fullWidth loading={busy} onClick={() => void dismiss()}>
          {t("scout.great")}
        </Button>
      </div>
    </div>
  );
}
