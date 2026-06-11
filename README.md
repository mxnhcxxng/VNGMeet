# VNG Meet — Meeting Room Availability

Đăng nhập bằng tài khoản **Microsoft (work)**, quét tất cả phòng được đánh dấu là
**meeting room** trong tổ chức, và hiển thị tình trạng đặt phòng dưới dạng **lưới**:

- **Cột = ngày**, **hàng = giờ**
- 🟩 xanh = trống · 🟨 vàng = tạm giữ (tentative) · 🟥 đỏ = đã book

## Kiến trúc

| Thành phần | Công nghệ | Cổng |
|---|---|---|
| Backend | FastAPI + MSAL + Microsoft Graph | `:8000` |
| Frontend | Next.js 14 (App Router) + HeroUI | `:3000` |

Luồng: user bấm **Đăng nhập** → backend redirect sang Microsoft (OAuth2 authorization
code flow, delegated) → callback đổi code lấy token → backend gọi Graph
`/places/microsoft.graph.room` (liệt kê phòng) và `/me/calendar/getSchedule`
(free/busy của từng phòng).

---

## 1. Tạo Azure AD App Registration

> Graph Explorer (developer.microsoft.com/graph/graph-explorer) chỉ để **test query**,
> không phải nơi lấy credential. Credential nằm ở **Azure Portal**.

1. Vào https://portal.azure.com → **Microsoft Entra ID** → **App registrations** → **New registration**.
2. Name: `VNG Meet`. Supported account types: *Accounts in this organizational directory only* (hoặc multi-tenant tuỳ nhu cầu).
3. **Redirect URI**: chọn type **Web**, giá trị `http://localhost:8000/api/auth/callback`.
4. Bấm **Register**. Ghi lại **Application (client) ID** và **Directory (tenant) ID**.
5. **Certificates & secrets** → **New client secret** → copy giá trị cột **Value** (chỉ hiện 1 lần).
6. **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**, thêm:
   - `Place.Read.All` — liệt kê phòng họp
   - `Calendars.Read.Shared` — đọc free/busy của phòng
   - `User.Read`
   Sau đó bấm **Grant admin consent** (`Place.Read.All` cần admin đồng ý).

## 2. Cấu hình `.env`

```bash
cp .env.example .env
# điền CLIENT_ID, CLIENT_SECRET, TENANT_ID
```

## 3. Chạy bằng Docker (khuyến nghị)

```bash
docker compose up --build
```

- Frontend: http://localhost:3000
- Backend docs: http://localhost:8000/docs

## 4. Chạy thủ công (dev, không Docker)

Backend:
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# nạp biến môi trường từ .env ở thư mục gốc, hoặc copy .env vào backend/
uvicorn app.main:app --reload --port 8000
```

Frontend:
```bash
cd frontend
npm install
npm run dev
```

---

## Tuỳ chỉnh

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `TIMEZONE` | Múi giờ hiển thị (IANA) | `Asia/Ho_Chi_Minh` |
| `BUSINESS_START_HOUR` / `BUSINESS_END_HOUR` | Khung giờ làm việc trên lưới | `8` / `18` |
| `SLOT_MINUTES` | Độ phân giải mỗi ô (phút) | `30` |

## Ghi chú

- Chỉ phòng có **room mailbox** (đăng ký trong Exchange) mới xuất hiện qua
  `/places/microsoft.graph.room`. Phòng tạo thủ công nhưng chưa phải room mailbox sẽ không hiện.
- Token cache hiện lưu **in-memory** trên backend (mất khi restart). Lên production nên
  thay bằng Redis và dùng HTTPS + `SESSION_SECRET` ngẫu nhiên.
- Trạng thái map từ Graph `availabilityView`: `0` free, `1` tentative, `2` busy,
  `3` out-of-office, `4` working-elsewhere. Mọi thứ khác `0` đều coi là "đã book" (đỏ).
```
