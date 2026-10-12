// Phòng họp đặt tên theo thành phố / trường ĐH trên thế giới. Map tên → cờ quốc
// gia (client-side, không cần cột DB). Khớp bản web (frontend/lib/roomFlags.ts).
// Tên không có trong map (vd "FA Meeting") thì không hiện cờ.
const ROOM_FLAGS: Record<string, string> = {
  amsterdam: "🇳🇱",
  athens: "🇬🇷",
  bangalore: "🇮🇳",
  barcelona: "🇪🇸",
  beijing: "🇨🇳",
  berlin: "🇩🇪",
  cornell: "🇺🇸",
  dubai: "🇦🇪",
  durham: "🇬🇧",
  hangzhou: "🇨🇳",
  harvard: "🇺🇸",
  helsinki: "🇫🇮",
  jakarta: "🇮🇩",
  "las vegas": "🇺🇸",
  lyon: "🇫🇷",
  madrid: "🇪🇸",
  manchester: "🇬🇧",
  manila: "🇵🇭",
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

/** Cờ emoji theo tên phòng, hoặc null nếu không map được. */
export function roomFlag(name?: string | null): string | null {
  if (!name) return null;
  return ROOM_FLAGS[name.trim().toLowerCase()] ?? null;
}
