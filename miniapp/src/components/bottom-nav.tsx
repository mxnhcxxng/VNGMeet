import House from "@gravity-ui/icons/House";
import ClockArrowRotateLeft from "@gravity-ui/icons/ClockArrowRotateLeft";
import Person from "@gravity-ui/icons/Person";

export type TabKey = "home" | "history" | "account";

const TABS: { key: TabKey; label: string; Icon: typeof House }[] = [
  { key: "home", label: "Trang chủ", Icon: House },
  { key: "history", label: "Lịch sử", Icon: ClockArrowRotateLeft },
  { key: "account", label: "Tài khoản", Icon: Person },
];

// Thanh điều hướng dưới cùng, icon @gravity-ui/icons y hệt bản web.
export default function BottomNav({
  active,
  onChange,
}: {
  active: TabKey;
  onChange: (tab: TabKey) => void;
}) {
  return (
    <nav className="bottom-nav">
      {TABS.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          className={`bottom-nav__item${active === key ? " is-active" : ""}`}
          onClick={() => onChange(key)}
        >
          <Icon width={24} height={24} />
          <span className="bottom-nav__label">{label}</span>
        </button>
      ))}
    </nav>
  );
}
