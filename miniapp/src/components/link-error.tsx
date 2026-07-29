import Xmark from "@gravity-ui/icons/Xmark";

import { useT } from "@/services/settings";

// Màn "Liên kết chatbot thất bại" (Figma 438-3259): hiện khi redeem mã pairing
// lỗi (mã sai/hết hạn) hoặc user không xác nhận được liên kết. Nút duy nhất đưa
// user về màn hình chính.
export default function LinkError({ onClose }: { onClose: () => void }) {
  const t = useT();

  return (
    <div className="link-ok">
      <div className="link-ok__banner link-ok__banner--error" />

      <div className="link-ok__body">
        <div className="link-ok__check link-ok__check--error">
          <Xmark width={40} height={40} />
        </div>

        <div className="link-ok__heads">
          <p className="link-ok__title">{t("linkError.title")}</p>
          <p className="link-ok__subtitle">{t("linkError.subtitle")}</p>
        </div>
      </div>

      <div className="link-ok__footer">
        <button
          className="link-ok__cta link-ok__cta--secondary"
          type="button"
          onClick={onClose}
        >
          {t("linkError.backHome")}
        </button>
      </div>
    </div>
  );
}
