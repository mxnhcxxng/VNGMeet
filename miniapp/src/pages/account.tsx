import { useEffect, useState, type ComponentType } from "react";
import { useSnackbar } from "zmp-ui";
import { openWebview } from "zmp-sdk";

import PersonPencil from "@gravity-ui/icons/PersonPencil";
import Palette from "@gravity-ui/icons/Palette";
import Globe from "@gravity-ui/icons/Globe";
import Comment from "@gravity-ui/icons/Comment";
import ChevronLeft from "@gravity-ui/icons/ChevronLeft";
import Check from "@gravity-ui/icons/Check";

import ProfileInfo from "@/components/profile-info";
import defaultAvatar from "@/static/default-avatar.jpg";
import themeLightPreview from "@/static/theme-light.png";
import themeDarkPreview from "@/static/theme-dark.png";
import themeSystemPreview from "@/static/theme-system.png";
import { api, AuthError } from "@/services/api";
import { useDisplayName } from "@/services/auth";
import { useSettings, type ThemeMode } from "@/services/settings";
import type { Language, MeResponse } from "@/types";
import { useSwipeBack } from "@/hooks/use-swipe-back";

type Props = {
  me: MeResponse | null;
  onMeChange: (me: MeResponse) => void;
};

// Biểu mẫu góp ý (dùng chung với web) — mở trong webview của Zalo.
const FEEDBACK_URL = "https://forms.office.com/r/tqXL5RYBqM";

// Thứ tự khớp app Zalo: Sáng · Tối · Hệ thống. Mỗi mục có ảnh preview minh hoạ
// giao diện (giống card chọn theme trong Zalo).
const THEME_OPTIONS: {
  mode: ThemeMode;
  labelKey: "settings.themeSystem" | "settings.themeLight" | "settings.themeDark";
  preview: string;
}[] = [
  { mode: "light", labelKey: "settings.themeLight", preview: themeLightPreview },
  { mode: "dark", labelKey: "settings.themeDark", preview: themeDarkPreview },
  { mode: "system", labelKey: "settings.themeSystem", preview: themeSystemPreview },
];

const LANG_OPTIONS: {
  value: Language;
  labelKey: "settings.langVi" | "settings.langEn";
  flag: string;
}[] = [
  { value: "vi", labelKey: "settings.langVi", flag: "🇻🇳" },
  { value: "en", labelKey: "settings.langEn", flag: "🇬🇧" },
];

type SubKey = "profile" | "theme" | "language";

