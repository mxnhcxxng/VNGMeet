import { Children, useLayoutEffect, useRef, useState } from "react";
import type * as React from "react";
import type { ReactNode } from "react";

// Bộ "trang trượt ngang" đổi tab bằng cách vuốt: nội dung bám theo ngón tay
// realtime (kéo tới đâu trượt tới đó), thả ra thì:
//   - vượt ngưỡng  -> chốt sang tab kế bên.
//   - chưa đủ ngưỡng -> bật đàn hồi về tab hiện tại.
// Khoá hướng (ngang/dọc) như iOS: vuốt dọc vẫn cuộn trang bình thường nhờ
// touch-action: pan-y (trình duyệt lo cuộn dọc, JS lo trượt ngang).
const DIR_LOCK_PX = 8; // di chuyển quá 8px mới khoá hướng
const COMMIT_RATIO = 0.22; // kéo qua 22% bề ngang thì đổi tab
const COMMIT_MIN_PX = 48; // hoặc tối thiểu 48px (cho màn hẹp)
const SETTLE_MS = 300; // thời lượng animation trượt nốt / bật về
const EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";

type Props = {
  index: number;
  onIndexChange: (i: number) => void;
  children: ReactNode;
  className?: string;
  // Cho nội dung cao thấp khác nhau (vd danh sách): chiều cao viewport tự bám
  // theo trang đang mở, có transition mượt khi đổi tab.
  autoHeight?: boolean;
};

export default function SwipeViews({
  index,
  onIndexChange,
  children,
  className,
  autoHeight = false,
}: Props) {
  const pages = Children.toArray(children);
  const count = pages.length;

  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const panelRefs = useRef<(HTMLDivElement | null)[]>([]);

  const start = useRef<{ x: number; y: number } | null>(null);
  const dir = useRef<"none" | "h" | "v">("none");
  const dxRef = useRef(0);
  const widthRef = useRef(0);
  const first = useRef(true);

  const [height, setHeight] = useState<number | undefined>(undefined);

  // Đặt track về đúng trang `index` (không kéo). Dùng layout-effect + cờ first
  // để lần mount đầu không animation (tránh giật khi tab mặc định != 0).
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    track.style.transition = first.current ? "none" : `transform ${SETTLE_MS}ms ${EASE}`;
    track.style.transform = `translate3d(${-index * 100}%, 0, 0)`;
    first.current = false;
  }, [index, count]);

  // autoHeight: viewport cao bằng trang đang mở; theo dõi để cập nhật khi nội
  // dung đổi (ảnh tải xong, danh sách dài ra...).
  useLayoutEffect(() => {
    if (!autoHeight) return;
    const el = panelRefs.current[index];
    if (!el) return;
    const update = () => setHeight(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [autoHeight, index, count]);

  function onTouchStart(e: React.TouchEvent) {
    if (e.touches.length !== 1) {
      start.current = null;
      return;
    }
    const t = e.touches[0];
    start.current = { x: t.clientX, y: t.clientY };
    dir.current = "none";
    dxRef.current = 0;
    widthRef.current = viewportRef.current?.offsetWidth || window.innerWidth;
  }

  function onTouchMove(e: React.TouchEvent) {
    if (!start.current || e.touches.length !== 1) return;
    const t = e.touches[0];
    const moveX = t.clientX - start.current.x;
    const moveY = t.clientY - start.current.y;

    // Khoá hướng ở lần vượt ngưỡng đầu tiên.
    if (dir.current === "none") {
      if (Math.abs(moveX) > DIR_LOCK_PX || Math.abs(moveY) > DIR_LOCK_PX) {
        dir.current = Math.abs(moveX) > Math.abs(moveY) ? "h" : "v";
        if (dir.current === "h") {
          if (trackRef.current) trackRef.current.style.transition = "none";
          // Nới chiều cao = max(trang hiện tại, trang sắp lộ) để không bị cắt
          // khi trang kế bên trượt vào.
          if (autoHeight) {
            const neighbor = panelRefs.current[moveX < 0 ? index + 1 : index - 1];
            const cur = panelRefs.current[index];
            const h = Math.max(cur?.offsetHeight || 0, neighbor?.offsetHeight || 0);
            if (h) setHeight(h);
          }
        }
      }
    }

    if (dir.current !== "h") return;

    let dx = moveX;
    // Kháng lực ở hai mép (không có tab để trượt tiếp) — kéo nặng tay hơn.
    if ((index === 0 && dx > 0) || (index === count - 1 && dx < 0)) {
      dx = dx / 3;
    }
    dxRef.current = dx;
    const px = -index * widthRef.current + dx;
    if (trackRef.current) {
      trackRef.current.style.transform = `translate3d(${px}px, 0, 0)`;
    }
  }

  function onTouchEnd() {
    if (dir.current !== "h") {
      start.current = null;
      dir.current = "none";
      return;
    }
    const w = widthRef.current || 1;
    const dx = dxRef.current;
    const threshold = Math.max(COMMIT_MIN_PX, w * COMMIT_RATIO);

    let target = index;
    if (dx <= -threshold && index < count - 1) target = index + 1;
    else if (dx >= threshold && index > 0) target = index - 1;

    const track = trackRef.current;
    if (track) {
      track.style.transition = `transform ${SETTLE_MS}ms ${EASE}`;
      track.style.transform = `translate3d(${-target * w}px, 0, 0)`;
    }

    start.current = null;
    dir.current = "none";
    dxRef.current = 0;

    if (target !== index) {
      onIndexChange(target);
    } else if (autoHeight) {
      // Không đổi tab → thu chiều cao về trang hiện tại.
      const el = panelRefs.current[index];
      if (el) setHeight(el.offsetHeight);
    }
  }

  return (
    <div
      ref={viewportRef}
      className={`swipe-views${className ? ` ${className}` : ""}`}
      style={autoHeight ? { height } : undefined}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <div className="swipe-views__track" ref={trackRef}>
        {pages.map((page, i) => (
          <div
            key={i}
            className="swipe-views__panel"
            ref={(el) => {
              panelRefs.current[i] = el;
            }}
          >
            {page}
          </div>
        ))}
      </div>
    </div>
  );
}
