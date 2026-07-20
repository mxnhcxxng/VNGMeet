// ZaUI stylesheet
import "zmp-ui/zaui.css";
// Tailwind stylesheet
import "@/css/tailwind.scss";
// Your stylesheet
import "@/css/app.scss";

// React core
import React from "react";
import { createRoot } from "react-dom/client";

// Mount the app
import Layout from "@/components/layout";

// Expose app configuration
import appConfig from "../app-config.json";

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

if (!window.APP_CONFIG) {
  window.APP_CONFIG = appConfig as any;
}

const root = createRoot(document.getElementById("app")!);
root.render(React.createElement(Layout));
