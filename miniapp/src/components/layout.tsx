import { useCallback, useEffect, useRef, useState } from "react";
import * as zmpSdk from "zmp-sdk";
import {
  AnimationRoutes,
  App,
  Box,
  Button,
  Page,
  Route,
  SnackbarProvider,
  Text,
  useSnackbar,
  ZMPRouter,
} from "zmp-ui";
import { AppProps } from "zmp-ui/app";

import AppShell from "@/components/app-shell";
import BlockScreen from "@/components/block-screen";
import LinkSuccess from "@/components/link-success";
import PermissionScreen from "@/components/permission-screen";
import { setToken, useToken } from "@/services/auth";
import { api, LinkRequiredError } from "@/services/api";
import { errText, hasPhonePermission, requestPhoneNumber } from "@/services/phone";
import { SettingsProvider, useSettings } from "@/services/settings";

type Phase = "authing" | "denied" | "unlinked" | "error";

// Đọc mã pairing của Zalo Bot từ deep-link (?bot_pair=<code>). Bot điều hướng user
// mở Mini App kèm mã này để liên kết chat_id ↔ tài khoản VNG.
function readBotPairCode(): string | null {
  // 1) Launch params từ deep-link Zalo (zmp-sdk). Đây là đường chính khi mini app
  //    được mở qua https://zalo.me/s/<app_id>/?bot_pair=<code>.
  try {
    const getRouteParams = (zmpSdk as Record<string, unknown>)["getRouteParams"];
    if (typeof getRouteParams === "function") {
      const params = (getRouteParams as () => Record<string, string>)();
      if (params?.bot_pair) return String(params.bot_pair);
    }
  } catch {
    // ignore
  }
  // 2) Fallback: query/hash của URL (web/simulator).
  try {
    const fromSearch = new URLSearchParams(window.location.search).get("bot_pair");
    if (fromSearch) return fromSearch;
    const hash = window.location.hash || "";
    const qIndex = hash.indexOf("?");
    if (qIndex >= 0) {
      return new URLSearchParams(hash.slice(qIndex + 1)).get("bot_pair");
    }
  } catch {
    // ignore
  }
  return null;
}

function clearBotPairParam(): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("bot_pair");
    window.history.replaceState({}, "", url.toString());
  } catch {
    // ignore
  }
}

