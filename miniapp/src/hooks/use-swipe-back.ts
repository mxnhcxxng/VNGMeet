import type * as React from "react";
import { useRef } from "react";

// Cử chỉ "swipe back": vuốt từ sát mép trái màn hình sang phải để quay lại
// (giống back của iOS). Trả về bộ handler gắn lên phần tử bao ngoài.
const EDGE_START_PX = 30; // chỉ nhận khi ngón bắt đầu trong 30px sát mép trái
const TRIGGER_DX = 64; // vuốt ngang quá 64px thì kích hoạt back

export function useSwipeBack(onBack: () => void, enabled = true) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  return {
    onTouchStart: (e: React.TouchEvent) => {
      if (!enabled || e.touches.length !== 1) {
        start.current = null;
        return;
      }
      const t = e.touches[0];
      start.current =
        t.clientX <= EDGE_START_PX ? { x: t.clientX, y: t.clientY } : null;
      fired.current = false;
    },
    onTouchMove: (e: React.TouchEvent) => {
      if (!start.current || fired.current || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - start.current.x;
      const dy = Math.abs(t.clientY - start.current.y);
      // Ngang phải rõ rệt và trội hơn dọc → coi là back.
      if (dx > TRIGGER_DX && dx > dy) {
        fired.current = true;
        start.current = null;
        onBack();
      }
    },
    onTouchEnd: () => {
      start.current = null;
    },
  };
}
