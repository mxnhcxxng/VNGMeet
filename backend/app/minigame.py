"""Room minigames (/minigame), each a 60-second round with its own leaderboard.

- guess:  see a room's photo, type its name.
- recall: type every room name you can remember.
- quiz:   see a room, pick its floor / building / directions from 4 options.

Only rooms with a country flag (room_flags.py) are asked or scored. Each round
is played under a VNG domain (the email username): a normal user always plays
as themselves, an admin types in the domain of whoever is at the keyboard (e.g.
an event booth). Every round is its own leaderboard entry.

Unlisted in the UI — reachable only by link. Scoring happens here, not in the
browser, so the leaderboard can't be farmed by posting a made-up score: the
client never learns an answer until it has answered.

Sessions live in process memory (single uvicorn worker); a restart only drops
games in flight. Finished scores go to `minigame_scores`
(supabase/migrate_minigame_scores.sql).
"""

from __future__ import annotations

import random
import re
import threading
import time
import unicodedata
import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from .app_context import log, settings
from .profiles import _read_user_profile, _request_identity
from .room_flags import room_flag

router = APIRouter()

GameKind = Literal["guess", "recall", "quiz"]

GAME_SECONDS = 60
# Network slack for an answer typed right at 0:00.
_GRACE_SECONDS = 2
_SESSION_TTL_SECONDS = 10 * 60
POINTS_EXACT = 100
POINTS_CLOSE = 50
POINTS_QUIZ = 100
MAX_TYPOS = 2
QUIZ_OPTIONS = 4
LEADERBOARD_SIZE = 10

_sessions: dict[str, dict] = {}
_lock = threading.Lock()


class StartPayload(BaseModel):
    game: GameKind = "guess"
    # Only read for admins; everyone else plays as their own domain.
    domain: str | None = None


class AnswerPayload(BaseModel):
    gameId: str
    answer: str = ""


class FinishPayload(BaseModel):
    gameId: str


def _normalize(value: str) -> str:
    """Case-, accent- and whitespace-insensitive form used for comparison."""
    decomposed = unicodedata.normalize("NFKD", value.replace("đ", "d").replace("Đ", "D"))
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]", "", stripped.lower())


def _distance(a: str, b: str) -> int:
    """Levenshtein edit distance."""
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def score_answer(answer: str, room_name: str) -> tuple[str, int]:
    given, expected = _normalize(answer), _normalize(room_name)
    if not given:
        return "skipped", 0
    if given == expected:
        return "correct", POINTS_EXACT
    if _distance(given, expected) <= MAX_TYPOS:
        return "close", POINTS_CLOSE
    return "wrong", 0


def _load_rooms() -> list[dict]:
    """Every room once per distinct name; a name shared across offices is one
    room to the player. Prefers the row that has a photo / directions."""
    from .supabase_client import get_supabase

    rows = (
        get_supabase()
        .table("meeting_room_metadata")
        .select("name, building, floor, zone, capacity, office, thumbnail_link, direction")
        .execute()
        .data
        or []
    )
    by_name: dict[str, dict] = {}
    for r in rows:
        name = (r.get("name") or "").strip()
        key = _normalize(name)
        if not key or not room_flag(name):
            continue
        richness = bool(r.get("thumbnail_link")) + bool(r.get("direction"))
        current = by_name.get(key)
        if not current or richness > current["_richness"]:
            by_name[key] = {**r, "name": name, "_key": key, "_richness": richness}
    return list(by_name.values())


def _location(room: dict) -> dict:
    return {
        "image": room.get("thumbnail_link"),
        "office": room.get("office"),
        "building": room.get("building"),
        "floor": room.get("floor"),
        "zone": room.get("zone"),
        "capacity": room.get("capacity"),
    }


# --------------------------------------------------------------------------- #
# guess: photo -> name
# --------------------------------------------------------------------------- #
def _guess_question(session: dict) -> dict:
    room = session["rooms"][session["index"]]
    name = room["name"]
    # "Las Vegas" -> "L _ _   V _ _ _ _": first letter plus the word shape.
    mask = "   ".join(
        " ".join([word[0].upper()] + ["_"] * (len(word) - 1)) for word in name.split()
    )
    return {"index": session["index"], "hint": mask, **_location(room)}


def _guess_setup(rooms: list[dict]) -> list[dict]:
    # A photo is the whole clue; only fall back to photo-less rooms if none have one.
    return [r for r in rooms if r.get("thumbnail_link")] or rooms


def _guess_answer(session: dict, answer: str) -> dict:
    room = session["rooms"][session["index"]]
    result, points = score_answer(answer, room["name"])
    session["index"] += 1
    return {"result": result, "points": points, "roomName": room["name"]}


