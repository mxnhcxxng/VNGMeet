import { useCallback, useEffect, useRef, useState } from "react";
import { getSystemInfo } from "zmp-sdk";
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

import ChatPage from "@/pages/chat";
import { setToken, useToken } from "@/services/auth";
import { api, LinkRequiredError } from "@/services/api";
import { errText, requestPhoneNumber } from "@/services/phone";

type Phase = "authing" | "denied" | "unlinked" | "error";

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
  const [phase, setPhase] = useState<Phase>("authing");
  const [detail, setDetail] = useState(""); // DEBUG: message lỗi thật
  const running = useRef(false);

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
          openSnackbar({ text: `Xin chào ${username}!`, type: "success" });
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

  // Gate luôn được render BÊN TRONG ZMPRouter (xem Layout), nên <Page> ở cả 2
  // nhánh đều có context router — không còn lỗi invariant của react-router.
  if (token) {
    return <ChatPage />;
  }

  // Chưa có token: đang authen, hoặc rơi vào một trạng thái lỗi cần user xử lý.
  const message: Record<Exclude<Phase, "authing">, string> = {
    denied: "VNGMeet cần số điện thoại của bạn để đăng nhập.",
    unlinked:
      "Số điện thoại này chưa được đăng ký trong VNGMeet. " +
      "Vui lòng liên kết tài khoản Microsoft trước rồi thử lại.",
    error: "Không kết nối được máy chủ. Vui lòng thử lại.",
  };

  return (
    <Page className="flex flex-col items-center justify-center px-6 bg-white dark:bg-black">
      <Box textAlign="center" className="space-y-4">
        <Text.Title size="large">VNGMeet</Text.Title>
        {phase === "authing" ? (
          <Text className="text-gray-500">Đang xác thực...</Text>
        ) : (
          <>
            <Text className="text-gray-500">{message[phase]}</Text>
            {detail && (
              <Text size="xSmall" className="text-red-500 break-words">
                {detail}
              </Text>
            )}
            <Button fullWidth onClick={() => void authenticate()}>
              {phase === "denied"
                ? "Cho phép chia sẻ số điện thoại"
                : "Thử lại"}
            </Button>
          </>
        )}
      </Box>
    </Page>
  );
}

const Layout = () => {
  return (
    <App theme={getSystemInfo().zaloTheme as AppProps["theme"]}>
      <SnackbarProvider>
        <ZMPRouter>
          <AnimationRoutes>
            <Route path="/" element={<Gate />}></Route>
          </AnimationRoutes>
        </ZMPRouter>
      </SnackbarProvider>
    </App>
  );
};
export default Layout;