// Trích mã bot_pair từ payload bất kỳ của event Zalo (OpenApp/AppResumed). Payload
// không có kiểu cố định nên dò cả `bot_pair` trực tiếp lẫn chuỗi dạng
// "...?bot_pair=<code>" nằm trong path/query/params/data.
function pairCodeFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  if (typeof obj.bot_pair === "string" && obj.bot_pair) return obj.bot_pair;
  for (const key of ["params", "query", "data", "extraData", "path", "url"]) {
    const v = obj[key];
    if (typeof v === "string") {
      const marker = "bot_pair=";
      const i = v.indexOf(marker);
      if (i >= 0) {
        const code = v.slice(i + marker.length).split(/[&#]/)[0];
        if (code) {
          try {
            return decodeURIComponent(code);
          } catch {
            return code;
          }
        }
      }
    } else {
      const nested = pairCodeFromPayload(v);
      if (nested) return nested;
    }
  }
  return null;
}

// Nhớ các mã pairing đã xử lý TRONG PHIÊN (sessionStorage sống qua reload nhưng
// mất khi đóng app) để tránh reload lặp vô hạn: getRouteParams có thể vẫn trả về
// mã của lần mở đầu ngay cả sau khi đã liên kết xong.
const PAIR_DONE_KEY = "vngmeet.botPairHandled";

function wasPairHandled(code: string): boolean {
  try {
    const raw = sessionStorage.getItem(PAIR_DONE_KEY);
    return raw ? (JSON.parse(raw) as string[]).includes(code) : false;
  } catch {
    return false;
  }
}

function markPairHandled(code: string): void {
  try {
    const raw = sessionStorage.getItem(PAIR_DONE_KEY);
    const set = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    set.add(code);
    sessionStorage.setItem(PAIR_DONE_KEY, JSON.stringify([...set]));
  } catch {
    // ignore
  }
}

// Cổng authen bằng SĐT Zalo. Đặt trong SnackbarProvider để dùng useSnackbar.
//
// Luồng:
//  - Có session token trong localStorage → vào thẳng app.
//  - Chưa có → xin quyền SĐT (popup lần đầu, im lặng các lần sau) → gửi grant
//    lên backend → nhận session JWT → lưu lại → vào app.
//  - Request nào trả 401 → api.ts xoá token → token về null → cổng này tự
//    authen lại (re-auth), không cần user thao tác.
function Gate() {
  const token = useToken();
  const { openSnackbar } = useSnackbar();
  const { t } = useSettings();
  const [phase, setPhase] = useState<Phase>("authing");
  const [detail, setDetail] = useState(""); // DEBUG: message lỗi thật
  // Trạng thái quyền SĐT: null = đang kiểm tra (chưa biết), true = đã cấp,
  // false = chưa cấp / bị từ chối. Home CHỈ được render khi phoneOk === true →
  // không bao giờ lọt vào Home trước khi có quyền.
  const [phoneOk, setPhoneOk] = useState<boolean | null>(null);
  // Đã liên kết Zalo Bot xong → hiện màn "Liên kết chatbot thành công".
  const [botLinked, setBotLinked] = useState(false);
  const running = useRef(false);
  const pairHandled = useRef(false);

  const authenticate = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setPhase("authing");
    setDetail("");
    try {
      // Bước 1: xin quyền SĐT Zalo (popup lần đầu, sau đó im lặng).
      const grant = await requestPhoneNumber();
      setPhoneOk(true); // requestPhoneNumber thành công = user đã cấp quyền SĐT.
      // Bước 2: BE đổi token→SĐT, map SĐT→user Microsoft đã link, trả session JWT.
      try {
        const { access_token, username } = await api.authWithZalo(grant);
        // DEBUG: in claims trong session JWT để xác nhận có profile_id/sub/email.
        try {
          console.log(
            "[auth] session claims:",
            JSON.parse(atob(access_token.split(".")[1])),
          );
        } catch (err) {
          console.warn("[auth] không decode được JWT:", err);
        }
        setToken(access_token); // → token có giá trị → render app
        if (username) {
          openSnackbar({ text: t("gate.hello", { name: username }), type: "success" });
        }
      } catch (e) {
        // 403 = SĐT chưa liên kết Microsoft (phương án B yêu cầu link trước).
        setDetail(errText(e));
        setPhase(e instanceof LinkRequiredError ? "unlinked" : "error");
      }
    } catch (e) {
      // requestPhoneNumber ném lỗi = user từ chối / timeout / SDK lỗi.
      setDetail(errText(e));
      setPhoneOk(false); // chưa có quyền → giữ ở màn chặn cấp quyền.
      setPhase("denied");
    } finally {
      running.current = false;
    }
  }, [openSnackbar]);

  // KIỂM TRA QUYỀN SĐT NGAY KHI MỞ APP (chạy 1 lần lúc mount). Mini App remount
  // mỗi lần mở nên đây là "mỗi khi mở miniapp". getSetting im lặng, không popup.
  // Chưa có quyền → phoneOk=false → render màn chặn (KHÔNG vào Home). Đã có quyền
  // → phoneOk=true → hiệu ứng bên dưới lo việc lấy session nếu cần.
  useEffect(() => {
    void (async () => {
      setPhoneOk(await hasPhonePermission());
    })();
  }, []);

  // Khi ĐÃ CÓ quyền SĐT nhưng chưa có session (token null) → tự đổi lấy session.
  // getPhoneNumber lúc này im lặng (quyền đã cấp) nên không làm phiền user.
  // Gate CHỈ auto-authen khi phoneOk === true: lúc chưa cấp quyền thì đứng ở màn
  // chặn chờ user bấm "Cấp quyền", không tự bật popup.
  // KHÔNG đưa `authenticate` vào deps: nó phụ thuộc openSnackbar (đổi ref mỗi
  // render) → tránh bật popup liên tục. Chỉ chạy lại khi token/phoneOk đổi.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (phoneOk === true && !token) void authenticate();
  }, [token, phoneOk]);

  // Liên kết Zalo Bot: khi đã có session và deep-link kèm ?bot_pair=<code>, đổi mã
  // lấy liên kết chat_id ↔ tài khoản VNG (chỉ chạy 1 lần).
  useEffect(() => {
    if (!token || pairHandled.current) return;
    const code = readBotPairCode();
    if (!code || wasPairHandled(code)) return;
    pairHandled.current = true;
    void (async () => {
      try {
        await api.linkBot(code);
        // Thành công → hiện màn "Liên kết chatbot thành công" (Figma 403-2707).
        setBotLinked(true);
      } catch {
        openSnackbar({
          text: t("gate.botLinkFailed"),
          type: "error",
        });
      } finally {
        // Đánh dấu đã xử lý (kể cả khi lỗi) để listener resume không reload lặp lại.
        markPairHandled(code);
        clearBotPairParam();
      }
    })();
  }, [token, openSnackbar]);

  // FIX luồng pair khi app đang mở: user vào bot → minimize app → bot trả link
  // ?bot_pair=<code> → mở lại app. Lúc này Zalo KHÔNG remount webview nên effect
  // pairing ở trên (chạy 1 lần lúc mount) không nổ lại → không tự liên kết.
  // Zalo bắn event OpenApp/AppResumed khi re-open kèm deep-link mới; ta đọc mã mới
  // rồi reload app để chạy lại toàn bộ luồng mount (đọc mã qua URL → linkBot).
  useEffect(() => {
    const evs = (zmpSdk as Record<string, unknown>)["events"] as
      | { on?: (n: string, fn: (...a: unknown[]) => void) => void; off?: (n: string, fn: (...a: unknown[]) => void) => void }
      | undefined;
    const EventName = (zmpSdk as Record<string, unknown>)["EventName"] as
      | Record<string, string>
      | undefined;
    if (!evs?.on || !EventName) return;

    // Mã của LẦN MỞ ĐẦU do effect pairing lo; listener chỉ xử lý mã KHÁC (resume
    // với deep-link mới) để không tạo thêm 1 lần reload thừa ngay khi mở app.
    const initialCode = readBotPairCode();

    const handler = (...args: unknown[]): void => {
      let code: string | null = null;
      for (const a of args) {
        code = pairCodeFromPayload(a);
        if (code) break;
      }
      if (!code) code = readBotPairCode();
      if (!code || code === initialCode || wasPairHandled(code)) return;
      // Ghi mã vào URL để lần mount sau (sau reload) đọc được qua fallback query.
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("bot_pair", code);
        window.history.replaceState({}, "", url.toString());
      } catch {
        // ignore
      }
      window.location.reload();
    };

    const names = [EventName.OpenApp, EventName.AppResumed].filter(Boolean);
    names.forEach((n) => evs.on!(n, handler));
    return () => {
      names.forEach((n) => evs.off?.(n, handler));
    };
  }, []);

  // Đang kiểm tra quyền SĐT (chưa biết) → chờ, TUYỆT ĐỐI không render Home.
  if (phoneOk === null) {
    return (
      <Page className="flex flex-col items-center justify-center px-6 bg-white dark:bg-black">
        <Box textAlign="center" className="space-y-4">
          <Text.Title size="large">VNGMeet</Text.Title>
          <Text className="text-gray-500">{t("gate.authing")}</Text>
        </Box>
      </Page>
    );
  }

  // Chưa cấp / bị từ chối quyền SĐT → màn chặn có nút "Cấp quyền" (Figma 403-13683).
  // Đặt TRƯỚC nhánh `token`: dù đã có session hợp lệ mà chưa có quyền (lần đầu mở
  // hoặc user thu hồi trong cài đặt Zalo) vẫn phải cấp quyền trước khi vào Home.
  if (!phoneOk) {
    return <PermissionScreen onGrant={() => void authenticate()} />;
  }

  // Đã có quyền SĐT. Gate luôn render BÊN TRONG ZMPRouter (xem Layout) nên <Page>
  // ở mọi nhánh đều có context router — không còn lỗi invariant của react-router.
  if (token) {
    // Vừa liên kết chatbot xong → màn thành công, "Trở về màn hình chính" đóng lại.
    if (botLinked) return <LinkSuccess onClose={() => setBotLinked(false)} />;
    return <AppShell />;
  }

  // SĐT Zalo không map được profile nào / token hết hạn và tài khoản không còn
  // → BE trả 403 → màn hướng dẫn đăng nhập lại qua link/QR (Figma 403-13608).
  if (phase === "unlinked") {
    return <BlockScreen />;
  }

  // Đã cấp quyền SĐT, đang đổi session (chưa có token) → spinner trên nền màn chặn
  // thay cho màn loading trắng, để không bị nháy trắng trước khi ra Home/BlockScreen.
  if (phase === "authing") {
    return <BlockScreen loading />;
  }

  // Rơi vào trạng thái lỗi authen (không phải link) cần user thử lại.
  const message: Record<Exclude<Phase, "authing">, string> = {
    denied: t("gate.denied"),
    unlinked: t("gate.unlinked"),
    error: t("gate.error"),
  };

  return (
    <Page className="flex flex-col items-center justify-center px-6 bg-white dark:bg-black">
      <Box textAlign="center" className="space-y-4">
        <Text.Title size="large">VNGMeet</Text.Title>
        <Text className="text-gray-500">{message[phase]}</Text>
        {detail && (
          <Text size="xSmall" className="text-red-500 break-words">
            {detail}
          </Text>
        )}
        <Button fullWidth onClick={() => void authenticate()}>
          {t("common.retry")}
        </Button>
      </Box>
    </Page>
  );
}

// Bọc <App> để lấy theme đã "giải" (light/dark) từ SettingsProvider làm theme
// khởi tạo cho ZaUI. SettingsProvider tự set thuộc tính zaui-theme trên <body>
// mỗi khi đổi theme nên việc chuyển sáng/tối vẫn "sống" dù <App> chỉ đọc prop
// theme lúc mount.
function ThemedApp() {
  const { resolvedTheme } = useSettings();
  return (
    <App theme={resolvedTheme as AppProps["theme"]}>
      <SnackbarProvider>
        <ZMPRouter>
          <AnimationRoutes>
            <Route path="/" element={<Gate />}></Route>
          </AnimationRoutes>
        </ZMPRouter>
      </SnackbarProvider>
    </App>
  );
}

const Layout = () => {
  return (
    <SettingsProvider>
      <ThemedApp />
    </SettingsProvider>
  );
};
export default Layout;
