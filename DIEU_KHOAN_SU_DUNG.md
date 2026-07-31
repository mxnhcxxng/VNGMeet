# ĐIỀU KHOẢN SỬ DỤNG ỨNG DỤNG VNGMeet

**Cập nhật lần cuối:** 29/07/2026

Chào mừng bạn đến với **VNGMeet** — ứng dụng đặt và quản lý phòng họp. Vui lòng đọc kỹ Điều khoản Sử dụng ("Điều khoản") này trước khi sử dụng. Khi bạn đăng nhập và sử dụng VNGMeet, bạn xác nhận đã đọc, hiểu và đồng ý bị ràng buộc bởi các Điều khoản dưới đây.

---

## 1. Định nghĩa

- **"Ứng dụng"** / **"VNGMeet"**: nền tảng đặt phòng họp được cung cấp dưới dạng Zalo Mini App và các kênh liên quan.
- **"Người dùng"** / **"Bạn"**: cá nhân đăng nhập và sử dụng Ứng dụng.
- **"Chúng tôi"**: đơn vị vận hành VNGMeet.
- **"Dịch vụ bên thứ ba"**: các nền tảng tích hợp gồm Zalo và Microsoft 365 (Microsoft Graph).

---

## 2. Phạm vi dịch vụ

VNGMeet cho phép Người dùng:

- Đăng nhập bằng số điện thoại thông qua Zalo.
- Xem danh sách phòng họp và tình trạng trống/bận của phòng.
- Đặt, chỉnh sửa và huỷ lịch đặt phòng họp trên hệ thống lịch Microsoft 365 của Người dùng.
- Xem thông tin hồ sơ cơ bản của chính mình phục vụ mục đích đăng nhập và hiển thị.

---

## 3. Đăng nhập và xác thực bằng số điện thoại

- Để sử dụng Ứng dụng, bạn cần cho phép VNGMeet truy cập **số điện thoại** đã đăng ký trên tài khoản Zalo của bạn.
- Số điện thoại được dùng **duy nhất cho mục đích xác thực và định danh tài khoản** của bạn trong Ứng dụng.
- Bạn chịu trách nhiệm bảo mật tài khoản Zalo dùng để đăng nhập. Mọi hoạt động phát sinh từ tài khoản đã đăng nhập được xem là do bạn thực hiện.

---

## 4. Các quyền truy cập được hệ thống sử dụng

Để cung cấp dịch vụ, VNGMeet yêu cầu và sử dụng các quyền sau. Chúng tôi chỉ sử dụng các quyền này đúng với mục đích được mô tả và trong phạm vi cần thiết để vận hành tính năng tương ứng.

### 4.1. Quyền từ Zalo

- **Truy cập số điện thoại:** Lấy số điện thoại của bạn để **đăng nhập** và định danh tài khoản trong Ứng dụng.

### 4.2. Quyền từ Microsoft 365 (Microsoft Graph)

- **`Calendars.Read`** — dùng để **liệt kê danh sách phòng họp** (qua endpoint `GET /beta/me/microsoft.graph.findRooms()`).
- **`Calendars.Read.Shared`** — dùng để **xem lịch trống/bận của phòng** (qua `POST /v1.0/me/calendar/getSchedule` và `GET /v1.0/me/calendarView`).
- **`Calendars.ReadWrite`** — dùng để **đặt / sửa / huỷ lịch đặt phòng** (qua `POST / PATCH / DELETE /v1.0/me/events`).
- **`User.Read`** — dùng để **đọc hồ sơ người dùng** (tên, email, ID) khi đăng nhập (qua `GET /v1.0/me`).

Việc cấp các quyền trên là **điều kiện cần thiết** để sử dụng các tính năng tương ứng. Nếu bạn từ chối cấp quyền, một số tính năng có thể không hoạt động.

---

## 5. Thu thập và sử dụng dữ liệu

Khi bạn sử dụng VNGMeet, chúng tôi có thể thu thập và xử lý:

- **Số điện thoại** (từ Zalo) — dùng để đăng nhập, định danh tài khoản.
- **Định danh Zalo** (`zalo_user_id`) và **liên kết hội thoại với Zalo Bot** — dùng để ánh xạ tài khoản Zalo của bạn với tài khoản VNGMeet và gửi/nhận tin nhắn qua Bot.
- **Thông tin hồ sơ Microsoft 365** — tên, email, ID người dùng — dùng để hiển thị và liên kết lịch đặt phòng.
- **Dữ liệu lịch liên quan đến việc đặt phòng** — thông tin phòng họp, thời gian trống/bận, và các lịch (events) do bạn tạo/sửa/huỷ thông qua Ứng dụng.
- **Nội dung trao đổi (chat)** giữa bạn và trợ lý AI của Ứng dụng.

