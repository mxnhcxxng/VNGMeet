"""Request models shared by API routers."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

ATTENDEE_EMAIL_DOMAIN = "@vng.com.vn"
# Max length for a booking body/description. Bounds the payload we forward to
# Microsoft Graph event creation and blocks oversized inputs.
BOOKING_BODY_MAX_LEN = 1000


def _normalize_attendees(values: list[str] | None) -> list[str]:
    """Normalize attendee entries and enforce the internal email domain.

    The booking modal lets users type bare usernames (e.g. "cuongdm4"); append
    the org suffix so we store/send full addresses. Entries that already contain
    "@" must belong to the internal domain — arbitrary external recipients are
    rejected so a booking (created from a real VNG mailbox via Graph) can't be
    abused to invite/phish outside addresses. Blanks are dropped.
    """
    normalized: list[str] = []
    for raw in values or []:
        value = (raw or "").strip()
        if not value:
            continue
        full = value if "@" in value else f"{value}{ATTENDEE_EMAIL_DOMAIN}"
        if not full.lower().endswith(ATTENDEE_EMAIL_DOMAIN):
            raise ValueError(
                f"Chỉ chấp nhận email nội bộ ({ATTENDEE_EMAIL_DOMAIN}): {value}"
            )
        normalized.append(full)
    return normalized


class BookingRequest(BaseModel):
    room_email: str
    room_name: str | None = None
    date: str  # "2026-06-11"
    start_time: str  # "09:00"
    end_time: str  # "10:00"
    booking_type: Literal["instant", "schedule", "scheduled", "scout"] = "instant"
    method: Literal["manual", "chatbot"] = "manual"
    subject: str
    attendees: list[str] = []
    body: str | None = Field(default=None, max_length=BOOKING_BODY_MAX_LEN)

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
    body: str | None = Field(default=None, max_length=BOOKING_BODY_MAX_LEN)

    @field_validator("attendees")
    @classmethod
    def _normalize(cls, value: list[str] | None) -> list[str] | None:
        # None means "leave attendees unchanged" — preserve it.
        return None if value is None else _normalize_attendees(value)


class ChatSendRequest(BaseModel):
    # Cap input length: bounds LLM cost and the size of any prompt-injection
    # payload. The endpoint still strips + rejects empty content separately.
    content: str = Field(max_length=4000)
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
