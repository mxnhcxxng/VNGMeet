"""Local, login-free server for the /minigame pages — for trying the games out.

    cd backend && ./venv/bin/python dev_minigame.py
    # then: cd frontend && npm run dev  ->  http://localhost:3000/minigame

Serves only the minigame routes (backend/app/minigame.py) on :8000 with:
- no login: every request plays as MINIGAME_DEV_EMAIL (default dev@vng.com.vn),
  as an admin unless MINIGAME_DEV_ROLE=user;
- rooms read live from meeting_room_metadata (read-only) when Supabase is
  configured in ../.env, else a synthetic set built from room_flags.py;
- scores kept in memory, so practice rounds never reach the real leaderboard.

None of the app's background jobs (availability refresh, scheduled bookings)
run here. Never deploy this file.
"""

from __future__ import annotations

import json
import os
import random
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import uvicorn  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

from app import minigame  # noqa: E402
from app.room_flags import ROOM_FLAGS  # noqa: E402

DEV_EMAIL = os.getenv("MINIGAME_DEV_EMAIL", "dev@vng.com.vn").lower()
DEV_ADMIN = os.getenv("MINIGAME_DEV_ROLE", "admin").lower() != "user"
PORT = int(os.getenv("PORT", "8000"))


class _MemoryScores:
    """Just enough of the postgrest builder for minigame.py's two calls."""

    rows: list[dict] = []

    def __init__(self) -> None:
        self._filters: list[tuple[str, object]] = []
        self._order: list[tuple[str, bool]] = []
        self._limit: int | None = None
        self._insert: dict | None = None

    def insert(self, row: dict):
        self._insert = {**row, "created_at": datetime.now(timezone.utc).isoformat()}
        return self

    def select(self, *_):
        return self

    def eq(self, column: str, value: object):
        self._filters.append((column, value))
        return self

    def order(self, column: str, desc: bool = False):
        self._order.append((column, desc))
        return self

    def limit(self, n: int):
        self._limit = n
        return self

    def execute(self):
        if self._insert is not None:
            _MemoryScores.rows.append(self._insert)
            return type("Result", (), {"data": [self._insert]})()
        rows = [r for r in _MemoryScores.rows if all(r.get(k) == v for k, v in self._filters)]
        for column, desc in reversed(self._order):
            rows.sort(key=lambda r: r.get(column) or 0, reverse=desc)
        return type("Result", (), {"data": rows[: self._limit]})()


def _rooms_via_curl() -> list[dict]:
    """Same read through curl, which trusts the macOS keychain — Python's
    bundled CAs reject the corporate proxy certificate on some networks."""
    url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return []
    out = subprocess.run(
        [
            "curl", "-sf", "-m", "20",
            f"{url}/rest/v1/meeting_room_metadata?select=*",
            "-H", f"apikey: {key}",
            "-H", f"Authorization: Bearer {key}",
        ],
        capture_output=True,
        check=True,
    ).stdout
    return json.loads(out)


def _synthetic_rooms() -> list[dict]:
    rng = random.Random(7)
    return [
        {
            "name": name.title(),
            "building": rng.choice(["V1", "V2"]),
            "floor": f"F{rng.randint(1, 3)}",
            "office": "campus",
            "capacity": rng.choice([4, 6, 8, 12]),
            "thumbnail_link": None,
            "direction": f"Go to floor {rng.randint(1, 3)}, turn {rng.choice(['left', 'right'])} "
            f"after the {rng.choice(['pantry', 'lift', 'atrium', 'balcony'])}.",
            "direction_vi": None,
        }
        for name in ROOM_FLAGS
    ]


_original_load_rooms = minigame._load_rooms
_rooms_cache: list[dict] | None = None


def _load_rooms() -> list[dict]:
    """Real rooms when reachable, cached for the session; synthetic otherwise."""
    global _rooms_cache
    if _rooms_cache is None:
        try:
            _rooms_cache = _original_load_rooms()
            print(f"[dev] {len(_rooms_cache)} rooms from Supabase")
        except Exception as e:  # noqa: BLE001
            print(f"[dev] Supabase client failed ({type(e).__name__}); trying curl")
            try:
                raw = _rooms_via_curl()

                class _Rows:
                    def table(self, _):
                        return self

                    def select(self, *_):
                        return self

                    def execute(self):
                        return type("Result", (), {"data": raw})()

                import app.supabase_client as sc

                original = sc.get_supabase
                sc.get_supabase = lambda: _Rows()
                try:
                    _rooms_cache = _original_load_rooms()
                finally:
                    sc.get_supabase = original
                print(f"[dev] {len(_rooms_cache)} rooms via curl")
            except Exception as e2:  # noqa: BLE001
                print(f"[dev] curl failed too ({e2}); using synthetic rooms")
                raw = _synthetic_rooms()
                _rooms_cache = [
                    {**r, "_key": minigame._normalize(r["name"]), "_richness": 0} for r in raw
                ]
    return [dict(r) for r in _rooms_cache]


minigame._request_identity = lambda request: (None, DEV_EMAIL)
minigame._is_admin = lambda email: DEV_ADMIN
minigame._load_rooms = _load_rooms
minigame._scores_table = _MemoryScores
minigame.settings = type("DevSettings", (), {"supabase_enabled": True})()

app = FastAPI(title="VNG Meet minigame (dev)")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(minigame.router)

if __name__ == "__main__":
    print(f"[dev] playing as {DEV_EMAIL} ({'admin' if DEV_ADMIN else 'user'}) on :{PORT}")
    uvicorn.run(app, host="127.0.0.1", port=PORT)
