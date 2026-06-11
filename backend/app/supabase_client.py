"""Server-side Supabase client (service-role).

The service-role key bypasses Row Level Security, so it must NEVER reach the
browser. It is used only here, on the backend, to read/write tables the user
shouldn't touch directly (e.g. `provider_tokens`) and to mirror booking metadata.
"""

from __future__ import annotations

from functools import lru_cache

from supabase import Client, create_client

from .config import get_settings


@lru_cache
def get_supabase() -> Client:
    s = get_settings()
    if not s.supabase_url or not s.supabase_service_role_key:
        raise RuntimeError(
            "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Check .env"
        )
    return create_client(s.supabase_url, s.supabase_service_role_key)
