import { Children, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

// Bộ "trang trượt ngang" đổi tab bằng cách vuốt: nội dung bám theo ngón tay
// realtime (kéo tới đâu trượt tới đó), thả ra thì:
//   - vượt ngưỡng  -> chốt sang tab kế bên.
//   - chưa đủ ngưỡng -> bật đàn hồi về tab hiện tại.
// Khoá hướng CHẶT (mỗi cử chỉ chỉ 1 trục): khi đã khoá ngang, chặn luôn cuộn
// dọc của trang (preventDefault) → không bao giờ trôi chéo. Khi khoá dọc thì
// không đụng track, để trang cuộn dọc bình thường.
// touchmove phải là listener non-passive mới preventDefault được nên gắn tay
// qua addEventListener thay vì prop React (React để passive).
const DIR_LOCK_PX = 8; // di chuyển quá 8px mới khoá hướng
const COMMIT_RATIO = 0.22; // kéo qua 22% bề ngang thì đổi tab
const COMMIT_MIN_PX = 48; // hoặc tối thiểu 48px (cho màn hẹp)
const SETTLE_MS = 300; // thời lượng animation trượt nốt / bật về
const GAP = 16; // khe hở giữa các trang khi trượt (px)
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
  const first = useRef(true);

  const [height, setHeight] = useState<number | undefined>(undefined);

  // Giá trị mới nhất cho handler native (gắn 1 lần) đọc mà không cần rebind.
  const idxRef = useRef(index);
  idxRef.current = index;
  const cntRef = useRef(count);
  cntRef.current = count;
  const onChangeRef = useRef(onIndexChange);
  onChangeRef.current = onIndexChange;
  const autoRef = useRef(autoHeight);
  autoRef.current = autoHeight;

  // Đặt track về đúng trang `index` (không kéo). Layout-effect + cờ first để lần
  // mount đầu không animation (tránh giật khi tab mặc định != 0).
  useLayoutEffect(() => {
    const track = trackRef.current;
    const vp = viewportRef.current;
    if (!track || !vp) return;
    // Bước dịch = bề ngang 1 trang + khe hở GAP (translate theo px để cộng GAP).
    const apply = (animate: boolean) => {
      const step = vp.offsetWidth + GAP;
      track.style.transition = animate ? `transform ${SETTLE_MS}ms ${EASE}` : "none";
      track.style.transform = `translate3d(${-index * step}px, 0, 0)`;
    };
    apply(!first.current);
    first.current = false;
    // Xoay màn / đổi bề ngang → đặt lại vị trí (không animation).
    const onResize = () => apply(false);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
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

  // Xử lý chạm bằng listener native (touchmove non-passive để preventDefault).
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;

    let startX = 0;
    let startY = 0;
    let dir: "none" | "h" | "v" = "none";
    let dx = 0;
    let width = 0;

    function onStart(e: TouchEvent) {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      dir = "none";
      dx = 0;
      width = vp!.offsetWidth || window.innerWidth;
    }

    function onMove(e: TouchEvent) {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const moveX = t.clientX - startX;
      const moveY = t.clientY - startY;
      const idx = idxRef.current;
      const cnt = cntRef.current;

      if (dir === "none") {
        if (Math.abs(moveX) > DIR_LOCK_PX || Math.abs(moveY) > DIR_LOCK_PX) {
          dir = Math.abs(moveX) > Math.abs(moveY) ? "h" : "v";
          if (dir === "h") {
            if (trackRef.current) trackRef.current.style.transition = "none";
            if (autoRef.current) {
              const neighbor = panelRefs.current[moveX < 0 ? idx + 1 : idx - 1];
              const cur = panelRefs.current[idx];
              const h = Math.max(cur?.offsetHeight || 0, neighbor?.offsetHeight || 0);
              if (h) setHeight(h);
            }
          }
        }
      }

      if (dir !== "h") return;
      // Đã khoá ngang → chặn cuộn dọc của trang để chỉ trôi theo 1 trục.
      if (e.cancelable) e.preventDefault();

      let d = moveX;
      if ((idx === 0 && d > 0) || (idx === cnt - 1 && d < 0)) d = d / 3;
      dx = d;
      const px = -idx * (width + GAP) + d;
      if (trackRef.current) {
        trackRef.current.style.transform = `translate3d(${px}px, 0, 0)`;
      }
    }

    function onEnd() {
      if (dir !== "h") {
        dir = "none";
        return;
      }
      const idx = idxRef.current;
      const cnt = cntRef.current;
      const w = width || 1;
      const threshold = Math.max(COMMIT_MIN_PX, w * COMMIT_RATIO);

      let target = idx;
      if (dx <= -threshold && idx < cnt - 1) target = idx + 1;
      else if (dx >= threshold && idx > 0) target = idx - 1;

      const track = trackRef.current;
      if (track) {
        track.style.transition = `transform ${SETTLE_MS}ms ${EASE}`;
        track.style.transform = `translate3d(${-target * (w + GAP)}px, 0, 0)`;
      }

      dir = "none";
      dx = 0;

      if (target !== idx) {
        onChangeRef.current(target);
      } else if (autoRef.current) {
        const el = panelRefs.current[idx];
        if (el) setHeight(el.offsetHeight);
      }
    }

    vp.addEventListener("touchstart", onStart, { passive: true });
    vp.addEventListener("touchmove", onMove, { passive: false });
    vp.addEventListener("touchend", onEnd, { passive: true });
    vp.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      vp.removeEventListener("touchstart", onStart);
      vp.removeEventListener("touchmove", onMove);
      vp.removeEventListener("touchend", onEnd);
      vp.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  return (
    <div
      ref={viewportRef}
      className={`swipe-views${className ? ` ${className}` : ""}`}
      style={autoHeight ? { height } : undefined}
    >
      <div
        className="swipe-views__track"
        ref={trackRef}
        style={{ gap: `${GAP}px` }}
      >
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
