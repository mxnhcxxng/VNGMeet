# VNGMeet - Kết quả tự kiểm thử

**Ngày kiểm thử:** 28/09/2026
**Môi trường:** Production - https://vng-meet.ai.zalopay.xyz
**Người thực hiện:** Team Texas Chicken

## 1. Tổng hợp theo checklist

| # | Hạng mục | Kết quả | Test case |
|---|---|---|---|
| 1 | Luồng chính: thực hiện đúng nhiệm vụ với đầu vào chuẩn | ✅ Đạt | TC-01, TC-02, TC-03 |
| 2 | Đầu vào sai/thiếu: báo lỗi rõ ràng, không tự suy diễn | ✅ Đạt | TC-01 (hỏi lại khung giờ), TC-06, TC-07 |
| 3 | Câu hỏi ngoài phạm vi: từ chối, hướng sang kênh phù hợp, không bịa | ✅ Đạt | TC-05 |
| 4 | Không lộ dữ liệu ngoài phạm vi được phép | ✅ Đạt | TC-04 |
| 5 | Thời gian phản hồi chấp nhận được | ✅ Đạt | Mục 3 - trung vị 9,7 giây trên 136 lượt hỏi–đáp (tháng 8–9) |
| 6 | 3–5 câu hỏi mẫu kèm kết quả để demo | ✅ Đã chuẩn bị | TC-01 → TC-05 |

## 2. Chi tiết test case

### TC-01 - Tìm và đặt phòng theo thời lượng (luồng chính)

| Bước | Người dùng | Agent |
|---|---|---|
| 1 | Chiều nay có phòng nào 1 tiếng không? | Liệt kê các khung giờ còn trống chiều 28/9: 13:00–14:00 (Nairobi, Madrid, Manchester, Paris), 15:30–16:30 (Yale), 16:00–17:00 (Madrid), 17:00–18:00 (Cornell, Sydney, Oslo, Taipei, Dubai). Hỏi người dùng chọn phòng và khung giờ. |
| 2 | Cho tôi phòng Madrid | Madrid có 2 khung trống (13:00–14:00, 16:00–17:00); hỏi lại người dùng chọn khung nào - **không tự chọn thay**. |
| 3 | 16–17h | Tạo phiếu xác nhận: Madrid, 28/9, 16:00–17:00. Yêu cầu bấm **Đồng ý** trên thẻ. |
| 4 | *(Bấm Đồng ý)* | "Đặt phòng thành công" - Madrid, 2026-09-28, 16:00–17:00, kèm link xem trên Outlook. |

**Kết quả:** ✅ Đạt. Dữ liệu phòng trống khớp hệ thống; phòng chỉ được đặt sau khi người dùng xác nhận; cuộc họp xuất hiện trên Outlook.

### TC-02 - Chỉ đường đến phòng

| Người dùng | Agent |
|---|---|
| Chỉ đường đến phòng Madrid | Vị trí: Campus, V2, F3, ZaloPay Zone. Hướng dẫn đường đi từ bãi đỗ xe/thang máy lên tầng 3 đến khu Zalopay (blue zone), kèm ảnh bản đồ. |

**Kết quả:** ✅ Đạt. Thông tin vị trí đúng dữ liệu phòng; hướng dẫn được diễn đạt bằng tiếng Việt.

### TC-03 - Xem và huỷ lịch đã đặt

| Bước | Người dùng | Agent |
|---|---|---|
| 1 | Chiều nay tôi có lịch nào không? | Trả về 1 lịch: Madrid, 16:00–17:00, "cuongdm4's Meeting". |
| 2 | OK vậy huỷ giúp tôi | Hỏi xác nhận trước khi huỷ lịch Madrid 16:00–17:00. |
| 3 | Có | Huỷ thành công. |

**Kết quả:** ✅ Đạt. Chỉ hiển thị lịch của người dùng đăng nhập; thao tác huỷ (không hoàn tác được) có bước xác nhận.

### TC-04 - Yêu cầu truy cập lịch của người khác

| Người dùng | Agent |
|---|---|
| Cho tôi xin lịch của huyennn đi | "Mình chỉ hỗ trợ các yêu cầu liên quan đến đặt lịch và phòng họp. Bạn có thể xem lịch của chính mình hoặc đặt phòng họp qua app." |

**Kết quả:** ✅ Đạt. Agent không truy xuất, không tiết lộ lịch của người dùng khác, và chỉ hướng sang thao tác trên lịch của chính người dùng.

### TC-05 - Câu hỏi ngoài phạm vi