// SĐT lưu dạng local VN "0339758256" → hiển thị nhóm 3-3-4 "033 975 8256".
function formatPhone(raw?: string | null): string {
  if (!raw) return "";
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  if (d.length === 11) return `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  return raw;
}

// Màn Tài khoản (Figma 400-2699): hồ sơ + danh sách mục (Thông tin cá nhân /
// Giao diện / Ngôn ngữ / Phản hồi) trong thẻ trắng bo góc. Mỗi mục mở một trang
// con trượt từ phải.
export default function AccountPage({ me, onMeChange }: Props) {
  const { theme, setTheme, language, setLanguage, t } = useSettings();
  const { openSnackbar } = useSnackbar();
  const displayName = useDisplayName() ?? t("common.you");
  const [sub, setSub] = useState<SubKey | null>(null);

  const profile = me?.profile ?? null;
  const phone = formatPhone(profile?.phone);

  // Nạp trước danh sách lựa chọn hồ sơ NGAY khi vào tab Tài khoản → khi bấm
  // "Thông tin cá nhân" dữ liệu đã sẵn trong cache, mở màn không giật/không chờ.
  useEffect(() => {
    void api.userProfileOptions().catch(() => {
      // im lặng — mở màn con sẽ tự thử lại nếu prefetch lỗi
    });
  }, []);

  // Đồng bộ 1 thay đổi (theme/ngôn ngữ) lên hồ sơ user. Best-effort: đã áp cục bộ
  // trước khi gọi nên lỗi mạng không làm mất lựa chọn. Backend bắt buộc office
  // hợp lệ, nên chỉ đồng bộ được khi hồ sơ đã có office.
  async function persist(patch: { theme?: ThemeMode; language?: Language }) {
    const office = (profile?.office ?? "").trim();
    if (!office) {
      openSnackbar({ text: t("settings.savedLocalOnly"), type: "info" });
      return;
    }
    try {
      const res = await api.updateProfile({
        office,
        floor: profile?.floor ?? "",
        building: profile?.building ?? "",
        preferred_rooms: profile?.preferred_rooms ?? [],
        book_without_confirmation: profile?.book_without_confirmation ?? undefined,
        theme: patch.theme ?? theme,
        language: patch.language ?? language,
      });
      if (me) {
        onMeChange({
          ...me,
          profile: res.profile,
          profileComplete: res.profileComplete,
        });
      }
    } catch (e) {
      if (!(e instanceof AuthError)) {
        openSnackbar({ text: t("settings.saveFailed"), type: "warning" });
      }
    }
  }

  function pickTheme(mode: ThemeMode) {
    if (mode === theme) return;
    setTheme(mode);
    void persist({ theme: mode });
  }

  function pickLanguage(lang: Language) {
    if (lang === language) return;
    setLanguage(lang);
    void persist({ language: lang });
  }

  async function openFeedback() {
    try {
      await openWebview({ url: FEEDBACK_URL, config: { style: "normal" } });
    } catch {
      try {
        window.open(FEEDBACK_URL, "_blank");
      } catch {
        // ignore
      }
    }
  }

  return (
    <div className="acct">
      {/* Hồ sơ + nền gradient xanh nhạt */}
      <section className="acct__hero">
        <img className="acct__avatar" src={defaultAvatar} alt={displayName} />
        <div className="acct__identity">
          <div className="acct__name">{displayName}</div>
          {phone && <div className="acct__phone">{phone}</div>}
        </div>
      </section>

      {/* Nhóm cài đặt trong thẻ trắng bo góc, trên dải nền xám tới bottom-nav */}
      <section className="acct__tail">
        <div className="acct__card">
          <MenuRow
            Icon={PersonPencil}
            label={t("settings.personalInfo")}
            onClick={() => setSub("profile")}
          />
          <MenuRow
            Icon={Palette}
            label={t("settings.displayPreference")}
            onClick={() => setSub("theme")}
          />
          <MenuRow
            Icon={Globe}
            label={t("settings.language")}
            onClick={() => setSub("language")}
            last
          />
        </div>
        <div className="acct__card">
          <MenuRow
            Icon={Comment}
            label={t("settings.feedback")}
            onClick={() => void openFeedback()}
            last
          />
        </div>
      </section>

      {/* Trang con: Thông tin cá nhân */}
      {sub === "profile" && (
        <SubPage title={t("settings.personalInfo")} onClose={() => setSub(null)}>
          <ProfileInfo me={me} onMeChange={onMeChange} />
        </SubPage>
      )}

      {/* Trang con: Giao diện */}
      {sub === "theme" && (
        <SubPage title={t("settings.displayPreference")} onClose={() => setSub(null)}>
          <div className="acct-sub__scroll">
            <p className="acct-sub__desc">{t("settings.displayPreferenceDesc")}</p>
            <div className="settings__theme-grid">
              {THEME_OPTIONS.map(({ mode, labelKey, preview }) => {
                const active = theme === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    className={`settings__theme-card${active ? " is-active" : ""}`}
                    onClick={() => pickTheme(mode)}
                    role="radio"
                    aria-checked={active}
                  >
                    <img
                      className="settings__theme-preview"
                      src={preview}
                      alt=""
                      aria-hidden="true"
                    />
                    <span className="settings__theme-choice">
                      <span
                        className={`settings__theme-radio${
                          active ? " is-active" : ""
                        }`}
                      />
                      <span className="settings__theme-label">{t(labelKey)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </SubPage>
      )}

      {/* Trang con: Ngôn ngữ */}
      {sub === "language" && (
        <SubPage title={t("settings.language")} onClose={() => setSub(null)}>
          <div className="acct-sub__scroll">
            <p className="acct-sub__desc">{t("settings.languageDesc")}</p>
            <div className="settings__lang-list">
              {LANG_OPTIONS.map(({ value, labelKey, flag }) => (
                <button
                  key={value}
                  type="button"
                  className="settings__lang-row"
                  onClick={() => pickLanguage(value)}
                >
                  <span className="settings__lang-flag">{flag}</span>
                  <span className="settings__lang-label">{t(labelKey)}</span>
                  {language === value && (
                    <Check className="settings__lang-check" width={20} height={20} />
                  )}
                </button>
              ))}
            </div>
          </div>
        </SubPage>
      )}
    </div>
  );
}

// Một dòng trong danh sách mục (icon + nhãn). Kẻ vạch dưới trừ dòng cuối nhóm.
function MenuRow({
  Icon,
  label,
  onClick,
  last,
}: {
  Icon: ComponentType<{ width?: number; height?: number; className?: string }>;
  label: string;
  onClick: () => void;
  last?: boolean;
}) {
  return (
    <button
      type="button"
      className={`acct__row${last ? " acct__row--last" : ""}`}
      onClick={onClick}
    >
      <Icon width={24} height={24} className="acct__row-icon" />
      <span className="acct__row-label">{label}</span>
    </button>
  );
}

// Trang con trượt từ phải sang (dùng lại header xanh của .mtg-detail + swipe-back).
function SubPage({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { t } = useSettings();
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  function close() {
    setLeaving(true);
    window.setTimeout(onClose, 260); // khớp thời lượng slide-out
  }

  const swipeBack = useSwipeBack(close, true);

  return (
    <div
      className={`acct-sub${entered && !leaving ? " is-open" : ""}`}
      role="dialog"
      aria-label={title}
      {...swipeBack}
    >
      <header className="mtg-detail__header">
        <button
          className="mtg-detail__back"
          type="button"
          aria-label={t("common.back")}
          onClick={close}
        >
          <ChevronLeft width={24} height={24} />
        </button>
        <span className="mtg-detail__header-title">{title}</span>
      </header>
      <div className="acct-sub__body">{children}</div>
    </div>
  );
}
