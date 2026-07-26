import { useState } from "react";
import { useSnackbar } from "zmp-ui";

import Person from "@gravity-ui/icons/Person";
import Display from "@gravity-ui/icons/Display";
import Sun from "@gravity-ui/icons/Sun";
import Moon from "@gravity-ui/icons/Moon";
import Globe from "@gravity-ui/icons/Globe";
import Check from "@gravity-ui/icons/Check";

import { api, AuthError } from "@/services/api";
import { useDisplayName } from "@/services/auth";
import { useSettings, type ThemeMode } from "@/services/settings";
import type { Language, MeResponse } from "@/types";

type Props = {
  me: MeResponse | null;
  onMeChange: (me: MeResponse) => void;
};

const THEME_OPTIONS: {
  mode: ThemeMode;
  labelKey: "settings.themeSystem" | "settings.themeLight" | "settings.themeDark";
  Icon: typeof Sun;
}[] = [
  { mode: "system", labelKey: "settings.themeSystem", Icon: Display },
  { mode: "light", labelKey: "settings.themeLight", Icon: Sun },
  { mode: "dark", labelKey: "settings.themeDark", Icon: Moon },
];

const LANG_OPTIONS: { value: Language; labelKey: "settings.langVi" | "settings.langEn"; flag: string }[] = [
  { value: "vi", labelKey: "settings.langVi", flag: "🇻🇳" },
  { value: "en", labelKey: "settings.langEn", flag: "🇬🇧" },
];

// Tab Tài khoản = màn Cài đặt: đổi giao diện (sáng/tối/hệ thống) + ngôn ngữ
// (Việt/Anh). Áp dụng NGAY (localStorage) và cố gắng đồng bộ lên hồ sơ user để
// khớp với bản web (PATCH /api/users/me/profile). Backend bắt buộc office hợp lệ
// nên chỉ đồng bộ được khi hồ sơ đã có office; nếu chưa thì chỉ lưu cục bộ.
export default function AccountPage({ me, onMeChange }: Props) {
  const { theme, setTheme, language, setLanguage, t } = useSettings();
  const { openSnackbar } = useSnackbar();
  const displayName = useDisplayName() ?? t("common.you");
  const [saving, setSaving] = useState(false);

  const profile = me?.profile ?? null;
  const email = profile?.email || me?.email || "";

  // Đồng bộ 1 thay đổi (theme hoặc language) lên hồ sơ user. Best-effort: theme/
  // language đã được áp cục bộ trước khi gọi hàm này, nên lỗi mạng không làm mất
  // lựa chọn của user.
  async function persist(patch: { theme?: ThemeMode; language?: Language }) {
    const office = (profile?.office ?? "").trim();
    if (!office) {
      // Chưa có office → backend từ chối PATCH. Chỉ lưu cục bộ.
      openSnackbar({ text: t("settings.savedLocalOnly"), type: "info" });
      return;
    }
    setSaving(true);
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
      openSnackbar({ text: t("settings.saved"), type: "success" });
    } catch (e) {
      if (!(e instanceof AuthError)) {
        openSnackbar({ text: t("settings.saveFailed"), type: "warning" });
      }
    } finally {
      setSaving(false);
    }
  }

  function pickTheme(mode: ThemeMode) {
    if (mode === theme) return;
    setTheme(mode); // áp dụng ngay + lưu localStorage
    void persist({ theme: mode });
  }

  function pickLanguage(lang: Language) {
    if (lang === language) return;
    setLanguage(lang);
    void persist({ language: lang });
  }

  return (
    <div className="settings">
      <header className="settings__header">
        <span className="settings__header-title">{t("settings.title")}</span>
      </header>

      <div className="settings__scroll">
        {/* Hồ sơ */}
        <section className="settings__profile">
          <div className="settings__avatar">
            <Person width={32} height={32} />
          </div>
          <div className="settings__profile-info">
            <div className="settings__name">{displayName}</div>
            {email && <div className="settings__email">{email}</div>}
          </div>
        </section>

        {/* Giao diện (sáng / tối / hệ thống) */}
        <section className="settings__section">
          <div className="settings__section-head">
            <div className="settings__section-title">
              {t("settings.displayPreference")}
            </div>
            <div className="settings__section-desc">
              {t("settings.displayPreferenceDesc")}
            </div>
          </div>
          <div className="settings__theme-grid">
            {THEME_OPTIONS.map(({ mode, labelKey, Icon }) => (
              <button
                key={mode}
                type="button"
                disabled={saving}
                className={`settings__theme-card${
                  theme === mode ? " is-active" : ""
                }`}
                onClick={() => pickTheme(mode)}
              >
                <Icon width={22} height={22} />
                <span className="settings__theme-label">{t(labelKey)}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Ngôn ngữ */}
        <section className="settings__section">
          <div className="settings__section-head">
            <div className="settings__section-title">
              {t("settings.language")}
            </div>
            <div className="settings__section-desc">
              {t("settings.languageDesc")}
            </div>
          </div>
          <div className="settings__lang-list">
            {LANG_OPTIONS.map(({ value, labelKey, flag }) => (
              <button
                key={value}
                type="button"
                disabled={saving}
                className={`settings__lang-row${
                  language === value ? " is-active" : ""
                }`}
                onClick={() => pickLanguage(value)}
              >
                <span className="settings__lang-flag">{flag}</span>
                <span className="settings__lang-label">{t(labelKey)}</span>
                {language === value ? (
                  <Check className="settings__lang-check" width={20} height={20} />
                ) : (
                  <Globe className="settings__lang-globe" width={18} height={18} />
                )}
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