# --------------------------------------------------------------------------- #
# recall: name as many rooms as you can
# --------------------------------------------------------------------------- #
def _recall_answer(session: dict, answer: str) -> dict:
    given = _normalize(answer)
    if not given:
        return {"result": "skipped", "points": 0}
    found: set[str] = session["found"]
    by_key = {r["_key"]: r for r in session["rooms"]}
    if given in by_key:
        room = by_key[given]
        if given in found:
            return {"result": "duplicate", "points": 0, "roomName": room["name"]}
        found.add(given)
        return {"result": "correct", "points": POINTS_EXACT, "roomName": room["name"]}
    # Typo credit only when exactly one room is the closest match, so a fuzzy
    # guess can't be read as two different rooms.
    scored = sorted((_distance(given, k), k) for k in by_key)
    best = scored[0] if scored else None
    if not best or best[0] > MAX_TYPOS or (len(scored) > 1 and scored[1][0] == best[0]):
        return {"result": "wrong", "points": 0}
    room = by_key[best[1]]
    if best[1] in found:
        return {"result": "duplicate", "points": 0, "roomName": room["name"]}
    found.add(best[1])
    return {"result": "close", "points": POINTS_CLOSE, "roomName": room["name"]}


# --------------------------------------------------------------------------- #
# quiz: room -> pick floor / building / directions
# --------------------------------------------------------------------------- #
def _quiz_value(room: dict, kind: str) -> str | None:
    value = room.get(kind)
    return str(value).strip() if value not in (None, "") else None


def _quiz_build(session: dict) -> dict | None:
    """Next question with 4 shuffled options; None once rooms run out."""
    rooms = session["rooms"]
    while session["index"] < len(rooms):
        room = rooms[session["index"]]
        kinds = [k for k in ("floor", "building", "direction") if _quiz_value(room, k)]
        random.shuffle(kinds)
        for kind in kinds:
            answer = _quiz_value(room, kind)
            pool = {_quiz_value(r, kind) for r in session["all_rooms"]} - {answer, None}
            if not pool:
                continue
            options = random.sample(sorted(pool), min(QUIZ_OPTIONS - 1, len(pool))) + [answer]
            random.shuffle(options)
            session["current"] = {"answer": options.index(answer), "kind": kind}
            return {
                "index": session["index"],
                "kind": kind,
                "roomName": room["name"],
                "options": options,
                **_location(room),
            }
        session["index"] += 1
    return None


def _quiz_answer(session: dict, answer: str) -> dict:
    current = session["current"]
    try:
        picked = int(answer)
    except ValueError:
        picked = -1
    correct = picked == current["answer"]
    session["index"] += 1
    return {
        "result": "correct" if correct else ("skipped" if picked < 0 else "wrong"),
        "points": POINTS_QUIZ if correct else 0,
        "correctIndex": current["answer"],
        "roomName": session["rooms"][session["index"] - 1]["name"],
    }


# --------------------------------------------------------------------------- #
# Session plumbing
# --------------------------------------------------------------------------- #
def _next_question(session: dict) -> dict | None:
    game = session["game"]
    if game == "recall":
        return None
    if game == "quiz":
        return _quiz_build(session)
    if session["index"] >= len(session["rooms"]):
        return None
    return _guess_question(session)


def _prune_locked(now: float) -> None:
    for gid in [g for g, s in _sessions.items() if now - s["started_at"] > _SESSION_TTL_SECONDS]:
        _sessions.pop(gid, None)


def _get_session_locked(email: str | None, game_id: str) -> dict:
    session = _sessions.get(game_id)
    if not session or session["email"] != (email or "").lower():
        raise HTTPException(404, "Game not found")
    return session


def _finish_locked(session: dict) -> None:
    """Persist the score exactly once."""
    if session["finished"]:
        return
    session["finished"] = True
    if not settings.supabase_enabled or not session["email"]:
        return
    try:
        from .supabase_client import get_supabase

        get_supabase().table("minigame_scores").insert(
            {
                "game": session["game"],
                "attempt_id": session["id"],
                "domain": session["domain"],
                "auth_user_id": session["auth_user_id"],
                "email": session["email"],
                "score": session["score"],
                "correct": session["correct"],
                "close": session["close"],
                "attempted": session["attempted"],
            }
        ).execute()
    except Exception as e:  # noqa: BLE001 - a lost score must not break the game
        log.warning("minigame score insert failed: %s", e)


def _summary(session: dict) -> dict:
    return {
        "score": session["score"],
        "correct": session["correct"],
        "close": session["close"],
        "attempted": session["attempted"],
    }


_DOMAIN_RE = re.compile(r"^[a-z0-9._-]{1,64}$")


def _is_admin(email: str | None) -> bool:
    profile = _read_user_profile(None, email) if email else None
    return (profile or {}).get("role") == "admin"


def _resolve_domain(email: str | None, requested: str | None) -> str:
    """The domain this round is scored under."""
    own = (email or "").split("@")[0].lower()
    if not _is_admin(email):
        return own
    # Accept a pasted email too: "cuongdm4@vng.com.vn" -> "cuongdm4".
    domain = (requested or "").strip().lower().split("@")[0]
    if not _DOMAIN_RE.match(domain):
        raise HTTPException(400, "A valid domain is required.")
    return domain


