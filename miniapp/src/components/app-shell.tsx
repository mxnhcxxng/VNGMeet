import { useState } from "react";
import { Page } from "zmp-ui";

import BottomNav, { TabKey } from "@/components/bottom-nav";
import HomePage from "@/pages/home";
import HistoryPage from "@/pages/history";
import AccountPage from "@/pages/account";

// Khung app sau khi đăng nhập: nội dung theo tab + thanh điều hướng dưới.
// Chuyển tab bằng state cục bộ (chưa cần router cho các tab mock).
// Lưu ý: các tab chuyển bằng bottom-nav (không có nút back) nên KHÔNG bật
// swipe-back — chỉ màn có nút back (chi tiết lịch họp, đặt phòng) mới swipe-back.
export default function AppShell() {
  const [tab, setTab] = useState<TabKey>("home");

  return (
    <Page hideScrollbar>
      {tab === "home" && <HomePage />}
      {tab === "history" && <HistoryPage />}
      {tab === "account" && <AccountPage />}
      <BottomNav active={tab} onChange={setTab} />
    </Page>
  );
}
