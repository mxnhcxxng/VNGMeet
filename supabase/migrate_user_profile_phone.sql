-- Store the user's mobile phone (from Graph `mobilePhone`) on their profile.
--
-- The backend normalizes the value to local VN format when calling Graph /me:
-- the +84 prefix is trimmed to a leading 0 (e.g. "+84 912 345 678" -> "0912345678").
alter table user_profiles add column if not exists phone text;