**Cải thiện AI:** Chúng tôi có thể thu thập và sử dụng **nội dung chat** của bạn nhằm mục đích **phân tích, huấn luyện và cải thiện chất lượng của trợ lý AI** trong Ứng dụng. Chúng tôi áp dụng các biện pháp hợp lý để hạn chế thông tin định danh cá nhân trong quá trình này.

Chúng tôi **không** sử dụng dữ liệu của bạn cho các mục đích ngoài phạm vi cung cấp và cải thiện dịch vụ, và **không** bán dữ liệu cá nhân của bạn cho bên thứ ba.

---

## 6. Lưu trữ và bảo mật dữ liệu

- Dữ liệu được lưu trữ và xử lý với các biện pháp bảo mật hợp lý nhằm bảo vệ khỏi truy cập trái phép.
- Việc truy cập lịch Microsoft 365 được thực hiện thông qua cơ chế uỷ quyền (OAuth) chuẩn của Microsoft; chúng tôi chỉ truy cập trong phạm vi các quyền bạn đã cấp.

---

## 7. Quyền rút lại uỷ quyền (gỡ liên kết Zalo)

Zalo Mini App chỉ là **kênh xác thực**: nó dùng số điện thoại để ánh xạ sang tài khoản VNGMeet — tài khoản này vốn hoạt động độc lập, đầy đủ trên web thông qua Microsoft.

Vì vậy, khi bạn **rút lại sự đồng ý** cho Mini App qua cài đặt của Zalo, hệ thống sẽ **chỉ gỡ phần dữ liệu do Zalo tạo ra**, cụ thể:

- Xoá **liên kết hội thoại với Zalo Bot** (`bot_links`).
- Xoá **định danh Zalo** (`zalo_user_id`) mà chúng tôi lưu để ánh xạ tài khoản.

Việc rút lại uỷ quyền **KHÔNG** xoá tài khoản VNGMeet của bạn cũng như các dữ liệu không phải do Zalo tạo ra, bao gồm: **hồ sơ tài khoản, lịch đặt phòng (booking), lịch sử chat và liên kết Microsoft**. Bạn vẫn có thể tiếp tục đăng nhập và sử dụng VNGMeet trên nền tảng web.

Sau khi gỡ liên kết, để dùng lại Mini App bạn chỉ cần đăng nhập lại bằng số điện thoại Zalo.

---

## 8. Trách nhiệm của Người dùng

Khi sử dụng VNGMeet, bạn cam kết:

- Cung cấp thông tin chính xác và sử dụng Ứng dụng đúng mục đích.
- Không sử dụng Ứng dụng cho mục đích vi phạm pháp luật hoặc quy định nội bộ.
- Không can thiệp, dò quét, khai thác lỗ hổng hoặc gây gián đoạn hoạt động của hệ thống.
- Không đặt/huỷ phòng nhằm mục đích quấy rối, chiếm dụng tài nguyên hoặc gây ảnh hưởng đến người dùng khác.

---

## 9. Dịch vụ bên thứ ba

- VNGMeet tích hợp với **Zalo** và **Microsoft 365**. Việc bạn sử dụng các dịch vụ này còn chịu sự điều chỉnh bởi điều khoản và chính sách riêng của Zalo và Microsoft.
- Chúng tôi không chịu trách nhiệm về hoạt động, tính khả dụng hoặc chính sách của các dịch vụ bên thứ ba.

---

## 10. Giới hạn trách nhiệm

- Ứng dụng được cung cấp theo hiện trạng ("as is"). Chúng tôi nỗ lực duy trì dịch vụ ổn định nhưng không cam kết Ứng dụng luôn không gián đoạn hoặc không có lỗi.
- Trong phạm vi pháp luật cho phép, chúng tôi không chịu trách nhiệm cho các thiệt hại gián tiếp phát sinh từ việc sử dụng hoặc không thể sử dụng Ứng dụng.

---

## 11. Thay đổi điều khoản

Chúng tôi có thể cập nhật Điều khoản này theo thời gian. Phiên bản cập nhật sẽ được thông báo trong Ứng dụng. Việc bạn tiếp tục sử dụng sau khi cập nhật đồng nghĩa với việc chấp nhận Điều khoản mới.

---

## 12. Liên hệ

Nếu có thắc mắc về Điều khoản Sử dụng hoặc cách xử lý dữ liệu, vui lòng liên hệ với đơn vị vận hành VNGMeet.
