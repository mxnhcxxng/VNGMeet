"""FastAPI backend: Microsoft login + meeting-room availability grid."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.middleware.sessions import SessionMiddleware

from . import auth, graph
from .config import get_settings

settings = get_settings()
app = FastAPI(title="VNG Meet — Meeting Room Availability")

app.add_middleware(SessionMiddleware, secret_key=settings.session_secret, same_site="lax")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _session_id(request: Request) -> str:
    sid = request.session.get("sid")
    if not sid:
        sid = uuid.uuid4().hex
        request.session["sid"] = sid
    return sid


def _require_token(request: Request) -> str:
    sid = _session_id(request)
    token = auth.get_access_token(sid)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return token


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #
@app.get("/api/auth/login")
def login(request: Request):
    if not settings.client_id or not settings.client_secret:
        raise HTTPException(500, "Server is missing CLIENT_ID / CLIENT_SECRET. Check .env")
    sid = _session_id(request)
    return RedirectResponse(auth.build_auth_url(sid))


@app.get("/api/auth/callback")
def callback(request: Request):
    sid = _session_id(request)
    try:
        auth.complete_login(sid, dict(request.query_params))
    except ValueError as e:
        return RedirectResponse(f"{settings.frontend_url}/?error={e}")
    return RedirectResponse(settings.frontend_url)


@app.post("/api/auth/token")
def set_token(request: Request, access_token: str = Body(..., embed=True)):
    """Test mode: dán trực tiếp một Graph access token (vd lấy từ Graph Explorer).

    Token không tự refresh — hết hạn (~1h) thì dán lại. Dùng tạm trước khi setup OAuth.
    """
    if not access_token or not access_token.strip():
        raise HTTPException(400, "access_token rỗng")
    sid = _session_id(request)
    auth.set_manual_token(sid, access_token)
    return JSONResponse({"ok": True, "username": auth.get_account_name(sid)})


@app.get("/api/auth/me")
def me(request: Request):
    sid = _session_id(request)
    name = auth.get_account_name(sid)
    if not name or not auth.get_access_token(sid):
        return JSONResponse({"authenticated": False})
    return JSONResponse({"authenticated": True, "username": name})


@app.get("/api/auth/scopes")
def scopes(request: Request):
    sid = _session_id(request)
    have = auth.get_token_scopes(sid)
    # findRooms() needs Calendars.Read; getSchedule needs Calendars.Read.Shared.
    # Calendars.Read.Shared is a superset, so either covers listing rooms.
    has_read = any(s in have for s in ("Calendars.Read", "Calendars.Read.Shared", "Calendars.ReadWrite"))
    has_shared = any(s in have for s in ("Calendars.Read.Shared", "Calendars.ReadWrite.Shared"))
    missing = []
    if not has_read:
        missing.append("Calendars.Read (để liệt kê phòng qua findRooms)")
    if not has_shared:
        missing.append("Calendars.Read.Shared (để đọc lịch phòng qua getSchedule)")
    return JSONResponse({"have": have, "missing": missing})


@app.post("/api/auth/logout")
def logout(request: Request):
    sid = _session_id(request)
    auth.logout(sid)
    return JSONResponse({"ok": True})


# --------------------------------------------------------------------------- #
# Rooms & schedule
# --------------------------------------------------------------------------- #
@app.get("/api/rooms")
async def rooms(request: Request):
    token = _require_token(request)
    try:
        return await graph.list_rooms(token)
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, e.response.text)


def _time_labels() -> list[str]:
    labels = []
    cur = settings.business_start_hour * 60
    end = settings.business_end_hour * 60
    while cur < end:
        labels.append(f"{cur // 60:02d}:{cur % 60:02d}")
        cur += settings.slot_minutes
    return labels


@app.get("/api/schedule")
async def schedule(
    request: Request,
    days: int = Query(7, ge=1, le=31),
    emails: str = Query("", description="Comma-separated room emails; empty = all rooms"),
):
    token = _require_token(request)
    tz = ZoneInfo(settings.timezone)

    # Resolve which rooms to query.
    try:
        all_rooms = await graph.list_rooms(token)
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, e.response.text)

    wanted = {e.strip().lower() for e in emails.split(",") if e.strip()}
    rooms_list = [r for r in all_rooms if not wanted or r["email"].lower() in wanted]
    room_emails = [r["email"] for r in rooms_list]

    times = _time_labels()
    today = datetime.now(tz).date()
    day_list = [(today + timedelta(days=i)).isoformat() for i in range(days)]

    # grid[email] -> list (per time) of list (per day) of status int
    grids: dict[str, list[list[int]]] = {
        e: [[0] * days for _ in times] for e in room_emails
    }

    # One getSchedule call per day (business hours only) keeps slicing trivial.
    for di, day in enumerate(day_list):
        start_iso = f"{day}T{settings.business_start_hour:02d}:00:00"
        end_iso = f"{day}T{settings.business_end_hour:02d}:00:00"
        try:
            views = await graph.get_schedule(
                token, room_emails, start_iso, end_iso, settings.timezone, settings.slot_minutes
            )
        except httpx.HTTPStatusError as e:
            raise HTTPException(e.response.status_code, e.response.text)
        for email, view in views.items():
            if email not in grids:
                continue
            for ti in range(len(times)):
                status = int(view[ti]) if ti < len(view) and view[ti].isdigit() else 0
                grids[email][ti][di] = status

    return {
        "timezone": settings.timezone,
        "slotMinutes": settings.slot_minutes,
        "days": day_list,
        "times": times,
        "rooms": [
            {**r, "grid": grids[r["email"]]} for r in rooms_list
        ],
    }


@app.get("/api/health")
def health():
    return {"status": "ok"}
