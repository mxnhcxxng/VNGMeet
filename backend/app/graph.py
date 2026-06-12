"""Microsoft Graph helpers: list meeting rooms and read their free/busy schedule."""

from __future__ import annotations

import time

import httpx

from .config import get_settings

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
GRAPH_BETA = "https://graph.microsoft.com/beta"

# App-only (client-credentials) token cache: (access_token, expires_at_epoch).
_APP_TOKEN_CACHE: tuple[str, float] | None = None


async def get_app_token() -> str:
    """Return an app-only Graph token via the client-credentials flow, cached.

    Used by the background availability job, which has no signed-in user. Requires
    the Calendars.Read *application* permission (admin consented) and a real
    tenant id in config (see Settings.graph_app_enabled).
    """
    global _APP_TOKEN_CACHE
    if _APP_TOKEN_CACHE and _APP_TOKEN_CACHE[1] - 60 > time.time():
        return _APP_TOKEN_CACHE[0]

    s = get_settings()
    data = {
        "client_id": s.client_id,
        "client_secret": s.client_secret,
        "grant_type": "client_credentials",
        "scope": "https://graph.microsoft.com/.default",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(s.token_endpoint, data=data)
    resp.raise_for_status()
    payload = resp.json()
    access_token = payload["access_token"]
    expires_in = int(payload.get("expires_in", 3600))
    _APP_TOKEN_CACHE = (access_token, time.time() + expires_in)
    return access_token


async def get_schedule_app(
    access_token: str,
    owner_email: str,
    emails: list[str],
    start_iso: str,
    end_iso: str,
    timezone: str,
    interval_minutes: int,
) -> dict[str, str]:
    """App-only getSchedule, calling /users/{owner}/calendar/getSchedule.

    The app-only flow has no /me; it acts against a specific mailbox. We use each
    room as its own calendar owner (owner_email == the room) so no service
    mailbox is required. Same response shape as get_schedule().
    """
    if not emails:
        return {}
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "Prefer": f'outlook.timezone="{timezone}"',
    }
    body = {
        "schedules": emails,
        "startTime": {"dateTime": start_iso, "timeZone": timezone},
        "endTime": {"dateTime": end_iso, "timeZone": timezone},
        "availabilityViewInterval": interval_minutes,
    }
    url = f"{GRAPH_BASE}/users/{owner_email}/calendar/getSchedule"
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(url, headers=headers, json=body)
        resp.raise_for_status()
        data = resp.json()

    result: dict[str, str] = {}
    for item in data.get("value", []):
        result[item.get("scheduleId")] = item.get("availabilityView", "")
    return result


async def _list_rooms_places(client: httpx.AsyncClient, headers: dict) -> list[dict]:
    """Rich room list via /places/microsoft.graph.room (needs Place.Read.All, admin)."""
    url = f"{GRAPH_BASE}/places/microsoft.graph.room?$top=100"
    rooms: list[dict] = []
    while url:
        resp = await client.get(url, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        for r in data.get("value", []):
            rooms.append(
                {
                    "id": r.get("id") or r.get("emailAddress"),
                    "name": r.get("displayName"),
                    "email": r.get("emailAddress"),
                    "building": r.get("building"),
                    "floor": r.get("floorLabel") or r.get("floorNumber"),
                    "capacity": r.get("capacity"),
                }
            )
        url = data.get("@odata.nextLink")
    return rooms


async def _list_rooms_findrooms(client: httpx.AsyncClient, headers: dict) -> list[dict]:
    """Lightweight room list via beta findRooms() (only needs Calendars.Read, no admin)."""
    url = f"{GRAPH_BETA}/me/microsoft.graph.findRooms()"
    resp = await client.get(url, headers=headers)
    resp.raise_for_status()
    data = resp.json()
    rooms = []
    for r in data.get("value", []):
        email = r.get("address")
        rooms.append(
            {
                "id": email,
                "name": r.get("name") or email,
                "email": email,
                "building": None,
                "floor": None,
                "capacity": None,
            }
        )
    return rooms


async def list_rooms(access_token: str) -> list[dict]:
    """Return all rooms (meeting-room mailboxes) the signed-in user can see.

    Tries the admin-grade /places API first (richer metadata). If that is
    forbidden (no Place.Read.All consent), falls back to beta findRooms(),
    which only needs the user-consentable Calendars.Read permission.
    """
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=30) as client:
        try:
            rooms = await _list_rooms_places(client, headers)
        except httpx.HTTPStatusError as e:
            if e.response.status_code in (401, 403):
                rooms = await _list_rooms_findrooms(client, headers)
            else:
                raise
    # Only rooms with a real mailbox email can be queried for schedule.
    return [r for r in rooms if r.get("email")]


async def get_schedule(
    access_token: str,
    emails: list[str],
    start_iso: str,
    end_iso: str,
    timezone: str,
    interval_minutes: int,
) -> dict[str, str]:
    """Call /me/calendar/getSchedule and return {email: availabilityView}.

    availabilityView is a string of digits, one per interval:
      0 = free, 1 = tentative, 2 = busy, 3 = out-of-office, 4 = working elsewhere.
    """
    if not emails:
        return {}
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "Prefer": f'outlook.timezone="{timezone}"',
    }
    body = {
        "schedules": emails,
        "startTime": {"dateTime": start_iso, "timeZone": timezone},
        "endTime": {"dateTime": end_iso, "timeZone": timezone},
        "availabilityViewInterval": interval_minutes,
    }
    url = f"{GRAPH_BASE}/me/calendar/getSchedule"
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(url, headers=headers, json=body)
        resp.raise_for_status()
        data = resp.json()

    result: dict[str, str] = {}
    for item in data.get("value", []):
        result[item.get("scheduleId")] = item.get("availabilityView", "")
    return result


async def create_event(
    access_token: str,
    subject: str,
    start_iso: str,
    end_iso: str,
    timezone: str,
    room_email: str,
    room_name: str | None = None,
    attendees: list[str] | None = None,
    body_text: str | None = None,
) -> dict:
    """Create an event on the signed-in user's calendar, booking a room.

    The room is added as a resource attendee; if the room mailbox is set to
    auto-accept, it will accept the invite and then show as busy in getSchedule.
    Needs the Calendars.ReadWrite delegated permission.
    """
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "Prefer": f'outlook.timezone="{timezone}"',
    }
    event_attendees: list[dict] = [
        {
            "emailAddress": {"address": room_email, "name": room_name or room_email},
            "type": "resource",
        }
    ]
    for email in attendees or []:
        email = email.strip()
        if email:
            event_attendees.append(
                {"emailAddress": {"address": email}, "type": "required"}
            )

    body: dict = {
        "subject": subject,
        "start": {"dateTime": start_iso, "timeZone": timezone},
        "end": {"dateTime": end_iso, "timeZone": timezone},
        "location": {"displayName": room_name or room_email},
        "attendees": event_attendees,
    }
    if body_text:
        body["body"] = {"contentType": "text", "content": body_text}

    url = f"{GRAPH_BASE}/me/events"
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(url, headers=headers, json=body)
        resp.raise_for_status()
        data = resp.json()

    return {
        "id": data.get("id"),
        "webLink": data.get("webLink"),
        "subject": data.get("subject"),
        "start": data.get("start"),
        "end": data.get("end"),
    }
