import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { getSystemInfo } from "zmp-sdk";

import {
  DEFAULT_LANGUAGE,
  translate,
  type Language,
  type TFunction,
} from "@/services/i18n";

// Chế độ giao diện — khớp bản web: "system" bám theo hệ thống (theme Zalo),
// còn lại là chọn cứng sáng/tối.
export type ThemeMode = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";

const THEME_KEY = "vngmeet_theme";
const LANG_KEY = "vngmeet_language";

// Theme của user KHI chọn "system": ưu tiên theme của app Zalo (getSystemInfo),
// fallback về prefers-color-scheme của webview.
function systemTheme(): ResolvedTheme {
  try {
    const z = (getSystemInfo() as { zaloTheme?: string })?.zaloTheme;
    if (z === "dark" || z === "light") return z;
  } catch {
    // ignore — SDK chỉ chạy trong app Zalo
  }
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "light";
}

function resolve(mode: ThemeMode): ResolvedTheme {
  return mode === "system" ? systemTheme() : mode;
}

// ZaUI + Tailwind (darkMode: [zaui-theme="dark"]) đều đọc thuộc tính này trên
// <body>. Tự set để đổi theme "sống" mà không phụ thuộc state nội bộ của <App>.
function applyTheme(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  document.body.setAttribute("zaui-theme", resolved);
  document.documentElement.style.colorScheme = resolved;
}

function readStoredTheme(): ThemeMode | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "system" || v === "light" || v === "dark") return v;
  } catch {
    // ignore
  }
  return null;
}
function readStoredLanguage(): Language | null {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v === "vi" || v === "en") return v;
  } catch {
    // ignore
  }
  return null;
}

interface SettingsContextValue {
  theme: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setTheme: (mode: ThemeMode) => void;
  language: Language;
  setLanguage: (lang: Language) => void;
  // Nạp giá trị từ hồ sơ user (GET /auth/me) LÀM MẶC ĐỊNH — chỉ áp dụng khi
  // user chưa từng tự chọn trên thiết bị này (localStorage rỗng). Nhờ vậy lần
  // đầu mở Mini App sẽ theo đúng cài đặt đã lưu ở bản web.
  hydrateFromProfile: (theme?: string | null, language?: string | null) => void;
  t: TFunction;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(
    () => readStoredTheme() ?? "system",
  );
  const [language, setLanguageState] = useState<Language>(
    () => readStoredLanguage() ?? DEFAULT_LANGUAGE,
  );
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolve(readStoredTheme() ?? "system"),
  );

  // Áp theme mỗi khi đổi; khi ở "system" thì lắng nghe thay đổi của hệ thống.
  useEffect(() => {
    const next = resolve(theme);
    setResolvedTheme(next);
    applyTheme(next);

    if (theme !== "system" || typeof window === "undefined" || !window.matchMedia)
      return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const r = systemTheme();
      setResolvedTheme(r);
      applyTheme(r);
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [theme]);

  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeState(mode);
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch {
      // ignore
    }
  }, []);

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      // ignore
    }
  }, []);

  const hydrateFromProfile = useCallback(
    (profileTheme?: string | null, profileLanguage?: string | null) => {
      // Chỉ áp dụng khi user CHƯA tự chọn (localStorage rỗng) → hồ sơ web là mặc
      // định. Không ghi localStorage để những lần sau vẫn bám theo hồ sơ.
      if (
        readStoredTheme() === null &&
        (profileTheme === "system" ||
          profileTheme === "light" ||
          profileTheme === "dark")
      ) {
        setThemeState(profileTheme);
      }
      if (
        readStoredLanguage() === null &&
        (profileLanguage === "vi" || profileLanguage === "en")
      ) {
        setLanguageState(profileLanguage);
      }
    },
    [],
  );

  // Đồng bộ thuộc tính lang của tài liệu (a11y).
  useEffect(() => {
    if (typeof document !== "undefined") document.documentElement.lang = language;
  }, [language]);

  const t = useCallback<TFunction>(
    (key, vars) => translate(language, key, vars),
    [language],
  );

  const value = useMemo(
    () => ({
      theme,
      resolvedTheme,
      setTheme,
      language,
      setLanguage,
      hydrateFromProfile,
      t,
    }),
    [
      theme,
      resolvedTheme,
      setTheme,
      language,
      setLanguage,
      hydrateFromProfile,
      t,
    ],
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}

// Hook tiện dụng cho component chỉ cần hàm dịch.
export function useT(): TFunction {
  return useSettings().t;
}
