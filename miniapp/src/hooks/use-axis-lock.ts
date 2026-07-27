import { useCallback, useRef } from "react";
import type { MutableRefObject, RefObject } from "react";

// Khoá hướng cuộn cho vùng cuộn 2 chiều (vd lưới lịch phòng): mỗi cử chỉ chỉ
// cuộn theo MỘT trục (ngang HOẶC dọc), không bao giờ cuộn chéo ("360").
//
// Cách làm CHẶT (khớp cơ chế của swipe-views): touchmove là listener non-passive
// để có quyền preventDefault. Ở lần di chuyển đầu vượt ngưỡng, chọn trục trội
// hơn rồi TỰ điều khiển cuộn — chặn cuộn native (preventDefault) và chỉ set
// scroll theo trục đã khoá, ghim trục kia về vị trí lúc chạm. Nhờ tự lái nên
// không có khung hình nào lọt cuộn chéo. Vì đã tự lái, momentum native mất →
// TỰ làm quán tính: đo vận tốc lúc kéo, thả tay thì chạy vòng rAF giảm dần theo
// ma sát trên đúng trục đã khoá (nắm lại giữa chừng thì huỷ để "bắt" đà).
//
// Trả về CALLBACK REF (không dùng useEffect): lưới lịch render có điều kiện (chỉ
// khi đã có data), nên nếu gắn qua useEffect([ref]) thì lúc effect chạy phần tử
// còn null → không bao giờ gắn được listener. Callback ref gắn/gỡ đúng lúc phần
// tử mount/unmount. Vẫn set `ref.current` để code khác (auto-scroll) dùng được.
const LOCK_PX = 6;
// Ma sát mỗi khung ~16.67ms: vận tốc còn 95% sau mỗi frame (chuẩn hoá theo dt).
const FRICTION = 0.95;
const FRAME_MS = 1000 / 60;
// Dưới ngưỡng này (px/ms) coi như dừng.
const MIN_VELOCITY = 0.02;
// Chặn fling quá mạnh (px/ms) cho ổn định.
const MAX_VELOCITY = 4;
// Mẫu vận tốc cũ hơn mốc này (ms) lúc thả tay → coi như giữ yên, không fling.
const STALE_MS = 90;

export function useAxisLock(ref: RefObject<HTMLElement | null>) {
  const cleanupRef = useRef<(() => void) | null>(null);

  return useCallback(
    (node: HTMLElement | null) => {
      // Gỡ listener của phần tử cũ (nếu có) trước khi gắn phần tử mới.
      cleanupRef.current?.();
      cleanupRef.current = null;
      (ref as MutableRefObject<HTMLElement | null>).current = node;
      if (!node) return;

      let startX = 0;
      let startY = 0;
      let startLeft = 0;
      let startTop = 0;
      let axis: "x" | "y" | null = null;
      let active = false;
      // Theo dõi vận tốc con trỏ dọc theo trục đã khoá (px/ms) để tính quán tính.
      let lastPos = 0;
      let lastTime = 0;
      let velocity = 0; // dương = toạ độ trục tăng theo thời gian
      let raf = 0;

      function stopMomentum() {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      }

      function onTouchStart(e: TouchEvent) {
        stopMomentum(); // nắm lại giữa lúc đang trôi → dừng để bắt đà mới
        if (e.touches.length !== 1) {
          active = false;
          axis = null;
          return;
        }
        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        startLeft = node!.scrollLeft;
        startTop = node!.scrollTop;
        axis = null;
        active = true;
        velocity = 0;
      }

      function onTouchMove(e: TouchEvent) {
        if (!active || e.touches.length !== 1) return;
        const t = e.touches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;

        if (!axis) {
          // Chưa đủ ngưỡng → để yên (cho phép tap chọn ô, không nuốt cử chỉ).
          if (Math.abs(dx) <= LOCK_PX && Math.abs(dy) <= LOCK_PX) return;
          axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
          lastPos = axis === "x" ? t.clientX : t.clientY;
          lastTime = e.timeStamp;
        }

        // Đã khoá trục → tự lái cuộn, chặn cuộn native (kẻo nó trôi chéo).
        if (e.cancelable) e.preventDefault();

        // Vận tốc scroll ngược dấu di chuyển ngón tay (kéo ngón lên → scroll tăng).
        const pos = axis === "x" ? t.clientX : t.clientY;
        const dt = e.timeStamp - lastTime;
        if (dt > 0) {
          const v = -(pos - lastPos) / dt;
          // Làm mượt nhẹ để bớt nhiễu mẫu.
          velocity = velocity * 0.2 + v * 0.8;
          lastPos = pos;
          lastTime = e.timeStamp;
        }

        if (axis === "x") {
          node!.scrollLeft = startLeft - dx;
          node!.scrollTop = startTop; // ghim trục dọc
        } else {
          node!.scrollTop = startTop - dy;
          node!.scrollLeft = startLeft; // ghim trục ngang
        }
      }

      function onTouchEnd(e: TouchEvent) {
        active = false;
        const lockedAxis = axis;
        axis = null;
        if (!lockedAxis) return;

        // Mẫu vận tốc quá cũ (ngón dừng trước khi nhấc) → không fling.
        if (e.timeStamp - lastTime > STALE_MS) return;
        let v = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, velocity));
        if (Math.abs(v) < MIN_VELOCITY) return;

        let prev = e.timeStamp;
        const step = (nowT: number) => {
          const frameDt = nowT - prev;
          prev = nowT;
          // Giảm dần theo ma sát, chuẩn hoá theo thời lượng frame thực.
          v *= Math.pow(FRICTION, frameDt / FRAME_MS);
          const before =
            lockedAxis === "x" ? node!.scrollLeft : node!.scrollTop;
          const next = before + v * frameDt;
          if (lockedAxis === "x") node!.scrollLeft = next;
          else node!.scrollTop = next;
          const after =
            lockedAxis === "x" ? node!.scrollLeft : node!.scrollTop;
          // Dừng khi vận tốc quá nhỏ hoặc chạm mép (không nhích thêm được nữa).
          if (Math.abs(v) < MIN_VELOCITY || Math.abs(after - before) < 0.1) {
            raf = 0;
            return;
          }
          raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
      }

      function onTouchCancel() {
        active = false;
        axis = null;
      }

      node.addEventListener("touchstart", onTouchStart, { passive: true });
      // Non-passive: bắt buộc để preventDefault() chặn được cuộn 2 chiều native.
      node.addEventListener("touchmove", onTouchMove, { passive: false });
      node.addEventListener("touchend", onTouchEnd, { passive: true });
      node.addEventListener("touchcancel", onTouchCancel, { passive: true });

      cleanupRef.current = () => {
        stopMomentum();
        node.removeEventListener("touchstart", onTouchStart);
        node.removeEventListener("touchmove", onTouchMove);
        node.removeEventListener("touchend", onTouchEnd);
        node.removeEventListener("touchcancel", onTouchCancel);
      };
    },
    [ref],
  );
}
