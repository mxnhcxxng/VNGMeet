// Nhận biết trang này đang được mở trong webview của Zalo Mini App.
//
// Màn chặn của Mini App mở thẳng link OAuth Supabase trong webview, với
// redirect_to = <web này>/?zma=1 (xem miniapp/src/config.ts). Liên kết Microsoft
// xong thì web KHÔNG hiện giao diện đặt phòng nữa mà hiện màn "đăng nhập thành
// công" hướng dẫn user bấm X để quay lại Mini App (Zalo không có API cho web
// trong webview tự đóng cửa sổ).
//
// Bản Mini App đã publish có thể còn gửi tham số cũ `zma_return=<deep-link>` —
// web và Mini App deploy rời nhau nên vẫn nhận, chỉ dùng làm cờ chứ không điều
// hướng tới nữa.
function read(): boolean {
  try {
    const q = new URLSearchParams(window.location.search);
    return q.get("zma") === "1" || Boolean(q.get("zma_return"));
  } catch {
    return false;
  }
}

// Chốt giá trị NGAY LÚC LOAD MODULE, trước khi React render.
//
// Bắt buộc phải đọc sớm: page.tsx đồng bộ view hiện tại vào URL bằng
// history.replaceState(..., "/chat") — chỉ có pathname, nên query string bị xoá
// sạch. Effect đó khai báo trước effect quay-về-Mini-App nên chạy trước, và cờ
// đã bay mất trước khi ta kịp đọc. Đọc ở module scope thì không đua với effect
// nào cả.
const captured = typeof window === "undefined" ? false : read();

export function isZaloMiniAppFlow(): boolean {
  return captured;
}
