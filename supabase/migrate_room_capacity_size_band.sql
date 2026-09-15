-- Chạy một lần trong Supabase SQL Editor.
--
-- Cột generated `meeting_room_metadata.capacity_size` đang thiếu capacity = 5:
-- nhánh medium viết là `capacity >= 6 and capacity <= 8`, nên phòng 5 chỗ rơi
-- vào `else null` thay vì 'medium'. Quy ước đúng: <=4 small, 5-8 medium, >8 large.
--
-- Cột là GENERATED ... STORED nên không ALTER được biểu thức — phải drop rồi
-- add lại. Dữ liệu không mất gì (giá trị được tính lại từ `capacity`), và hiện
-- không có index/view/policy nào tham chiếu cột này.
alter table meeting_room_metadata
  drop column if exists capacity_size;

alter table meeting_room_metadata
  add column capacity_size text generated always as (
    case
      when capacity is null then null::text
      when capacity <= 4 then 'small'::text
      when capacity between 5 and 8 then 'medium'::text
      when capacity > 8 then 'large'::text
      else null::text
    end
  ) stored;
