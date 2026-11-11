"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, ButtonGroup, Chip, Tabs, Tooltip } from "@heroui/react";
import { ArrowsRotateLeft, Minus, Persons, Plus } from "@gravity-ui/icons";
import type { DirectoryRoom } from "@/lib/api";
import {
  CAMPUS_FLOORS,
  FLOOR_MAPS,
  placeLabels,
  type CampusFloor,
  type PlacedLabel,
} from "@/lib/campusMap";
import { roomFlag } from "@/lib/roomFlags";
import { useT } from "@/app/providers";
import { CAPACITY_RANGE } from "./BookingModal";

// Labels are 24px semibold in the design (at 1:1). On screen they follow the
// map's scale but never shrink below ~8px text, so they stay readable.
const LABEL_MIN_SCALE = 0.34;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
// Zoom range on top of the fit-to-box scale.
const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

/** Always-visible room label; hovering it drops the room info down (HeroUI Tooltip). */
function RoomLabel({
  label,
  left,
  top,
  size,
  active,
  onSelect,
}: {
  label: PlacedLabel;
  left: number;
  top: number;
  size: number;
  active: boolean;
  onSelect: (room: DirectoryRoom) => void;
}) {
  const t = useT();
  const room = label.room;
  const flag = roomFlag(label.name);
  const floor = (room?.floor ?? "").trim().replace(/^f(?=\d)/i, "");
  // Same rule as the room list: a room has a page when it has a route map.
  const hasDirections = Boolean((room?.map || "").trim());

  return (
    <Tooltip delay={0} closeDelay={0}>
      <Tooltip.Trigger
        aria-label={label.name}
        onClick={() => room && hasDirections && onSelect(room)}
        style={{
          left,
          top,
          padding: `${10 * size}px`,
          fontSize: 24 * size,
          lineHeight: `${32 * size}px`,
          borderWidth: 2,
        }}
        // Per Figma: white chip, black semibold text; the hovered/selected one
        // gets the blue (#5caaff) outline.
        className={`absolute z-[1] flex -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center whitespace-nowrap rounded-[4px] border-solid bg-white font-semibold text-black outline-none transition-colors hover:z-[2] hover:border-[#5caaff] focus-visible:border-[#5caaff] ${
          active ? "z-[2] border-[#5caaff]" : "border-transparent"
        }`}
      >
        {flag && <span className="mr-[0.3em]">{flag}</span>}
        {label.name}
      </Tooltip.Trigger>
      <Tooltip.Content showArrow placement="bottom">
        <Tooltip.Arrow />
        <div className="flex min-w-[160px] flex-col gap-2 py-1">
          <span className="text-sm font-semibold leading-5">
            {flag && <span className="mr-1">{flag}</span>}
            {label.name}
          </span>
          {room ? (
            <div className="flex flex-wrap gap-1">
              {room.capacity_size && (
                <Chip size="sm" color="accent" variant="primary">
                  <span className="inline-flex items-center gap-1">
                    <Persons width={12} height={12} />
                    {CAPACITY_RANGE[room.capacity_size]}
                  </span>
                </Chip>
              )}
              {floor && (
                <Chip size="sm" color="accent" variant="secondary">
                  {t("booking.floor", { floor })}
                </Chip>
              )}
              {room.building && (
                <Chip size="sm" color="accent" variant="secondary">
                  {room.building}
                </Chip>
              )}
            </div>
          ) : (
            <span className="text-xs text-[#a1a1aa]">{t("roomWiki.mapNoSize")}</span>
          )}
          {hasDirections && (
            <span className="text-xs text-[#a1a1aa]">{t("roomWiki.mapClickHint")}</span>
          )}
        </div>
      </Tooltip.Content>
    </Tooltip>
  );
}

/**
 * The floor drawing + labels, fitted inside its box (centred), with wheel /
 * pinch zoom, drag to pan and the zoom buttons (bottom right).
 */
