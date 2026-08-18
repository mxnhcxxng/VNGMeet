import { useCallback, useRef, useState } from "react";
import type { ComponentType } from "react";
import * as zmpSdk from "zmp-sdk";
import { openWebview } from "zmp-sdk";
import { useSnackbar } from "zmp-ui";
import Magnifier from "@gravity-ui/icons/Magnifier";
import Binoculars from "@gravity-ui/icons/Binoculars";
import Clock from "@gravity-ui/icons/Clock";
import MapPin from "@gravity-ui/icons/MapPin";

import logo from "@/static/logo-blue.png";
import { msOAuthUrl } from "@/config";
import { useT } from "@/services/settings";
import type { TranslationKey } from "@/services/i18n";

type IconProps = { width?: number; height?: number; className?: string };

// Các tính năng chính, dùng để "chào hàng" ở màn chặn (Figma 506-4832).
const FEATURES: { Icon: ComponentType<IconProps>; labelKey: TranslationKey }[] = [
  { Icon: Magnifier, labelKey: "block.featFree" },
  { Icon: Binoculars, labelKey: "block.featScout" },
  { Icon: Clock, labelKey: "block.featSchedule" },
  { Icon: MapPin, labelKey: "block.featDirection" },
];

// Logo Microsoft (4 ô vuông) đặt trước nhãn nút đăng nhập — Figma để placeholder
// "(Logo)", đây là mark chính thức nên vẽ inline, không cần thêm asset.
function MicrosoftMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="0" y="0" width="9.5" height="9.5" fill="#F25022" />
      <rect x="11.5" y="0" width="9.5" height="9.5" fill="#7FBA00" />
      <rect x="0" y="11.5" width="9.5" height="9.5" fill="#00A4EF" />
      <rect x="11.5" y="11.5" width="9.5" height="9.5" fill="#FFB900" />
    </svg>
  );
}

// Màn chặn (Figma 506-4832): hiện khi token đã hết hạn HOẶC SĐT Zalo không map
// được với profile nào trong database (BE trả 403 → LinkRequiredError ở Gate).
//
// Trước đây màn này đưa link/QR trang web VNG Meet để user tự vào đó bấm đăng
// nhập. Giờ bấm CTA là MỞ THẲNG link OAuth Microsoft (BE dựng qua
// GET /api/auth/oauth-url) trong webview — bớt một chặng.
//
// `onRetry` (nếu có) được gọi lại khi user đóng webview và quay về Mini App: lúc
// đó tài khoản có thể vừa được liên kết xong nên thử đổi session luôn, user không
// phải tự đóng/mở lại Mini App.
export default function BlockScreen({
  loading = false,
  onRetry,
}: { loading?: boolean; onRetry?: () => void } = {}) {
  const t = useT();
  const { openSnackbar } = useSnackbar();
  const [opening, setOpening] = useState(false);
  // Giữ callback trong ref để listener "quay lại app" không phải gắn/tháo lại
  // mỗi lần Gate render ra hàm mới.
  const retryRef = useRef(onRetry);
  retryRef.current = onRetry;

  // Chờ user quay lại từ webview OAuth rồi đổi session luôn.
  //
  // Zalo KHÔNG có API cho Mini App tự đóng webview (openWebview chỉ nhận url /
  // style / leftButton), nên ta không điều khiển được cửa sổ đó — chỉ nghe được
  // lúc nó đóng — nên web liên kết xong chỉ hiện màn "đăng nhập thành công"
  // nhắc user tự bấm X (frontend/components/ZaloReturnScreen.tsx). Bắt CẢ BA tín
  // hiệu vì mỗi nền tảng trả về một kiểu:
  //   - WebviewClosed: user bấm X đóng webview (cả hai nền tảng).
  //   - OpenApp / AppResumed: Zalo mở lại Mini App sau khi webview đóng.
  //   - visibilitychange: dự phòng cho môi trường không có event SDK
  //     (web/simulator); chỉ bắn khi trang ĐÃ bị ẩn rồi hiện lại, để không tự
  //     authen ngay lúc vừa bấm nút.
  const watchReturn = useCallback(() => {
    let done = false;
    const evs = (zmpSdk as Record<string, unknown>)["events"] as
      | {
          on?: (n: string, fn: () => void) => void;
          off?: (n: string, fn: () => void) => void;
        }
      | undefined;
    const EventName = (zmpSdk as Record<string, unknown>)["EventName"] as
      | Record<string, string>
      | undefined;
    const names = [
      EventName?.WebviewClosed,
      EventName?.OpenApp,
      EventName?.AppResumed,
    ].filter((n): n is string => Boolean(n));

    const finish = () => {
      if (done) return;
      done = true;
      names.forEach((n) => evs?.off?.(n, finish));
      document.removeEventListener("visibilitychange", onVisibility);
      retryRef.current?.();
    };

    let leftApp = false;
    function onVisibility() {
      if (document.visibilityState === "hidden") {
        leftApp = true;
        return;
      }
      if (leftApp) finish();
    }

    names.forEach((n) => evs?.on?.(n, finish));
    document.addEventListener("visibilitychange", onVisibility);
  }, []);

  async function login() {
    if (opening) return;
    const url = msOAuthUrl();
    if (!url) {
      openSnackbar({ text: t("block.loginFailed"), type: "error" });
      console.warn("[block] chưa cấu hình SUPABASE_URL trong src/config.ts");
      return;
    }
    setOpening(true);
    // DEBUG: in link OAuth (kèm ?zma=1 ở redirect_to) để soi trong vConsole khi
    // webview không ra được màn "đăng nhập thành công" của web.
    console.log("[block] oauth url:", url);
    // Gắn listener TRƯỚC khi mở, tránh cửa sổ đóng nhanh hơn lúc ta kịp đăng ký.
    watchReturn();
    try {
      await openWebview({ url, config: { style: "normal" } });
    } catch {
      // Webview Zalo từ chối (vd chạy trên web/simulator) → mở tab thường.
      window.open(url, "_blank");
    } finally {
      setOpening(false);
    }
  }

  // Trạng thái chờ authen (đã cấp quyền SĐT, đang đổi session). Dùng chung nền +
  // banner của màn chặn và một spinner để KHÔNG nháy màn trắng trước khi ra
  // Home/BlockScreen.
  if (loading) {
    return (
      <div className="block-scr">
        <div className="block-scr__banner" />
        <div className="block-scr__loading">
          <span className="block-scr__spinner" aria-label={t("gate.authing")} />
        </div>
      </div>
    );
  }

  return (
    <div className="block-scr">
      <div className="block-scr__banner" />

      <div className="block-scr__body">
        <div className="block-scr__heads">
          <div className="block-scr__brand">
            <img className="block-scr__logo" src={logo} alt="VNG Meet" />
          </div>
          <p className="block-scr__desc">{t("block.desc")}</p>
        </div>

        <div className="block-scr__features">
          {FEATURES.map(({ Icon, labelKey }) => (
            <div className="block-scr__feature" key={labelKey}>
              <Icon width={20} height={20} className="block-scr__feature-icon" />
              <span>{t(labelKey)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="block-scr__footer">
        <button
          className="block-scr__cta"
          type="button"
          disabled={opening}
          onClick={() => void login()}
        >
          <MicrosoftMark />
          {t("block.login")}
        </button>
      </div>
    </div>
  );
}
