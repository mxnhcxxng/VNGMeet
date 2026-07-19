"""Chat assistant routes and tool handlers."""

from __future__ import annotations

import json
from datetime import date as date_cls, datetime, timedelta, timezone
from uuid import uuid4
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, HTTPException, Request

from . import auth, availability, graph
from .app_context import _live_availability_horizon_end, log, settings
from .models import (
    BookingRequest,
    ChatBookingActionRequest,
    ChatFeedbackRequest,
    ChatSendRequest,
    ChatThreadRenameRequest,
)
from .profiles import (
    _booking_auth_context,
    _claims_from_bearer,
    _profile_payload,
    _read_user_profile,
    _upsert_user_profile,
)
from .room_resources import _availability_slot_index, _ensure_availability_cache_fresh

router = APIRouter()


async def _create_booking_via_bookings(request: Request, payload: BookingRequest) -> dict:
    from .bookings import create_booking

    return await create_booking(request, payload)


def _set_book_without_confirmation(user_profile_id: str | None, value: bool) -> None:
    from .bookings import _set_book_without_confirmation as set_value

    set_value(user_profile_id, value)

CHAT_BOT_EMAIL = "booking-bot@vngmeet.local"
CHAT_MAX_OPTIONS = 5
# Max number of time windows returned when scanning a flexible search frame
# (ví dụ "chiều nay 1 tiếng" → quét toàn bộ khung 13:00-18:00).
CHAT_MAX_FRAME_SLOTS = 6
CHAT_SYSTEM_PROMPT = """Bạn là trợ lý đặt lịch cho app booking phòng họp.

Phạm vi hỗ trợ:
Chỉ trả lời các câu hỏi liên quan đến đặt lịch, kiểm tra lịch trống, đặt phòng họp, săn phòng (Room Scout), chỉ đường/tìm vị trí phòng họp, đổi lịch hoặc huỷ lịch.
Nếu người dùng hỏi ngoài phạm vi này, hãy trả lời ngắn gọn: “Mình chỉ hỗ trợ các yêu cầu liên quan đến đặt lịch và phòng họp.”

Nhiệm vụ chính:
- Hiểu nhu cầu đặt lịch của người dùng.
- Dùng API/function calling để kiểm tra phòng trống theo thời gian, số người, địa điểm hoặc yêu cầu cụ thể.
- Gợi ý các khung giờ và phòng có thể đặt.
- Trả chỉ đường/map đến phòng họp khi user hỏi vị trí hoặc cách đi đến một phòng.
- Chỉ gợi ý phòng trong office của user theo ngữ cảnh profile, trừ khi profile chưa có office.
- Xác nhận đủ thông tin trước khi chuẩn bị phiếu đặt phòng.
- Gọi API/function calling để tạo phiếu xác nhận đặt phòng; chỉ book thật sau khi người dùng bấm Đồng ý trên card.

Luồng xử lý:
1. Người dùng hỏi có phòng phù hợp không.
2. Kiểm tra thông tin đã có: ngày, giờ bắt đầu, giờ kết thúc hoặc thời lượng, nhu cầu phòng (nhỏ/vừa/lớn), địa điểm/khu vực.
3. Nếu thiếu thông tin cần thiết, hỏi bổ sung ngắn gọn.
   Nếu user chỉ nhập con số hoặc khoảng số mơ hồ (ví dụ "2-4", "3", "2 đến 4") mà không nói rõ đó là ngày (mùng mấy), thứ trong tuần, hay khung giờ, KHÔNG được tự đoán; hãy hỏi lại để làm rõ ý của user là ngày, thứ hay giờ.
   NGOẠI LỆ: nếu con số có kèm đơn vị giờ như "h" hoặc "giờ" (ví dụ "2-4h", "2h-4h", "2 giờ đến 4 giờ", "14-16h", "9-11h"), hiểu ĐÓ LÀ KHUNG GIỜ (giờ bắt đầu đến giờ kết thúc), KHÔNG hỏi lại. Chọn cách hiểu nằm trong giờ làm việc 09:00-18:00 (ví dụ "2-4h" = 14:00-16:00, "9-11h" = 09:00-11:00).
4. Khi đủ thông tin, gọi function kiểm tra lịch/phòng trống. check_room_availability có 2 chế độ, hãy CHỌN ĐÚNG chế độ theo cách user nói giờ:
   - CHẾ ĐỘ CỐ ĐỊNH: user nói RÕ cả giờ bắt đầu và kết thúc cụ thể (ví dụ "9h-12h") → truyền start_time + end_time đúng khoảng đó. Phòng phải trống SUỐT cả khoảng.
   - CHẾ ĐỘ LINH HOẠT (frame): user chỉ nói THỜI LƯỢNG, hoặc KHÔNG nói giờ cụ thể — ví dụ "giờ nào cũng được", "lúc nào cũng được", "buổi sáng", "buổi chiều", "trong ngày", "hôm nay có phòng nào", "ngày mai còn phòng không"... → truyền duration_minutes (ví dụ 60 cho 1 tiếng; nếu user không nói thời lượng, mặc định 60). Nếu user khoanh vùng một buổi thì truyền thêm window_start/window_end của buổi đó (ví dụ chiều → window_start=13:00, window_end=18:00); nếu user KHÔNG khoanh buổi (chỉ nói "hôm nay/ngày mai") thì BỎ TRỐNG window_start/window_end để backend quét cả ngày làm việc. KHÔNG truyền start_time/end_time ở chế độ này, và TUYỆT ĐỐI không tự chọn trước một cửa sổ rồi chỉ kiểm tra mỗi cửa sổ đó. Lưu ý: backend tự cắt các cửa sổ đã qua trong hôm nay (bắt đầu từ mốc 30 phút liền trước hiện tại), bạn không cần tự tính.
   - Ở chế độ linh hoạt, backend tự QUÉT MỌI cửa sổ đúng thời lượng trong khung và trả về mảng `slots` (mỗi phần tử gồm start_time/end_time và danh sách phòng trống của cửa sổ đó). Bạn chỉ việc tổng hợp `slots` để đề xuất; không cần đoán cửa sổ trước.
5. Trả kết quả theo đúng dữ liệu function trả về:
   - Chế độ cố định: `rooms` chứa đầy đủ danh sách phòng trống; ở lần hiển thị kết quả tìm kiếm chỉ liệt kê tối đa 5 phòng đầu, nếu `count` > 5 thì thêm "và N phòng khác" (N = count − số tên đã kê). Khi user hỏi chi tiết các phòng còn lại thì liệt kê đầy đủ từ `rooms`, không giới hạn 5. Nếu trống cả khoảng không có phòng nào, dùng split_suggestions để gợi ý tách phòng; nếu cũng không tách được, dùng alternate_suggestions để gợi ý khung giờ khác cùng thời lượng.
   - Chế độ linh hoạt: liệt kê các khung giờ trong `slots`, trải đều trong buổi user hỏi; nếu `truncated`=true thì nói còn thêm khung khác. Với mỗi khung, `count` là TỔNG số phòng trống, còn `rooms` chứa ĐẦY ĐỦ danh sách phòng (không bị cắt). Ở LẦN TRẢ KẾT QUẢ TÌM KIẾM, mỗi khung chỉ hiển thị TỐI ĐA 5 tên phòng đầu; nếu `count` > 5 thì thêm "và N phòng khác" (N = count − số tên đã kê) — để bảng gọn, dễ đọc. Ở bảng này CHỈ hiển thị TÊN phòng, KHÔNG kèm vị trí (building/floor/zone như "V1-F3", "Red Zone"...) hay sức chứa. Nếu `slots` rỗng thì gợi ý Săn phòng.
   - NHƯNG khi user hỏi chi tiết về số phòng còn lại (ví dụ "5 phòng khác là phòng nào", "liệt kê hết đi"), hãy trả lời ĐẦY ĐỦ tất cả phòng trong `rooms` của khung tương ứng, KHÔNG giới hạn 5 nữa. Giới hạn 5 chỉ áp dụng cho lần hiển thị bảng tìm kiếm ban đầu.
6. Khi người dùng chọn phòng, kiểm tra lại các trường bắt buộc để đặt lịch.
7. Khi người dùng muốn đặt phòng, gọi function book_room cho đặt tức thì hoặc schedule_room cho scheduled booking để tạo card xác nhận với các thông tin đã điền.
8. Xử lý kết quả book_room/schedule_room theo trường trả về:
   - Nếu trả về requires_confirmation=true: KHÔNG nói đã đặt phòng; chỉ nói người dùng kiểm tra card và bấm Đồng ý hoặc Từ chối.
   - Nếu trả về booked=true (user đã bật chế độ đặt phòng không cần xác nhận): báo luôn kết quả. Nếu pending=true thì nói scheduled booking đã được tạo và sẽ tự đặt khi lịch mở; nếu không thì chỉ cần báo đặt phòng thành công. KHÔNG trả link Outlook/calendar hay bất kỳ link xác nhận nào. Sau đó BẮT BUỘC gọi get_room_directions cho phòng vừa đặt và đính kèm map dưới dạng ẢNH (không phải link).
   - Nếu ok=false: báo thất bại kèm lý do và đề xuất phòng/giờ khác.
9. Báo kết quả đặt phòng thành công hoặc thất bại sau khi hệ thống nhận action từ card.

Luồng chỉ đường:
- Khi user hỏi "chỉ đường", "đường đến", "map", "ở đâu", "vị trí" kèm tên phòng, gọi function get_room_directions.
- Nếu tìm thấy phòng, trả tên phòng, office/building/floor/zone nếu có, direction nếu có, và ẢNH map nếu có map_link. KHÔNG trả map dưới dạng link, chỉ trả dưới dạng ảnh.
- Nếu user chỉ nói tên như "Chỉ đường đến Tokyo", hiểu Tokyo là tên phòng.
- Nếu user nhập một tên có vẻ là tên phòng nhưng sai chính tả hoặc gần giống một tên phòng đã biết (ví dụ "Tokio" thay vì "Tokyo", "Singapor" thay vì "Singapore"), đừng tự đoán chắc chắn; hãy hỏi lại để xác nhận có phải user muốn nói đến phòng đó không trước khi tra cứu hoặc đặt.
- Nếu dữ liệu direction/map note trong DB là tiếng Anh nhưng user hỏi bằng tiếng Việt, hãy dịch/diễn đạt lại phần hướng dẫn sang tiếng Việt tự nhiên; không trả nguyên văn tiếng Anh trừ tên riêng, tầng, toà nhà, khu vực hoặc landmark.

Luồng Săn phòng (Room Scout):
- Khi user muốn "săn phòng", "theo dõi phòng trống", "báo khi có phòng", hoặc đồng ý bật Săn phòng sau khi bạn gợi ý, hãy thu thập đủ thông tin rồi gọi function create_room_scout để bật.
- Các trường cần cho create_room_scout (giống form Săn phòng trong app): scout_date (YYYY-MM-DD, từ hôm nay đến tối đa 14 ngày tới), duration_minutes (thời lượng cần), scout_start_time và scout_end_time (khung giờ săn HH:MM, giờ làm việc 09:00-18:00, khung phải dài ít nhất bằng thời lượng), capacity_sizes (nhu cầu sức chứa: small/medium/large, có thể nhiều).
- Cuối tuần: scout_date VẪN nhận Thứ 7/Chủ nhật NẾU user chủ động yêu cầu săn đúng ngày cuối tuần đó; nhưng KHÔNG tự gợi ý/đề xuất ngày cuối tuần khi bạn chọn ngày giúp user.
- Xác định thời lượng & khung giờ săn: nếu user nói RÕ giờ bắt đầu và kết thúc (ví dụ "9h-11h", "14:00 đến 16:00") → đặt scout_start_time/scout_end_time đúng khoảng đó và TỰ MAP duration_minutes = số phút từ bắt đầu đến kết thúc, KHÔNG hỏi lại thời lượng. Nếu user CHỈ nói THỜI LƯỢNG (ví dụ "1 tiếng", "90 phút") mà chưa nói khung giờ → HỎI THÊM khung giờ muốn săn (giờ bắt đầu và kết thúc) rồi mới bật.
- Khung giờ theo buổi: user nói "sáng" → khung auto 09:00-12:00; "chiều" → khung auto 13:00-18:00 (trưa là 12:00-13:00). Với khung theo buổi vẫn cần thời lượng; nếu user chưa nói thời lượng thì hỏi thêm.
- Nếu scout_date là HÔM NAY: scout_start_time KHÔNG được lấy giờ đã qua — làm tròn tới mốc :00 hoặc :30 gần nhất tính từ thời điểm hiện tại; nếu mốc đó đã qua thì lấy mốc :00/:30 kế tiếp (ví dụ bây giờ 14:12 → 14:30, 14:35 → 15:00). Áp dụng cho cả khung "sáng/chiều" khi rơi vào hôm nay.
- Nếu user không nói sức chứa, mặc định capacity_sizes = ["medium"] (vừa).
- TUYỆT ĐỐI KHÔNG hỏi office. Office tự lấy theo profile của user; đừng đưa office vào câu hỏi hay vào tham số.
- ignore_lunch_break: khi khung giờ [scout_start_time, scout_end_time) có giao với giờ nghỉ trưa 12:00-13:00 (ví dụ 11:30-14:00, hoặc 12:30-15:00), MẶC ĐỊNH đặt ignore_lunch_break = true (tự động chấp nhận đặt phòng trong giờ nghỉ trưa), KHÔNG cần hỏi user; chỉ đặt false khi user chủ động nói không muốn đặt phòng vào giờ nghỉ trưa. Nếu khung giờ KHÔNG chạm 12:00-13:00 (ví dụ 09:00-11:00 hoặc 14:00-17:00) thì để mặc định false.
- Nếu thiếu trường bắt buộc nào (ngày, thời lượng, khung giờ, sức chứa), hỏi bổ sung ngắn gọn trước khi gọi function. Xác nhận lại thông tin với user trước khi bật.
- Xử lý kết quả create_room_scout: nếu ok=true và created=true thì báo đã bật Săn phòng thành công, tóm tắt ngày/khung giờ/thời lượng/sức chứa, và nói hệ thống sẽ email khi có phòng trống; nhắc user có thể vào trang [Săn phòng](/room-scout) để theo dõi hoặc dừng. Nếu ok=false thì báo lý do (ví dụ chưa cấp quyền Mail.Send, đang có phiên săn phòng khác, hoặc thông tin không hợp lệ) và hướng dẫn user xử lý.
- Huỷ/dừng Săn phòng: khi user muốn DỪNG/HUỶ/TẮT săn phòng, xác định outcome rồi gọi cancel_room_scout:
  • Nếu user ĐÃ NÓI RÕ đã đặt/tìm được phòng (ví dụ "tìm được phòng rồi, dừng săn đi", "đặt được phòng rồi huỷ giúp") → gọi ngay với outcome='success', KHÔNG hỏi lại.
  • Nếu user nói rõ chưa đặt được / chỉ muốn dừng (ví dụ "chưa được, tắt đi") → outcome='canceled', không cần hỏi.
  • Nếu KHÔNG rõ user đã đặt được phòng hay chưa (chỉ nói chung chung "huỷ săn phòng", "dừng săn phòng") → HỎI "Bạn đã đặt được phòng chưa?" rồi gọi theo câu trả lời.
  Xử lý kết quả: nếu stopped=true thì báo đã dừng phiên Săn phòng (nếu outcome='success' có thể chúc mừng user đã đặt được phòng); nếu stopped=false với reason=no_active_scout thì báo user hiện không có phiên Săn phòng nào đang chạy; nếu ok=false thì báo lý do.

Nguyên tắc phản hồi:
- Trả lời ngắn gọn, rõ ràng, tập trung vào hành động tiếp theo.
- Trả lời cùng ngôn ngữ với người dùng. Nếu user hỏi tiếng Việt, toàn bộ câu trả lời nên là tiếng Việt tự nhiên, kể cả hướng dẫn đường đi lấy từ metadata tiếng Anh.
- Không hỏi số lượng người tham dự. Phân loại nhu cầu phòng: nhỏ (4 người) = small, vừa (5-12 người) = medium, lớn (13+ người) = large. Nếu user tự nói rõ con số hoặc nói nhỏ/vừa/lớn thì quy thành capacity_size rồi truyền đi. Nếu user KHÔNG nói gì về sức chứa/nhu cầu phòng, MẶC ĐỊNH dùng size vừa (medium) — KHÔNG hỏi lại; có thể nói ngắn gọn rằng đang mặc định phòng vừa và user muốn đổi thì cứ báo.
- NGOẠI LỆ: nếu user đã gọi đích danh một phòng cụ thể (ví dụ "đặt phòng Barcelona", "Tokyo còn trống không"), thì KHÔNG hỏi về nhu cầu phòng/size nữa (hỏi size lúc này vô nghĩa vì user đã chốt phòng). Khi đó truyền tên phòng vào trường location và bỏ qua capacity_size/capacity. Chỉ hỏi size khi user nói chung chung về loại/sức chứa phòng mà chưa chỉ rõ phòng nào.
- Sức chứa phòng được phân loại theo cột capacity_size (small/medium/large), không dựa trên con số capacity thô. Khi hiển thị sức chứa cho user, LUÔN dùng capacity_size quy đổi sang tiếng Việt: small = "Nhỏ", medium = "Vừa", large = "Lớn"; TUYỆT ĐỐI không hiển thị số người cụ thể (ví dụ "6 người", "12 người").
- Ưu tiên ngày làm việc (Thứ 2 đến Thứ 6). Vẫn ĐẶT ĐƯỢC phòng vào Thứ 7/Chủ nhật NẾU user chủ động hỏi/yêu cầu đúng ngày cuối tuần đó — khi đó cứ kiểm tra và đặt bình thường. NHƯNG TUYỆT ĐỐI KHÔNG tự gợi ý/đề xuất ngày Thứ 7 hoặc Chủ nhật: khi bạn tự chọn ngày thay thế hay gợi ý khung giờ, chỉ đưa ra ngày làm việc T2-T6, không bao giờ đưa ngày cuối tuần trừ khi chính user nêu ngày đó.
- Do giới hạn hệ thống, chỉ đặt được phòng tối đa 15 ngày kể từ hôm nay (tính cả hôm nay là ngày thứ 0, ví dụ hôm nay 16/6 thì ngày xa nhất đặt được là 1/7). Nếu user yêu cầu ngày xa hơn, báo ngắn gọn rằng chỉ đặt được trong vòng 15 ngày tới và gợi ý ngày hợp lệ gần nhất. Không kiểm tra phòng trống hay tạo card đặt phòng cho ngày vượt quá giới hạn này.
- Không bịa phòng, giờ trống hoặc trạng thái booking nếu chưa có dữ liệu từ API.
- Nếu API không trả về phòng phù hợp, trước tiên dùng split_suggestions/alternate_suggestions để gợi ý tách phòng hoặc khung giờ khác cùng thời lượng. Sau khi đã đưa các gợi ý đó, LUÔN thêm ở phía cuối một đề xuất dùng thử Room Scout (tên tiếng Việt là "Săn phòng"): nói rằng nếu user vẫn muốn giữ đúng khung giờ đã yêu cầu, có thể vào trang Săn phòng để hệ thống tự theo dõi; khi có phòng được nhả ra trong khung giờ đó, hệ thống sẽ báo cho user (qua email). BẮT BUỘC để tên "Săn phòng" dưới dạng hyperlink markdown trỏ tới đường dẫn /room-scout, ví dụ: [Săn phòng](/room-scout). Room Scout/Săn phòng hỗ trợ ngày từ hôm nay đến 14 ngày tới. Nếu user muốn, bạn có thể tự bật Săn phòng bằng function create_room_scout (xem "Luồng Săn phòng" bên dưới); nếu user chưa muốn thì chỉ gợi ý qua hyperlink [Săn phòng](/room-scout).
- Nếu người dùng không nói tên cuộc họp, để trống subject; hệ thống sẽ tự điền tên mặc định.
- Nếu đặt lịch ngoài vùng live availability/schedule-bookable, truyền booking_type="scheduled"; còn đặt tức thì thì booking_type="instant".
- Trả nhiều option hữu ích nhưng tối đa 5 option.
- Khi liệt kê/gợi ý phòng, KHÔNG hiển thị map hay ảnh map. Chỉ hiển thị map trong 2 trường hợp: (1) user hỏi vị trí/chỉ đường (gọi get_room_directions), hoặc (2) sau khi đặt phòng thành công thì gọi get_room_directions cho phòng vừa đặt để đính kèm map. Trong cả 2 trường hợp, map phải được trả dưới dạng ẢNH map, không trả dưới dạng link.
- Không hỏi thêm về thiết bị phòng họp.
- Nếu book thất bại, giải thích lý do nếu API có trả về và đề xuất thử phòng/giờ khác.
- Nếu kết quả function trả về ok=false với lý do token/phiên Microsoft sắp hết hạn (nội dung có các bước "làm mới token" và link Microsoft Graph Explorer — xảy ra khi tạo scheduled booking hoặc bật/cập nhật Săn phòng mà token không còn đủ hạn tới lúc tác vụ chạy), hãy TRUYỀN LẠI NGUYÊN VĂN thông báo đó cho user: giữ đủ các bước đánh số 1-4 và link [Microsoft Graph Explorer], KHÔNG rút gọn, KHÔNG diễn giải lại. KHÔNG đề xuất phòng/giờ khác trong trường hợp này vì lỗi là do token, không phải do phòng.
- Nếu người dùng muốn đổi lịch hoặc huỷ lịch, hiện app chưa có API đổi/huỷ; hãy xin thông tin và nói ngắn gọn rằng bạn chưa thể thực hiện tự động trong phiên bản này.
"""


