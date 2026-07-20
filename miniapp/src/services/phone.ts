import { getAccessToken, getPhoneNumber, getSetting } from "zmp-sdk";

// Xin quyền số điện thoại theo tài liệu Zalo:
// https://docs.zaloplatforms.com/docs/MA/api/user/user-information/getPhoneNumber
//
// LƯU Ý QUAN TRỌNG: getPhoneNumber() KHÔNG trả về số điện thoại trực tiếp mà
// trả về một `token` (hết hạn sau 2 phút, dùng 1 lần). Muốn ra SĐT thật phải
// gọi Zalo Open API Ở PHÍA SERVER (cần secret_key của app — không được để lộ
// ở client):
//
//   GET https://graph.zalo.me/v2.0/me/info
//     header: access_token: <accessToken>
//     header: code:         <token>
//     header: secret_key:   <ZALO_APP_SECRET_KEY>
//   → { "data": { "number": "84912345678" }, "error": 0 }
//
// Vì vậy client chỉ lấy { token, accessToken } rồi gửi về backend VNGMeet đổi.

export interface PhoneGrant {
  /** Code dùng 1 lần để server đổi lấy SĐT (hết hạn sau 2 phút). */
  token: string;
  /** Access token của user để server gọi Zalo Open API. */
  accessToken: string;
}

/**
 * User đã cấp quyền SĐT trước đó chưa? Dùng để tránh bật popup lại mỗi lần mở.
 * Trả về false nếu chưa cấp hoặc không đọc được cài đặt.
 */
export async function hasPhonePermission(): Promise<boolean> {
  try {
    const { authSetting } = await getSetting({});
    return authSetting?.["scope.userPhonenumber"] === true;
  } catch {
    return false;
  }
}

// DEBUG: một số API SDK gọi xuống native rồi CHỜ phản hồi; nếu native không trả
// (vd chưa bật quyền SĐT trên dashboard) sẽ treo mãi. Bọc timeout để treo biến
// thành lỗi nhìn thấy được.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timeout sau ${ms}ms (native không phản hồi?)`)),
        ms,
      ),
    ),
  ]);
}

// SDK Zalo reject bằng OBJECT { code, message } chứ không phải Error → cần
// serialize ra chuỗi đọc được (thay vì "[object Object]").
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    if ("code" in o || "message" in o) {
      return `code=${String(o.code)} message=${String(o.message)}`;
    }
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}

/**
 * Kích hoạt popup xin quyền SĐT của Zalo và lấy token + accessToken.
 * Gọi TUẦN TỰ + log để biết bước nào lỗi. Ném Error (đã serialize) nếu thất bại.
 */
export async function requestPhoneNumber(): Promise<PhoneGrant> {
  let accessToken: string;
  try {
    console.log("[phone] gọi getAccessToken...");
    accessToken = await withTimeout(getAccessToken(), 15000, "getAccessToken");
    console.log("[phone] accessToken OK:", accessToken ? "có" : "rỗng");
  } catch (e) {
    console.error("[phone] getAccessToken lỗi:", e);
    throw new Error("getAccessToken → " + errText(e));
  }

  try {
    console.log("[phone] gọi getPhoneNumber (popup sẽ hiện ở đây)...");
    const { token } = await withTimeout(getPhoneNumber(), 15000, "getPhoneNumber");
    console.log("[phone] phone token OK:", token ? "có" : "rỗng");
    if (!token) {
      throw new Error("Không nhận được token số điện thoại từ Zalo.");
    }
    return { token, accessToken };
  } catch (e) {
    console.error("[phone] getPhoneNumber lỗi:", e);
    throw new Error("getPhoneNumber → " + errText(e));
  }
}
