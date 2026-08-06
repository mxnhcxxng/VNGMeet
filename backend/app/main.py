"""FastAPI backend entrypoint for VNG Meet."""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware

from . import booking_schedule
from .app_context import log, settings
from .bookings import (
    fire_scheduled_bookings,
    prepare_scheduled_bookings,
    process_scheduled_bookings,
    router as bookings_router,
)
from .bot import router as bot_router
from .chat import router as chat_router
from .profiles import router as profiles_router
from .room_resources import router as room_resources_router
from .room_scouts import process_room_scouts, router as room_scouts_router
from .zalo_webhook import router as zalo_webhook_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start background jobs when their required integrations are configured."""
    scheduler = None
    if settings.supabase_enabled and not settings.availability_refresh_disabled:
        from apscheduler.schedulers.asyncio import AsyncIOScheduler
        from apscheduler.triggers.cron import CronTrigger

        scheduler = AsyncIOScheduler(timezone=settings.timezone)
        # Refresh the cache every minute with the newest active DELEGATED token
        # from graph_token_pool (needs only Calendars.Read.Shared), so user
        # requests never have to refresh Graph themselves. There is no app-only
        # (client-credentials) path: it required a Calendars.Read *application*
        # permission with admin consent that this app deliberately does not use.
        scheduler.add_job(
            _safe_refresh_from_pool,
            CronTrigger(minute="*", timezone=settings.timezone),
            id="refresh_availability_pool",
            max_instances=1,
            coalesce=True,
            misfire_grace_time=55,
        )
        # Leave the fire thread ~5s to spin up, warm and arm even if prep misfires.
        prep_grace = max(
            5, booking_schedule.PREP_LEAD_SECONDS - booking_schedule.FIRE_LEAD_SECONDS - 5
        )
        prep_h, prep_m, prep_s = booking_schedule.shifted_hms(-booking_schedule.PREP_LEAD_SECONDS)
        fire_h, fire_m, fire_s = booking_schedule.shifted_hms(-booking_schedule.FIRE_LEAD_SECONDS)
        cu_h, cu_m, cu_s = booking_schedule.shifted_hms(booking_schedule.CATCHUP_DELAY_SECONDS)
        scheduler.add_job(
            _safe_prepare_scheduled_bookings,
            CronTrigger(hour=prep_h, minute=prep_m, second=prep_s, timezone=settings.timezone),
            id="prepare_scheduled_bookings",
            max_instances=1,
            coalesce=True,
            # Prep arming the fire thread even a few seconds late is far better than
            # it being dropped — a dropped prep means the watchdog has to fall back
            # to the (much less precise) inline path.
            misfire_grace_time=prep_grace,
        )
        scheduler.add_job(
            _safe_fire_scheduled_bookings,
            CronTrigger(hour=fire_h, minute=fire_m, second=fire_s, timezone=settings.timezone),
            id="fire_scheduled_bookings",
            max_instances=1,
            coalesce=True,
            misfire_grace_time=15,
        )
        scheduler.add_job(
            _safe_process_scheduled_bookings,
            CronTrigger(hour=cu_h, minute=cu_m, second=cu_s, timezone=settings.timezone),
            id="catchup_scheduled_bookings",
            max_instances=1,
            coalesce=True,
            misfire_grace_time=600,
        )
        log.warning(
            "Scheduled-booking jobs registered (fire_time=%s, send_lead=%dms): "
            "prep=%02d:%02d:%02d, fire=%02d:%02d:%02d, catchup=%02d:%02d:%02d; "
            "other jobs blacked out from -%ds to +%ds around fire_time",
            booking_schedule.FIRE_TIME,
            booking_schedule.SEND_LEAD_MS,
            prep_h, prep_m, prep_s,
            fire_h, fire_m, fire_s,
            cu_h, cu_m, cu_s,
            booking_schedule.BLACKOUT_LEAD_SECONDS,
            booking_schedule.BLACKOUT_TRAIL_SECONDS,
        )
        # Runs every minute, ~30s after the :00 availability poll, so it auto-books
        # against a freshly refreshed cache. Kept a separate job so its per-scout
        # room-response waits never delay the availability refresh.
        scheduler.add_job(
            _safe_process_room_scouts,
            CronTrigger(minute="*", second=30, timezone=settings.timezone),
            id="process_room_scouts",
            max_instances=1,
            coalesce=True,
            misfire_grace_time=55,
        )
        # Keep every OAuth user's pooled Graph token ahead of its own expiry.
        # Without this the pool is only ever topped up reactively — by a user
        # request, or by the availability job once the pool has already run dry —
        # so rows sat `expired` overnight and /api/auth/me had no expiry to show.
        # Every 5 minutes is just the polling grain; a user is only re-exchanged
        # when their token is inside _RENEW_MARGIN, i.e. roughly once an hour.
        scheduler.add_job(
            _safe_renew_pool_tokens,
            CronTrigger(minute="*/5", timezone=settings.timezone),
            id="renew_pool_tokens",
            max_instances=1,
            coalesce=True,
            misfire_grace_time=240,
        )
        scheduler.add_job(_safe_renew_pool_tokens, "date", run_date=None)
        scheduler.add_job(_safe_refresh_from_pool, "date", run_date=None)
        scheduler.start()
        log.warning(
            "Background scheduler started "
            "(availability=token-pool (*/1), scheduled_bookings=True, room_scouts=True)."
        )
    else:
        log.warning(
            "Background scheduler NOT started "
            "(supabase_enabled=%s, disabled=%s). "
            "Cache will refresh on demand from the requesting user's delegated token; "
            "scheduled bookings and room scouts will not run automatically.",
            settings.supabase_enabled,
            settings.availability_refresh_disabled,
        )
    try:
        yield
    finally:
        if scheduler:
            scheduler.shutdown(wait=False)


def _fire_blackout(job: str) -> bool:
    """Skip a routine job that would otherwise start inside the midnight quiet window.

    supabase-py is synchronous, so these jobs block the single event loop for as
    long as their round-trips take — the availability refresh upserts
    rooms x AVAILABILITY_DAYS rows in one call. Landing that on 23:59:00 or
    00:00:00 used to starve the scheduled-booking countdown and push the POST out
    to ~00:00:02. Each of these runs every minute or every five, so losing one
    tick a day costs nothing.
    """
    now = datetime.now(ZoneInfo(settings.timezone))
    if not booking_schedule.in_fire_blackout(now):
        return False
    log.warning("%s skipped: inside the scheduled-booking blackout (now=%s)", job, now.isoformat())
    return True


async def _safe_refresh_from_pool() -> None:
    """Scheduler entry point for the delegated token-pool refresh."""
    if _fire_blackout("refresh_availability_from_pool"):
        return
    try:
        from . import token_pool

        await token_pool.refresh_availability_from_pool()
    except Exception as e:  # noqa: BLE001
        log.exception("refresh_availability_from_pool failed: %s", e)


async def _safe_renew_pool_tokens() -> None:
    """Scheduler entry point for the proactive pooled-token renewal."""
    if _fire_blackout("renew_pool_tokens"):
        return
    try:
        from . import token_pool

        await token_pool.renew_pool_tokens()
    except Exception as e:  # noqa: BLE001
        log.exception("renew_pool_tokens failed: %s", e)


async def _safe_process_scheduled_bookings() -> None:
    """Scheduler entry point for pending schedule bookings (catch-up safety net)."""
    try:
        await process_scheduled_bookings()
    except Exception as e:  # noqa: BLE001
        log.exception("process_scheduled_bookings failed: %s", e)


async def _safe_prepare_scheduled_bookings() -> None:
    """Scheduler entry point: pre-stage tonight's bookings just before midnight."""
    try:
        await prepare_scheduled_bookings()
    except Exception as e:  # noqa: BLE001
        log.exception("prepare_scheduled_bookings failed: %s", e)


