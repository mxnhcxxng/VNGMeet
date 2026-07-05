-- Add the 'success' status to user_activity.
--
-- Status lifecycle:
--   pending  -> booking created / scheduled, awaiting the room
--   ok       -> event placed on the calendar (scheduled booking fired), still
--               awaiting the room's response
--   success  -> the room accepted the invite
--   failed   -> the room declined, or the booking errored
--   canceled -> the event was removed from the calendar
alter table user_activity
  drop constraint if exists user_activity_status_check;
alter table user_activity
  add constraint user_activity_status_check
  check (status in ('ok', 'failed', 'pending', 'canceled', 'success'));
