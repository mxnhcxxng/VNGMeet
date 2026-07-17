"""FastAPI backend entrypoint for VNG Meet."""

from __future__ import annotations

from contextlib import asynccontextmanager

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
from .chat import router as chat_router
from .profiles import router as profiles_router
from .room_resources import router as room_resources_router
from .room_scouts import process_room_scouts, router as room_scouts_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start background jobs when their required integrations are configured."""
    scheduler = None
    if settings.supabase_enabled and not settings.availability_refresh_disabled:
        from apscheduler.schedulers.asyncio import AsyncIOScheduler
        from apscheduler.triggers.cron import CronTrigger

        scheduler = AsyncIOScheduler(timezone=settings.timezone)
        if settings.graph_app_enabled:
            scheduler.add_job(
                _safe_refresh,
                CronTrigger(
                    minute=settings.availability_refresh_minutes,
                    timezone=settings.timezone,
                ),
                id="refresh_availability",
                max_instances=1,
                coalesce=True,
                misfire_grace_time=120,
            )
        else:
            # No app-only creds: refresh the cache every minute with the newest
            # active delegated token from graph_token_pool, so user requests
            # never have to refresh Graph themselves.
            scheduler.add_job(
                _safe_refresh_from_pool,
                CronTrigger(minute="*", timezone=settings.timezone),
                id="refresh_availability_pool",
                max_instances=1,
                coalesce=True,
                misfire_grace_time=55,
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
            misfire_grace_time=15,
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
            "prep=%02d:%02d:%02d, fire=%02d:%02d:%02d, catchup=%02d:%02d:%02d",
            booking_schedule.FIRE_TIME,
            booking_schedule.SEND_LEAD_MS,
            prep_h, prep_m, prep_s,
            fire_h, fire_m, fire_s,
            cu_h, cu_m, cu_s,
        )
        scheduler.add_job(
            _safe_process_room_scouts,
            CronTrigger(minute="16,46", second=0, timezone=settings.timezone),
            id="process_room_scouts",
            max_instances=1,
            coalesce=True,
            misfire_grace_time=120,
        )
        if settings.graph_app_enabled:
            scheduler.add_job(_safe_refresh, "date", run_date=None)
        else:
            scheduler.add_job(_safe_refresh_from_pool, "date", run_date=None)
        scheduler.start()
        log.warning(
            "Background scheduler started (availability=%s, scheduled_bookings=True, room_scouts=True, cron minute=%s).",
            "app-only" if settings.graph_app_enabled else "token-pool (*/1)",
            settings.availability_refresh_minutes,
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


async def _safe_refresh() -> None:
    """Scheduler entry point: never let an exception kill the job thread."""
    try:
        from . import availability

        await availability.refresh_availability()
    except Exception as e:  # noqa: BLE001
        log.exception("refresh_availability failed: %s", e)


async def _safe_refresh_from_pool() -> None:
    """Scheduler entry point for the delegated token-pool refresh."""
    try:
        from . import token_pool

        await token_pool.refresh_availability_from_pool()
    except Exception as e:  # noqa: BLE001
        log.exception("refresh_availability_from_pool failed: %s", e)


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
    try:
        await process_room_scouts()
    except Exception as e:  # noqa: BLE001
        log.exception("process_room_scouts failed: %s", e)


app = FastAPI(title="VNG Meet — Meeting Room Availability", lifespan=lifespan)

app.add_middleware(SessionMiddleware, secret_key=settings.session_secret, same_site="lax")
_cors_origins = [o.strip() for o in settings.frontend_url.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(profiles_router)
app.include_router(room_resources_router)
app.include_router(room_scouts_router)
app.include_router(chat_router)
app.include_router(bookings_router)


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/health")
def health_root():
    return {"ok": True}
