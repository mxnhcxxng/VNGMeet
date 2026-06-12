from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
_PROJECT_ROOT = _BACKEND_ROOT.parent


class Settings(BaseSettings):
    """App configuration, loaded from environment / .env file."""

    model_config = SettingsConfigDict(
        env_file=(_PROJECT_ROOT / ".env", _BACKEND_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Azure AD App Registration.
    # Auth is now handled by Supabase (Azure OAuth provider). The backend keeps these
    # creds so it can exchange the stored provider_refresh_token for a fresh Graph
    # access token directly against Azure's token endpoint (Supabase does NOT refresh
    # provider tokens for us).
    client_id: str = ""
    client_secret: str = ""
    tenant_id: str = "common"

    # After login the frontend (Supabase) redirects the browser back here.
    frontend_url: str = "http://localhost:3000"

    # Delegated Microsoft Graph permissions. offline_access is required so Azure
    # issues a refresh token that the backend can store and re-exchange.
    # Place.Read.All  -> list meeting rooms
    # Calendars.Read.Shared -> read other people's / rooms' free-busy via getSchedule
    # Calendars.ReadWrite -> create events (book a room) on the signed-in user's calendar
    scopes: list[str] = [
        "offline_access",
        "Place.Read.All",
        "Calendars.Read.Shared",
        "Calendars.ReadWrite",
        "User.Read",
    ]

    # Supabase project (Project Settings -> API). Optional — empty means the
    # Supabase auth/DB path is disabled and the app runs on the manual Graph-token
    # paste flow only (works without admin consent).
    supabase_url: str = ""
    supabase_anon_key: str = ""
    supabase_service_role_key: str = ""
    supabase_jwt_secret: str = ""

    # Session cookie signing key — used by the manual Graph-token paste flow to
    # key the server-side token store. Override in .env for production.
    session_secret: str = "change-me-in-production-please"

    @property
    def supabase_enabled(self) -> bool:
        return bool(self.supabase_url and self.supabase_service_role_key)

    @property
    def graph_app_enabled(self) -> bool:
        """App-only (client-credentials) flow is usable for the background job.

        Needs a real tenant id (not the multi-tenant "common" placeholder) plus
        a client id/secret, and the Calendars.Read *application* permission
        granted admin consent in Azure.
        """
        return bool(
            self.client_id
            and self.client_secret
            and self.tenant_id
            and self.tenant_id != "common"
        )

    # Default business window shown in the grid
    timezone: str = "Asia/Ho_Chi_Minh"
    business_start_hour: int = 9
    business_end_hour: int = 18
    slot_minutes: int = 30

    # Availability cache (room_availability table). A background job refreshes it
    # app-only from Graph every 15 min and the browse grid reads from the cache
    # instead of calling Graph live. The cache always stores the FULL day at
    # 15-min granularity (96 slots) for `availability_days` days starting today.
    availability_days: int = 15
    availability_slot_minutes: int = 15  # 24h / 15min = 96 slots per day
    # Cron minutes the refresh fires on (aligned to the quarter hour: :00 :15 :30 :45).
    availability_refresh_minutes: str = "0,15,30,45"
    # Set true to disable the scheduler even when app creds are present.
    availability_refresh_disabled: bool = False

    @property
    def authority(self) -> str:
        return f"https://login.microsoftonline.com/{self.tenant_id}"

    @property
    def token_endpoint(self) -> str:
        return f"{self.authority}/oauth2/v2.0/token"


@lru_cache
def get_settings() -> Settings:
    return Settings()
