import { useEffect, useState } from "react";

// Phần chiều cao màn hình bị BÀN PHÍM ẢO che, tính bằng px.
//
// Vì sao cần: iOS (WKWebView) KHÔNG resize window khi bàn phím bật lên — chỉ
// "visual viewport" co lại, còn layout viewport (window.innerHeight) giữ nguyên.
// Hệ quả là mọi thứ neo đáy màn hình (footer trong Sheet, nút hành động) chui
// xuống dưới bàn phím, và nếu ô nhập nằm thấp thì iOS còn tự cuộn cả visual
// viewport lên để lộ ô đó — kéo theo cả lớp position: fixed trôi lệch.
//
// Đo phần bị che = layout viewport − (phần đang thấy + phần đã bị cuộn), rồi
// lấy số đó chèn vào padding-bottom của panel để footer luôn nằm trên bàn phím.
//
// `active` để chỉ lắng nghe khi panel đang mở (đóng thì trả 0 và gỡ listener).
const MIN_INSET_PX = 40; // dưới ngưỡng này là thanh công cụ / sai số, không phải bàn phím

export function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) {
      setInset(0);
      return;
    }
    const update = () => {
      const covered = window.innerHeight - vv.height - vv.offsetTop;
      setInset(covered > MIN_INSET_PX ? Math.round(covered) : 0);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [active]);

  return inset;
}
