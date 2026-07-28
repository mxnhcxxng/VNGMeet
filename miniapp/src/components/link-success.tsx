import type { ComponentType } from "react";

import Check from "@gravity-ui/icons/Check";
import Magnifier from "@gravity-ui/icons/Magnifier";
import Binoculars from "@gravity-ui/icons/Binoculars";
import Clock from "@gravity-ui/icons/Clock";
import MapPin from "@gravity-ui/icons/MapPin";

import botAvatar from "@/static/bot-avatar.png";
import { useT } from "@/services/settings";
import type { TranslationKey } from "@/services/i18n";

type IconProps = { width?: number; height?: number; className?: string };

// Danh sách năng lực của bot (khớp Figma 403-2707): tìm/săn/hẹn giờ/chỉ đường.
const FEATURES: { Icon: ComponentType<IconProps>; labelKey: TranslationKey }[] = [
  { Icon: Magnifier, labelKey: "linkSuccess.find" },
  { Icon: Binoculars, labelKey: "linkSuccess.scout" },
  { Icon: Clock, labelKey: "linkSuccess.schedule" },
  { Icon: MapPin, labelKey: "linkSuccess.direction" },
];

// Màn "Liên kết chatbot thành công" (Figma 403-2707): hiện sau khi mở deep-link
// ?bot_pair=<code> và BE liên kết chat_id ↔ tài khoản VNG thành công.
export default function LinkSuccess({ onClose }: { onClose: () => void }) {
  const t = useT();

  return (
    <div className="link-ok">
      <div className="link-ok__banner" />

      <div className="link-ok__body">
        <div className="link-ok__check">
          <Check width={40} height={40} />
        </div>

        <div className="link-ok__heads">
          <p className="link-ok__title">{t("linkSuccess.title")}</p>
          <p className="link-ok__subtitle">{t("linkSuccess.subtitle")}</p>
        </div>

        <div className="link-ok__panel">
          <div className="link-ok__bot">
            <img className="link-ok__bot-avatar" src={botAvatar} alt="" />
            <div className="link-ok__bot-info">
              <span className="link-ok__bot-name">{t("linkSuccess.botName")}</span>
              <span className="link-ok__bot-sub">{t("linkSuccess.botAccount")}</span>
            </div>
          </div>

          <div className="link-ok__features">
            {FEATURES.map(({ Icon, labelKey }) => (
              <div className="link-ok__feature" key={labelKey}>
                <Icon width={16} height={16} className="link-ok__feature-icon" />
                <span>{t(labelKey)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="link-ok__footer">
        <button className="link-ok__cta" type="button" onClick={onClose}>
          {t("linkSuccess.backHome")}
        </button>
      </div>
    </div>
  );
}
