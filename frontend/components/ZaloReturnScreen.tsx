"use client";

import { useT } from "@/app/providers";

// Màn "đăng nhập thành công" của luồng đăng nhập hộ Zalo Mini App (Figma
// 508-3538), chỉ hiện khi trang này được mở trong webview của Mini App
// (URL có ?zma=1, xem lib/zaloReturn.ts).
//
// Zalo KHÔNG cấp bridge nào cho trang web trong webview để tự đóng cửa sổ:
// openWebview chỉ có url/style/leftButton, và không có API kiểu
// zlpSdk.UI.closeWindow() của ZaloPay Mini App. Deep-link zalo.me/s/<app_id> cũng
// không đáng tin (app chưa publish thì Zalo đá sang zalo.me/nf, mất luôn màn
// hình). Nên ở đây chỉ hướng dẫn user tự bấm X — mũi tên chỉ lên đúng nút X ở
// góc trên bên trái webview. Mini App tự bắt lúc webview đóng để đổi session
// (xem miniapp/src/components/block-screen.tsx).
export default function ZaloReturnScreen() {
  const t = useT();

  return (
    <div className="flex min-h-dvh flex-col items-center gap-6 bg-white p-4 dark:bg-[#13161b]">
      {/* Mũi tên chỉ lên nút X của webview.
          Header là chrome NATIVE của Zalo nên vị trí X đo bằng px tuyệt đối từ
          mép trái, KHÔNG theo % bề ngang máy: đo trên iPhone 14 (viewport
          390px) thì tâm X ở ~71px. Mũi tên rộng 24px → mép trái 59px = 16px
          padding của cột + 43px margin. */}
      <div className="w-full">
        <svg
          className="zma-nudge ms-[43px]"
          width="24"
          height="34"
          viewBox="0 0 23.75 33.75"
          fill="none"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M11.875 0C12.9105 0 13.75 0.839466 13.75 1.875V27.3483L20.5492 20.5492C21.2814 19.8169 22.4686 19.8169 23.2008 20.5492C23.9331 21.2814 23.9331 22.4686 23.2008 23.2008L13.2008 33.2008C12.4686 33.9331 11.2814 33.9331 10.5492 33.2008L0.549175 23.2008C-0.183058 22.4686 -0.183058 21.2814 0.549175 20.5492C1.28141 19.8169 2.46859 19.8169 3.20082 20.5492L10 27.3483V1.875C10 0.839466 10.8395 0 11.875 0Z"
            fill="#006AF5"
            transform="rotate(180 11.875 16.875)"
          />
        </svg>
      </div>

      <svg width="80" height="80" viewBox="0 0 80 80" fill="none" aria-hidden="true">
        <path
          d="M40 0C17.96 0 0 17.96 0 40C0 62.04 17.96 80 40 80C62.04 80 80 62.04 80 40C80 17.96 62.04 0 40 0ZM59.12 30.8L36.44 53.48C35.88 54.04 35.12 54.36 34.32 54.36C33.52 54.36 32.76 54.04 32.2 53.48L20.88 42.16C19.72 41 19.72 39.08 20.88 37.92C22.04 36.76 23.96 36.76 25.12 37.92L34.32 47.12L54.88 26.56C56.04 25.4 57.96 25.4 59.12 26.56C60.28 27.72 60.28 29.6 59.12 30.8Z"
          fill="url(#zma-check-gradient)"
        />
        <defs>
          <linearGradient
            id="zma-check-gradient"
            x1="40"
            y1="0"
            x2="40"
            y2="80"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#0068FF" />
            <stop offset="1" stopColor="#549AFF" />
          </linearGradient>
        </defs>
      </svg>

      <div className="flex w-full flex-col items-center gap-2 text-center">
        <p className="text-[20px] font-semibold leading-[26px] text-[#18181b] dark:text-zinc-100">
          {t("zma.doneTitle")}
        </p>
        <p className="text-[16px] leading-[22px] text-[#71717a] dark:text-zinc-400">
          {t("zma.doneDesc")}
        </p>
      </div>
    </div>
  );
}
