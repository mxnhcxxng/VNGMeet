"""FastAPI backend: meeting-room availability grid.

Two auth paths (see auth.py): paste a Graph access token (works without admin),
or sign in via Supabase's Azure OAuth provider once SUPABASE_* is configured.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
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


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #
@app.post("/api/auth/token")
def set_token(request: Request, access_token: str = Body(..., embed=True)):
    """Manual mode: paste a Graph access token (e.g. from Graph Explorer).

    Token does not auto-refresh — paste again when it expires (~1h). Works without
    admin consent / Supabase.
    """
    if not access_token or not access_token.strip():
        raise HTTPException(400, "access_token rỗng")
    sid = auth.session_id(request)
    auth.set_manual_token(sid, access_token)
    name = auth._decode_jwt_claim(access_token, "upn", "preferred_username", "name")
    return JSONResponse({"ok": True, "username": name or "Graph token"})


@app.post("/api/auth/link")
def link_microsoft(request: Request, provider_refresh_token: str = Body(..., embed=True)):
    """Supabase mode: store the Microsoft refresh token after Azure sign-in."""
    bearer = request.headers.get("Authorization", "")
    if not bearer.startswith("Bearer "):
        raise HTTPException(401, "Not authenticated")
    claims = auth.verify_jwt(bearer[len("Bearer ") :])
    if not provider_refresh_token or not provider_refresh_token.strip():
        raise HTTPException(400, "provider_refresh_token rỗng")
    auth.store_refresh_token(claims["sub"], provider_refresh_token.strip())
    return {"ok": True}


@app.get("/api/auth/me")
def me(request: Request):
    bearer = request.headers.get("Authorization", "")
    if bearer.startswith("Bearer "):
        claims = auth.verify_jwt(bearer[len("Bearer ") :])
        return JSONResponse(
            {
                "authenticated": True,
                "username": claims.get("email"),
                "graphLinked": auth.has_refresh_token(claims["sub"]),
            }
        )
    sid = auth.session_id(request)
    token = auth.get_manual_token(sid)
    if not token:
        return JSONResponse({"authenticated": False})
    name = auth._decode_jwt_claim(token, "upn", "preferred_username", "name")
    return JSONResponse({"authenticated": True, "username": name or "Graph token"})


@app.post("/api/auth/logout")
def logout(request: Request):
    auth.logout(auth.session_id(request))
    return JSONResponse({"ok": True})


# --------------------------------------------------------------------------- #
# Rooms & schedule
# --------------------------------------------------------------------------- #
@app.get("/api/rooms")
async def rooms(request: Request):
    token, _ = await auth.resolve_token(request)
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
    token, _ = await auth.resolve_token(request)
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


# --------------------------------------------------------------------------- #
# Bookings
# --------------------------------------------------------------------------- #
class BookingRequest(BaseModel):
    room_email: str
    room_name: str | None = None
    date: str  # "2026-06-11"
    start_time: str  # "09:00"
    end_time: str  # "10:00"
    subject: str
    attendees: list[str] = []
    body: str | None = None


@app.post("/api/bookings")
async def create_booking(request: Request, payload: BookingRequest):
    token, user_id = await auth.resolve_token(request)

    if not payload.subject.strip():
        raise HTTPException(400, "Tiêu đề cuộc họp không được để trống")
    if payload.end_time <= payload.start_time:
        raise HTTPException(400, "Giờ kết thúc phải sau giờ bắt đầu")

    start_iso = f"{payload.date}T{payload.start_time}:00"
    end_iso = f"{payload.date}T{payload.end_time}:00"
    try:
        ev = await graph.create_event(
            token,
            payload.subject,
            start_iso,
            end_iso,
            settings.timezone,
            payload.room_email,
            payload.room_name,
            payload.attendees,
            payload.body,
        )
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, e.response.text)

    # Mirror booking metadata into Supabase when available (Supabase path only).
    if user_id and settings.supabase_enabled:
        try:
            from .supabase_client import get_supabase

            get_supabase().table("bookings").insert(
                {
                    "user_id": user_id,
                    "room_email": payload.room_email,
                    "room_name": payload.room_name,
                    "date": payload.date,
                    "start_time": payload.start_time,
                    "end_time": payload.end_time,
                    "subject": payload.subject,
                    "graph_event_id": ev.get("id"),
                    "web_link": ev.get("webLink"),
                }
            ).execute()
        except Exception:
            pass

    return {"ok": True, **ev}


@app.get("/api/health")
def health():
    return {"status": "ok"}
