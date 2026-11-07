"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Chip, Tabs, Tooltip } from "@heroui/react";
import { Persons } from "@gravity-ui/icons";
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
import { Lightbox } from "./Lightbox";

// Labels are 24px semibold in the design (at 1:1). On screen they follow the
// map's scale but never shrink below ~8px text, so they stay readable.
const LABEL_MIN_SCALE = 0.34;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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
  const hasDirections = Boolean((room?.direction || room?.direction_vi || "").trim());

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
 * The floor drawing + labels, scaled to its box. `fit="width"` (inline) takes
 * the box width and sets its own height; `fit="contain"` (full screen) fits
 * inside the parent and centres.
 */
function MapCanvas({
  floor,
  labels,
  fit,
  activeKey,
  onSelectRoom,
  onOpen,
}: {
  floor: CampusFloor;
  labels: PlacedLabel[];
  fit: "width" | "contain";
  activeKey?: string | null;
  onSelectRoom: (room: DirectoryRoom) => void;
  /** Inline only: clicking the map (not a label) opens the full-screen view. */
  onOpen?: () => void;
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

  const scale =
    fit === "width"
      ? box.width / map.width
      : Math.min(box.width / map.width, box.height / map.height);
  const w = map.width * scale;
  const h = map.height * scale;
  const offsetX = fit === "contain" ? (box.width - w) / 2 : 0;
  const offsetY = fit === "contain" ? (box.height - h) / 2 : 0;
  const labelSize = clamp(scale, LABEL_MIN_SCALE, 1);
  const keyOf = (r: DirectoryRoom) => r.email || r.name;

  return (
    <div
      ref={boxRef}
      className={`relative w-full overflow-hidden ${
        fit === "width" ? "rounded-xl border border-[color:var(--separator)]" : "h-full"
      } bg-white`}
      style={fit === "width" ? { height: h || undefined, aspectRatio: h ? undefined : `${map.width} / ${map.height}` } : undefined}
    >
      {scale > 0 && (
        <>
          {onOpen ? (
            <button
              type="button"
              onClick={onOpen}
              aria-label={t("roomWiki.openMap")}
              title={t("roomWiki.openMap")}
              className="absolute inset-0 cursor-zoom-in"
            />
          ) : null}
          <div
            className="pointer-events-none absolute origin-top-left overflow-hidden"
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
            <Tabs.Tab key={f} id={f}>
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
  const t = useT();
  const [floor, setFloor] = useState<CampusFloor>("F1");
  const [fullscreen, setFullscreen] = useState(false);
  const labels = useMemo(() => placeLabels(floor, rooms), [floor, rooms]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold leading-7 text-[#18181b] dark:text-[#f7f7f7]">
          {t("roomWiki.campusMap")}
        </h2>
        <p className="text-base leading-6 text-[#414651] dark:text-[#cecfd2]">
          {t("roomWiki.campusMapHint")}
        </p>
      </div>

      <FloorTabs floor={floor} onChange={setFloor} />

      <MapCanvas
        floor={floor}
        labels={labels}
        fit="width"
        activeKey={activeKey}
        onSelectRoom={onSelectRoom}
        onOpen={() => setFullscreen(true)}
      />

      <Lightbox
        isOpen={fullscreen}
        onOpenChange={setFullscreen}
        title={t("roomWiki.campusMap")}
      >
        {/* Same floor state as inline, so switching here carries back. */}
        <div className="flex h-full flex-col gap-4 px-4 pb-4">
          <FloorTabs floor={floor} onChange={setFloor} className="w-full max-w-md self-center" />
          <div className="min-h-0 flex-1">
            <MapCanvas
              floor={floor}
              labels={labels}
              fit="contain"
              activeKey={activeKey}
              onSelectRoom={(room) => {
                setFullscreen(false);
                onSelectRoom(room);
              }}
            />
          </div>
        </div>
      </Lightbox>
    </div>
  );
}
