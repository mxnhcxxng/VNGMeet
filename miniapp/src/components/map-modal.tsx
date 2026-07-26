import type * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import ChevronLeft from "@gravity-ui/icons/ChevronLeft";

import { useT } from "@/services/settings";

// Modal xem ảnh map toàn màn hình: pinch/double-tap để phóng to - thu nhỏ,
// kéo để pan khi đang zoom, vuốt xuống (khi ở 1x) hoặc bấm X để đóng.
type Props = {
  src: string;
  onClose: () => void;
};

const MAX_SCALE = 4;
const MIN_SCALE = 1;
const DOUBLE_TAP_SCALE = 2.5;
const CLOSE_DRAG_THRESHOLD = 120; // px kéo xuống để đóng

function distance(t1: React.Touch, t2: React.Touch): number {
  const dx = t1.clientX - t2.clientX;
  const dy = t1.clientY - t2.clientY;
  return Math.hypot(dx, dy);
}

export default function MapModal({ src, onClose }: Props) {
  const t = useT();
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  // dragY: độ dời khi vuốt-xuống-để-đóng (chỉ ở 1x). closing: bật animation tắt.
  const [dragY, setDragY] = useState(0);
  const [closing, setClosing] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Trạng thái cử chỉ (ref để không re-render mỗi lần chạm).
  const gesture = useRef({
    mode: "none" as "none" | "pan" | "pinch" | "swipe",
    startX: 0,
    startY: 0,
    startTx: 0,
    startTy: 0,
    startDist: 0,
    startScale: 1,
    lastTap: 0,
    transition: false,
  });

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const close = useCallback(() => {
    setClosing(true);
    // đợi animation fade/slide rồi mới gỡ khỏi cây DOM
    window.setTimeout(onClose, 220);
  }, [onClose]);

  const clampPan = useCallback((nextScale: number, x: number, y: number) => {
    // Giới hạn pan để ảnh không kéo ra khỏi khung quá xa (ước lượng theo viewport).
    const maxX = (window.innerWidth * (nextScale - 1)) / 2;
    const maxY = (window.innerHeight * (nextScale - 1)) / 2;
    return {
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    };
  }, []);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const g = gesture.current;
      g.transition = false;
      if (e.touches.length === 2) {
        g.mode = "pinch";
        g.startDist = distance(e.touches[0], e.touches[1]);
        g.startScale = scale;
        g.startTx = tx;
        g.startTy = ty;
      } else if (e.touches.length === 1) {
        const t = e.touches[0];
        g.startX = t.clientX;
        g.startY = t.clientY;
        g.startTx = tx;
        g.startTy = ty;
        g.mode = scale > 1 ? "pan" : "swipe";
      }
    },
    [scale, tx, ty],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const g = gesture.current;
      if (g.mode === "pinch" && e.touches.length === 2) {
        const d = distance(e.touches[0], e.touches[1]);
        if (g.startDist > 0) {
          const next = Math.max(
            MIN_SCALE,
            Math.min(MAX_SCALE, (g.startScale * d) / g.startDist),
          );
          setScale(next);
          const p = clampPan(next, g.startTx, g.startTy);
          setTx(p.x);
          setTy(p.y);
        }
      } else if (g.mode === "pan" && e.touches.length === 1) {
        const t = e.touches[0];
        const p = clampPan(
          scale,
          g.startTx + (t.clientX - g.startX),
          g.startTy + (t.clientY - g.startY),
        );
        setTx(p.x);
        setTy(p.y);
      } else if (g.mode === "swipe" && e.touches.length === 1) {
        const t = e.touches[0];
        const dy = t.clientY - g.startY;
        // chỉ nhận kéo xuống
        setDragY(dy > 0 ? dy : 0);
      }
    },
    [scale, clampPan],
  );

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const g = gesture.current;
      if (g.mode === "swipe") {
        if (dragY > CLOSE_DRAG_THRESHOLD) {
          close();
          return;
        }
        g.transition = true;
        setDragY(0);
      }
      // double-tap để toggle zoom (chỉ khi kết thúc bằng 1 chạm)
      if (e.touches.length === 0 && g.mode !== "pinch") {
        const now = Date.now();
        const moved =
          Math.abs((e.changedTouches[0]?.clientX ?? 0) - g.startX) > 10 ||
          Math.abs((e.changedTouches[0]?.clientY ?? 0) - g.startY) > 10;
        if (!moved && now - g.lastTap < 300) {
          g.transition = true;
          if (scale > 1) {
            setScale(1);
            setTx(0);
            setTy(0);
          } else {
            setScale(DOUBLE_TAP_SCALE);
          }
          g.lastTap = 0;
        } else {
          g.lastTap = now;
        }
      }
      if (e.touches.length === 0) g.mode = "none";
    },
    [dragY, scale, close],
  );

  // Zoom bằng con lăn chuột (hỗ trợ test trên desktop/simulator).
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const next = Math.max(
        MIN_SCALE,
        Math.min(MAX_SCALE, scale - e.deltaY * 0.002),
      );
      setScale(next);
      if (next === 1) {
        setTx(0);
        setTy(0);
      }
    },
    [scale],
  );

  const useTransition = gesture.current.transition;
  const opacity = closing ? 0 : mounted ? 1 - Math.min(dragY / 400, 0.6) : 0;

  return (
    <div
      className={`map-modal${closing ? " is-closing" : ""}`}
      style={{ opacity }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onWheel={onWheel}
    >
      <button
        className="map-modal__close"
        type="button"
        aria-label={t("common.back")}
        onClick={close}
      >
        <ChevronLeft width={22} height={22} />
      </button>

      <img
        className="map-modal__img"
        src={src}
        alt={t("detail.mapAlt")}
        draggable={false}
        style={{
          transform: `translate3d(${tx}px, ${ty + dragY}px, 0) scale(${scale})`,
          transition: useTransition
            ? "transform 0.2s ease"
            : closing
              ? "transform 0.2s ease"
              : "none",
        }}
      />
    </div>
  );
}
