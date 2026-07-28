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
      setPhase("denied");
    } finally {
      running.current = false;
    }
  }, [openSnackbar]);

  // Auto authen ĐÚNG 1 LẦN mỗi khi ở trạng thái chưa đăng nhập (token null):
  // lúc mở app, và khi bị 401 (token bị xoá → token đổi → chạy lại 1 lần).
  // KHÔNG đưa `authenticate` vào deps: nó phụ thuộc openSnackbar (đổi ref mỗi
  // render) nên nếu để vào, mỗi lần set lỗi → re-render → effect chạy lại →
  // popup xin quyền bị bật LIÊN TỤC. Chỉ chạy lại khi `token` đổi.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!token) void authenticate();
  }, [token]);

  // Bảo đảm quyền SĐT LUÔN được xin mỗi khi mở app: session JWT sống ~30 ngày
  // nên các lần mở sau sẽ bỏ qua authenticate() ở trên → không xin lại quyền.
  // Nếu đã có session nhưng quyền scope.userPhonenumber chưa/không còn được cấp
  // (vd user thu hồi trong cài đặt Zalo), chạy lại authen để bật popup xin quyền.
  // getSetting im lặng nên khi quyền đã có sẽ không làm phiền user.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!token) return;
    void (async () => {
      if (!(await hasPhonePermission())) void authenticate();
    })();
  }, [token]);

  // Liên kết Zalo Bot: khi đã có session và deep-link kèm ?bot_pair=<code>, đổi mã
  // lấy liên kết chat_id ↔ tài khoản VNG (chỉ chạy 1 lần).
  useEffect(() => {
    if (!token || pairHandled.current) return;
    const code = readBotPairCode();
    if (!code) return;
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
        clearBotPairParam();
      }
    })();
  }, [token, openSnackbar]);

  // Gate luôn được render BÊN TRONG ZMPRouter (xem Layout), nên <Page> ở cả 2
  // nhánh đều có context router — không còn lỗi invariant của react-router.
  if (token) {
    // Vừa liên kết chatbot xong → màn thành công, "Trở về màn hình chính" đóng lại.
    if (botLinked) return <LinkSuccess onClose={() => setBotLinked(false)} />;
    return <AppShell />;
  }

  // SĐT Zalo không map được profile nào / token hết hạn và tài khoản không còn
  // → BE trả 403 → màn chặn hướng dẫn đăng nhập lại qua link (Figma 400-2855).
  if (phase === "unlinked") {
    return <BlockScreen />;
  }

  // Chưa có token: đang authen, hoặc rơi vào một trạng thái lỗi cần user xử lý.
  const message: Record<Exclude<Phase, "authing">, string> = {
    denied: t("gate.denied"),
    unlinked: t("gate.unlinked"),
    error: t("gate.error"),
  };

  return (
    <Page className="flex flex-col items-center justify-center px-6 bg-white dark:bg-black">
      <Box textAlign="center" className="space-y-4">
        <Text.Title size="large">VNGMeet</Text.Title>
        {phase === "authing" ? (
          <Text className="text-gray-500">{t("gate.authing")}</Text>
        ) : (
          <>
            <Text className="text-gray-500">{message[phase]}</Text>
            {detail && (
              <Text size="xSmall" className="text-red-500 break-words">
                {detail}
              </Text>
            )}
            <Button fullWidth onClick={() => void authenticate()}>
              {phase === "denied" ? t("gate.allowPhone") : t("common.retry")}
            </Button>
          </>
        )}
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