@router.get("/api/minigame/player")
def player(request: Request):
    """Who the next round is played as; admins must type a domain in instead."""
    _, email = _request_identity(request)
    return {
        "isAdmin": _is_admin(email),
        "domain": (email or "").split("@")[0].lower(),
    }


@router.post("/api/minigame/start")
def start_game(request: Request, payload: StartPayload | None = None):
    payload = payload or StartPayload()
    game = payload.game
    auth_user_id, email = _request_identity(request)
    if not settings.supabase_enabled:
        raise HTTPException(503, "Minigame requires Supabase configuration.")
    domain = _resolve_domain(email, payload.domain)
    all_rooms = _load_rooms()
    rooms = _guess_setup(all_rooms) if game == "guess" else list(all_rooms)
    if not rooms:
        raise HTTPException(503, "No rooms available.")
    random.shuffle(rooms)
    now = time.time()
    game_id = uuid.uuid4().hex
    session = {
        "id": game_id,
        "domain": domain,
        "game": game,
        "auth_user_id": auth_user_id,
        "email": (email or "").lower(),
        "rooms": rooms,
        "all_rooms": all_rooms,
        "found": set(),
        "current": None,
        "index": 0,
        "score": 0,
        "correct": 0,
        "close": 0,
        "attempted": 0,
        "started_at": now,
        "ends_at": now + GAME_SECONDS,
        "finished": False,
    }
    question = _next_question(session)
    if game != "recall" and question is None:
        raise HTTPException(503, "Not enough room data for this game.")
    with _lock:
        _prune_locked(now)
        _sessions[game_id] = session
    return {
        "gameId": game_id,
        "game": game,
        "domain": domain,
        "durationSeconds": GAME_SECONDS,
        "totalRooms": len(rooms),
        "question": question,
    }


@router.post("/api/minigame/answer")
def answer(payload: AnswerPayload, request: Request):
    _, email = _request_identity(request)
    with _lock:
        session = _get_session_locked(email, payload.gameId)
        if session["finished"] or time.time() > session["ends_at"] + _GRACE_SECONDS:
            _finish_locked(session)
            return {"finished": True, "timeUp": True, **_summary(session)}

        game = session["game"]
        if game == "recall":
            outcome = _recall_answer(session, payload.answer)
        elif game == "quiz":
            outcome = _quiz_answer(session, payload.answer)
        else:
            outcome = _guess_answer(session, payload.answer)

        session["score"] += outcome["points"]
        if outcome["result"] not in ("skipped", "duplicate") or game != "recall":
            session["attempted"] += 1
        if outcome["result"] == "correct":
            session["correct"] += 1
        elif outcome["result"] == "close":
            session["close"] += 1

        question = _next_question(session)
        out_of_rooms = (
            len(session["found"]) >= len(session["rooms"])
            if game == "recall"
            else question is None
        )
        if out_of_rooms:
            _finish_locked(session)
        return {
            **outcome,
            "finished": out_of_rooms,
            "question": question,
            "found": len(session["found"]),
            "totalRooms": len(session["rooms"]),
            **_summary(session),
        }


@router.post("/api/minigame/finish")
def finish(payload: FinishPayload, request: Request):
    _, email = _request_identity(request)
    with _lock:
        session = _get_session_locked(email, payload.gameId)
        _finish_locked(session)
        result = {"finished": True, **_summary(session)}
        if session["game"] == "recall":
            # The rooms they didn't think of — the fun part of the reveal.
            result["missed"] = sorted(
                r["name"] for r in session["rooms"] if r["_key"] not in session["found"]
            )
        return result


@router.get("/api/minigame/leaderboard")
def leaderboard(
    request: Request,
    game: GameKind = Query("guess"),
    attempt: str | None = Query(None),
):
    """Top rounds for a game — every round is its own row, so one player can
    hold several places. `attempt` (a gameId) is highlighted and ranked even
    when it falls outside the top."""
    _request_identity(request)
    if not settings.supabase_enabled:
        return {"entries": [], "me": None}
    from .supabase_client import get_supabase

    rows = (
        get_supabase()
        .table("minigame_scores")
        .select("attempt_id, domain, email, score, correct, close, created_at")
        .eq("game", game)
        .order("score", desc=True)
        .order("created_at")
        .limit(5000)
        .execute()
        .data
        or []
    )
    ranked = [
        {
            "rank": i,
            "name": r.get("domain") or (r.get("email") or "").split("@")[0],
            "score": r["score"],
            "correct": r.get("correct") or 0,
            "close": r.get("close") or 0,
            "isMe": bool(attempt) and r.get("attempt_id") == attempt,
        }
        for i, r in enumerate(rows, 1)
    ]
    me = next((e for e in ranked if e["isMe"]), None)
    return {"entries": ranked[:LEADERBOARD_SIZE], "me": me}
