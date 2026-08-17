// ZaUI stylesheet
import "zmp-ui/zaui.css";
// Tailwind stylesheet
import "@/css/tailwind.scss";
// Your stylesheet
import "@/css/app.scss";

// React core
import React from "react";
import { createRoot } from "react-dom/client";
import * as zmpSdk from "zmp-sdk";

// Mount the app
import Layout from "@/components/layout";
import { clearToken } from "@/services/auth";

// Expose app configuration
import appConfig from "../app-config.json";

// --- Reset session qua deep-link (?reset=1) ---
// Mở Mini App bằng https://zalo.me/s/<app_id>/?reset=1 để xoá session JWT trước khi
// React mount → Gate authen lại từ đầu. Dùng khi cần test lại luồng đăng nhập mà
// không vào được tab Tài khoản (nút "Đăng nhập lại"), và bản live không có vConsole
// để tự xoá localStorage. Vô hại: Gate tự authen im lặng bằng SĐT Zalo.
try {
  const routeParams = (() => {
    try {
      const fn = (zmpSdk as Record<string, unknown>)["getRouteParams"];
      return typeof fn === "function"
        ? (fn as () => Record<string, string>)()
        : {};
    } catch {
      return {};
    }
  })();
  const hash = window.location.hash || "";
  const hashQuery = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  const fromUrl =
    new URLSearchParams(window.location.search).get("reset") ??
    new URLSearchParams(hashQuery).get("reset");
  if (routeParams?.reset === "1" || fromUrl === "1") {
    clearToken();
  }
} catch {
  // ignore
}

// --- DEBUG: lòi ra lỗi runtime thật trong webview Zalo (bundle đã minify) ---
// Lỗi Promise (unhandledrejection) KHÔNG bị che cross-origin → in được message +
// stack thật. Gỡ block này sau khi debug xong.
window.addEventListener("unhandledrejection", (e) => {
  const r = (e as PromiseRejectionEvent).reason as any;
  console.error(
    "[unhandledrejection]",
    r?.name,
    r?.message ?? r,
    "\nstack:",
    r?.stack,
  );
});
window.addEventListener("error", (e) => {
  console.error(
    "[window.error]",
    e.message,
    `${e.filename}:${e.lineno}:${e.colno}`,
    e.error?.stack,
  );
});

// --- DEBUG: reset vị trí nút gỡ lỗi (vConsole) của Zalo ---
// vConsole lưu vị trí nút gạt trong localStorage (vConsole_switch_x/y, tính từ
// góc DƯỚI-PHẢI). Nút hay bị kẹt sát đỉnh (dưới dynamic island) nên không kéo ra
// được. Nếu vị trí đã lưu quá cao thì đưa về góc dưới-phải cho dễ thao tác.
// Gỡ block này khi không cần debug nữa.
try {
  const raw = localStorage.getItem("vConsole_switch_y");
  const y = raw == null ? null : Number(raw);
  const stuckNearTop =
    y != null && Number.isFinite(y) && y > window.innerHeight - 120;
  if (stuckNearTop) {
    localStorage.setItem("vConsole_switch_x", "16");
    localStorage.setItem("vConsole_switch_y", "80");
    const vc = (window as unknown as { vConsole?: { setSwitchPosition?: (x: number, y: number) => void } }).vConsole;
    vc?.setSwitchPosition?.(16, 80);
  }
} catch {
  // ignore
}

if (!window.APP_CONFIG) {
  window.APP_CONFIG = appConfig as any;
}

const root = createRoot(document.getElementById("app")!);
root.render(React.createElement(Layout));
