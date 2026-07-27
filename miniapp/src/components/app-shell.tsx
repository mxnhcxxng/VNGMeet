import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  // Neo để tìm khung cuộn <Page> (.zaui-page) mà cả 3 tab dùng CHUNG.
  const scrollAnchorRef = useRef<HTMLDivElement>(null);

  // Ba tab render trong cùng một khung cuộn <Page> nên vị trí cuộn "dính" từ
  // tab này sang tab kia (Home cuộn xuống → mở Lịch sử vẫn ở giữa trang). Mỗi
  // lần đổi tab, đưa khung cuộn về đầu để từng tab độc lập và luôn mở ở trên
  // cùng. useLayoutEffect: reset trước khi vẽ nên không thấy nhảy.
  useLayoutEffect(() => {
    const page = scrollAnchorRef.current?.closest(".zaui-page") as
      | HTMLElement
      | null;
    if (page) page.scrollTop = 0;
  }, [tab]);

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
      <div ref={scrollAnchorRef} hidden />
      {tab === "home" && <HomePage />}
      {tab === "history" && <HistoryPage />}
      {tab === "account" && <AccountPage me={me} onMeChange={setMe} />}
      <BottomNav active={tab} onChange={setTab} />
    </Page>
  );
}
