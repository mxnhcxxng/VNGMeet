-- Room-usage lifecycle for user_activity: `ongoing` / `finished` + a `note` column.
--
-- Problem this fixes: once the room mailbox accepted an invite the row went
-- `success`, and everything after that was decided by the per-user calendar sync
-- that only runs when someone opens the app. By then Outlook had already flipped
-- the room's response to "declined" — which is what a room does BOTH when it
-- auto-releases an un-checked-in booking AND when someone checks out early — so
-- normal, successful room usage landed in history as `failed` + `room_declined`,
-- indistinguishable from a booking that never got the room at all.
--
-- The fix reads the room's OWN free/busy, which the availability job already
-- refreshes every minute, and drives the row from that (see
-- availability._reconcile_room_usage).
--
-- Status lifecycle after this migration:
--   pending  -> booking created / scheduled, awaiting the room
--   ok       -> event placed on the calendar, still awaiting the room's response
--   success  -> the room accepted, meeting has not started yet
--   ongoing  -> the meeting has started and the room still holds the slot
--   finished -> the room held the slot into the meeting, then released it (early
--               check-out) or the meeting ran to its end_time
--   canceled -> the slot was released before the meeting could be used (cancelled
--               in Outlook, or auto-released because nobody checked in), or the
--               user cancelled from the app
--   failed   -> the room declined BEFORE accepting, or the booking errored
--
-- `note` is a backend-only diagnostic breadcrumb. It is deliberately NOT returned
-- by /api/bookings and never rendered — it exists so the row's outcome can be
-- explained from the DB alone.

alter table user_activity add column if not exists note text;

comment on column user_activity.note is
  'Backend-only diagnostic breadcrumb for the room-usage lifecycle (see '
  'availability._reconcile_room_usage). Machine-readable English codes, never '
  'shown in the UI: canceled_outlook | room_auto_canceled | canceled_by_user | '
  'canceled_unverified | "finished_at HH:MM" | "finished_unverified HH:MM".';

alter table user_activity
  drop constraint if exists user_activity_status_check;
alter table user_activity
  add constraint user_activity_status_check check (
    status in ('ok', 'failed', 'pending', 'canceled', 'success', 'ongoing', 'finished')
  );

-- The reconcile runs once a minute and scans exactly this set: accepted/running
-- bookings inside the availability window. Partial so it stays tiny — a row drops
-- out of the index the moment it reaches a terminal status.
create index if not exists idx_user_activity_room_usage
  on user_activity (date, status)
  where status in ('success', 'ongoing');

-- OPTIONAL one-time backfill. The reconcile only sweeps the last
-- availability.USAGE_SWEEP_DAYS days, so `success` rows older than that keep the
-- old status forever and history reads inconsistently (old meetings "Thành công",
-- new ones "Đã kết thúc"). Uncomment to close them out; the note flags that the
-- outcome was inferred, not observed.
--
-- update user_activity
-- set status = 'finished',
--     note = 'finished_unverified ' || left(end_time, 5)
-- where status = 'success'
--   and date < current_date - interval '7 days';
