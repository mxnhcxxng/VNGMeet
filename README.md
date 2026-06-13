# VNG Meet — Meeting Room Availability

Đăng nhập bằng tài khoản **Microsoft (work)**, quét tất cả phòng được đánh dấu là
**meeting room** trong tổ chức, và hiển thị tình trạng đặt phòng dưới dạng **lưới**:

- **Cột = ngày**, **hàng = giờ**
- 🟩 xanh = trống · 🟨 vàng = tạm giữ (tentative) · 🟥 đỏ = đã book

## Kiến trúc

| Thành phần | Công nghệ | Cổng |
|---|---|---|
| Backend | FastAPI + Microsoft Graph | `:8000` |
| Frontend | Next.js 14 (App Router) + HeroUI | `:3000` |
| Auth + DB | Supabase (Azure OAuth provider, Postgres) | — |

Luồng: user bấm **Đăng nhập** → **Supabase** chạy OAuth với **Azure (Microsoft)** làm
provider → user login bằng tài khoản MS work → Supabase trả session JWT + `provider_token`
(Graph access token) + `provider_refresh_token`. Frontend gửi `provider_refresh_token`
cho backend (`POST /api/auth/link`) lưu vào bảng `provider_tokens`. Mỗi lần gọi Graph,
backend đổi refresh token đó lấy access token mới tại endpoint token của Azure (vì
**Supabase không tự refresh provider token**), rồi gọi `/places/microsoft.graph.room`
(liệt kê phòng) và `/me/calendar/getSchedule` (free/busy).

---

## 1. Tạo Azure AD App Registration

> Graph Explorer (developer.microsoft.com/graph/graph-explorer) chỉ để **test query**,
> không phải nơi lấy credential. Credential nằm ở **Azure Portal**.

1. Vào https://portal.azure.com → **Microsoft Entra ID** → **App registrations** → **New registration**.
2. Name: `VNG Meet`. Supported account types: *Accounts in this organizational directory only* (hoặc multi-tenant tuỳ nhu cầu).
3. **Redirect URI**: chọn type **Web**, giá trị `https://<project-ref>.supabase.co/auth/v1/callback` (lấy từ Supabase → Authentication → Providers → Azure).
4. Bấm **Register**. Ghi lại **Application (client) ID** và **Directory (tenant) ID**.
5. **Certificates & secrets** → **New client secret** → copy giá trị cột **Value** (chỉ hiện 1 lần).
6. **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**, thêm:
   - `Place.Read.All` — liệt kê phòng họp
   - `Calendars.Read.Shared` — đọc free/busy của phòng
   - `Calendars.ReadWrite` — tạo event (đặt phòng)
   - `User.Read`
   Sau đó bấm **Grant admin consent** (`Place.Read.All` cần admin đồng ý).

## 2. Cấu hình Supabase

1. Tạo project tại https://supabase.com (nếu chưa có).
2. **Authentication → Providers → Azure**: Enable, điền Azure `Application (client) ID`,
   `Secret Value`, và **Azure Tenant URL** = `https://login.microsoftonline.com/<TENANT_ID>`.
3. **SQL Editor**: chạy [`supabase/schema.sql`](supabase/schema.sql) để tạo bảng
   `provider_tokens`, `bookings`, `favorite_rooms` (kèm RLS).
4. **Project Settings → API**: lấy `Project URL`, `anon key`, `service_role key`, và
   `JWT Secret`.

## 3. Cấu hình `.env`

```bash
cp .env.example .env
# điền CLIENT_ID, CLIENT_SECRET, TENANT_ID + SUPABASE_URL / ANON_KEY /
# SERVICE_ROLE_KEY / JWT_SECRET
# điền thêm LLM_BASE_URL, LLM_API_KEY, LLM_MODEL để bật chat bot

cp frontend/.env.local.example frontend/.env.local
# điền NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY
```

## 4. Chạy bằng Docker (khuyến nghị)

```bash
docker compose up --build
```

- Frontend: http://localhost:3000
- Backend docs: http://localhost:8000/docs

## 5. Chạy thủ công (dev, không Docker)

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
| `BUSINESS_START_HOUR` / `BUSINESS_END_HOUR` | Khung giờ làm việc trên lưới | `9` / `18` |
| `SLOT_MINUTES` | Độ phân giải mỗi ô (phút) | `30` |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | Provider chat OpenAI-compatible | — |

## Ghi chú

- Chỉ phòng có **room mailbox** (đăng ký trong Exchange) mới xuất hiện qua
  `/places/microsoft.graph.room`. Phòng tạo thủ công nhưng chưa phải room mailbox sẽ không hiện.
- `provider_refresh_token` được lưu bền trong Supabase (`provider_tokens`); Graph access
  token chỉ cache **in-memory** theo user (mất khi restart nhưng tự dựng lại từ refresh
  token). Supabase **không** tự refresh provider token — backend phải tự đổi.
- Browse grid đọc `/api/availability` từ bảng `room_availability`; nếu cache thiếu hoặc
  `updated_at` cũ hơn 5 phút, backend dùng delegated Graph token của user hiện tại để
  refresh bảng rồi mới trả UI.
- Supabase cron job `seed_room_availability_midnight_gmt7` chạy mỗi 00:00 GMT+7
  để tạo các row `room_availability` còn thiếu cho ngày thứ 18 tính từ ngày mới.
  Row đã tồn tại trong DB sẽ được bỏ qua.
- Trạng thái map từ Graph `availabilityView`: `0` free, `1` tentative, `2` busy,
  `3` out-of-office, `4` working-elsewhere. Mọi thứ khác `0` đều coi là "đã book" (đỏ).
```
