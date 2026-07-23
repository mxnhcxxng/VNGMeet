"""Microsoft Graph helpers: list meeting rooms and read their free/busy schedule."""

from __future__ import annotations

import httpx

from .config import get_settings

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
GRAPH_BETA = "https://graph.microsoft.com/beta"


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

    Uses beta findRooms(), which only needs the user-consentable
    Calendars.Read.Shared permission (no admin-grade Place.Read.All). Richer
    metadata (building/floor/capacity/zone) is layered on from the app's own DB
    in room_resources._enrich_rooms().
    """
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=30) as client:
        rooms = await _list_rooms_findrooms(client, headers)
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


async def get_calendar_view(
    access_token: str,
    start_iso: str,
    end_iso: str,
    timezone: str,
) -> list[dict]:
    """Return the signed-in user's events in [start, end) via /me/calendarView.

    Unlike getSchedule (free/busy only), calendarView returns full events the user
    organizes OR is invited to, including organizer and the attendee list (the room
    appears as a type="resource" attendee). calendarView also expands recurring
    series within the window. Used to attribute each busy room slot to its real
    owner/attendees, even for bookings made directly in Outlook.
    """
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
        "Prefer": f'outlook.timezone="{timezone}"',
    }
    params: dict | None = {
        "startDateTime": start_iso,
        "endDateTime": end_iso,
        "$select": "id,subject,bodyPreview,start,end,location,attendees,organizer,isCancelled,showAs",
        "$top": "100",
        "$orderby": "start/dateTime",
    }
    url = f"{GRAPH_BASE}/me/calendarView"
    events: list[dict] = []
    async with httpx.AsyncClient(timeout=60) as client:
        while url:
            resp = await client.get(url, headers=headers, params=params)
            resp.raise_for_status()
            data = resp.json()
            for ev in data.get("value", []):
                if ev.get("isCancelled"):
                    continue
                events.append(ev)
            url = data.get("@odata.nextLink")
            params = None  # nextLink already carries the query string
    return events


def build_event_body(
    subject: str,
    start_iso: str,
    end_iso: str,
    timezone: str,
    room_email: str,
    room_name: str | None = None,
    attendees: list[str] | None = None,
    body_text: str | None = None,
) -> dict:
    """Build the Graph event JSON body (pure, no I/O) so callers can pre-stage it
    before the time-critical POST (see the scheduled-booking fire path)."""
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
    return body


def _event_headers(access_token: str, timezone: str) -> dict:
    return {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "Prefer": f'outlook.timezone="{timezone}"',
    }


def _event_result(data: dict) -> dict:
    return {
        "id": data.get("id"),
        "webLink": data.get("webLink"),
        "subject": data.get("subject"),
        "start": data.get("start"),
        "end": data.get("end"),
    }


async def post_event(
    client: httpx.AsyncClient,
    access_token: str,
    body: dict,
    timezone: str,
) -> dict:
    """POST a pre-built event body using a caller-supplied (possibly warm) client.

    Splitting this out lets the scheduled-booking fire path reuse a connection
    that was warmed before midnight, so the critical path is just one round-trip.
    """
    resp = await client.post(
        f"{GRAPH_BASE}/me/events",
        headers=_event_headers(access_token, timezone),
        json=body,
    )
    resp.raise_for_status()
    return _event_result(resp.json())


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
    body = build_event_body(
        subject, start_iso, end_iso, timezone, room_email, room_name, attendees, body_text
    )
    async with httpx.AsyncClient(timeout=60) as client:
        return await post_event(client, access_token, body, timezone)


async def update_event(
    access_token: str,
    event_id: str,
    timezone: str,
    subject: str | None = None,
    start_iso: str | None = None,
    end_iso: str | None = None,
    body_text: str | None = None,
    attendees: list[str] | None = None,
    room_email: str | None = None,
    room_name: str | None = None,
) -> dict:
    """Patch an existing event on the signed-in user's calendar.

    Only the fields supplied are changed (Graph PATCH semantics). When `attendees`
    is given, the whole attendee collection is rewritten — so the room resource is
    re-added first to avoid dropping the booked room. Pass attendees=None to leave
    attendees (and the room) untouched. Needs Calendars.ReadWrite delegated.
    """
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "Prefer": f'outlook.timezone="{timezone}"',
    }
    body: dict = {}
    if subject is not None:
        body["subject"] = subject
    if start_iso is not None:
        body["start"] = {"dateTime": start_iso, "timeZone": timezone}
    if end_iso is not None:
        body["end"] = {"dateTime": end_iso, "timeZone": timezone}
    if body_text is not None:
        body["body"] = {"contentType": "text", "content": body_text}
    if attendees is not None:
        event_attendees: list[dict] = []
        if room_email:
            event_attendees.append(
                {
                    "emailAddress": {"address": room_email, "name": room_name or room_email},
                    "type": "resource",
                }
            )
        for email in attendees:
            email = email.strip()
            if email:
                event_attendees.append(
                    {"emailAddress": {"address": email}, "type": "required"}
                )
        body["attendees"] = event_attendees

    url = f"{GRAPH_BASE}/me/events/{event_id}"
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.patch(url, headers=headers, json=body)
        resp.raise_for_status()
        data = resp.json()

    return {
        "id": data.get("id"),
        "webLink": data.get("webLink"),
        "subject": data.get("subject"),
        "start": data.get("start"),
        "end": data.get("end"),
    }


async def delete_event(access_token: str, event_id: str) -> None:
    """Delete (cancel) an event on the signed-in user's calendar.

    A 404 is treated as success — the event is already gone. Needs the
    Calendars.ReadWrite delegated permission.
    """
    headers = {"Authorization": f"Bearer {access_token}"}
    url = f"{GRAPH_BASE}/me/events/{event_id}"
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.delete(url, headers=headers)
        if resp.status_code == 404:
            return
        resp.raise_for_status()


async def send_mail(
    access_token: str,
    to_email: str,
    subject: str,
    html_body: str,
    inline_images: list[dict] | None = None,
) -> None:
    """Send a notification from the signed-in user's mailbox via Graph.

    Needs the Mail.Send delegated permission. In manual-token mode the pasted
    Graph token must include that scope.

    ``inline_images`` lets the HTML reference embedded images via ``cid:<id>``.
    Each entry is ``{"content_id": str, "content_bytes": <base64 str>,
    "content_type": str}``. CID attachments render in Outlook desktop, which
    strips both inline SVG and base64 data-URI images.
    """
    message: dict = {
        "subject": subject,
        "body": {"contentType": "HTML", "content": html_body},
        "toRecipients": [
            {"emailAddress": {"address": to_email}},
        ],
    }
    if inline_images:
        message["attachments"] = [
            {
                "@odata.type": "#microsoft.graph.fileAttachment",
                "name": f"{img['content_id']}.png",
                "contentType": img.get("content_type", "image/png"),
                "contentId": img["content_id"],
                "isInline": True,
                "contentBytes": img["content_bytes"],
            }
            for img in inline_images
        ]
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    body = {
        "message": message,
        "saveToSentItems": False,
    }
    url = f"{GRAPH_BASE}/me/sendMail"
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(url, headers=headers, json=body)
        resp.raise_for_status()