CHAT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "check_room_availability",
            "description": (
                "Kiểm tra phòng họp còn trống theo ngày, sức chứa và khu vực. "
                "Hỗ trợ 2 chế độ:\n"
                "1) Khung giờ CỐ ĐỊNH: user nói rõ giờ bắt đầu và kết thúc → "
                "truyền start_time + end_time; kiểm tra đúng một khoảng đó.\n"
                "2) LINH HOẠT (frame): user chỉ nói thời lượng, hoặc nói 'buổi "
                "sáng/trưa/chiều', 'giờ nào cũng được', 'trong ngày'... → truyền "
                "duration_minutes (+ window_start/window_end nếu muốn giới hạn "
                "khung tìm kiếm, ví dụ chiều = 13:00 đến 18:00). Backend sẽ tự "
                "QUÉT TẤT CẢ các cửa sổ dài đúng thời lượng trong khung và trả về "
                "danh sách `slots` các khung giờ trống. KHÔNG cần bạn tự chọn "
                "trước một cửa sổ."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "date": {
                        "type": "string",
                        "description": "Ngày cần đặt, định dạng YYYY-MM-DD.",
                    },
                    "start_time": {
                        "type": "string",
                        "description": "CHẾ ĐỘ CỐ ĐỊNH: giờ bắt đầu HH:MM (timezone Asia/Ho_Chi_Minh). Chỉ dùng khi user nói rõ cả giờ bắt đầu và kết thúc; khi đó bỏ trống duration_minutes.",
                    },
                    "end_time": {
                        "type": "string",
                        "description": "CHẾ ĐỘ CỐ ĐỊNH: giờ kết thúc HH:MM (timezone Asia/Ho_Chi_Minh). Đi kèm với start_time.",
                    },
                    "duration_minutes": {
                        "type": "integer",
                        "description": "CHẾ ĐỘ LINH HOẠT: thời lượng cần (phút), ví dụ 60 cho 1 tiếng. Dùng khi user chỉ nói thời lượng hoặc linh hoạt về giờ. Khi truyền trường này thì KHÔNG truyền start_time/end_time.",
                    },
                    "window_start": {
                        "type": "string",
                        "description": "CHẾ ĐỘ LINH HOẠT: giờ bắt đầu của khung tìm kiếm HH:MM (ví dụ buổi chiều = 13:00). Mặc định đầu giờ làm việc nếu bỏ trống.",
                    },
                    "window_end": {
                        "type": "string",
                        "description": "CHẾ ĐỘ LINH HOẠT: giờ kết thúc của khung tìm kiếm HH:MM (ví dụ buổi chiều = 18:00). Mặc định cuối giờ làm việc nếu bỏ trống.",
                    },
                    "capacity_size": {
                        "type": "string",
                        "enum": ["small", "medium", "large"],
                        "description": "Nhu cầu phòng do user chọn: small = nhỏ (4 người), medium = vừa (5-12 người), large = lớn (13+ người). Ưu tiên dùng trường này thay vì hỏi số người.",
                    },
                    "capacity": {
                        "type": "integer",
                        "description": "Số người tham dự, chỉ dùng khi user tự nói rõ con số. Backend map <=4 thành small, 5-12 thành medium, 13+ thành large.",
                    },
                    "location": {
                        "type": "string",
                        "description": "Địa điểm/khu vực/tầng/toà/office user yêu cầu.",
                    },
                },
                "required": ["date"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_room_directions",
            "description": "Lấy thông tin vị trí/chỉ đường/map đến một phòng họp theo tên phòng.",
            "parameters": {
                "type": "object",
                "properties": {
                    "room_name": {
                        "type": "string",
                        "description": "Tên phòng user muốn tìm/chỉ đường đến, ví dụ Tokyo.",
                    },
                },
                "required": ["room_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "book_room",
            "description": "Tạo card xác nhận đặt phòng với thông tin đã điền; chưa đặt phòng thật.",
            "parameters": {
                "type": "object",
                "properties": {
                    "room_email": {"type": "string", "description": "Email phòng họp."},
                    "room_name": {"type": "string", "description": "Tên phòng họp."},
                    "date": {"type": "string", "description": "Ngày đặt, định dạng YYYY-MM-DD."},
                    "start_time": {"type": "string", "description": "Giờ bắt đầu HH:MM."},
                    "end_time": {"type": "string", "description": "Giờ kết thúc HH:MM."},
                    "subject": {"type": "string", "description": "Tiêu đề cuộc họp; để trống nếu user không nói tên, hệ thống sẽ tự điền."},
                    "attendees": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Email người tham dự, nếu có.",
                    },
                    "body": {"type": "string", "description": "Nội dung mô tả cuộc họp."},
                    "booking_type": {
                        "type": "string",
                        "enum": ["instant", "scheduled"],
                        "description": "instant cho booking live; scheduled cho ngày/slot schedule-bookable.",
                    },
                },
                "required": ["date", "start_time", "end_time"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "schedule_room",
            "description": "Tạo card xác nhận scheduled booking; chưa đặt phòng thật cho đến khi user bấm Đồng ý.",
            "parameters": {
                "type": "object",
                "properties": {
                    "room_email": {"type": "string", "description": "Email phòng họp."},
                    "room_name": {"type": "string", "description": "Tên phòng họp."},
                    "date": {"type": "string", "description": "KHÔNG dùng cho scheduled booking — hệ thống tự cố định ngày (ngày xa nhất mở đặt lúc 00:00). Bỏ trống và TUYỆT ĐỐI KHÔNG hỏi user chọn ngày."},
                    "start_time": {"type": "string", "description": "Giờ bắt đầu HH:MM."},
                    "end_time": {"type": "string", "description": "Giờ kết thúc HH:MM."},
                    "subject": {"type": "string", "description": "Tiêu đề cuộc họp; để trống nếu user không nói tên, hệ thống sẽ tự điền."},
                    "attendees": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Email người tham dự, nếu có.",
                    },
                    "body": {"type": "string", "description": "Nội dung mô tả cuộc họp."},
                },
                "required": ["start_time", "end_time"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_room_scout",
            "description": (
                "Bật Săn phòng (Room Scout): hệ thống tự theo dõi và gửi email cho "
                "user khi có phòng trống đúng ngày / khung giờ / thời lượng / sức "
                "chứa yêu cầu. Chỉ gọi khi user đã đồng ý bật Săn phòng và đã đủ "
                "thông tin. KHÔNG hỏi office — office tự lấy theo profile của user. "
                "Chỉ hỏi/đặt ignore_lunch_break khi khung giờ "
                "[scout_start_time, scout_end_time) có giao với giờ nghỉ trưa "
                "12:00-13:00; nếu khung giờ không chạm giờ trưa thì BỎ QUA, để mặc "
                "định false."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "scout_date": {
                        "type": "string",
                        "description": "Ngày cần săn phòng, định dạng YYYY-MM-DD. Từ hôm nay đến tối đa 14 ngày tới.",
                    },
                    "duration_minutes": {
                        "type": "integer",
                        "description": "Thời lượng cuộc họp cần (phút), ví dụ 60 cho 1 tiếng. Thường 30/60/90/120/150/180.",
                    },
                    "scout_start_time": {
                        "type": "string",
                        "description": "Giờ bắt đầu khung săn HH:MM (giờ làm việc 09:00-18:00).",
                    },
                    "scout_end_time": {
                        "type": "string",
                        "description": "Giờ kết thúc khung săn HH:MM. Phải sau scout_start_time và khung phải dài ít nhất bằng duration_minutes.",
                    },
                    "capacity_sizes": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "enum": ["small", "medium", "large"],
                        },
                        "description": "Nhu cầu sức chứa phòng: small = nhỏ (4 người), medium = vừa (5-12 người), large = lớn (13+ người). Có thể chọn nhiều.",
                    },
                    "ignore_lunch_break": {
                        "type": "boolean",
                        "description": "Cho phép phòng trống vắt qua giờ nghỉ trưa 12:00-13:00. CHỈ đặt trường này khi khung giờ có giao 12:00-13:00; nếu không giao, để mặc định false.",
                    },
                },
                "required": [
                    "scout_date",
                    "duration_minutes",
                    "scout_start_time",
                    "scout_end_time",
                    "capacity_sizes",
                ],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cancel_room_scout",
            "description": (
                "Dừng phiên Săn phòng (Room Scout) đang chạy của user. Chọn outcome: "
                "user đã đặt/tìm được phòng thì outcome='success', chưa (chỉ muốn dừng) "
                "thì outcome='canceled'. Nếu tin nhắn của user đã cho biết rõ đã đặt "
                "được phòng hay chưa thì gọi luôn với outcome tương ứng, KHÔNG hỏi lại; "
                "chỉ hỏi khi chưa rõ. User chỉ có tối đa một phiên đang chạy nên không "
                "cần id."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "outcome": {
                        "type": "string",
                        "enum": ["success", "canceled"],
                        "description": "success = user đã đặt/tìm được phòng; canceled = user chưa đặt được, chỉ muốn dừng săn.",
                    },
                },
                "required": ["outcome"],
            },
        },
    },
]


