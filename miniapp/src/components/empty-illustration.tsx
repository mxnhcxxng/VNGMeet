import emptyLight from "@/static/empty-light.png";
import emptyDark from "@/static/empty-dark.png";
import { useSettings } from "@/services/settings";

// Illustration lịch trống cho các empty state (lịch sử đặt phòng, phòng trống
// hôm nay/ngày mai). Ảnh đã bake sẵn nền sáng/tối nên chọn theo theme đã resolve.
export default function EmptyIllustration({ size = 120 }: { size?: number }) {
  const { resolvedTheme } = useSettings();
  return (
    <img
      className="empty-illus"
      src={resolvedTheme === "dark" ? emptyDark : emptyLight}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
    />
  );
}
