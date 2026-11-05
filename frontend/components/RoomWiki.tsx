"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Chip, Spinner } from "@heroui/react";
import { ChevronLeft, Persons } from "@gravity-ui/icons";
import { api, type DirectoryRoom, type UserProfileOption } from "@/lib/api";
import { roomFlag } from "@/lib/roomFlags";
import { useLanguage, useT } from "@/app/providers";
import { CAPACITY_RANGE } from "./BookingModal";

// Room Wiki only documents Campus rooms (the menu entry is gated to Campus users).
const WIKI_OFFICE = "campus";

// Directory is effectively static for a session: keep it module-level so going
// back to the tab renders instantly, then revalidate in the background.
let directoryCache: DirectoryRoom[] | null = null;

function groupLetter(name: string): string {
  const c = (name.trim()[0] ?? "").toUpperCase();
  return /[A-Z]/.test(c) ? c : "#";
}

// Split the free-text directions into paragraphs (one per line in the DB).
function paragraphs(text?: string | null): string[] {
  return (text ?? "")
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function RoomWiki({
  buildingOptions,
}: {
  // Profile building options (value → label, e.g. "V1" → "V1 (VNGGames, Zalo,
  // Greennode)") so the chip shows the same wording as Settings.
  buildingOptions: UserProfileOption[];
}) {
  const t = useT();
  const [rooms, setRooms] = useState<DirectoryRoom[] | null>(directoryCache);
  const [error, setError] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Below `lg` list and detail share the screen: the detail replaces the list.
  const [mobileDetail, setMobileDetail] = useState(false);

  const load = () => {
    setError(false);
    api
      .roomsDirectory()
      .then(({ rooms }) => {
        directoryCache = rooms;
        setRooms(rooms);
      })
      .catch(() => {
        if (!directoryCache) setError(true);
      });
  };
  useEffect(load, []);

  const campusRooms = useMemo(() => {
    // meeting_room_metadata has some duplicated wiki-only rows (same name, no
    // email) — keep one per name/email so the list doesn't repeat.
    const seen = new Set<string>();
    return (rooms ?? [])
      .filter((r) => (r.office ?? "").trim().toLowerCase() === WIKI_OFFICE)
      // Only rooms that actually have directions (text in either language).
      .filter((r) => Boolean((r.direction || r.direction_vi || "").trim()))
      .filter((r) => {
        const k = (r.email || r.name).trim().toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name, "vi"));
  }, [rooms]);

  const groups = useMemo(() => {
    const byLetter = new Map<string, DirectoryRoom[]>();
    for (const r of campusRooms) {
      const letter = groupLetter(r.name);
      byLetter.set(letter, [...(byLetter.get(letter) ?? []), r]);
    }
    return [...byLetter.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [campusRooms]);

  const keyOf = (r: DirectoryRoom) => r.email || r.name;
  const selected =
    campusRooms.find((r) => keyOf(r) === selectedKey) ?? campusRooms[0] ?? null;

  const buildingLabel = (building?: string | null) => {
    const value = (building ?? "").trim();
    if (!value) return "";
    const match = buildingOptions.find(
      (o) =>
        o.value.toLowerCase() === value.toLowerCase() &&
        (!o.parentValue || o.parentValue.toLowerCase() === WIKI_OFFICE),
    );
    return match?.label || value;
  };

  if (!rooms && !error) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner color="accent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-[#71717a]">
        {t("roomWiki.loadFailed")}
        <Button size="sm" variant="secondary" onPress={load}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  if (!campusRooms.length) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[#71717a]">
        {t("roomWiki.empty")}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 p-1">
      {/* Room list, grouped by first letter */}
      <div
        className={`composer-scroll min-h-0 w-full shrink-0 overflow-y-auto px-6 py-5 lg:block lg:w-[351px] ${
          mobileDetail ? "hidden" : "block"
        }`}
      >
        {/* Per Figma: each group = letter row (16px semibold, muted) + divider
            + pill buttons (h-10, gap 4px); group internals spaced 8px apart. */}
        <div className="flex flex-col gap-6">
          {groups.map(([letter, items]) => (
            <section key={letter} className="flex flex-col gap-2">
              <div className="flex h-6 items-center px-4 text-base font-semibold leading-6 text-[#717680] dark:text-[#94979c]">
                {letter}
              </div>
              <div className="h-px w-full bg-[#e4e4e7] dark:bg-[#373a41]" />
              <div className="flex flex-col gap-1">
                {items.map((room) => {
                  const active = selected && keyOf(selected) === keyOf(room);
                  const flag = roomFlag(room.name);
                  return (
                    <button
                      key={keyOf(room)}
                      type="button"
                      onClick={() => {
                        setSelectedKey(keyOf(room));
                        setMobileDetail(true);
                      }}
                      aria-current={active ? "true" : undefined}
                      // Same pill row as the sidebar nav (Sidebar.tsx ROW): h-10,
                      // rounded-full, grey hover, --default (#ebebec) when selected.
                      className={`flex h-10 w-full shrink-0 items-center gap-2 rounded-full px-4 text-left text-base font-medium leading-6 text-[#18181b] transition-colors dark:text-[#f7f7f7] ${
                        active
                          ? "bg-[var(--default)]"
                          : "hover:bg-[#f5f5f5] dark:hover:bg-[#22262f]"
                      }`}
                    >
                      <span className="truncate">
                        {flag && <span className="mr-1.5">{flag}</span>}
                        {room.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>

      <div className="my-5 hidden w-px shrink-0 bg-[color:var(--separator)] lg:block" />

      {/* Room detail */}
      <div
        className={`composer-scroll min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-8 lg:block ${
          mobileDetail ? "block" : "hidden"
        }`}
      >
        {selected ? (
          <RoomDetail
            room={selected}
            building={buildingLabel(selected.building)}
            onBack={() => setMobileDetail(false)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[#71717a]">
            {t("roomWiki.selectRoom")}
          </div>
        )}
      </div>
    </div>
  );
}

function RoomDetail({
  room,
  building,
  onBack,
}: {
  room: DirectoryRoom;
  building: string;
  onBack: () => void;
}) {
  const t = useT();
  const { language } = useLanguage();
  const flag = roomFlag(room.name);
  // DB stores floors as "F1"/"F3"; the chip reads "Floor 1" like the design.
  const floor = (room.floor ?? "").trim().replace(/^f(?=\d)/i, "");
  // Directions follow the UI language; fall back to the other one if missing.
  const steps = paragraphs(
    language === "vi"
      ? room.direction_vi || room.direction
      : room.direction || room.direction_vi,
  );

  return (
    <div className="flex flex-col gap-6 sm:gap-10">
      <button
        type="button"
        onClick={onBack}
        className="-mb-2 flex items-center gap-1 self-start text-sm font-medium text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f7f7f7] lg:hidden"
      >
        <ChevronLeft width={16} height={16} />
        {t("roomWiki.back")}
      </button>

      {/* Cover: thumbnail + gradient + name, email and metadata chips */}
      <div className="relative h-[200px] w-full shrink-0 overflow-hidden rounded-lg bg-default-100">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={room.image || "/default-room-thumbnail.png"}
          alt={room.name}
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/60 via-45% to-black/90" />
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 p-6 text-white">
          <div>
            <p className="text-2xl font-bold leading-8">
              {flag && <span className="mr-2">{flag}</span>}
              {room.name}
            </p>
            {room.email && (
              <p className="truncate text-sm font-medium leading-5">{room.email}</p>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {room.capacity_size && (
              <Chip size="md" color="accent" variant="primary" className="backdrop-blur-sm">
                <span className="inline-flex items-center gap-1">
                  <Persons width={14} height={14} />
                  {CAPACITY_RANGE[room.capacity_size]}
                </span>
              </Chip>
            )}
            {floor && (
              <Chip size="md" color="accent" variant="secondary" className="backdrop-blur-sm">
                {t("booking.floor", { floor })}
              </Chip>
            )}
            {building && (
              <Chip size="md" color="accent" variant="secondary" className="backdrop-blur-sm">
                {building}
              </Chip>
            )}
          </div>
        </div>
      </div>

      {/* Directions: map image + text */}
      <div className="flex flex-col gap-6">
        <h2 className="text-xl font-semibold leading-7 text-[#18181b] dark:text-[#f7f7f7]">
          {t("roomWiki.directionsTitle")}
        </h2>
        {room.map && (
          <a
            href={room.map}
            target="_blank"
            rel="noreferrer"
            aria-label={t("roomWiki.openMap")}
            title={t("roomWiki.openMap")}
            className="block overflow-hidden rounded-xl"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={room.map} alt={room.name} className="w-full object-cover" />
          </a>
        )}
        {steps.length ? (
          <div className="flex flex-col gap-4 text-base font-normal leading-6 text-[#414651] dark:text-[#cecfd2]">
            {steps.map((step, i) => (
              <p key={i} className="whitespace-pre-line">
                {step}
              </p>
            ))}
          </div>
        ) : (
          <p className="text-base leading-6 text-[#71717a]">{t("roomWiki.noDirections")}</p>
        )}
      </div>
    </div>
  );
}
