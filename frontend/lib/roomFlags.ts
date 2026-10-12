// Meeting rooms are named after world cities / universities. We map each name
// to its country's flag emoji here — client-side, so no database column is
// needed. Keyed by the lowercased room name; unknown names (e.g. "FA Meeting")
// simply get no flag. Extend this map when new rooms are added — and mirror it
// in backend/app/room_flags.py, which limits the minigames to flagged rooms.
const ROOM_FLAGS: Record<string, string> = {
  amsterdam: "🇳🇱",
  athens: "🇬🇷",
  bangalore: "🇮🇳",
  barcelona: "🇪🇸",
  beijing: "🇨🇳",
  berlin: "🇩🇪",
  cambridge: "🇬🇧",
  cornell: "🇺🇸",
  "da nang": "🇻🇳",
  dubai: "🇦🇪",
  durham: "🇬🇧",
  "ha noi": "🇻🇳",
  hangzhou: "🇨🇳",
  harvard: "🇺🇸",
  helsinki: "🇫🇮",
  jakarta: "🇮🇩",
  "las vegas": "🇺🇸",
  liverpool: "🇬🇧",
  lyon: "🇫🇷",
  madrid: "🇪🇸",
  manchester: "🇬🇧",
  manila: "🇵🇭",
  mumbai: "🇮🇳",
  nairobi: "🇰🇪",
  nottingham: "🇬🇧",
  oslo: "🇳🇴",
  oxford: "🇬🇧",
  paris: "🇫🇷",
  rome: "🇮🇹",
  "sai gon": "🇻🇳",
  "san francisco": "🇺🇸",
  "sao paulo": "🇧🇷",
  seattle: "🇺🇸",
  seoul: "🇰🇷",
  shanghai: "🇨🇳",
  shenzhen: "🇨🇳",
  "silicon valley": "🇺🇸",
  singapore: "🇸🇬",
  stanford: "🇺🇸",
  stockholm: "🇸🇪",
  sydney: "🇦🇺",
  taipei: "🇹🇼",
  "tel aviv": "🇮🇱",
  tokyo: "🇯🇵",
  toronto: "🇨🇦",
  vancouver: "🇨🇦",
  venice: "🇮🇹",
  yale: "🇺🇸",
  yangoon: "🇲🇲",
  zurich: "🇨🇭",
};

/** Flag emoji for a room name, or null when the room has no mapped country. */
export function roomFlag(name?: string | null): string | null {
  if (!name) return null;
  return ROOM_FLAGS[name.trim().toLowerCase()] ?? null;
}