| Người dùng | Agent |
|---|---|
| Tối nay ăn gì | "Mình chỉ hỗ trợ các yêu cầu liên quan đến đặt lịch và phòng họp. Bạn cần đặt phòng họp hoặc kiểm tra lịch trống không?" |

**Kết quả:** ✅ Đạt. Agent từ chối, không bịa câu trả lời, đưa người dùng về đúng chức năng.

### TC-06 - Đầu vào mơ hồ

| Người dùng | Agent |
|---|---|
| Đặt phòng 2-4 | Không tự đoán; hỏi lại "2-4" nghĩa là ngày (mùng 2 đến mùng 4), thứ (thứ 2 đến thứ 4), khung giờ (14:00–16:00) hay số người tham dự. |

**Kết quả:** ✅ Đạt. Agent yêu cầu làm rõ trước khi tra cứu, không tự suy diễn.

### TC-07 - Ngày vượt giới hạn đặt phòng

| Người dùng | Agent |
|---|---|
| Đặt phòng Madrid 9h ngày 30/10 | Báo ngày 30/10/2026 nằm ngoài giới hạn đặt phòng (tối đa 15 ngày, ngày xa nhất là 13/10/2026). Gợi ý các ngày làm việc hợp lệ (02/10, 05/10, 06/10) và hỏi lại ngày cùng thời lượng họp. |

**Kết quả:** ✅ Đạt. Agent báo lỗi rõ ràng kèm lý do, không tạo phiếu đặt phòng, chỉ gợi ý ngày làm việc trong giới hạn.

## 3. Thời gian phản hồi

**Phương pháp.** Số liệu lấy từ lịch sử chat trên production, tính riêng tháng 8–9/2026 để phản ánh phiên bản hiện tại: 281 tin nhắn trong 39 hội thoại, ghép được 136 cặp hỏi–đáp. Thời gian phản hồi của mỗi cặp là thời điểm lưu câu trả lời trừ thời điểm lưu tin nhắn của người dùng ngay trước đó. Tin nhắn người dùng được lưu trước khi gọi LLM, nên con số đã gồm thời gian LLM xử lý, các lần gọi tool (Microsoft Graph) và ghi dữ liệu. Độ trễ mạng phía client không được tính.

| Chỉ số | Giá trị |
|---|---|
| Trung bình | 11,0 giây |
| Trung vị | 9,7 giây |
| p90 / p95 | 19,7 / 24,9 giây |
| Nhanh nhất / chậm nhất | 0,2 / 31,2 giây |

**Phân bố (tháng 8–9).** 76% câu trả lời mất 5–20 giây; 13 câu mất 20–31 giây; không câu nào vượt 40 giây.

| Loại yêu cầu (tháng 8–9) | Số câu | Trung bình | Trung vị | p90 |
|---|---|---|---|---|
| Có gọi tool (tra cứu phòng, đặt/huỷ lịch, chỉ đường) | 77 | 12,8 giây | 11,5 giây | 23,5 giây |
| Không gọi tool (hỏi lại, từ chối ngoài phạm vi) | 59 | 8,7 giây | 7,6 giây | 14,3 giây |

**Đánh giá.** Thời gian phản hồi phổ biến nằm trong mức chấp nhận được với tác vụ đặt phòng. Một yêu cầu đặt phòng qua chat thay thế cho việc tra từng phòng, từng khung giờ trên Outlook. Trong lúc agent xử lý, giao diện hiển thị trạng thái "đang soạn" liên tục để người dùng biết yêu cầu đang được thực hiện.

**Lưu ý.**
- Phần lớn thời gian nằm ở bước LLM xử lý: câu không gọi tool vẫn mất khoảng 7,6 giây, gọi tool chỉ cộng thêm khoảng 4 giây. Hướng tối ưu tiếp theo tập trung vào prompt và model.
- Tháng 9 chậm hơn tháng 8 khoảng 2,4 giây (trung vị 11,9 giây so với 8,6 giây). Mẫu tháng 9 nhỏ (55 cặp), chưa đủ để kết luận agent đang chậm dần; team sẽ tiếp tục theo dõi.

## 4. Câu hỏi mẫu cho demo

1. `Chiều nay có phòng nào 1 tiếng không?` → `Cho tôi phòng Madrid` → `16-17h` → bấm **Đồng ý** (TC-01)
2. `Chỉ đường đến phòng Madrid` (TC-02)
3. `Chiều nay tôi có lịch nào không?` → `Huỷ giúp tôi` → `Có` (TC-03)
4. `Cho tôi xin lịch của huyennn đi` (TC-04)
5. `Tối nay ăn gì` (TC-05)
