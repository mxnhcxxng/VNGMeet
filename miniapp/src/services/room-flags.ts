// Phòng họp đặt tên theo thành phố / trường ĐH trên thế giới. Map tên → cờ quốc
// gia (client-side, không cần cột DB). Khớp bản web (frontend/lib/roomFlags.ts).
// Tên không có trong map (vd "FA Meeting") thì không hiện cờ.
const ROOM_FLAGS: Record<string, string> = {
  amsterdam: "🇳🇱",
  athens: "🇬🇷",
  barcelona: "🇪🇸",
  beijing: "🇨🇳",
  berlin: "🇩🇪",
  cornell: "🇺🇸",
  dubai: "🇦🇪",
  helsinki: "🇫🇮",
  jakarta: "🇮🇩",
  lyon: "🇫🇷",
  madrid: "🇪🇸",
  manchester: "🇬🇧",
  nairobi: "🇰🇪",
  nottingham: "🇬🇧",
  oslo: "🇳🇴",
  paris: "🇫🇷",
  rome: "🇮🇹",
  "san francisco": "🇺🇸",
  "sao paulo": "🇧🇷",
  seattle: "🇺🇸",
  seoul: "🇰🇷",
  shanghai: "🇨🇳",
  shenzhen: "🇨🇳",
  "silicon valley": "🇺🇸",
  singapore: "🇸🇬",
  sydney: "🇦🇺",
  taipei: "🇹🇼",
  "tel aviv": "🇮🇱",
  tokyo: "🇯🇵",
  venice: "🇮🇹",
  yale: "🇺🇸",
  yangoon: "🇲🇲",
  zurich: "🇨🇭",
};

/** Cờ emoji theo tên phòng, hoặc null nếu không map được. */
export function roomFlag(name?: string | null): string | null {
  if (!name) return null;
  return ROOM_FLAGS[name.trim().toLowerCase()] ?? null;
}
