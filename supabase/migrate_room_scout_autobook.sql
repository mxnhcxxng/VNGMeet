-- Room Scout auto-booking migration.
--
-- Scout stops being notify-only and starts creating real bookings. Two changes:
--   1. Booking-history rows may now carry booking_type = 'scout'.
--   2. A scout tracks its in-flight (pending) auto-booking so the next processing
--      cycle can re-check whether the room accepted/declined.
-- Idempotent — safe to run more than once.

-- Allow the new 'scout' booking type on booking history rows.
alter table user_activity drop constraint if exists user_activity_booking_type_check;
alter table user_activity
  add constraint user_activity_booking_type_check
  check (booking_type in ('instant', 'scheduled', 'scout'));

-- Track a scout's in-flight (pending) auto-booking so the next cycle can re-check it.
alter table room_scouts
  add column if not exists pending_activity_id uuid
  references public.user_activity(id) on delete set null;
