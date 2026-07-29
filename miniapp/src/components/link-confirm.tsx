import botAvatar from "@/static/bot-avatar.png";
import defaultAvatar from "@/static/default-avatar.jpg";
import { useT } from "@/services/settings";

type Props = {
  name: string;
  phone: string | null;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

// Màn "Xác nhận liên kết chatbot" (Figma 439-3472): chặn auto-link im lặng từ
// deep-link ?bot_pair=<code>. User thấy rõ tài khoản (tên + SĐT) sắp được liên
// kết với bot và phải chủ động bấm "Liên kết" — nếu link do người khác gửi tới,
// user sẽ bấm "Thoát". Đây là biện pháp chống F-02 (hijack liên kết bot).
export default function LinkConfirm({
  name,
  phone,
  pending,
  onConfirm,
  onCancel,
}: Props) {
  const t = useT();

  return (
    <div className="link-ok">
      <div className="link-ok__banner" />

      <div className="link-ok__body">
        <div className="link-ok__check link-ok__check--soft">
          <img className="link-ok__check-img" src={botAvatar} alt="" />
        </div>

        <div className="link-ok__heads">
          <p className="link-ok__title">{t("linkConfirm.title")}</p>
          <p className="link-ok__subtitle">{t("linkConfirm.subtitle")}</p>
        </div>

        <div className="link-ok__panel">
          <div className="link-ok__bot">
            <img className="link-ok__bot-avatar" src={defaultAvatar} alt="" />
            <div className="link-ok__bot-info">
              <span className="link-ok__bot-name">{name}</span>
              {phone && <span className="link-ok__bot-sub">{phone}</span>}
            </div>
          </div>
        </div>
      </div>

      <div className="link-ok__footer">
        <button
          className="link-ok__cta link-ok__cta--primary"
          type="button"
          disabled={pending}
          onClick={onConfirm}
        >
          {t("linkConfirm.confirm")}
        </button>
        <button
          className="link-ok__cta link-ok__cta--secondary"
          type="button"
          disabled={pending}
          onClick={onCancel}
        >
          {t("linkConfirm.cancel")}
        </button>
      </div>
    </div>
  );
}
