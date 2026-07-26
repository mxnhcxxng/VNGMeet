import type * as React from "react";
import { useRef } from "react";

// Cử chỉ "swipe back" kiểu iOS: vuốt từ sát mép trái sang phải để quay lại.
// Panel bám theo ngón tay realtime (kéo tới đâu trượt tới đó); khi thả:
//  - vượt ngưỡng  -> trượt nốt ra ngoài rồi gọi onBack (đóng màn).
//  - chưa đủ ngưỡng -> bật đàn hồi về vị trí mở.
// Gắn bộ handler trả về lên chính phần tử panel (element có transition transform).
const EDGE_START_PX = 30; // chỉ nhận khi ngón bắt đầu trong 30px sát mép trái
const DIR_LOCK_PX = 6; // di chuyển quá 6px mới khoá hướng (ngang/dọc)
const COMMIT_RATIO = 0.4; // kéo qua 40% bề ngang panel thì coi là back
const COMMIT_MIN_PX = 80; // hoặc tối thiểu 80px (cho panel hẹp)
const SETTLE_MS = 240; // thời lượng animation trượt nốt / bật về

type Dir = "none" | "horizontal" | "vertical";

export function useSwipeBack(onBack: () => void, enabled = true) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const dir = useRef<Dir>("none");
  const el = useRef<HTMLElement | null>(null);
  const dx = useRef(0);

  // Xoá transition tạm thời để transform bám ngón tay không bị trễ.
  function beginDrag(target: HTMLElement) {
    el.current = target;
    target.style.transition = "none";
  }

  // Trả quyền điều khiển transform lại cho CSS class (is-open) sau khi settle.
  function clearInline() {
    const node = el.current;
    if (!node) return;
    node.style.transition = "";
    node.style.transform = "";
  }

  function reset() {
    start.current = null;
    dir.current = "none";
    dx.current = 0;
  }

  return {
    onTouchStart: (e: React.TouchEvent) => {
      if (!enabled || e.touches.length !== 1) {
        reset();
        return;
      }
      const t = e.touches[0];
      if (t.clientX <= EDGE_START_PX) {
        start.current = { x: t.clientX, y: t.clientY };
        dir.current = "none";
        dx.current = 0;
        el.current = e.currentTarget as HTMLElement;
      } else {
        start.current = null;
      }
    },

    onTouchMove: (e: React.TouchEvent) => {
      if (!start.current || e.touches.length !== 1) return;
      const t = e.touches[0];
      const moveX = t.clientX - start.current.x;
      const moveY = t.clientY - start.current.y;

      // Khoá hướng ở lần vượt ngưỡng đầu tiên.
      if (dir.current === "none") {
        if (Math.abs(moveX) > DIR_LOCK_PX || Math.abs(moveY) > DIR_LOCK_PX) {
          dir.current =
            Math.abs(moveX) > Math.abs(moveY) ? "horizontal" : "vertical";
          if (dir.current === "horizontal" && el.current) {
            beginDrag(el.current);
          }
        }
      }

      if (dir.current !== "horizontal" || !el.current) return;
      // Chỉ cho kéo sang phải (đóng); kéo ngược lại giữ ở mép.
      dx.current = Math.max(0, moveX);
      el.current.style.transform = `translateX(${dx.current}px)`;
    },

    onTouchEnd: () => {
      const node = el.current;
      if (dir.current !== "horizontal" || !node) {
        reset();
        return;
      }

      const width = node.offsetWidth || window.innerWidth;
      const commit =
        dx.current > Math.max(COMMIT_MIN_PX, width * COMMIT_RATIO);

      node.style.transition = `transform ${SETTLE_MS}ms ease`;
      if (commit) {
        // Trượt nốt ra ngoài rồi báo đóng. onBack tự lo unmount/animation của
        // component; transform inline 100% khớp trạng thái đóng nên không giật.
        node.style.transform = "translateX(100%)";
        window.setTimeout(onBack, SETTLE_MS);
      } else {
        // Bật đàn hồi về vị trí mở rồi trả transform lại cho CSS.
        node.style.transform = "translateX(0)";
        window.setTimeout(clearInline, SETTLE_MS);
      }
      reset();
    },
  };
}
