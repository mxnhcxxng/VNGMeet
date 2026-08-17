import { useEffect, useMemo, useState } from "react";
import { Button, Input, Picker, Sheet, useSnackbar } from "zmp-ui";

import Check from "@gravity-ui/icons/Check";
import Xmark from "@gravity-ui/icons/Xmark";
import ChevronDown from "@gravity-ui/icons/ChevronDown";
import Magnifier from "@gravity-ui/icons/Magnifier";
import Plus from "@gravity-ui/icons/Plus";

import { api, AuthError, getCachedProfileOptions } from "@/services/api";
import { useSettings } from "@/services/settings";
import { useKeyboardInset } from "@/hooks/use-keyboard-inset";
import type { MeResponse, UserProfileOption, UserProfileOptions } from "@/types";

type Props = {
  me: MeResponse | null;
  onMeChange: (me: MeResponse) => void;
};

// Màn "Thông tin cá nhân" (mở từ tab Tài khoản) — port các trường từ tab Cài đặt
// bản web (frontend/components/SettingsScreen.tsx): tên đăng nhập + email (chỉ
// đọc), văn phòng / tầng / tòa nhà (Picker), phòng ưa thích (tối đa 3, chọn qua
// Sheet), và công tắc "đặt phòng không cần xác nhận". Lưu qua PATCH
// /api/users/me/profile (kèm theme/language hiện tại để không ghi đè).
//
// Tầng & tòa nhà chỉ áp dụng cho office "campus" (giống web) — office khác thì
// hai trường này bị vô hiệu và gửi rỗng.
export default function ProfileInfo({ me, onMeChange }: Props) {
  const { theme, language, t } = useSettings();
  const { openSnackbar } = useSnackbar();

  const profile = me?.profile ?? null;
  const email = profile?.email || me?.email || "";
  const emailUsername =
    profile?.email_username || (email.includes("@") ? email.split("@", 1)[0] : "");

  const [office, setOffice] = useState(profile?.office ?? "");
  const [floor, setFloor] = useState(profile?.floor ?? "");
  const [building, setBuilding] = useState(profile?.building ?? "");
  const [preferredRooms, setPreferredRooms] = useState<string[]>(
    profile?.preferred_rooms ?? [],
  );
  // Ẩn công tắc "đặt phòng không cần xác nhận" khỏi UI nhưng vẫn giữ nguyên giá
  // trị hiện tại khi lưu (không vô tình reset về false).
  const bookWithoutConfirmation = profile?.book_without_confirmation ?? false;

  // Khởi tạo đồng bộ từ cache (đã prefetch ở tab Tài khoản) → mở màn không chờ,
  // Picker chọn sẵn giá trị ngay từ lần render đầu.
  const cachedOptions = getCachedProfileOptions();
  const [options, setOptions] = useState<UserProfileOptions | null>(cachedOptions);
  const [optionsLoading, setOptionsLoading] = useState(!cachedOptions);
  const [saving, setSaving] = useState(false);
  const [roomSheetOpen, setRoomSheetOpen] = useState(false);
  const [roomSearch, setRoomSearch] = useState("");
  // Bàn phím che bao nhiêu px → chèn vào padding-bottom của sheet để nút "Xong"
  // luôn nổi trên bàn phím thay vì bị nuốt mất.
  const keyboardInset = useKeyboardInset(roomSheetOpen);

  const isCampus = office === "campus";

  // Nạp danh sách lựa chọn (office/floor/building/phòng) 1 lần — bỏ qua nếu cache
  // đã có (prefetch từ tab Tài khoản).
  useEffect(() => {
    if (options) return;
    let alive = true;
    setOptionsLoading(true);
    void (async () => {
      try {
        const o = await api.userProfileOptions();
        if (alive) setOptions(o);
      } catch (e) {
        if (!(e instanceof AuthError)) {
          openSnackbar({ text: t("settings.optionsFailed"), type: "warning" });
        }
      } finally {
        if (alive) setOptionsLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Office khác campus → không có tầng/tòa nhà (khớp web).
  useEffect(() => {
    if (!isCampus) {
      setFloor("");
      setBuilding("");
    }
  }, [isCampus]);

  const byOffice = (items?: UserProfileOption[]) =>
    (items ?? []).filter((it) => it.parentValue === office);
  const floorOptions = byOffice(options?.floor);
  const buildingOptions = byOffice(options?.building);
  const preferredRoomOptions = byOffice(options?.preferredRooms);

  // Nhãn hiển thị cho một value đã chọn (fallback về chính value nếu chưa có nhãn).
  const labelOf = (items: UserProfileOption[], value: string) =>
    items.find((it) => it.value === value)?.label ?? value;

  const sortedRooms = (rooms: string[]) => [...rooms].sort().join("|");
  const dirty =
    office !== (profile?.office ?? "") ||
    (isCampus ? floor : "") !== (profile?.floor ?? "") ||
    (isCampus ? building : "") !== (profile?.building ?? "") ||
    sortedRooms(preferredRooms) !== sortedRooms(profile?.preferred_rooms ?? []) ||
    bookWithoutConfirmation !== (profile?.book_without_confirmation ?? false);
  const canSave = Boolean(office) && dirty && !optionsLoading;

  // Đổi office → reset phòng ưa thích (khác office thì danh sách phòng khác hẳn).
  function changeOffice(next: string) {
    if (next === office) return;
    setOffice(next);
    setPreferredRooms([]);
  }

  function toggleRoom(value: string) {
    setPreferredRooms((cur) => {
      if (cur.includes(value)) return cur.filter((v) => v !== value);
      if (cur.length >= 3) {
        openSnackbar({ text: t("settings.roomsLimit"), type: "info" });
        return cur;
      }
      return [...cur, value];
    });
  }

  const roomResults = useMemo(() => {
    const q = roomSearch.trim().toLowerCase();
    if (!q) return preferredRoomOptions;
    return preferredRoomOptions.filter((it) =>
      it.label.toLowerCase().includes(q),
    );
  }, [preferredRoomOptions, roomSearch]);

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      const res = await api.updateProfile({
        office,
        floor: isCampus ? floor : "",
        building: isCampus ? building : "",
        preferred_rooms: preferredRooms,
        book_without_confirmation: bookWithoutConfirmation,
        theme,
        language,
      });
      if (me) {
        onMeChange({
          ...me,
          profile: res.profile,
          profileComplete: res.profileComplete,
        });
      }
      openSnackbar({ text: t("settings.saved"), type: "success" });
    } catch (e) {
      if (!(e instanceof AuthError)) {
        openSnackbar({ text: t("settings.saveFailed"), type: "warning" });
      }
    } finally {
      setSaving(false);
    }
  }

  const suffix = <ChevronDown width={18} height={18} className="pinfo__chevron" />;
  const pickerAction = { text: t("scout.confirm"), close: true };

  return (
    <>
      <div className="pinfo__scroll">
        {/* Tên đăng nhập + Email — chỉ đọc (đồng bộ từ tài khoản Microsoft) */}
        <div className="pinfo__grid">
          <Input
            label={t("settings.domain")}
            value={emailUsername}
            disabled
            readOnly
          />
          <Input label={t("settings.email")} value={email} disabled readOnly />
        </div>

        {/* Văn phòng */}
        <div className="pinfo__field">
          <Picker
            // ZaUI Picker chỉ đọc `value` lúc khởi tạo; options lại nạp bất đồng
            // bộ sau khi mount → remount khi options sẵn sàng để chọn sẵn giá trị
            // hiện tại của hồ sơ.
            key={`office-${options?.office.length ?? 0}`}
            label={t("settings.office")}
            title={t("settings.chooseOffice")}
            placeholder={t("settings.chooseOffice")}
            data={[
              {
                name: "office",
                options: (options?.office ?? []).map((it) => ({
                  value: it.value,
                  displayName: it.label,
                })),
              },
            ]}
            value={office ? { office } : undefined}
            onChange={(v) => changeOffice(String(v.office.value))}
            mask
            maskClosable
            action={pickerAction}
            suffix={suffix}
          />
        </div>

        {/* Tầng + Tòa nhà (chỉ campus) */}
        <div className="pinfo__grid">
          <div className="pinfo__field">
            <Picker
              key={`floor-${office}-${floorOptions.length}`}
              label={t("settings.floor")}
              title={t("settings.chooseFloor")}
              placeholder={t("settings.chooseFloor")}
              disabled={!isCampus || optionsLoading}
              data={[
                {
                  name: "floor",
                  options: floorOptions.map((it) => ({
                    value: it.value,
                    displayName: it.label,
                  })),
                },
              ]}
              value={floor ? { floor } : undefined}
              onChange={(v) => setFloor(String(v.floor.value))}
              mask
              maskClosable
              action={pickerAction}
              suffix={suffix}
            />
          </div>
          <div className="pinfo__field">
            <Picker
              key={`building-${office}-${buildingOptions.length}`}
              label={t("settings.building")}
              title={t("settings.chooseBuilding")}
              placeholder={t("settings.chooseBuilding")}
              disabled={!isCampus || optionsLoading}
              data={[
                {
                  name: "building",
                  options: buildingOptions.map((it) => ({
                    value: it.value,
                    displayName: it.label,
                  })),
                },
              ]}
              value={building ? { building } : undefined}
              onChange={(v) => setBuilding(String(v.building.value))}
              mask
              maskClosable
              action={pickerAction}
              suffix={suffix}
            />
          </div>
        </div>

        {/* Phòng ưa thích — tối đa 3, chọn qua Sheet */}
        <div className="pinfo__field">
          <span className="pinfo__label">{t("settings.preferredRooms")}</span>
          <button
            type="button"
            className="pinfo__rooms"
            disabled={!office || optionsLoading}
            onClick={() => {
              setRoomSearch("");
              setRoomSheetOpen(true);
            }}
          >
            {preferredRooms.length === 0 ? (
              <span className="pinfo__rooms-placeholder">
                {t("settings.preferredRoomsPlaceholder")}
              </span>
            ) : (
              <span className="pinfo__chips">
                {preferredRooms.map((value) => (
                  <span
                    key={value}
                    className="pinfo__chip"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleRoom(value);
                    }}
                  >
                    {labelOf(preferredRoomOptions, value)}
                    <Xmark width={14} height={14} />
                  </span>
                ))}
              </span>
            )}
            <Plus width={18} height={18} className="pinfo__rooms-add" />
          </button>
        </div>
      </div>

      {/* Nút Lưu cố định dưới cùng */}
      <div className="pinfo__footer">
        <Button
          fullWidth
          loading={saving}
          disabled={!canSave || saving}
          onClick={() => void save()}
        >
          {t("settings.save")}
        </Button>
      </div>

      {/* Sheet chọn phòng ưa thích.
          height 92% (thay vì co theo nội dung): ô tìm kiếm phải nằm gần ĐỈNH màn
          hình, nếu không iOS sẽ tự cuộn visual viewport để lộ ô đang focus và
          kéo lệch cả sheet. Cao cố định cũng khiến danh sách không nhảy chiều
          cao mỗi lần gõ (lọc còn 1 kết quả thì sheet vẫn đứng yên). */}
      <Sheet
        className="pinfo-sheet"
        visible={roomSheetOpen}
        onClose={() => setRoomSheetOpen(false)}
        title={t("settings.preferredRooms")}
        height="92%"
        maskClosable
      >
        <div className="pinfo__sheet" style={{ paddingBottom: keyboardInset }}>
          <div className="pinfo__search">
            <Magnifier width={18} height={18} className="pinfo__search-icon" />
            <input
              className="pinfo__search-input"
              value={roomSearch}
              placeholder={t("settings.searchRooms")}
              onChange={(e) => setRoomSearch(e.target.value)}
              // Tên phòng là danh từ riêng ngắn (Amsterdam, Hà Nội…) → tắt hết
              // auto-capitalize / autocorrect / spellcheck, nếu không iOS viết
              // hoa chữ đầu + gạch chân đỏ như đang gõ sai chính tả.
              type="text"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              // Enter = đóng bàn phím, trả lại chiều cao cho danh sách.
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
            {roomSearch && (
              <button
                type="button"
                className="pinfo__search-clear"
                aria-label={t("settings.clearSearch")}
                // Giữ focus ở ô nhập: không chặn mousedown thì nút cướp focus,
                // bàn phím sập xuống rồi lại phải chạm ô để gõ tiếp.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setRoomSearch("")}
              >
                <Xmark width={16} height={16} />
              </button>
            )}
          </div>
          <div className="pinfo__room-list">
            {roomResults.length === 0 ? (
              <div className="pinfo__room-empty">{t("settings.noResults")}</div>
            ) : (
              roomResults.map((room) => {
                const active = preferredRooms.includes(room.value);
                const atLimit = preferredRooms.length >= 3 && !active;
                return (
                  <button
                    key={room.value}
                    type="button"
                    className={`pinfo__room${active ? " is-active" : ""}`}
                    disabled={atLimit}
                    onClick={() => toggleRoom(room.value)}
                  >
                    <span className="pinfo__room-name">{room.label}</span>
                    {active && (
                      <Check width={18} height={18} className="pinfo__room-check" />
                    )}
                  </button>
                );
              })
            )}
          </div>
          <div className="pinfo__sheet-footer">
            <Button fullWidth onClick={() => setRoomSheetOpen(false)}>
              {t("scout.confirm")}
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
