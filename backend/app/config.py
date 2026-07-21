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
    # Mail.Send -> send Room Scout notifications from the signed-in user's mailbox
    scopes: list[str] = [
        "offline_access",
        "Place.Read.All",
        "Calendars.Read.Shared",
        "Calendars.ReadWrite",
        "Mail.Send",
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
    # Encrypts manual Graph access tokens saved for pending scheduled bookings.
    # Generate with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    # If unset, the backend derives a stable key from session_secret.
    scheduled_token_encryption_key: str = ""

    # OpenAI-compatible chat provider. Example:
    # LLM_BASE_URL=https://api.openai.com/v1
    # LLM_API_KEY=...
    # LLM_MODEL=gpt-4o-mini
    llm_base_url: str = ""
    llm_api_key: str = ""
    llm_model: str = ""

    # Zalo Mini App
    zalo_app_secret_key: str = ""          # secret_key của Zalo App (mini.zalo.me)
    miniapp_session_secret: str = ""       # khoá ký session JWT của VNGMeet cho Mini App
    miniapp_session_ttl_seconds: int = 30 * 24 * 3600   # 30 ngày

    # Zalo Bot Platform (chat bot — sản phẩm KHÁC Mini App, bot.zaloplatforms.com).
    # Bot nhận tin qua webhook và trả lời bằng chính agent chat của Mini App.
    zalo_bot_token: str = ""               # Bot Token từ bot.zaloplatforms.com
    zalo_bot_secret_token: str = ""        # X-Bot-Api-Secret-Token dùng verify webhook
    bot_pairing_ttl_seconds: int = 600     # hạn mã pairing liên kết tài khoản (10 phút)
    # Deep-link MỞ MINI APP để user liên kết tài khoản (vd https://zalo.me/s/<app_id>/).
    # PHẢI trỏ tới Mini App (nơi có phone-auth + handler bot_pair), KHÔNG phải web
    # frontend. Nếu để trống, tạm fallback về public_url (web) — user sẽ không link được.
    bot_miniapp_link: str = ""

    @property
    def zalo_bot_enabled(self) -> bool:
        return bool(self.zalo_bot_token and self.zalo_bot_secret_token)

    @property
    def zalo_bot_api_base(self) -> str:
        return f"https://bot-api.zaloplatforms.com/bot{self.zalo_bot_token}"

    @property
    def public_url(self) -> str:
        """Canonical, browser-reachable URL of the frontend for use in links
        (e.g. Room Scout emails).

        FRONTEND_URL may be a comma-separated list of CORS origins mixing local
        dev with the deployed AgentBase endpoint. For a link we want a single,
        real URL: prefer the first non-localhost entry, falling back to the
        first entry overall.
        """
        candidates = [o.strip() for o in self.frontend_url.split(",") if o.strip()]
        if not candidates:
            return self.frontend_url
        for url in candidates:
            if "localhost" not in url and "127.0.0.1" not in url:
                return url
        return candidates[0]

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
    # app-only from Graph on the cron below (default: every 2 minutes) and the browse
    # grid reads from the cache instead of calling Graph live. The cache always
    # stores the FULL day at
    # 15-min granularity (96 slots) for `availability_days` days starting today.
    # The final day is Graph-scanned for conflicts but remains scheduled-booking
    # territory: free slots are stored as -1 and busy slots as 1.
    availability_days: int = 16
    availability_slot_minutes: int = 15  # 24h / 15min = 96 slots per day
    # Cron minutes the refresh fires on. "*/2" = every 2 minutes; "*" = every
    # minute; a CSV list like "0,15,30,45" pins it to specific minutes of the hour.
    availability_refresh_minutes: str = "*/2"
    # Set true to disable the scheduler even when app creds are present.
    availability_refresh_disabled: bool = False
    # Hard limit on how far ahead a room can be booked (system constraint).
    # A date is bookable only when it falls within today .. today + N days
    # (inclusive). E.g. with 15 and today=16/06, the latest bookable day is 01/07.
    max_booking_advance_days: int = 15

    @property
    def authority(self) -> str:
        return f"https://login.microsoftonline.com/{self.tenant_id}"

    @property
    def token_endpoint(self) -> str:
        return f"{self.authority}/oauth2/v2.0/token"


@lru_cache
def get_settings() -> Settings:
    return Settings()
