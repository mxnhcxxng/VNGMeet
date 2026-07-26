import House from "@gravity-ui/icons/House";
import ClockArrowRotateLeft from "@gravity-ui/icons/ClockArrowRotateLeft";
import Person from "@gravity-ui/icons/Person";

import { useT } from "@/services/settings";
import type { TranslationKey } from "@/services/i18n";

export type TabKey = "home" | "history" | "account";

const TABS: { key: TabKey; labelKey: TranslationKey; Icon: typeof House }[] = [
  { key: "home", labelKey: "nav.home", Icon: House },
  { key: "history", labelKey: "nav.history", Icon: ClockArrowRotateLeft },
  { key: "account", labelKey: "nav.account", Icon: Person },
];

// Thanh điều hướng dưới cùng, icon @gravity-ui/icons y hệt bản web.
export default function BottomNav({
  active,
  onChange,
}: {
  active: TabKey;
  onChange: (tab: TabKey) => void;
}) {
  const t = useT();
  return (
    <nav className="bottom-nav">
      {TABS.map(({ key, labelKey, Icon }) => (
        <button
          key={key}
          type="button"
          className={`bottom-nav__item${active === key ? " is-active" : ""}`}
          onClick={() => onChange(key)}
        >
          <Icon width={24} height={24} />
          <span className="bottom-nav__label">{t(labelKey)}</span>
        </button>
      ))}
    </nav>
  );
}
