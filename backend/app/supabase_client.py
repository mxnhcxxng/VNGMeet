"""Server-side Supabase client (service-role).

The service-role key bypasses Row Level Security, so it must NEVER reach the
browser. It is used only here, on the backend, to read/write tables the user
shouldn't touch directly (e.g. `provider_tokens`) and to mirror booking metadata.
"""

from __future__ import annotations

from functools import lru_cache

import httpx
from supabase import Client, ClientOptions, create_client

from .config import get_settings


def _build_http_client() -> httpx.Client:
    """The one httpx client every Supabase call shares — deliberately HTTP/1.1.

    postgrest-py builds its own client with `http2=True`, and `get_supabase()`
    below hands out a single process-wide Client. HTTP/2 multiplexes every
    request onto ONE connection, so FastAPI's sync-endpoint threadpool and the
    availability cron job's `asyncio.to_thread` calls all end up writing frames
    to that same connection concurrently. Nothing serializes them, the frame
    stream gets interleaved — we saw request pseudo-headers surface as trailers —
    and Supabase answers GOAWAY(PROTOCOL_ERROR), which kills every request
    in flight on that connection together:

        07:00:06.700  GET /api/users/profile-options -> 500
        07:00:06.700  room_availability prune failed: <ConnectionTerminated
                      error_code:1, last_stream_id:75>
        07:00:06.703  could not upsert user profile:  <same last_stream_id:75>
        07:00:06.703  GET /api/chat/threads          -> 503

    Four unrelated call sites, one stream id, three milliseconds. HTTP/1.1 has no
    multiplexing: httpx checks out one connection per request from a thread-safe
    pool, so concurrent callers never share frame state. Injecting our own client
    is the supported way to turn h2 off — supabase-py forwards
    `options.httpx_client` to postgrest/auth/storage untouched, and postgrest
    addresses tables by absolute URL, so this client needs no `base_url`.

    Serializing callers instead would also work and is what the availability job
    now does internally, but it only removes contention the job has with itself;
    the job still races every inbound request. Fixing the connection fixes both.
    """
    return httpx.Client(
        http2=False,
        # NOT httpx defaults. httpx would default to 5s, which the multi-megabyte
        # room_availability upserts blow straight through.
        #
        # It is also deliberately BELOW Supabase's own gateway timeout (~60s).
        # At the old 120s the client outlived the gateway, so a request the
        # gateway had already given up on came back as a bare 504 that named
        # nothing — which is exactly how these surfaced in the Supabase log:
        #
        #     GET /rest/v1/graph_token_pool          504
        #     GET /rest/v1/meeting_room_metadata     504
        #     GET /rest/v1/provider_tokens           504
        #     POST /rest/v1/provider_tokens          504
        #
        # Timing out first means the failure is raised HERE, with our own
        # stack and our own log line, instead of arriving as someone else's
        # gateway error. A healthy call is nowhere near this: the whole
        # availability refresh (46 rooms, 736 rows) runs in ~8s.
        timeout=httpx.Timeout(45.0, connect=10.0),
        follow_redirects=True,
        # One connection per in-flight request now, where h2 needed one in total.
        # Keepalive covers the whole threadpool so a burst reuses connections
        # instead of paying a TLS handshake per request.
        #
        # 25, not 100. PostgREST hands every request a Postgres connection out of
        # a pool far smaller than 100, so a burst above that ceiling does not run
        # in parallel — it QUEUES on the database, and the slowest of the queue
        # exceeds the gateway timeout and 504s. Capping here makes the queue form
        # on our side, where a waiting request costs nothing and keeps its
        # deadline, instead of inside Supabase where it burns the gateway budget.
        # Raise only alongside evidence that the database pool grew too.
        limits=httpx.Limits(max_connections=25, max_keepalive_connections=10),
    )


@lru_cache
def get_supabase() -> Client:
    s = get_settings()
    if not s.supabase_url or not s.supabase_service_role_key:
        raise RuntimeError(
            "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Check .env"
        )
    return create_client(
        s.supabase_url,
        s.supabase_service_role_key,
        options=ClientOptions(httpx_client=_build_http_client()),
    )
