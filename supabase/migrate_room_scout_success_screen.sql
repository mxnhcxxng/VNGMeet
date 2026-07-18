-- Room Scout success screen: persist the auto-booked room + exact window on the
-- scout row so the Scout Room tab can show a "we found a room" screen, and track
-- when the user dismisses it via the "Great" button.
alter table room_scouts add column if not exists booked_room_email text;
alter table room_scouts add column if not exists booked_start_time text;
alter table room_scouts add column if not exists booked_end_time text;
alter table room_scouts add column if not exists acknowledged_at timestamptz;
