-- Find meeting_room_metadata rows that are identical except for their id.
-- Read-only. Each result row is one group of duplicates.
--
-- `ignore` lists the columns left out of the comparison. Strictly "everything
-- but id" is just 'id'; timestamps (created_at / updated_at) usually differ
-- between copies, so they're ignored too — remove them from the array for a
-- strict match.

with ignore(cols) as (
  values (array['id', 'created_at', 'updated_at'])
),
rows as (
  select m.id, to_jsonb(m) - (select cols from ignore) as body
  from meeting_room_metadata m
)
select
  body ->> 'name'   as name,
  body ->> 'office' as office,
  body ->> 'floor'  as floor,
  count(*)          as copies,
  array_agg(id order by id) as ids,
  body              as row_without_ids
from rows
group by body
having count(*) > 1
order by name, office;
