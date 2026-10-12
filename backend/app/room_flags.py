"""Room-name -> country flag, mirrored from frontend/lib/roomFlags.ts.

Keep the two in sync when rooms are added. The minigames only quiz rooms that
have a flag here (backend/app/minigame.py).
"""

ROOM_FLAGS: dict[str, str] = {
    "amsterdam": "🇳🇱",
    "athens": "🇬🇷",
    "bangalore": "🇮🇳",
    "barcelona": "🇪🇸",
    "beijing": "🇨🇳",
    "berlin": "🇩🇪",
    "cambridge": "🇬🇧",
    "cornell": "🇺🇸",
    "da nang": "🇻🇳",
    "dubai": "🇦🇪",
    "durham": "🇬🇧",
    "ha noi": "🇻🇳",
    "hangzhou": "🇨🇳",
    "harvard": "🇺🇸",
    "helsinki": "🇫🇮",
    "jakarta": "🇮🇩",
    "las vegas": "🇺🇸",
    "liverpool": "🇬🇧",
    "lyon": "🇫🇷",
    "madrid": "🇪🇸",
    "manchester": "🇬🇧",
    "manila": "🇵🇭",
    "mumbai": "🇮🇳",
    "nairobi": "🇰🇪",
    "nottingham": "🇬🇧",
    "oslo": "🇳🇴",
    "oxford": "🇬🇧",
    "paris": "🇫🇷",
    "rome": "🇮🇹",
    "sai gon": "🇻🇳",
    "san francisco": "🇺🇸",
    "sao paulo": "🇧🇷",
    "seattle": "🇺🇸",
    "seoul": "🇰🇷",
    "shanghai": "🇨🇳",
    "shenzhen": "🇨🇳",
    "silicon valley": "🇺🇸",
    "singapore": "🇸🇬",
    "stanford": "🇺🇸",
    "stockholm": "🇸🇪",
    "sydney": "🇦🇺",
    "taipei": "🇹🇼",
    "tel aviv": "🇮🇱",
    "tokyo": "🇯🇵",
    "toronto": "🇨🇦",
    "vancouver": "🇨🇦",
    "venice": "🇮🇹",
    "yale": "🇺🇸",
    "yangoon": "🇲🇲",
    "zurich": "🇨🇭",
}


def room_flag(name: str | None) -> str | None:
    if not name:
        return None
    return ROOM_FLAGS.get(name.strip().lower())
