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
    "cornell": "🇺🇸",
    "dubai": "🇦🇪",
    "durham": "🇬🇧",
    "hangzhou": "🇨🇳",
    "harvard": "🇺🇸",
    "helsinki": "🇫🇮",
    "jakarta": "🇮🇩",
    "las vegas": "🇺🇸",
    "lyon": "🇫🇷",
    "madrid": "🇪🇸",
    "manchester": "🇬🇧",
    "manila": "🇵🇭",
    "nairobi": "🇰🇪",
    "nottingham": "🇬🇧",
    "oslo": "🇳🇴",
    "paris": "🇫🇷",
    "rome": "🇮🇹",
    "san francisco": "🇺🇸",
    "sao paulo": "🇧🇷",
    "seattle": "🇺🇸",
    "seoul": "🇰🇷",
    "shanghai": "🇨🇳",
    "shenzhen": "🇨🇳",
    "silicon valley": "🇺🇸",
    "singapore": "🇸🇬",
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