def _require_supabase_chat():
    if not settings.supabase_enabled:
        raise HTTPException(503, "Chat history requires Supabase configuration.")
    from .supabase_client import get_supabase

    return get_supabase()


def _current_user_profile_id(request: Request) -> str:
    if request.headers.get("Authorization", "").startswith("Bearer "):
        claims = _claims_from_bearer(request)
    else:
        token = auth.get_manual_token(auth.session_id(request))
        if not token:
            raise HTTPException(401, "Not authenticated")
        claims = auth.get_manual_claims(auth.session_id(request))
    profile_id = _upsert_user_profile(claims)
    if not profile_id:
        raise HTTPException(503, "Could not resolve user profile for chat.")
    return profile_id


def _bot_profile_id(sb) -> str:
    res = (
        sb.table("user_profiles")
        .upsert(
            {
                "email": CHAT_BOT_EMAIL,
                "last_seen_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
            on_conflict="email",
        )
        .execute()
    )
    if res.data and res.data[0].get("id"):
        return str(res.data[0]["id"])
    rows = (
        sb.table("user_profiles")
        .select("id")
        .eq("email", CHAT_BOT_EMAIL)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        raise HTTPException(503, "Could not initialize chat bot profile.")
    return str(rows[0]["id"])


def _assert_thread_owner(sb, thread_id: str, user_profile_id: str) -> dict:
    rows = (
        sb.table("thread")
        .select("id, user_id, title, created_at, updated_at")
        .eq("id", thread_id)
        .eq("user_id", user_profile_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        raise HTTPException(404, "Thread not found.")
    return rows[0]


def _create_thread(sb, user_profile_id: str, content: str) -> dict:
    title = content.strip().replace("\n", " ")
    if len(title) > 64:
        title = title[:61].rstrip() + "..."
    rows = (
        sb.table("thread")
        .insert({"user_id": user_profile_id, "title": title or "Chat mới"})
        .execute()
        .data
        or []
    )
    if not rows:
        raise HTTPException(503, "Could not create chat thread.")
    return rows[0]


def _insert_chat_message(
    sb,
    thread_id: str,
    from_user_id: str,
    to_user_id: str,
    content: str,
    metadata: dict | None = None,
) -> dict:
    rows = (
        sb.table("messages")
        .insert(
            {
                "thread_id": thread_id,
                "from_user_id": from_user_id,
                "to_user_id": to_user_id,
                "content": content,
                "metadata": metadata or {},
            }
        )
        .execute()
        .data
        or []
    )
    if not rows:
        raise HTTPException(503, "Could not save chat message.")
    sb.table("thread").update(
        {"updated_at": datetime.now(timezone.utc).isoformat()}
    ).eq("id", thread_id).execute()
    return rows[0]


def _message_role(row: dict, bot_profile_id: str) -> str:
    return "assistant" if str(row.get("from_user_id")) == bot_profile_id else "user"


def _chat_message_response(row: dict, role: str) -> dict:
    return {
        "id": row["id"],
        "role": role,
        "content": row.get("content") or "",
        "created_at": row.get("created_at"),
        "metadata": row.get("metadata") or {},
        "feedback": row.get("feedback"),
    }


def _chat_messages_for_llm(sb, thread_id: str, bot_profile_id: str) -> list[dict]:
    rows = (
        sb.table("messages")
        .select("from_user_id, content, created_at")
        .eq("thread_id", thread_id)
        .order("created_at", desc=True)
        .limit(30)
        .execute()
        .data
        or []
    )
    return [
        {"role": _message_role(row, bot_profile_id), "content": row.get("content") or ""}
        for row in reversed(rows)
    ]


def _llm_text(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        text = value.get("text") or value.get("content")
        if isinstance(text, (str, list, dict)):
            return _llm_text(text)
        return ""
    if isinstance(value, list):
        chunks: list[str] = []
        for item in value:
            if isinstance(item, (str, dict, list)):
                chunks.append(_llm_text(item))
            elif item:
                chunks.append(str(item))
        return "".join(chunks)
    return str(value or "")


def _llm_reasoning_text(message: dict) -> str:
    chunks: list[str] = []
    for key in ("reasoning_content", "reasoning", "reasoning_text"):
        text = _llm_text(message.get(key)).strip()
        if text:
            chunks.append(text)

    details = message.get("reasoning_details")
    if isinstance(details, list):
        for item in details:
            if isinstance(item, dict):
                text = _llm_text(item.get("text") or item.get("content")).strip()
                if text:
                    chunks.append(text)
            else:
                text = _llm_text(item).strip()
                if text:
                    chunks.append(text)

    return "\n\n".join(dict.fromkeys(chunks))


def _assistant_content_with_reasoning(
    message: dict,
    prior_reasoning: list[str] | None = None,
) -> str:
    content = _llm_text(message.get("content")).strip()
    reasoning_parts = [part for part in (prior_reasoning or []) if part.strip()]
    current_reasoning = _llm_reasoning_text(message)
    if current_reasoning:
        reasoning_parts.append(current_reasoning)

    reasoning = "\n\n".join(dict.fromkeys(reasoning_parts)).strip()
    if not reasoning or "<think" in content.lower():
        return content
    if not content:
        return f"<think>\n{reasoning}\n</think>"
    return f"<think>\n{reasoning}\n</think>\n\n{content}"


def _chat_completion_url() -> str:
    if not settings.llm_base_url or not settings.llm_api_key or not settings.llm_model:
        raise HTTPException(
            503,
            "Missing LLM_BASE_URL / LLM_API_KEY / LLM_MODEL configuration.",
        )
    return settings.llm_base_url.rstrip("/") + "/chat/completions"


def _chat_slot_range(start_time: str, end_time: str) -> tuple[int, int]:
    start = _availability_slot_index(start_time)
    end = _availability_slot_index(end_time)
    if start is None or end is None or end <= start:
        raise ValueError("invalid_time_range")
    return start, end


def _chat_time_from_slot(idx: int) -> str:
    minutes = idx * settings.availability_slot_minutes
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _earliest_end_slot_today(now: datetime) -> int:
    """Smallest end-slot index whose clock time is strictly after `now`.

    A booking slot is only offerable when its end time is after the current
    moment, e.g. at 16:12 a 16:00-17:00 slot (end 17:00) is fine but a
    13:00-15:00 slot (end 15:00) is not. End-slot time = idx * slot_minutes,
    so the first acceptable end index is now_minutes // slot_minutes + 1.
    """
    now_minutes = now.hour * 60 + now.minute
    return now_minutes // settings.availability_slot_minutes + 1


def _chat_slot_is_bookable(slots: list, idx: int) -> bool:
    """True for live-free slots and seeded schedule-bookable slots."""
    if idx < 0 or idx >= len(slots):
        return False
    return slots[idx] in (0, -1)


def _chat_slot_has_scheduled_owner(slot_owner_ids: list, idx: int) -> bool:
    return idx < len(slot_owner_ids) and bool(slot_owner_ids[idx])


def _numeric_floor(value: object) -> int | None:
    text = str(value or "")
    digits = "".join(ch for ch in text if ch.isdigit() or ch == "-")
    if not digits or digits == "-":
        return None
    try:
        return int(digits)
    except ValueError:
        return None


def _capacity_rank(room: dict) -> int:
    capacity_size = _effective_capacity_size(room) or ""
    if capacity_size == "medium":
        return 0
    if capacity_size == "large":
        return 1
    if capacity_size == "small":
        return 2
    return 3


def _capacity_size_for_people(value: object) -> str | None:
    if not isinstance(value, int) or value <= 0:
        return None
    if value <= 4:
        return "small"
    if value <= 12:
        return "medium"
    return "large"


def _normalize_capacity_size(value: object) -> str | None:
    size = str(value or "").strip().lower()
    return size if size in {"small", "medium", "large"} else None


def _effective_capacity_size(room: dict) -> str | None:
    # Source of truth for a room's size is the `capacity_size` column; only fall
    # back to deriving from the numeric `capacity` when the column is missing.
    explicit = str(room.get("capacity_size") or "").lower() or None
    return explicit or _capacity_size_for_people(room.get("capacity"))


def _location_rank(room: dict, profile: dict | None) -> tuple[int, int, int]:
    user_building = str((profile or {}).get("building") or "").strip().lower()
    room_building = str(room.get("building") or "").strip().lower()
    same_building = bool(user_building and room_building and user_building == room_building)
    user_floor = _numeric_floor((profile or {}).get("floor"))
    room_floor = _numeric_floor(room.get("floor"))
    has_floor = user_floor is not None and room_floor is not None
    same_floor = has_floor and user_floor == room_floor

    if same_building and same_floor:
        return (0, 0, 0)
    if not same_building and same_floor:
        return (1, 0, 0)
    if has_floor:
        gap = abs(room_floor - user_floor)
        above = 1 if room_floor > user_floor else 0
        return (2 if same_building else 3, gap, above)
    return (4, 9999, 1)


def _sort_chat_rooms_like_browse(rooms: list[dict], profile: dict | None) -> list[dict]:
    preferred = {
        str(room or "").strip().lower()
        for room in ((profile or {}).get("preferred_rooms") or [])
        if str(room or "").strip()
    }

    def key(item: tuple[int, dict]) -> tuple:
        index, room = item
        email = str(room.get("email") or "").strip().lower()
        return (
            0 if email in preferred else 1,
            _capacity_rank(room),
            *_location_rank(room, profile),
            str(room.get("name") or "").lower(),
            index,
        )

    return [room for _, room in sorted(enumerate(rooms), key=key)]


def _room_result(room: dict, include_map: bool = False) -> dict:
    # Map/direction are only attached when explicitly requested (directions tool
    # or a completed booking) so the room listing stays map-free.
    result = {
        "name": room.get("name"),
        "email": room.get("email"),
        "building": room.get("building"),
        "floor": room.get("floor"),
        "zone": room.get("zone"),
        "office": room.get("office"),
        # Chỉ trả capacity_size (small/medium/large), KHÔNG trả con số capacity
        # để hiển thị sức chứa theo nhóm thay vì số người cụ thể.
        "capacity_size": _effective_capacity_size(room),
        "booking_type": room.get("_booking_type") or "instant",
    }
    if include_map:
        result["map_link"] = room.get("map_link")
        result["direction"] = room.get("direction")
    return result


def _rows_for_chat_availability(
    sb, requested_capacity_size: str | None, location: str, profile: dict | None
) -> list[dict]:
    rows = (
        sb.table("meeting_room_metadata")
        .select(
            "id, name, email, building, floor, zone, capacity, capacity_size, "
            "office, map_link, direction"
        )
        .eq("in_use", True)
        .execute()
        .data
        or []
    )
    user_office = str((profile or {}).get("office") or "").strip()
    if user_office:
        rows = [r for r in rows if str(r.get("office") or "").strip() == user_office]
    if requested_capacity_size:
        rows = [
            r
            for r in rows
            if _effective_capacity_size(r) == requested_capacity_size
        ]
    if location:
        rows = [
            r
            for r in rows
            if location
            in " ".join(
                str(r.get(k) or "").lower()
                for k in ("name", "building", "floor", "zone", "office")
            )
        ]
    return _sort_chat_rooms_like_browse(rows, profile)


def _room_bookable_for_range(cache_row: dict | None, start_idx: int, end_idx: int) -> str | None:
    slots = list(cache_row.get("slots") or []) if cache_row else []
    owners = list(cache_row.get("slot_owner_ids") or []) if cache_row else []
    if len(slots) != availability.SLOTS_PER_DAY:
        return None
    if start_idx < 0 or end_idx > len(slots) or end_idx <= start_idx:
        return None
    if len(owners) != availability.SLOTS_PER_DAY:
        owners = [None] * availability.SLOTS_PER_DAY
    uses_scheduled_slot = False
    for idx in range(start_idx, end_idx):
        if _chat_slot_has_scheduled_owner(owners, idx) or not _chat_slot_is_bookable(slots, idx):
            return None
        if slots[idx] == -1:
            uses_scheduled_slot = True
    return "scheduled" if uses_scheduled_slot else "instant"


def _split_room_suggestions(
    rows: list[dict],
    cache: dict[tuple[str, str], dict],
    day: str,
    start_idx: int,
    end_idx: int,
    profile: dict | None,
    now: datetime,
) -> list[dict]:
    # Hôm nay: không gợi ý các đoạn có giờ kết thúc <= thời điểm hiện tại.
    is_today = day == now.date().isoformat()
    earliest_end_slot = _earliest_end_slot_today(now) if is_today else 0
    segments: list[dict] = []
    idx = start_idx
    while idx < end_idx:
        best: tuple[int, dict, str] | None = None
        for order, room in enumerate(rows):
            row = cache.get((room["id"], day))
            slots = list(row.get("slots") or []) if row else []
            owners = list(row.get("slot_owner_ids") or []) if row else []
            if len(owners) != availability.SLOTS_PER_DAY:
                owners = [None] * availability.SLOTS_PER_DAY
            if len(slots) != availability.SLOTS_PER_DAY:
                continue
            if _chat_slot_has_scheduled_owner(owners, idx) or not _chat_slot_is_bookable(slots, idx):
                continue
            end = idx
            uses_scheduled_slot = False
            while end < end_idx:
                if _chat_slot_has_scheduled_owner(owners, end) or not _chat_slot_is_bookable(slots, end):
                    break
                uses_scheduled_slot = uses_scheduled_slot or slots[end] == -1
                end += 1
            if best is None or end > best[0]:
                room_copy = {**room, "_booking_type": "scheduled" if uses_scheduled_slot else "instant"}
                best = (end, room_copy, str(room.get("id")))
                if end == end_idx:
                    break
        if best is None or best[0] <= idx:
            return []
        # Đoạn này kết thúc trong quá khứ (so với hiện tại, hôm nay) → không gợi ý split.
        if is_today and best[0] < earliest_end_slot:
            return []
        segments.append(
            {
                "date": day,
                "start_time": _chat_time_from_slot(idx),
                "end_time": _chat_time_from_slot(best[0]),
                "room": _room_result(best[1]),
            }
        )
        idx = best[0]
    # Avoid suggesting a "split" with the same room for the whole duration.
    if len({segment["room"]["email"] for segment in segments}) <= 1:
        return []
    return segments


def _half_day_group(start_idx: int) -> str:
    return "morning" if start_idx < (12 * 60 // settings.availability_slot_minutes) else "afternoon"


def _overlaps_lunch(start_idx: int, end_idx: int) -> bool:
    """True if [start_idx, end_idx) overlaps the 12:00-13:00 lunch window.

    Used to deprioritize lunch-time slots when the system *chooses* an
    alternate meeting time (the user's exact requested range is never moved).
    """
    lunch_start = 12 * 60 // settings.availability_slot_minutes
    lunch_end = 13 * 60 // settings.availability_slot_minutes
    return start_idx < lunch_end and end_idx > lunch_start


def _alternate_priority(requested_date: date_cls, candidate_date: date_cls, start_idx: int, end_idx: int, requested_start_idx: int) -> tuple:
    same_day = candidate_date == requested_date
    same_half = _half_day_group(start_idx) == _half_day_group(requested_start_idx)
    if same_day and same_half:
        tier = 0
    elif same_day:
        tier = 1
    else:
        tier = 2
    # Lunch-overlapping slots are deprioritized within a tier: they still appear
    # as a last resort, but any non-lunch option in the same tier ranks ahead.
    lunch_penalty = 1 if _overlaps_lunch(start_idx, end_idx) else 0
    distance = abs(
        (datetime.combine(candidate_date, datetime.min.time()) + timedelta(minutes=start_idx * settings.availability_slot_minutes))
        - (datetime.combine(requested_date, datetime.min.time()) + timedelta(minutes=requested_start_idx * settings.availability_slot_minutes))
    )
    return (tier, lunch_penalty, distance, candidate_date.isoformat(), abs(start_idx - requested_start_idx))


def _alternate_time_suggestions(
    rows: list[dict],
    cache: dict[tuple[str, str], dict],
    day_list: list[str],
    requested_date: str,
    start_idx: int,
    end_idx: int,
    profile: dict | None,
    now: datetime,
) -> list[dict]:
    duration = end_idx - start_idx
    if duration <= 0:
        return []
    try:
        requested_day = date_cls.fromisoformat(requested_date)
    except ValueError:
        return []
    candidates: list[tuple[tuple, dict]] = []
    business_start = settings.business_start_hour * 60 // settings.availability_slot_minutes
    business_end = settings.business_end_hour * 60 // settings.availability_slot_minutes
    today = now.date()
    earliest_end_slot = _earliest_end_slot_today(now)
    # Chỉ gợi ý giờ thay thế bắt đầu ở mốc :00/:30 → bước theo lưới 30 phút và
    # căn điểm bắt đầu lên lưới đó.
    step = max(1, 30 // settings.availability_slot_minutes)
    grid_start = ((business_start + step - 1) // step) * step
    for day in day_list:
        try:
            candidate_day = date_cls.fromisoformat(day)
        except ValueError:
            continue
        # Không tự gợi ý ngày cuối tuần (T7/CN); cuối tuần chỉ đặt khi user hỏi thẳng.
        if candidate_day.weekday() >= 5:
            continue
        latest_start = business_end - duration
        for candidate_start in range(grid_start, latest_start + 1, step):
            candidate_end = candidate_start + duration
            # Hôm nay: chỉ gợi ý khung giờ có giờ kết thúc sau thời điểm hiện tại.
            if candidate_day == today and candidate_end < earliest_end_slot:
                continue
            for room in rows:
                booking_type = _room_bookable_for_range(
                    cache.get((room["id"], day)), candidate_start, candidate_end
                )
                if not booking_type:
                    continue
                room_copy = {**room, "_booking_type": booking_type}
                candidates.append(
                    (
                        _alternate_priority(
                            requested_day, candidate_day, candidate_start, candidate_end, start_idx
                        ),
                        {
                            "date": day,
                            "start_time": _chat_time_from_slot(candidate_start),
                            "end_time": _chat_time_from_slot(candidate_end),
                            "room": _room_result(room_copy),
                        },
                    )
                )
                break
    seen: set[tuple[str, str, str]] = set()
    suggestions: list[dict] = []
    for _, suggestion in sorted(candidates, key=lambda item: item[0]):
        key = (suggestion["date"], suggestion["start_time"], suggestion["room"]["email"])
        if key in seen:
            continue
        seen.add(key)
        suggestions.append(suggestion)
        if len(suggestions) >= CHAT_MAX_OPTIONS:
            break
    return suggestions


def _frame_window_slots(
    rows: list[dict],
    cache: dict[tuple[str, str], dict],
    date: str,
    frame_start_idx: int,
    frame_end_idx: int,
    duration_slots: int,
    now: datetime,
) -> tuple[list[dict], bool]:
    """Quét MỌI cửa sổ dài đúng `duration_slots` nằm trong khung
    [frame_start_idx, frame_end_idx) và trả về các cửa sổ có ít nhất một phòng
    đặt được.

    Trả về (slots, truncated). Các cửa sổ được bước theo lưới 30 phút; nếu số
    cửa sổ trống nhiều hơn CHAT_MAX_FRAME_SLOTS thì lấy mẫu đều nhau để kết quả
    trải khắp khung thay vì dồn về đầu khung.
    """
    if duration_slots <= 0 or frame_end_idx - frame_start_idx < duration_slots:
        return [], False
    step = max(1, 30 // settings.availability_slot_minutes)
    today = now.date()
    is_today = date == today.isoformat()
    # Hôm nay: bắt đầu từ cửa sổ trong quá khứ gần nhất, tức mốc 30 phút liền
    # trước thời điểm hiện tại (ví dụ bây giờ 14:48 thì khung bắt đầu từ 14:30).
    min_start_idx = frame_start_idx
    if is_today:
        now_idx = (now.hour * 60 + now.minute) // settings.availability_slot_minutes
        min_start_idx = max(frame_start_idx, (now_idx // step) * step)
    found: list[dict] = []
    # Chỉ gợi ý cửa sổ bắt đầu ở mốc :00/:30 nên căn điểm bắt đầu lên lưới 30 phút
    # (ví dụ window_start 09:15 → cửa sổ đầu tiên bắt đầu từ 09:30).
    cand = ((frame_start_idx + step - 1) // step) * step
    while cand + duration_slots <= frame_end_idx:
        cand_end = cand + duration_slots
        if cand >= min_start_idx:
            window_rooms = []
            for room in rows:
                booking_type = _room_bookable_for_range(
                    cache.get((room["id"], date)), cand, cand_end
                )
                if booking_type:
                    window_rooms.append({**room, "_booking_type": booking_type})
            if window_rooms:
                found.append(
                    {
                        "start_time": _chat_time_from_slot(cand),
                        "end_time": _chat_time_from_slot(cand_end),
                        "count": len(window_rooms),
                        # Trả ĐỦ danh sách phòng để khi user hỏi chi tiết ("5
                        # phòng khác là gì") bot vẫn có dữ liệu trả lời; việc giới
                        # hạn hiển thị 5 phòng là do prompt xử lý, không cắt ở data.
                        "rooms": [_room_result(room) for room in window_rooms],
                    }
                )
        cand += step
    if len(found) <= CHAT_MAX_FRAME_SLOTS:
        return found, False
    n = len(found)
    picked = [
        found[i * (n - 1) // (CHAT_MAX_FRAME_SLOTS - 1)]
        for i in range(CHAT_MAX_FRAME_SLOTS)
    ]
    return picked, True


def _norm_room_lookup(value: object) -> str:
    return " ".join(str(value or "").strip().lower().split())


def _find_room_metadata(room_name: object = None, room_email: object = None) -> dict | None:
    """Find one in-use room by exact or fuzzy name/email metadata."""
    if not settings.supabase_enabled:
        return None

    room_name_norm = _norm_room_lookup(room_name)
    room_email_norm = _norm_room_lookup(room_email)
    if not room_name_norm and not room_email_norm:
        return None

    from .supabase_client import get_supabase

    rows = (
        get_supabase()
        .table("meeting_room_metadata")
        .select(
            "id, name, email, office, building, floor, zone, capacity, capacity_size, "
            "map_link, direction"
        )
        .eq("in_use", True)
        .execute()
        .data
        or []
    )

    def room_name_matches(row: dict) -> bool:
        name = _norm_room_lookup(row.get("name"))
        email = _norm_room_lookup(row.get("email"))
        return bool(room_name_norm and room_name_norm in {name, email})

    def room_email_matches(row: dict) -> bool:
        return bool(room_email_norm and room_email_norm == _norm_room_lookup(row.get("email")))

    match = next((row for row in rows if room_name_matches(row)), None)
    if not match:
        match = next((row for row in rows if room_email_matches(row)), None)
    if not match and room_name_norm:
        candidates = [
            row
            for row in rows
            if room_name_norm in _norm_room_lookup(row.get("name"))
            or _norm_room_lookup(row.get("name")) in room_name_norm
        ]
        if len(candidates) == 1:
            match = candidates[0]

    return match


def _resolve_booking_room_from_metadata(payload: BookingRequest) -> BookingRequest:
    """Resolve the room email/name from meeting_room_metadata instead of trusting LLM."""
    if not settings.supabase_enabled:
        return payload

    if not _norm_room_lookup(payload.room_name) and not _norm_room_lookup(payload.room_email):
        raise HTTPException(400, "Thiếu tên phòng hoặc email phòng.")

    match = _find_room_metadata(payload.room_name, payload.room_email)
    if not match or not match.get("email"):
        raise HTTPException(
            400,
            "Không tìm thấy phòng trong meeting_room_metadata. "
            "Bạn chọn lại đúng tên phòng nhé.",
        )

    payload.room_email = str(match["email"]).strip()
    payload.room_name = str(match.get("name") or match["email"]).strip()
    return payload


async def _tool_get_room_directions(args: dict) -> dict:
    room_name = str(args.get("room_name") or "").strip()
    if not room_name:
        return {"ok": False, "error": "Thiếu tên phòng cần chỉ đường."}

    room = _find_room_metadata(room_name)
    if not room:
        return {
            "ok": False,
            "error": "Không tìm thấy phòng này trong meeting_room_metadata.",
        }

    return {
        "ok": True,
        "room": _room_result(room, include_map=True),
    }


def _extract_room_direction_query(content: str) -> str | None:
    text = " ".join(content.strip().split())
    lower = text.lower()
    triggers = (
        "chỉ đường đến",
        "chi duong den",
        "đường đến",
        "duong den",
        "map đến",
        "map den",
        "vị trí phòng",
        "vi tri phong",
        "phòng",
    )
    if not any(trigger in lower for trigger in triggers):
        return None

    prefixes = (
        "chỉ đường đến phòng họp",
        "chỉ đường đến phòng",
        "chỉ đường đến",
        "chi duong den phong hop",
        "chi duong den phong",
        "chi duong den",
        "đường đến phòng họp",
        "đường đến phòng",
        "đường đến",
        "duong den phong hop",
        "duong den phong",
        "duong den",
        "map đến phòng họp",
        "map đến phòng",
        "map đến",
        "map den phong hop",
        "map den phong",
        "map den",
        "vị trí phòng họp",
        "vị trí phòng",
        "vi tri phong hop",
        "vi tri phong",
    )
    for prefix in sorted(prefixes, key=len, reverse=True):
        if lower.startswith(prefix):
            room_name = text[len(prefix) :].strip(" :,-")
            return room_name or None
    return None


def _looks_vietnamese(text: str) -> bool:
    lower = text.lower()
    vietnamese_chars = set("ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ")
    if any(ch in vietnamese_chars for ch in lower):
        return True
    vietnamese_words = (
        "chỉ đường",
        "chi duong",
        "đường đến",
        "duong den",
        "vị trí",
        "vi tri",
        "ở đâu",
        "o dau",
        "phòng",
        "phong",
        "tới",
        "toi",
        "đến",
        "den",
    )
    return any(word in lower for word in vietnamese_words)


async def _rewrite_direction_for_user_language(
    direction: str, user_content: str
) -> str:
    direction = direction.strip()
    if not direction or not _looks_vietnamese(user_content):
        return direction
    try:
        headers = {
            "Authorization": f"Bearer {settings.llm_api_key}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=20) as client:
            res = await client.post(
                _chat_completion_url(),
                headers=headers,
                json={
                    "model": settings.llm_model,
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "Bạn dịch/diễn đạt lại hướng dẫn đường đi sang tiếng Việt tự nhiên. "
                                "Giữ nguyên tên riêng, tên phòng, tên toà nhà, tầng, zone, landmark, "
                                "mã hiệu và URL. Không thêm thông tin mới."
                            ),
                        },
                        {
                            "role": "user",
                            "content": (
                                "User hỏi bằng tiếng Việt. Hãy chuyển hướng dẫn sau sang tiếng Việt:\n"
                                f"{direction}"
                            ),
                        },
                    ],
                    "temperature": 0,
                },
            )
        if res.status_code >= 400:
            log.warning("direction localization failed: %s", res.text)
            return direction
        msg = (res.json().get("choices") or [{}])[0].get("message") or {}
        localized = str(msg.get("content") or "").strip()
        return localized or direction
    except Exception as e:  # noqa: BLE001 - direction text should not block chat
        log.warning("direction localization failed: %s", e)
        return direction


async def _room_direction_reply(result: dict, user_content: str = "") -> str:
    if not result.get("ok"):
        return f"Mình chưa tìm thấy phòng này. {result.get('error') or ''}".strip()
    room = result.get("room") or {}
    name = room.get("name") or "phòng này"
    details = [
        str(room.get(key) or "").strip()
        for key in ("office", "building", "floor", "zone")
        if str(room.get(key) or "").strip()
    ]
    lines = [f"Đây là chỉ đường đến {name}."]
    if details:
        lines.append(f"Vị trí: {', '.join(details)}.")
    direction = str(room.get("direction") or "").strip()
    if direction:
        direction = await _rewrite_direction_for_user_language(direction, user_content)
        lines.append(f"Hướng dẫn: {direction}")
    map_link = str(room.get("map_link") or "").strip()
    if map_link:
        lines.append(f"[Mở map]({map_link})")
        lines.append(f"![Map đến {name}]({map_link})")
    else:
        lines.append("Phòng này chưa có map_link trong metadata.")
    return "\n".join(lines)


async def _tool_check_room_availability(
    request: Request,
    args: dict,
    user_profile_id: str | None,
) -> dict:
    if not settings.supabase_enabled:
        return {"ok": False, "error": "Availability checking requires Supabase."}
    date = str(args.get("date") or "").strip()
    start_time = str(args.get("start_time") or "").strip()
    end_time = str(args.get("end_time") or "").strip()
    window_start = str(args.get("window_start") or "").strip()
    window_end = str(args.get("window_end") or "").strip()
    duration_minutes_raw = args.get("duration_minutes")
    location = str(args.get("location") or "").strip().lower()
    # User chọn nhu cầu phòng trực tiếp (small/medium/large); giữ fallback cho
    # trường hợp model vẫn truyền con số capacity.
    requested_capacity_size = _normalize_capacity_size(
        args.get("capacity_size")
    ) or _capacity_size_for_people(args.get("capacity"))

    try:
        requested_day = date_cls.fromisoformat(date)
    except Exception:
        return {"ok": False, "error": "date không hợp lệ."}

    slot_minutes = settings.availability_slot_minutes
    business_start = settings.business_start_hour * 60 // slot_minutes
    business_end = settings.business_end_hour * 60 // slot_minutes

    # CHẾ ĐỘ LINH HOẠT: user chỉ nói thời lượng / buổi → quét cả khung tìm kiếm.
    flexible = duration_minutes_raw is not None and not (start_time and end_time)
    duration_minutes = 0
    duration_slots = 0
    frame_start_idx = business_start
    frame_end_idx = business_end
    if flexible:
        try:
            duration_minutes = int(duration_minutes_raw)
        except (TypeError, ValueError):
            return {"ok": False, "error": "duration_minutes không hợp lệ."}
        if duration_minutes <= 0:
            return {"ok": False, "error": "duration_minutes phải lớn hơn 0."}
        # Làm tròn lên bội số của slot.
        duration_slots = max(1, -(-duration_minutes // slot_minutes))
        fs = _availability_slot_index(window_start) if window_start else None
        fe = _availability_slot_index(window_end) if window_end else None
        frame_start_idx = max(fs if fs is not None else business_start, business_start)
        frame_end_idx = min(fe if fe is not None else business_end, business_end)
        if frame_end_idx - frame_start_idx < duration_slots:
            return {
                "ok": False,
                "error": "Khung tìm kiếm ngắn hơn thời lượng yêu cầu.",
            }
        # Dùng đầu/cuối khung cho các bước kiểm tra (quá khứ, đã qua trong ngày).
        start_idx, end_idx = frame_start_idx, frame_end_idx
        # Giờ đại diện cho fallback live Graph + gợi ý Săn phòng (cửa sổ đầu khung).
        start_time = _chat_time_from_slot(frame_start_idx)
        end_time = _chat_time_from_slot(frame_start_idx + duration_slots)
    else:
        try:
            start_idx, end_idx = _chat_slot_range(start_time, end_time)
        except Exception:
            return {"ok": False, "error": "start_time/end_time không hợp lệ."}

    from .supabase_client import get_supabase

    sb = get_supabase()
    profile = _read_user_profile(user_profile_id) if user_profile_id else None
    rows = _rows_for_chat_availability(sb, requested_capacity_size, location, profile)

    room_ids = [r["id"] for r in rows if r.get("id")]
    now = datetime.now(ZoneInfo(settings.timezone))
    today = now.date()
    if requested_day < today:
        return {"ok": False, "error": "Không thể kiểm tra/ngỏ ý đặt phòng trong quá khứ."}
    # Khung giờ trong hôm nay nhưng đã kết thúc trước thời điểm hiện tại thì coi như
    # đã qua: ví dụ bây giờ 16:00 thì không nhận khung 13:00-15:00.
    if requested_day == today and end_idx < _earliest_end_slot_today(now):
        return {
            "ok": False,
            "error": "Khung giờ này đã qua; vui lòng chọn khung giờ có giờ kết thúc sau thời điểm hiện tại.",
        }
    max_booking_day = today + timedelta(days=settings.max_booking_advance_days)
    if requested_day > max_booking_day:
        return {
            "ok": False,
            "error": (
                f"Do giới hạn hệ thống, chỉ đặt được phòng tối đa "
                f"{settings.max_booking_advance_days} ngày từ hôm nay "
                f"(đến hết ngày {max_booking_day.isoformat()})."
            ),
        }
    # Cuối tuần (T7/CN) VẪN đặt được nếu user hỏi thẳng ngày đó; nhưng không bao
    # giờ tự gợi ý ngày cuối tuần (xem lọc trong _alternate_time_suggestions).
    day_list = [
        (today + timedelta(days=i)).isoformat()
        for i in range(settings.availability_days)
    ]
    if date not in day_list:
        day_list.append(date)
        day_list.sort()
    try:
        cache = await _ensure_availability_cache_fresh(request, sb, room_ids, day_list)
    except HTTPException as e:
        if e.status_code != 503:
            return {"ok": False, "error": str(e.detail)}
        log.warning(
            "chat availability cache unavailable; falling back to live Graph: %s",
            e.detail,
        )
        return await _tool_check_room_availability_live(
            request, rows, date, start_time, end_time
        )
    except Exception as e:  # noqa: BLE001
        log.warning(
            "chat availability cache check failed; falling back to live Graph: %s",
            e,
        )
        return await _tool_check_room_availability_live(
            request, rows, date, start_time, end_time
        )

    if rows and not any((room.get("id"), date) in cache for room in rows):
        log.info(
            "chat availability cache missing requested date; falling back to live Graph"
        )
        return await _tool_check_room_availability_live(
            request, rows, date, start_time, end_time
        )

    if flexible:
        slots, slots_truncated = _frame_window_slots(
            rows, cache, date, frame_start_idx, frame_end_idx, duration_slots, now
        )
        room_scout_suggestion = None
        if not slots and requested_day <= today + timedelta(days=14):
            room_scout_suggestion = {
                "feature": "room_scout",
                "label": "Săn phòng",
                "url": "/room-scout",
                "message": (
                    "Không có phòng trống trong khung giờ này. Nếu vẫn muốn giữ "
                    "khung giờ đã yêu cầu, hãy vào [Săn phòng](/room-scout) để hệ "
                    "thống tự theo dõi; khi có phòng được nhả ra, hệ thống sẽ báo "
                    "cho bạn."
                ),
                "scout_start_time": start_time,
                "scout_end_time": end_time,
                "scout_date": date,
                "capacity_size": requested_capacity_size,
                "office": (_profile_payload(profile) or {}).get("office"),
            }
        return {
            "ok": True,
            "date": date,
            "mode": "flexible",
            "window_start": _chat_time_from_slot(frame_start_idx),
            "window_end": _chat_time_from_slot(frame_end_idx),
            "duration_minutes": duration_minutes,
            "user_context": _profile_payload(profile),
            "requested_capacity_size": requested_capacity_size,
            "slot_count": len(slots),
            "slots": slots,
            "truncated": slots_truncated,
            "room_scout_suggestion": room_scout_suggestion,
        }

    available = []
    for room in rows:
        booking_type = _room_bookable_for_range(cache.get((room["id"], date)), start_idx, end_idx)
        if booking_type:
            available.append({**room, "_booking_type": booking_type})

    split_suggestions: list[dict] = []
    alternate_suggestions: list[dict] = []
    room_scout_suggestion: dict | None = None
    if not available:
        split_suggestions = _split_room_suggestions(
            rows, cache, date, start_idx, end_idx, profile, now
        )
        if not split_suggestions:
            alternate_suggestions = _alternate_time_suggestions(
                rows, cache, day_list, date, start_idx, end_idx, profile, now
            )
        # Room Scout supports today through 14 days from today.
        if requested_day <= today + timedelta(days=14):
            room_scout_suggestion = {
                "feature": "room_scout",
                "label": "Săn phòng",
                "url": "/room-scout",
                "message": (
                    "Không có phòng trống đúng khung giờ này. Nếu vẫn muốn giữ "
                    "khung giờ đã yêu cầu, hãy vào [Săn phòng](/room-scout) "
                    "để hệ thống tự theo dõi; khi có phòng được nhả ra trong "
                    "khung giờ đó, hệ thống sẽ báo cho bạn."
                ),
                "scout_start_time": start_time,
                "scout_end_time": end_time,
                "scout_date": date,
                "capacity_size": requested_capacity_size,
                "office": (_profile_payload(profile) or {}).get("office"),
            }

    return {
        "ok": True,
        "date": date,
        "start_time": start_time,
        "end_time": end_time,
        "user_context": _profile_payload(profile),
        "requested_capacity_size": requested_capacity_size,
        "count": len(available),
        # Trả đủ phòng trong data; giới hạn hiển thị 5 là do prompt xử lý.
        "rooms": [_room_result(room) for room in available],
        "truncated": len(available) > CHAT_MAX_OPTIONS,
        "split_suggestions": split_suggestions,
        "alternate_suggestions": alternate_suggestions,
        "room_scout_suggestion": room_scout_suggestion,
    }


async def _tool_check_room_availability_live(
    request: Request,
    rooms: list[dict],
    date: str,
    start_time: str,
    end_time: str,
) -> dict:
    """Check the requested interval through Graph when cache is unavailable."""
    if not rooms:
        return {
            "ok": True,
            "date": date,
            "start_time": start_time,
            "end_time": end_time,
            "count": 0,
            "rooms": [],
            "truncated": False,
            "source": "graph_live",
        }

    try:
        token, _ = await auth.resolve_token(request)
        start_iso = f"{date}T{start_time}:00"
        end_iso = f"{date}T{end_time}:00"
        by_email = {
            str(room.get("email") or "").strip().lower(): room
            for room in rooms
            if room.get("email")
        }
        available = []
        emails = list(by_email)
        for i in range(0, len(emails), availability.SCHEDULE_BATCH):
            batch = emails[i : i + availability.SCHEDULE_BATCH]
            views = await graph.get_schedule(
                token,
                batch,
                start_iso,
                end_iso,
                settings.timezone,
                settings.availability_slot_minutes,
            )
            for email, view in views.items():
                room = by_email.get(str(email or "").strip().lower())
                if not room:
                    continue
                if view and all(ch == "0" for ch in view):
                    available.append(
                        {
                            "name": room.get("name"),
                            "email": room.get("email"),
                            "building": room.get("building"),
                            "floor": room.get("floor"),
                            "zone": room.get("zone"),
                            "capacity": room.get("capacity"),
                            "capacity_size": _effective_capacity_size(room),
                        }
                    )
    except httpx.HTTPStatusError as e:
        return {"ok": False, "error": e.response.text, "source": "graph_live"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e), "source": "graph_live"}

    return {
        "ok": True,
        "date": date,
        "start_time": start_time,
        "end_time": end_time,
        "count": len(available),
        "rooms": available[:CHAT_MAX_OPTIONS],
        "truncated": len(available) > CHAT_MAX_OPTIONS,
        "source": "graph_live",
    }


def _scheduled_default_day(today: date_cls) -> date_cls:
    """Ngày cố định cho scheduled booking: ngày xa nhất trong giới hạn hệ thống
    (mở đặt vào 00:00 đêm nay). Cho phép rơi vào cuối tuần — trường hợp đó bot sẽ
    hỏi lại user có thực sự muốn đặt cuối tuần không trước khi tạo phiếu."""
    return today + timedelta(days=settings.max_booking_advance_days)


async def _tool_book_room(
    request: Request,
    args: dict,
    graph_token: str,
    user_profile_id: str | None,
    auth_user_id: str | None,
) -> dict:
    _ = (graph_token, auth_user_id)
    profile = _read_user_profile(user_profile_id) if user_profile_id else None
    # The bot must not pick instant vs scheduled itself: a date is "scheduled"
    # only when it falls on the final cache day. The first
    # (availability_days - 1) days are instant; the last day is scanned from
    # Graph for admin conflicts but remains scheduled.
    booking_date = str(args.get("date") or "").strip()
    booking_type = str(args.get("booking_type") or "instant").strip()
    if booking_type not in {"instant", "schedule", "scheduled"}:
        booking_type = "instant"
    try:
        target_day = date_cls.fromisoformat(booking_date)
        today = datetime.now(ZoneInfo(settings.timezone)).date()
        max_booking_day = today + timedelta(days=settings.max_booking_advance_days)
        if target_day > max_booking_day:
            return {
                "ok": False,
                "error": (
                    f"Do giới hạn hệ thống, chỉ đặt được phòng tối đa "
                    f"{settings.max_booking_advance_days} ngày từ hôm nay "
                    f"(đến hết ngày {max_booking_day.isoformat()})."
                ),
            }
        horizon_end = _live_availability_horizon_end(today)
        booking_type = "scheduled" if target_day > horizon_end else "instant"
    except ValueError:
        pass
    # Auto-fill the subject when the user didn't name the meeting:
    # "<Domain>'s Meeting" for instant, "<Domain>'s Scheduled Meeting" otherwise.
    subject = str(args.get("subject") or "").strip()
    if not subject:
        domain = (_profile_payload(profile) or {}).get("email_username") or ""
        kind = "Meeting" if booking_type == "instant" else "Scheduled Meeting"
        subject = f"{domain}'s {kind}" if domain else kind
    payload = BookingRequest(
        room_email=str(args.get("room_email") or "").strip(),
        room_name=(args.get("room_name") or None),
        date=str(args.get("date") or "").strip(),
        start_time=str(args.get("start_time") or "").strip(),
        end_time=str(args.get("end_time") or "").strip(),
        booking_type=booking_type,
        subject=subject,
        attendees=args.get("attendees") or [],
        body=args.get("body") or None,
        method="chatbot",
    )
    if payload.end_time <= payload.start_time:
        return {"ok": False, "error": "Giờ kết thúc phải sau giờ bắt đầu."}
    try:
        payload = _resolve_booking_room_from_metadata(payload)
    except HTTPException as e:
        return {"ok": False, "error": str(e.detail)}

    # If the user previously opted in, book immediately without a confirmation card.
    if profile and profile.get("book_without_confirmation"):
        try:
            result = await _create_booking_via_bookings(request, payload)
        except HTTPException as e:
            return {"ok": False, "error": str(e.detail)}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}
        return {
            "ok": True,
            "booked": True,
            "pending": result.get("status") == "pending",
            "booking": payload.model_dump(),
            "result": result,
        }

    return {
        "ok": True,
        "requires_confirmation": True,
        "confirmation_id": str(uuid4()),
        "booking": payload.model_dump(),
    }


async def _tool_create_room_scout(
    request: Request,
    args: dict,
    user_profile_id: str | None,
) -> dict:
    """Enable Room Scout for the user. Office is taken from the profile (never
    from the LLM); the shared create_room_scout endpoint handles Mail.Send,
    time-range and date validation exactly like the in-app form."""
    if not settings.supabase_enabled:
        return {"ok": False, "error": "Room Scout requires Supabase."}

    # The in-app UI only ever surfaces a single active scout, so refuse to start
    # a second one via the bot; point the user at the Săn phòng page to stop it.
    if user_profile_id:
        from .supabase_client import get_supabase

        existing = (
            get_supabase()
            .table("room_scouts")
            .select("id")
            .eq("user_id", user_profile_id)
            .eq("status", "active")
            .limit(1)
            .execute()
            .data
            or []
        )
        if existing:
            return {
                "ok": False,
                "error": (
                    "Bạn đang có một phiên Săn phòng đang chạy. Vào trang "
                    "[Săn phòng](/room-scout) để dừng trước khi tạo phiên mới."
                ),
            }

    from .room_scouts import RoomScoutRequest, create_room_scout

    capacity_sizes = [
        size
        for raw in (args.get("capacity_sizes") or [])
        if (size := _normalize_capacity_size(raw))
    ]
    if not capacity_sizes:
        return {"ok": False, "error": "Cần ít nhất một nhu cầu sức chứa (nhỏ/vừa/lớn)."}

    try:
        payload = RoomScoutRequest(
            scout_date=str(args.get("scout_date") or "").strip() or None,
            duration_minutes=int(args.get("duration_minutes") or 0),
            capacity_sizes=capacity_sizes,
            scout_start_time=str(args.get("scout_start_time") or "").strip() or None,
            scout_end_time=str(args.get("scout_end_time") or "").strip() or None,
            ignore_lunch_break=bool(args.get("ignore_lunch_break")),
            # office intentionally omitted → endpoint fills it from the profile.
            office=None,
        )
    except Exception as e:  # noqa: BLE001 - surface bad args as a chat message
        return {"ok": False, "error": f"Thông tin săn phòng không hợp lệ: {e}"}

    try:
        result = await create_room_scout(request, payload)
    except HTTPException as e:
        return {"ok": False, "error": str(e.detail)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}

    scout = result.get("scout") or {}
    return {
        "ok": True,
        "created": True,
        "scout": {
            "scout_date": scout.get("scout_date"),
            "duration_minutes": scout.get("duration_minutes"),
            "scout_start_time": scout.get("scout_start_time"),
            "scout_end_time": scout.get("scout_end_time"),
            "capacity_sizes": scout.get("capacity_sizes"),
            "ignore_lunch_break": scout.get("ignore_lunch_break"),
            "office": scout.get("office"),
        },
    }


async def _tool_cancel_room_scout(
    request: Request,
    args: dict,
    user_profile_id: str | None,
) -> dict:
    """Stop the user's active Room Scout, if any. Mirrors the in-app card's two
    buttons: `outcome="success"` when the user already found/booked a room, else
    `outcome="canceled"`. The user only ever has one active scout, so no id is
    needed — we look it up and stop it."""
    if not settings.supabase_enabled:
        return {"ok": False, "error": "Room Scout requires Supabase."}
    if not user_profile_id:
        return {"ok": False, "error": "Không xác định được user."}

    # Only "success" (user booked a room) vs "canceled" (gave up); default the
    # safer "canceled" if the model omits/garbles it.
    outcome = "success" if str(args.get("outcome") or "").strip().lower() == "success" else "canceled"

    from .supabase_client import get_supabase

    active = (
        get_supabase()
        .table("room_scouts")
        .select("id, scout_date, scout_start_time, scout_end_time")
        .eq("user_id", user_profile_id)
        .eq("status", "active")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not active:
        return {"ok": True, "stopped": False, "reason": "no_active_scout"}

    scout = active[0]
    from .room_scouts import stop_room_scout

    try:
        await stop_room_scout(request, str(scout["id"]), outcome)
    except HTTPException as e:
        return {"ok": False, "error": str(e.detail)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}

    return {
        "ok": True,
        "stopped": True,
        "outcome": outcome,
        "scout": {
            "scout_date": scout.get("scout_date"),
            "scout_start_time": scout.get("scout_start_time"),
            "scout_end_time": scout.get("scout_end_time"),
        },
    }


async def _run_chat_tool(
    request: Request,
    name: str,
    args: dict,
    graph_token: str,
    user_profile_id: str | None,
    auth_user_id: str | None,
) -> dict:
    if name == "check_room_availability":
        return await _tool_check_room_availability(request, args, user_profile_id)
    if name == "get_room_directions":
        return await _tool_get_room_directions(args)
    if name == "book_room":
        return await _tool_book_room(
            request, args, graph_token, user_profile_id, auth_user_id
        )
    if name == "schedule_room":
        # Scheduled booking chỉ được đặt vào đúng ngày mặc định (ngày xa nhất mở
        # đặt lúc 00:00); user không có quyền đổi ngày nên ép date ở backend, bỏ
        # qua mọi date do model truyền lên.
        today = datetime.now(ZoneInfo(settings.timezone)).date()
        return await _tool_book_room(
            request,
            {
                **args,
                "date": _scheduled_default_day(today).isoformat(),
                "booking_type": "scheduled",
            },
            graph_token,
            user_profile_id,
            auth_user_id,
        )
    if name == "create_room_scout":
        return await _tool_create_room_scout(request, args, user_profile_id)
    if name == "cancel_room_scout":
        return await _tool_cancel_room_scout(request, args, user_profile_id)
    return {"ok": False, "error": f"Unknown tool: {name}"}


async def _call_llm_with_tools(
    request: Request,
    history: list[dict],
    graph_token: str,
    user_profile_id: str | None,
    auth_user_id: str | None,
) -> tuple[str, list[dict]]:
    now = datetime.now(ZoneInfo(settings.timezone))
    profile = _read_user_profile(user_profile_id) if user_profile_id else None
    profile_payload = _profile_payload(profile) or {}
    profile_context = (
        "\n\nNgữ cảnh người dùng từ profile/app:\n"
        f"- Email: {profile_payload.get('email') or 'chưa rõ'}.\n"
        f"- Office: {profile_payload.get('office') or 'chưa rõ'}.\n"
        f"- Building: {profile_payload.get('building') or 'chưa rõ'}.\n"
        f"- Floor/chỗ ngồi: {profile_payload.get('floor') or 'chưa rõ'}.\n"
        f"- Preferred rooms: {', '.join(profile_payload.get('preferred_rooms') or []) or 'không có'}.\n"
        "- Khi gợi ý phòng, ưu tiên và giới hạn theo office trong profile nếu đã có office."
    )
    weekday_names = [
        "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7", "Chủ nhật",
    ]
    # Precompute calendar-week ranges so the model never does week math itself
    # (it tends to read "tuần sau" as today+7 instead of next Monday's week).
    today = now.date()
    this_monday = today - timedelta(days=today.weekday())
    this_sunday = this_monday + timedelta(days=6)
    next_monday = this_monday + timedelta(days=7)
    next_sunday = next_monday + timedelta(days=6)
    max_booking_day = today + timedelta(days=settings.max_booking_advance_days)
    scheduled_default_day = _scheduled_default_day(today)
    runtime_context = (
        f"\n\nNgữ cảnh thời gian hiện tại:\n"
        f"- Hôm nay là {today.isoformat()} ({weekday_names[now.weekday()]}).\n"
        f"- Thời gian hiện tại là {now.strftime('%H:%M')}.\n"
        f"- Timezone là {settings.timezone}.\n"
        f"- Ngày xa nhất có thể đặt phòng là {max_booking_day.isoformat()} "
        f"(giới hạn hệ thống {settings.max_booking_advance_days} ngày kể từ hôm nay). "
        "Không kiểm tra/đặt phòng cho ngày sau ngày này.\n"
        f"- Đặt phòng theo lịch (scheduled booking / hẹn giờ đặt phòng): khi yêu cầu "
        "của user liên quan đến 'hẹn giờ đặt phòng', 'đặt lịch trước', 'đặt phòng "
        "theo lịch', hoặc 'đặt đêm nay' / 'đặt lúc 00:00' (ý là canh mở đặt lúc nửa "
        "đêm cho ngày xa nhất chưa mở đặt tức thì) → LUÔN coi đây là scheduled "
        "booking và dùng function schedule_room (KHÔNG dùng book_room). Scheduled "
        f"booking CHỈ đặt được vào đúng ngày {scheduled_default_day.isoformat()} "
        f"({weekday_names[scheduled_default_day.weekday()]}) — ngày xa nhất trong giới "
        "hạn hệ thống, sẽ tự mở đặt vào 00:00. User KHÔNG được đổi ngày này; nếu user "
        "yêu cầu ngày khác cho scheduled booking, hãy giải thích ngắn gọn rằng "
        "scheduled booking chỉ áp dụng cho ngày đó. (Backend luôn ép ngày này, không "
        "cần bạn tự tính.) TUYỆT ĐỐI KHÔNG HỎI user muốn đặt ngày nào cho scheduled "
        f"booking — hãy CHỦ ĐỘNG thông báo là sẽ đặt cho ngày {scheduled_default_day.isoformat()} "
        f"({weekday_names[scheduled_default_day.weekday()]}), rồi chỉ hỏi thêm những thông tin "
        "CÒN THIẾU khác (khung giờ, phòng/sức chứa) nếu cần."
        + (
            f" LƯU Ý: ngày {scheduled_default_day.isoformat()} rơi vào CUỐI TUẦN "
            f"({weekday_names[scheduled_default_day.weekday()]}); trước khi gọi "
            "schedule_room hãy HỎI LẠI user xem có thực sự muốn đặt phòng vào cuối "
            "tuần không, chỉ tạo phiếu khi user xác nhận."
            if scheduled_default_day.weekday() >= 5
            else ""
        )
        + "\n"
        "- Tuần bắt đầu từ Thứ 2 và kết thúc vào Chủ nhật.\n"
        f"- Tuần này: Thứ 2 {this_monday.isoformat()} đến Chủ nhật {this_sunday.isoformat()}.\n"
        f"- Tuần sau: Thứ 2 {next_monday.isoformat()} đến Chủ nhật {next_sunday.isoformat()}.\n"
        "- 'Tuần sau'/'tuần tới' là tuần lịch kế tiếp ở trên (bắt đầu Thứ 2 "
        f"{next_monday.isoformat()}), KHÔNG phải 7 ngày kể từ hôm nay. Khi user "
        "nói 'đầu tuần', 'thứ X tuần này/tuần sau', 'cuối tuần'... hãy lấy ngày "
        "tương ứng trong các dải ngày đã cho, không tự cộng trừ ngày.\n"
        "- Khi người dùng nói hôm nay/ngày mai/hôm qua hoặc thứ trong tuần, "
        "hãy quy đổi theo ngữ cảnh thời gian này trước khi gọi function.\n"
        "- Quy ước buổi trong ngày: sáng = 09:00-12:00, trưa = 12:00-13:00, "
        "chiều = 13:00-18:00. Khi user nói 'buổi sáng/trưa/chiều' mà không nói "
        "giờ cụ thể, đây là KHUNG TÌM KIẾM (frame), KHÔNG phải một khoảng để đặt "
        "liền. Hãy gọi check_room_availability ở CHẾ ĐỘ LINH HOẠT: truyền "
        "duration_minutes (mặc định 60 nếu user không nói thời lượng) cùng "
        "window_start/window_end đúng bằng khung của buổi đó (ví dụ 'chiều nay 1 "
        "tiếng' → window_start=13:00, window_end=18:00, duration_minutes=60). "
        "Backend sẽ tự quét tất cả các ca trong khung và trả về `slots`; tuyệt "
        "đối KHÔNG tự chọn trước một cửa sổ (như 13:00-14:00) rồi chỉ kiểm tra "
        "mỗi cửa sổ đó."
    )
    messages = [
        {"role": "system", "content": CHAT_SYSTEM_PROMPT + runtime_context + profile_context},
        *history,
    ]
    tool_results: list[dict] = []
    headers = {
        "Authorization": f"Bearer {settings.llm_api_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=60) as client:
        reasoning_parts: list[str] = []
        for _ in range(3):
            res = await client.post(
                _chat_completion_url(),
                headers=headers,
                json={
                    "model": settings.llm_model,
                    "messages": messages,
                    "tools": CHAT_TOOLS,
                    "tool_choice": "auto",
                    "temperature": 0.2,
                },
            )
            if res.status_code >= 400:
                raise HTTPException(res.status_code, res.text)
            msg = (res.json().get("choices") or [{}])[0].get("message") or {}
            tool_calls = msg.get("tool_calls") or []
            if not tool_calls:
                return _assistant_content_with_reasoning(msg, reasoning_parts).strip(), tool_results

            reasoning = _llm_reasoning_text(msg)
            if reasoning:
                reasoning_parts.append(reasoning)
            messages.append(msg)
            for call in tool_calls:
                fn = call.get("function") or {}
                name = fn.get("name") or ""
                raw_args = fn.get("arguments") or "{}"
                try:
                    args = json.loads(raw_args)
                except json.JSONDecodeError:
                    args = {}
                result = await _run_chat_tool(
                    request, name, args, graph_token, user_profile_id, auth_user_id
                )
                # Log the tool name + args the LLM actually produced so we can see
                # which date/time it resolved (e.g. "ngày mai") and the outcome.
                log.info(
                    "chat tool call: name=%s args=%s ok=%s count=%s error=%s",
                    name,
                    args,
                    result.get("ok") if isinstance(result, dict) else None,
                    result.get("count") if isinstance(result, dict) else None,
                    result.get("error") if isinstance(result, dict) else None,
                )
                tool_results.append({"name": name, "arguments": args, "result": result})
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.get("id"),
                        "content": json.dumps(result, ensure_ascii=False),
                    }
                )
    return (
        "Mình chưa xử lý xong yêu cầu này. Bạn thử nói rõ ngày, giờ và số người nhé.",
        tool_results,
    )


@router.get("/api/chat/threads")
def list_chat_threads(request: Request):
    sb = _require_supabase_chat()
    user_profile_id = _current_user_profile_id(request)
    rows = (
        sb.table("thread")
        .select("id, title, created_at, updated_at")
        .eq("user_id", user_profile_id)
        .order("updated_at", desc=True)
        .execute()
        .data
        or []
    )
    return {"threads": rows}


@router.get("/api/chat/threads/{thread_id}/messages")
def list_chat_messages(request: Request, thread_id: str):
    sb = _require_supabase_chat()
    user_profile_id = _current_user_profile_id(request)
    bot_profile_id = _bot_profile_id(sb)
    _assert_thread_owner(sb, thread_id, user_profile_id)
    rows = (
        sb.table("messages")
        .select("id, from_user_id, to_user_id, content, metadata, feedback, created_at")
        .eq("thread_id", thread_id)
        .order("created_at", desc=False)
        .execute()
        .data
        or []
    )
    return {
        "messages": [
            _chat_message_response(row, _message_role(row, bot_profile_id))
            for row in rows
        ]
    }


@router.patch("/api/chat/threads/{thread_id}")
def rename_chat_thread(
    request: Request,
    thread_id: str,
    payload: ChatThreadRenameRequest,
):
    title = payload.title.strip()
    if not title:
        raise HTTPException(400, "Tên chat không được để trống.")

    sb = _require_supabase_chat()
    user_profile_id = _current_user_profile_id(request)
    _assert_thread_owner(sb, thread_id, user_profile_id)
    now = datetime.now(timezone.utc).isoformat()
    rows = (
        sb.table("thread")
        .update({"title": title, "updated_at": now})
        .eq("id", thread_id)
        .eq("user_id", user_profile_id)
        .execute()
        .data
        or []
    )
    if not rows:
        raise HTTPException(503, "Could not rename chat thread.")
    return {"thread": rows[0]}


@router.post("/api/chat/messages/{message_id}/feedback")
def set_chat_message_feedback(
    request: Request,
    message_id: str,
    payload: ChatFeedbackRequest,
):
    sb = _require_supabase_chat()
    user_profile_id = _current_user_profile_id(request)
    bot_profile_id = _bot_profile_id(sb)
    rows = (
        sb.table("messages")
        .select("id, thread_id, from_user_id, to_user_id, content, metadata, feedback, created_at")
        .eq("id", message_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        raise HTTPException(404, "Message not found.")
    message = rows[0]
    # Only the owner of the thread may give feedback, and only on assistant replies.
    _assert_thread_owner(sb, message["thread_id"], user_profile_id)
    if _message_role(message, bot_profile_id) != "assistant":
        raise HTTPException(400, "Feedback is only allowed on assistant messages.")
    updated = (
        sb.table("messages")
        .update({"feedback": payload.feedback})
        .eq("id", message_id)
        .execute()
        .data
        or []
    )
    if not updated:
        raise HTTPException(503, "Could not save feedback.")
    return {"message": _chat_message_response(updated[0], "assistant")}


@router.delete("/api/chat/threads/{thread_id}")
def delete_chat_thread(request: Request, thread_id: str):
    sb = _require_supabase_chat()
    user_profile_id = _current_user_profile_id(request)
    _assert_thread_owner(sb, thread_id, user_profile_id)
    sb.table("thread").delete().eq("id", thread_id).eq("user_id", user_profile_id).execute()
    return {"ok": True}


@router.post("/api/chat/messages")
async def send_chat_message(request: Request, payload: ChatSendRequest):
    content = payload.content.strip()
    if not content:
        raise HTTPException(400, "Tin nhắn không được để trống.")

    graph_token, auth_user_id, user_profile_id, _auth_email = await _booking_auth_context(
        request
    )
    if not user_profile_id:
        raise HTTPException(503, "Could not resolve user profile for chat.")

    sb = _require_supabase_chat()
    bot_profile_id = _bot_profile_id(sb)
    thread = (
        _assert_thread_owner(sb, payload.thread_id, user_profile_id)
        if payload.thread_id
        else _create_thread(sb, user_profile_id, content)
    )
    thread_id = str(thread["id"])
    user_msg = _insert_chat_message(
        sb, thread_id, user_profile_id, bot_profile_id, content
    )

    direction_room_name = _extract_room_direction_query(content)
    if direction_room_name:
        direction_result = await _tool_get_room_directions(
            {"room_name": direction_room_name}
        )
        assistant_msg = _insert_chat_message(
            sb,
            thread_id,
            bot_profile_id,
            user_profile_id,
            await _room_direction_reply(direction_result, content),
            {
                "tool_results": [
                    {
                        "name": "get_room_directions",
                        "arguments": {"room_name": direction_room_name},
                        "result": direction_result,
                    }
                ]
            },
        )
        return {
            "thread": {
                "id": thread_id,
                "title": thread.get("title"),
                "created_at": thread.get("created_at"),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
            "messages": [
                {
                    "id": user_msg["id"],
                    "role": "user",
                    "content": user_msg.get("content") or "",
                    "created_at": user_msg.get("created_at"),
                },
                {
                    "id": assistant_msg["id"],
                    "role": "assistant",
                    "content": assistant_msg.get("content") or "",
                    "created_at": assistant_msg.get("created_at"),
                    "metadata": assistant_msg.get("metadata") or {},
                },
            ],
        }

    history = _chat_messages_for_llm(sb, thread_id, bot_profile_id)
    reply, tool_results = await _call_llm_with_tools(
        request, history, graph_token, user_profile_id, auth_user_id
    )
    if not reply:
        reply = "Mình chưa có câu trả lời phù hợp. Bạn cho mình thêm ngày, giờ và số người nhé."
    assistant_msg = _insert_chat_message(
        sb,
        thread_id,
        bot_profile_id,
        user_profile_id,
        reply,
        {"tool_results": tool_results} if tool_results else {},
    )
    return {
        "thread": {
            "id": thread_id,
            "title": thread.get("title"),
            "created_at": thread.get("created_at"),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
        "messages": [
            {
                "id": user_msg["id"],
                "role": "user",
                "content": user_msg.get("content") or "",
                "created_at": user_msg.get("created_at"),
            },
            {
                "id": assistant_msg["id"],
                "role": "assistant",
                "content": assistant_msg.get("content") or "",
                "created_at": assistant_msg.get("created_at"),
                "metadata": assistant_msg.get("metadata") or {},
            },
        ],
    }


@router.post("/api/chat/bookings/action")
async def chat_booking_action(request: Request, payload: ChatBookingActionRequest):
    sb = _require_supabase_chat()
    user_profile_id = _current_user_profile_id(request)
    bot_profile_id = _bot_profile_id(sb)
    thread = _assert_thread_owner(sb, payload.thread_id, user_profile_id)

    metadata = {
        "booking_action": {
            "confirmation_id": payload.confirmation_id,
            "action": payload.action,
        }
    }
    if payload.action in {"reject", "expire"}:
        if payload.action == "expire":
            content = "Yêu cầu đặt phòng đã hết hạn. Bạn hãy gửi lại yêu cầu nếu vẫn muốn đặt phòng này."
            metadata["booking_action"]["status"] = "expired"
        else:
            content = "Đã huỷ yêu cầu đặt phòng này."
        assistant_msg = _insert_chat_message(
            sb,
            str(thread["id"]),
            bot_profile_id,
            user_profile_id,
            content,
            metadata,
        )
        return {"ok": True, "message": _chat_message_response(assistant_msg, "assistant")}

    if not payload.booking:
        raise HTTPException(400, "Thiếu thông tin đặt phòng.")

    # User opted in on the card: remember it so future chat bookings skip the card.
    if payload.book_without_confirmation:
        _set_book_without_confirmation(user_profile_id, True)

    payload.booking.method = "chatbot"
    try:
        result = await _create_booking_via_bookings(request, payload.booking)
        if result.get("status") == "pending":
            content = (
                "Đã tạo scheduled booking. Hệ thống sẽ tự đặt phòng khi lịch mở.\n"
                f"- Phòng: {payload.booking.room_name or payload.booking.room_email}\n"
                f"- Ngày: {payload.booking.date}\n"
                f"- Giờ: {payload.booking.start_time}-{payload.booking.end_time}"
            )
        else:
            content = (
                "Đặt phòng thành công.\n"
                f"- Phòng: {payload.booking.room_name or payload.booking.room_email}\n"
                f"- Ngày: {payload.booking.date}\n"
                f"- Giờ: {payload.booking.start_time}-{payload.booking.end_time}"
            )
        if result.get("webLink"):
            content += f"\n- [Xem trên Outlook]({result['webLink']})"
        metadata["booking_action"]["status"] = "ok"
        metadata["booking_action"]["result"] = result
    except HTTPException as e:
        content = f"Đặt phòng thất bại: {e.detail}"
        metadata["booking_action"]["status"] = "failed"
        metadata["booking_action"]["error"] = str(e.detail)
    except Exception as e:  # noqa: BLE001
        content = f"Đặt phòng thất bại: {e}"
        metadata["booking_action"]["status"] = "failed"
        metadata["booking_action"]["error"] = str(e)

    assistant_msg = _insert_chat_message(
        sb,
        str(thread["id"]),
        bot_profile_id,
        user_profile_id,
        content,
        metadata,
    )
    return {
        "ok": metadata["booking_action"].get("status") == "ok",
        "message": _chat_message_response(assistant_msg, "assistant"),
    }
