import { useState } from "react";
import { openWebview } from "zmp-sdk";
import Copy from "@gravity-ui/icons/Copy";
import Check from "@gravity-ui/icons/Check";

import logo from "@/static/logo.png";
import qrCode from "@/static/qr-vngmeet.png";
import { useT } from "@/services/settings";

// Màn chặn (Figma 400-2855): hiện khi token đã hết hạn HOẶC SĐT Zalo không map
// được với profile nào trong database (BE trả 403 → LinkRequiredError ở Gate).
// User quét QR / mở link để đăng nhập & liên kết tài khoản rồi quay lại app.
const LINK_URL = "https://go.zalo.me/VNGMeet";
const LINK_LABEL = "go.zalo.me/VNGMeet";

export default function BlockScreen({ loading = false }: { loading?: boolean } = {}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(LINK_URL);
    } catch {
      // Fallback cho webview cũ không có Clipboard API.
      try {
        const ta = document.createElement("textarea");
        ta.value = LINK_URL;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        return;
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  async function openLink() {
    try {
      await openWebview({ url: LINK_URL, config: { style: "normal" } });
    } catch {
      try {
        window.open(LINK_URL, "_blank");
      } catch {
        // ignore
      }
    }
  }

  // Trạng thái chờ authen (đã cấp quyền SĐT, đang đổi session). Dùng chung nền màn
  // chặn + logo và một spinner để KHÔNG nháy màn trắng trước khi ra Home/BlockScreen.
  if (loading) {
    return (
      <div className="block-scr">
        <div className="block-scr__body">
          <div className="block-scr__brand">
            <img className="block-scr__logo" src={logo} alt="VNG Meet" />
          </div>
          <div className="block-scr__loading">
            <span className="block-scr__spinner" aria-label={t("gate.authing")} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="block-scr">
      <div className="block-scr__body">
        <div className="block-scr__brand">
          <img className="block-scr__logo" src={logo} alt="VNG Meet" />
        </div>

        <div className="block-scr__main">
          <p className="block-scr__desc">{t("block.desc")}</p>

          <div className="block-scr__qr-group">
            {/* Chip xanh: link + icon copy nằm cùng 1 nút, bấm để sao chép
                (Figma 403-13608). Copy xong → icon đổi thành dấu check. */}
            <button
              className="block-scr__link"
              type="button"
              onClick={() => void copyLink()}
              aria-label={copied ? t("block.copied") : t("block.copy")}
            >
              <span className="block-scr__link-text">{LINK_LABEL}</span>
              {copied ? (
                <Check width={14} height={14} />
              ) : (
                <Copy width={14} height={14} />
              )}
            </button>
            <img className="block-scr__qr" src={qrCode} alt={LINK_LABEL} />
          </div>
        </div>

        <button
          className="block-scr__cta"
          type="button"
          onClick={() => void openLink()}
        >
          {t("block.visit")}
        </button>
      </div>
    </div>
  );
}
