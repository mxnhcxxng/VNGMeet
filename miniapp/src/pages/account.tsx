import Person from "@gravity-ui/icons/Person";

import { useDisplayName } from "@/services/auth";

// Tab Tài khoản — placeholder, chưa nối BE.
export default function AccountPage() {
  const name = useDisplayName() ?? "bạn";
  return (
    <div className="placeholder-page">
      <Person className="placeholder-page__icon" width={40} height={40} />
      <div className="placeholder-page__title">{name}</div>
      <div>Thông tin tài khoản sẽ hiển thị ở đây.</div>
    </div>
  );
}
