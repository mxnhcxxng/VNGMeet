import { useEffect, useState } from "react";
import { Page } from "zmp-ui";

import BottomNav, { TabKey } from "@/components/bottom-nav";
import HomePage from "@/pages/home";
import HistoryPage from "@/pages/history";
import AccountPage from "@/pages/account";
import { api } from "@/services/api";
import { useSettings } from "@/services/settings";
import type { MeResponse } from "@/types";

// Khung app sau khi đăng nhập: nội dung theo tab + thanh điều hướng dưới.
// Chuyển tab bằng state cục bộ (chưa cần router cho các tab mock).
// Lưu ý: các tab chuyển bằng bottom-nav (không có nút back) nên KHÔNG bật
// swipe-back — chỉ màn có nút back (chi tiết lịch họp, đặt phòng) mới swipe-back.
export default function AppShell() {
  const [tab, setTab] = useState<TabKey>("home");
  // Hồ sơ user — nạp 1 lần để (1) đồng bộ theme/ngôn ngữ từ web, (2) truyền cho
  // màn Tài khoản dùng lại (office/floor... cần cho việc lưu cài đặt lên server).
  const [me, setMe] = useState<MeResponse | null>(null);
  const { hydrateFromProfile } = useSettings();

  useEffect(() => {
    let alive = true;
    void api
      .me()
      .then((m) => {
        if (!alive) return;
        setMe(m);
        hydrateFromProfile(m.profile?.theme, m.profile?.language);
      })
      .catch(() => {
        // im lặng — 401 sẽ được api.ts xử lý (re-auth); lỗi khác không chặn app.
      });
    return () => {
      alive = false;
    };
  }, [hydrateFromProfile]);

  return (
    <Page hideScrollbar>
      {tab === "home" && <HomePage />}
      {tab === "history" && <HistoryPage />}
      {tab === "account" && <AccountPage me={me} onMeChange={setMe} />}
      <BottomNav active={tab} onChange={setTab} />
    </Page>
  );
}