async def _safe_fire_scheduled_bookings() -> None:
    """Scheduler entry point: fire the pre-staged bookings at 00:00:00 sharp."""
    try:
        await fire_scheduled_bookings()
    except Exception as e:  # noqa: BLE001
        log.exception("fire_scheduled_bookings failed: %s", e)


async def _safe_process_room_scouts() -> None:
    """Scheduler entry point for Room Scout notifications."""
    if _fire_blackout("process_room_scouts"):
        return
    try:
        await process_room_scouts()
    except Exception as e:  # noqa: BLE001
        log.exception("process_room_scouts failed: %s", e)


app = FastAPI(title="VNG Meet — Meeting Room Availability", lifespan=lifespan)

app.add_middleware(SessionMiddleware, secret_key=settings.session_secret, same_site="lax")
# Origin tĩnh luôn được phép: Zalo Mini App prod (domain cố định của Zalo) + local
# dev. Giữ ngoài env để FRONTEND_URL chỉ cần một origin (endpoint AgentBase động).
_STATIC_CORS_ORIGINS = ["https://h5.zdn.vn", "http://localhost:3000"]
_cors_origins = [o.strip() for o in settings.frontend_url.split(",") if o.strip()]
# Gộp với origin tĩnh, khử trùng lặp và giữ nguyên thứ tự.
_cors_origins = list(dict.fromkeys(_cors_origins + _STATIC_CORS_ORIGINS))
# Note: `https://h5.zdn.vn` is shared by ALL Zalo Mini Apps, so it can never be a
# trust boundary. Auth never relies on Origin: the Mini App sends a Bearer token
# in the Authorization header (not a cookie), and the manual/web cookie flow is
# SameSite=lax (browsers don't attach it to cross-site fetch/XHR). We still scope
# methods/headers explicitly (instead of "*") to shrink the surface exposed to
# any page served from a shared origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(profiles_router)
app.include_router(room_resources_router)
app.include_router(room_scouts_router)
app.include_router(chat_router)
app.include_router(bookings_router)
app.include_router(bot_router)
app.include_router(zalo_webhook_router)


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/health")
def health_root():
    return {"ok": True}
