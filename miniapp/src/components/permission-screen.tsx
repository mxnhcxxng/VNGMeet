import favicon from "@/static/favicon-white.png";
import mockup from "@/static/permission-mockup.png";
import { useT } from "@/services/settings";

// Màn chặn khi quyền SĐT bị từ chối / chưa được cấp (Figma 403-13683). Hiện ngay
// khi mở app mà user không cấp quyền số điện thoại. Nút "Cấp quyền" gọi lại luồng
// authen → bật popup xin quyền của Zalo một lần nữa.
export default function PermissionScreen({ onGrant }: { onGrant: () => void }) {
  const t = useT();

  return (
    <div className="perm-scr">
      <div className="perm-scr__body">
        <div className="perm-scr__brand">
          <img className="perm-scr__logo" src={favicon} alt="VNG Meet" />
          <span className="perm-scr__title">VNG Meet</span>
        </div>

        <p className="perm-scr__desc">{t("permission.desc")}</p>

        {/* Ảnh minh hoạt màn hình chính, bị khung cắt bớt ở đáy (khớp Figma). */}
        <div className="perm-scr__mockup">
          <img src={mockup} alt="" />
        </div>
      </div>

      <div className="perm-scr__footer">
        <button className="perm-scr__cta" type="button" onClick={onGrant}>
          {t("permission.grant")}
        </button>
      </div>
    </div>
  );
}