function MapCanvas({
  floor,
  labels,
  activeKey,
  onSelectRoom,
}: {
  floor: CampusFloor;
  labels: PlacedLabel[];
  activeKey?: string | null;
  onSelectRoom: (room: DirectoryRoom) => void;
}) {
  const t = useT();
  const map = FLOOR_MAPS[floor];
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const update = () => {
      const { width, height } = el.getBoundingClientRect();
      setBox({ width, height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Leave a margin around the map at the fit-to-box zoom (Figma: ~30px).
  const fitScale = Math.max(
    0,
    Math.min((box.width - 48) / map.width, (box.height - 128) / map.height),
  );

  // Zoom (× fitScale) and the map's top-left in box px. One state
  // object so zooming around a point updates both together; a ref mirrors it
  // for the event handlers.
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;

  // Clamp zoom; keep the map covering the box when bigger, centred when smaller.
  const settle = useCallback(
    (v: { zoom: number; x: number; y: number }) => {
      const zoom = clamp(v.zoom, MIN_ZOOM, MAX_ZOOM);
      const s = fitScale * zoom;
      const bound = (p: number, size: number, boxSize: number) =>
        size <= boxSize ? (boxSize - size) / 2 : clamp(p, boxSize - size, 0);
      return {
        zoom,
        x: bound(v.x, map.width * s, box.width),
        y: bound(v.y, map.height * s, box.height),
      };
    },
    [fitScale, map.width, map.height, box.width, box.height],
  );

  const reset = useCallback(() => setView(settle({ zoom: 1, x: 0, y: 0 })), [settle]);
  // Re-centre whenever the box or the floor changes.
  useEffect(() => {
    reset();
  }, [reset, floor]);

  // Zoom keeping the point (px, py) — box coords — still.
  const zoomAt = useCallback(
    (next: number, px: number, py: number) => {
      const v = viewRef.current;
      const k = clamp(next, MIN_ZOOM, MAX_ZOOM) / v.zoom;
      setView(settle({ zoom: v.zoom * k, x: px - (px - v.x) * k, y: py - (py - v.y) * k }));
    },
    [settle],
  );
  const zoomBy = (factor: number) =>
    zoomAt(viewRef.current.zoom * factor, box.width / 2, box.height / 2);

  // Wheel / trackpad zoom (non-passive so the page doesn't scroll).
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(viewRef.current.zoom * Math.exp(-e.deltaY * 0.002), e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // Drag to pan, pinch to zoom. A real drag swallows the click that follows so
  // releasing over a label doesn't open that room.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; pinchDist?: number; pinchZoom?: number }>({ moved: false });
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) gesture.current = { moved: false };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      gesture.current.pinchZoom = viewRef.current.zoom;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    const el = boxRef.current;
    if (!prev || !el) return;
    const cur = { x: e.clientX, y: e.clientY };

    if (pointers.current.size >= 2 && gesture.current.pinchDist) {
      pointers.current.set(e.pointerId, cur);
      const [a, b] = [...pointers.current.values()];
      const rect = el.getBoundingClientRect();
      gesture.current.moved = true;
      zoomAt(
        (gesture.current.pinchZoom ?? 1) * (Math.hypot(a.x - b.x, a.y - b.y) / gesture.current.pinchDist),
        (a.x + b.x) / 2 - rect.left,
        (a.y + b.y) / 2 - rect.top,
      );
      return;
    }

    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    if (!gesture.current.moved && Math.hypot(dx, dy) < 4) return; // jitter
    pointers.current.set(e.pointerId, cur);
    if (!gesture.current.moved) {
      el.setPointerCapture(e.pointerId);
      setDragging(true);
    }
    gesture.current.moved = true;
    const v = viewRef.current;
    setView(settle({ zoom: v.zoom, x: v.x + dx, y: v.y + dy }));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current.pinchDist = undefined;
    if (!pointers.current.size) setDragging(false);
  };

  const onClickCapture = (e: React.MouseEvent) => {
    if (gesture.current.moved) {
      e.stopPropagation();
      gesture.current.moved = false;
    }
  };

  const scale = fitScale * view.zoom;
  const offsetX = view.x;
  const offsetY = view.y;
  const labelSize = clamp(scale, LABEL_MIN_SCALE, 1);
  const keyOf = (r: DirectoryRoom) => r.email || r.name;

  return (
    <div
      ref={boxRef}
      className="relative h-full w-full touch-none select-none overflow-hidden"
      style={{ cursor: dragging ? "grabbing" : "grab" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClickCapture={onClickCapture}
    >
      {scale > 0 && (
        <>
          <div
            // The drawings have a white ground; multiply lets the panel's grey
            // show through (Figma: map sits on bg-tertiary). Set here, not on
            // the <img>: the transform makes this layer its own blend group.
            className="pointer-events-none absolute origin-top-left overflow-hidden mix-blend-multiply"
            style={{
              left: offsetX,
              top: offsetY,
              width: map.width,
              height: map.height,
              transform: `scale(${scale})`,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={map.image.src}
              alt=""
              draggable={false}
              className="absolute max-w-none"
              style={{
                left: map.image.x,
                top: map.image.y,
                width: map.image.width,
                height: map.image.height,
              }}
            />
            {map.leaders?.map(([x, y1, y2]) => (
              <div
                key={`${x}-${y1}`}
                className="absolute bg-white"
                style={{ left: x - 1, top: y1, width: 2, height: y2 - y1 }}
              />
            ))}
          </div>

          {/* Labels live in screen space so their size can be clamped. */}
          {labels.map((l) => (
            <RoomLabel
              key={`${floor}-${l.id}`}
              label={l}
              left={offsetX + l.cx * scale}
              top={offsetY + l.cy * scale}
              size={labelSize}
              active={Boolean(l.room && activeKey && keyOf(l.room) === activeKey)}
              onSelect={onSelectRoom}
            />
          ))}
        </>
      )}

      {/* Zoom tools, bottom right (Figma "Tool"): HeroUI vertical ButtonGroup. */}
      <ButtonGroup
        orientation="vertical"
        variant="tertiary"
        size="sm"
        className="absolute bottom-4 right-4 z-[3]"
      >
        <Button isIconOnly aria-label={t("roomWiki.zoomIn")} onPress={() => zoomBy(1.5)}>
          <Plus />
        </Button>
        <Button isIconOnly aria-label={t("roomWiki.zoomOut")} onPress={() => zoomBy(1 / 1.5)}>
          <Minus />
        </Button>
        <Button isIconOnly aria-label={t("roomWiki.zoomReset")} onPress={reset}>
          <ArrowsRotateLeft />
        </Button>
      </ButtonGroup>
    </div>
  );
}

/** Floor switcher (HeroUI Tabs), used inline and in the full-screen view. */
function FloorTabs({
  floor,
  onChange,
  className,
}: {
  floor: CampusFloor;
  onChange: (floor: CampusFloor) => void;
  className?: string;
}) {
  const t = useT();
  return (
    <Tabs
      className={className}
      selectedKey={floor}
      onSelectionChange={(k) => onChange(k as CampusFloor)}
    >
      <Tabs.ListContainer>
        <Tabs.List aria-label={t("roomWiki.campusMap")}>
          {CAMPUS_FLOORS.map((f) => (
            <Tabs.Tab key={f} id={f} className="whitespace-nowrap">
              {t("booking.floor", { floor: f.slice(1) })}
              <Tabs.Indicator />
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs>
  );
}

export function CampusMap({
  rooms,
  activeKey,
  onSelectRoom,
}: {
  /** Campus rooms from the directory (used for names, sizes and floors). */
  rooms: DirectoryRoom[];
  /** Key (email || name) of the room highlighted on the map. */
  activeKey?: string | null;
  onSelectRoom: (room: DirectoryRoom) => void;
}) {
  const [floor, setFloor] = useState<CampusFloor>("F1");
  const labels = useMemo(() => placeLabels(floor, rooms), [floor, rooms]);

  // Per Figma 696-19: the map fills a grey (#fafafa) rounded panel; HeroUI floor
  // tabs float top-left, zoom tools bottom-right, both 16px from the edges.
  return (
    <div className="relative min-h-[420px] w-full flex-1 overflow-hidden rounded-lg bg-[#fafafa] dark:bg-[#13161b]">
      <MapCanvas
        floor={floor}
        labels={labels}
        activeKey={activeKey}
        onSelectRoom={onSelectRoom}
      />
      <FloorTabs
        floor={floor}
        onChange={setFloor}
        className="absolute left-4 top-4 z-[3] max-w-[calc(100%-32px)]"
      />
    </div>
  );
}
