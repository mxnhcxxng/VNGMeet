// Base URL của backend VNGMeet. KHÔNG có dấu "/" ở cuối — path trong api.ts tự thêm "/".
//
// Đang trỏ về endpoint AgentBase public để deploy/test trên điện thoại thật.
// (Local dưới đây chỉ dùng khi chạy web/simulator cùng máy với backend.)
export const API_BASE =
  "https://endpoint-43d00107-bcbd-4907-ade0-e87008a842b3.agentbase-runtime.aiplatform.vngcloud.vn/api";
// export const API_BASE = "http://localhost:8000/api";

// --- Đăng nhập Microsoft (màn chặn) ------------------------------------------
// Mini App mở THẲNG link OAuth của Supabase, y như bản web gọi
// supabase.auth.signInWithOAuth({ provider: "azure" }) — chỉ khác là ta tự dựng
// URL thay vì nhúng cả supabase-js vào bundle.
//
// SUPABASE_URL = NEXT_PUBLIC_SUPABASE_URL của bản web (giá trị công khai, bản web
// cũng nhúng thẳng vào bundle). KHÔNG có dấu "/" ở cuối.
export const SUPABASE_URL: string = "https://uaibsnqnnutqonveusui.supabase.co";

// Origin của WEB VNGMeet, dùng làm redirect_to (bản web truyền
// window.location.origin). KHÔNG phải origin của Mini App (h5.zdn.vn): sau khi
// Microsoft trả về, chính trang web này mới hoàn tất OAuth — nó đọc session trong
// URL hash rồi POST /api/auth/link để lưu Microsoft refresh token + SĐT, là khoá
// mà /api/auth/zalo dùng để map SĐT Zalo → tài khoản. Mini App không có
// supabase-js nên không làm được bước đó.
//
// Endpoint AgentBase đổi khi redeploy web thì sửa ở đây (giống API_BASE). Để rỗng
// = dùng "Site URL" cấu hình trong Supabase. KHÔNG có dấu "/" ở cuối.
export const WEB_URL: string =
  "https://endpoint-eccce4e2-81f8-4d05-8daf-6920f5190439.agentbase-runtime.aiplatform.vngcloud.vn";

// Giữ khớp với SCOPES ở frontend/lib/api.ts: xin thiếu/thừa scope là Microsoft
// bắt user consent lại dù đã consent từ web.
const MS_SCOPES =
  "offline_access openid email profile Calendars.Read.Shared Calendars.ReadWrite User.Read";

// Không có deep-link quay về ở đây: link zalo.me/s/<app_id> chỉ mở được BẢN
// LIVE (bản Development/Testing hoặc app chưa publish thì Zalo đá sang
// zalo.me/nf), nên web không tự đá user về nữa mà hiện màn hướng dẫn bấm X.

// URL đăng nhập Microsoft để mở trong webview. Dựng ĐÚNG như supabase-js
// _getUrlForProvider ở chế độ implicit (bản web không set flowType nên mặc định là
// implicit): provider + redirect_to + scopes, encodeURIComponent từng giá trị.
//
// Khác bản web một chỗ: kèm ?zma=1 vào redirect_to để web biết mình đang chạy
// trong webview của Mini App. Liên kết xong web không hiện giao diện đặt phòng
// mà hiện màn "đăng nhập thành công", hướng dẫn user bấm X đóng webview (xem
// frontend/lib/zaloReturn.ts) — Mini App bắt lúc webview đóng để đổi session.
// Cờ này KHÔNG phụ thuộc deep-link: dựng được link quay về hay không thì màn kia
// vẫn phải hiện.
// Trả null khi chưa cấu hình SUPABASE_URL (màn chặn báo lỗi thay vì mở link rỗng).
export function msOAuthUrl(): string | null {
  if (!SUPABASE_URL) return null;
  const params = [`provider=azure`];
  if (WEB_URL) {
    const target = `${WEB_URL.replace(/\/+$/, "")}/?zma=1`;
    params.push(`redirect_to=${encodeURIComponent(target)}`);
  }
  params.push(`scopes=${encodeURIComponent(MS_SCOPES)}`);
  return `${SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/authorize?${params.join("&")}`;
}
