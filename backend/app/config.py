from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """App configuration, loaded from environment / .env file."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Azure AD App Registration
    client_id: str = ""
    client_secret: str = ""
    tenant_id: str = "common"

    # OAuth2
    redirect_uri: str = "http://localhost:8000/api/auth/callback"
    # After login the backend redirects the browser back to the frontend.
    frontend_url: str = "http://localhost:3000"

    # Delegated Microsoft Graph permissions we ask consent for.
    # Place.Read.All  -> list meeting rooms
    # Calendars.Read.Shared -> read other people's / rooms' free-busy via getSchedule
    # Calendars.ReadWrite -> create events (book a room) on the signed-in user's calendar
    scopes: list[str] = ["Place.Read.All", "Calendars.Read.Shared", "Calendars.ReadWrite", "User.Read"]

    # Session cookie signing key (override in .env for production)
    session_secret: str = "change-me-in-production-please"

    # Default business window shown in the grid
    timezone: str = "Asia/Ho_Chi_Minh"
    business_start_hour: int = 8
    business_end_hour: int = 18
    slot_minutes: int = 30

    @property
    def authority(self) -> str:
        return f"https://login.microsoftonline.com/{self.tenant_id}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
