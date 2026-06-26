"""Request models shared by API routers."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

ATTENDEE_EMAIL_DOMAIN = "@vng.com.vn"


def _normalize_attendees(values: list[str] | None) -> list[str]:
    """The booking modal lets users type bare domains (e.g. "cuongdm4"); append
    the org email suffix so we store and send full addresses. Entries that
    already contain "@" are kept as-is. Blanks are dropped."""
    normalized: list[str] = []
    for raw in values or []:
        value = (raw or "").strip()
        if not value:
            continue
        normalized.append(value if "@" in value else f"{value}{ATTENDEE_EMAIL_DOMAIN}")
    return normalized


class BookingRequest(BaseModel):
    room_email: str
    room_name: str | None = None
    date: str  # "2026-06-11"
    start_time: str  # "09:00"
    end_time: str  # "10:00"
    booking_type: Literal["instant", "schedule", "scheduled"] = "instant"
    method: Literal["manual", "chatbot"] = "manual"
    subject: str
    attendees: list[str] = []
    body: str | None = None

    @field_validator("attendees")
    @classmethod
    def _normalize(cls, value: list[str]) -> list[str]:
        return _normalize_attendees(value)


class UpdateBookingRequest(BaseModel):
    """Editable fields of an existing booking. All optional — only sent fields change."""

    date: str | None = None  # "2026-06-11"
    start_time: str | None = None  # "09:00"
    end_time: str | None = None  # "10:00"
    subject: str | None = None
    attendees: list[str] | None = None
    body: str | None = None

    @field_validator("attendees")
    @classmethod
    def _normalize(cls, value: list[str] | None) -> list[str] | None:
        # None means "leave attendees unchanged" — preserve it.
        return None if value is None else _normalize_attendees(value)


class ChatSendRequest(BaseModel):
    content: str
    thread_id: str | None = None


class ChatThreadRenameRequest(BaseModel):
    title: str = Field(min_length=1, max_length=120)


class ChatFeedbackRequest(BaseModel):
    feedback: Literal["positive", "negative"] | None = None


class ChatBookingActionRequest(BaseModel):
    thread_id: str
    confirmation_id: str
    action: Literal["accept", "reject", "expire"]
    booking: BookingRequest | None = None
    # When the user ticks "book without confirmation next time" on the card.
    book_without_confirmation: bool = False


class UserProfileUpdateRequest(BaseModel):
    office: str
    floor: str = ""
    building: str = ""
    preferred_rooms: list[str] = Field(default_factory=list)
    book_without_confirmation: bool | None = None
    theme: str | None = None
    language: str | None = None
