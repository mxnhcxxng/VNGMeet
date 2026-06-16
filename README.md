# 🏢 VNGMeet — Vì Starter xứng đáng được họp trong phòng

## 😩 Problem

Gọi phòng họp ở VNG là vàng vì ngày nào Starter cũng đào mãi không ra. Outlook không
hiện view tổng quan, nên *"xem khung giờ khác còn phòng không"* dịch cabin ra là *"ngồi
check từng giờ, ăn may thì ra"*. Nếu team có lịch họp cố định — trước đó 14 ngày, Starter
phải thức đến 12 giờ đêm nhưng không phải để săn sale mà để canh đúng giờ mở slot book phòng.

## 👤 User

Toàn bộ **Starter tại VNG** trên khắp Việt Nam, nếu Starter từng book phòng họp.

## 💡 Solution

**VNGMeet** là **AI chatbot** tích hợp trực tiếp với hệ thống đặt phòng tại VNG.

### 🗓️ Use case 1 — Book phòng

- Starter input khung giờ họp (kết hợp với dữ liệu vị trí của Starter trong **Setting**)
- VNGMeet truy vấn **real-time** → trả về danh sách phòng trống
- Nếu không có → VNGMeet **gợi ý slot lân cận** có phòng trống
- Starter xác nhận → VNGMeet **book phòng** và gửi confirm qua **Outlook**
- Starter **edit** hoặc **cancel** phòng → chat trực tiếp

### ⏰ Use case 2 — Đặt gạch để book phòng

- Starter chọn trước **phòng + khung giờ**
- Đúng thời điểm hệ thống mở đăng ký → VNGMeet **tự động** thực hiện booking
- Starter nhận confirm qua **Outlook** — không cần thức đêm hay thao tác thủ công

### 🗺️ Feature bổ sung

VNGMeet tích hợp **map nội bộ**, chỉ đường đến bất kỳ phòng họp nào.

## 🎯 Value

- ⚡ Starter tìm phòng trống nhanh hơn, không còn cảnh tìm phòng phút chót, họp muộn,
  hủy họp, hay... **họp đứng** (chuyện có thật)
- 💬 Starter tiết kiệm thời gian book phòng vì chỉ cần **1 lệnh chat**
- 😴 Starter được ngủ đủ giấc, sáng dậy vẫn có phòng

---

## Tổng quan kỹ thuật

Đăng nhập bằng tài khoản **Microsoft (work)**, quét tất cả phòng được đánh dấu là
**meeting room** trong tổ chức, và hiển thị tình trạng đặt phòng dưới dạng **lưới**:

- **Cột = ngày**, **hàng = giờ**
- 🟩 xanh = trống · 🟥 đỏ = đã book

## Kiến trúc

| Thành phần | Công nghệ | Cổng local | Cổng container |
|---|---|---|---|
| Backend | FastAPI + Microsoft Graph | `:8000` | `:8080` |
| Frontend | Next.js 14 (App Router) + HeroUI | `:3000` | `:8080` |
| Auth + DB | Supabase (Azure OAuth provider, Postgres) | — | — |

> **Cổng:** cả hai container mặc định nghe port `8080` (chuẩn của GreenNode AgentBase
> Runtime) và expose `GET /health`. Khi chạy local bằng `docker compose`, biến `PORT`
> được ghim lại để giữ backend ở `:8000` và frontend ở `:3000`. Mỗi service có thể đổi
> port qua biến môi trường `PORT`.

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

> **`FRONTEND_URL`** dùng cho CORS của backend và có thể là **danh sách nhiều origin
> phân tách bằng dấu phẩy** — để vừa chạy local vừa chạy bản deploy, đặt ví dụ:
> `FRONTEND_URL=http://localhost:3000,https://<frontend-endpoint>.agentbase-runtime.aiplatform.vngcloud.vn`

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

## 6. Deploy lên GreenNode AgentBase

App được deploy thành **2 Custom Agent runtime** (backend + frontend) trên
[GreenNode AgentBase](https://aiplatform.console.vngcloud.vn/agent-runtime?tab=runtime);
Supabase vẫn là dịch vụ ngoài. Mọi thao tác dùng bộ skill kèm trong repo tại
`greennode-agentbase-skills/.claude/skills/` (đặt `SK` cho gọn):

```bash
SK=greennode-agentbase-skills/.claude/skills/agentbase/scripts
```

> **Hợp đồng runtime:** container phải nghe port `8080` và có `GET /health` → 200.
> Repo này đã thoả sẵn (xem mục Kiến trúc) nên không cần chỉnh gì thêm.

### 6.1. Chuẩn bị credentials (chỉ làm 1 lần)

Cần **GreenNode IAM Service Account** — **khác hoàn toàn** với `CLIENT_ID`/`CLIENT_SECRET`
của Azure trong `.env` (Azure là để gọi Microsoft Graph; IAM là để gọi API quản trị
AgentBase lúc deploy).

1. Tạo Service Account tại https://iam.console.vngcloud.vn/service-accounts, gán policy
   `AgentBaseFullAccess`, `vcrFullAccess`, `AiPlatformFullAccess`.
2. Lưu cặp client_id/secret vào `.greennode.json` ở thư mục gốc (đã được `.gitignore`):
   ```json
   { "client_id": "<IAM client id>", "client_secret": "<IAM client secret>" }
   ```
3. Kiểm tra: `bash $SK/check_credentials.sh iam`

> IAM credentials chỉ dùng trên máy local khi deploy. Khi container chạy, AgentBase tự
> inject `GREENNODE_*` vào container — **không** đặt các biến này trong `.env`.

### 6.2. Đăng nhập Container Registry

Mỗi tài khoản có sẵn 1 repo trong AgentBase managed CR:

```bash
bash $SK/cr.sh repo get                    # xem registryUrl + tên repo
bash $SK/cr.sh credentials docker-login    # đăng nhập docker (không ghi file)
```

Đường dẫn image có dạng `{registryUrl}/{repo}/{image}:{tag}`
(ví dụ `vcr.vngcloud.vn/<repo>/vng-meet-backend:<tag>`).

### 6.3. Deploy lần đầu

Máy Apple Silicon (arm64) phải build `--platform linux/amd64`. **Thứ tự quan trọng:**
backend trước (lấy URL), rồi frontend (trỏ vào URL backend), rồi cập nhật CORS backend.

```bash
REPO=$(bash $SK/cr.sh repo get | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['registryUrl']+'/'+d['name'])")

# --- Backend ---
TAG="v$(date +%Y%m%d%H%M%S)"; IMG="$REPO/vng-meet-backend:$TAG"
docker build --platform linux/amd64 -t "$IMG" ./backend && docker push "$IMG"
bash $SK/runtime.sh create --name vng-meet-backend --image "$IMG" \
  --flavor runtime-s2-general-2x4 --env-file .env --from-cr --network-mode PUBLIC \
  --min-replicas 1 --max-replicas 1 --cpu-scale 50 --mem-scale 50
# Lấy backend URL:
BURL=$(bash $SK/runtime.sh endpoints list <backend-runtime-id> | python3 -c "import sys,json;d=json.load(sys.stdin);items=d if isinstance(d,list) else d['listData'];print([e['url'] for e in items if e['name']=='DEFAULT'][0])")

# --- Frontend (cần BURL ở build time) ---
SUPA_URL=$(grep -E '^SUPABASE_URL=' .env | cut -d= -f2-)
SUPA_ANON=$(grep -E '^SUPABASE_ANON_KEY=' .env | cut -d= -f2-)
TAG="v$(date +%Y%m%d%H%M%S)"; IMG="$REPO/vng-meet-frontend:$TAG"
docker build --platform linux/amd64 \
  --build-arg NEXT_PUBLIC_API_URL="$BURL" \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="$SUPA_URL" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$SUPA_ANON" \
  -t "$IMG" ./frontend && docker push "$IMG"
bash $SK/runtime.sh create --name vng-meet-frontend --image "$IMG" \
  --flavor runtime-s2-general-2x4 --from-cr --network-mode PUBLIC \
  --min-replicas 1 --max-replicas 1 --cpu-scale 50 --mem-scale 50
```

Sau khi có frontend URL, thêm nó vào `FRONTEND_URL` (xem mục 3) rồi redeploy backend để
CORS cho phép origin frontend (mục 6.4).

### 6.4. Redeploy khi sửa code

URL endpoint **không đổi** qua các lần update — chỉ build image mới, push, rồi `update`:

```bash
# Backend
TAG="v$(date +%Y%m%d%H%M%S)"; IMG="$REPO/vng-meet-backend:$TAG"
docker build --platform linux/amd64 -t "$IMG" ./backend && docker push "$IMG"
bash $SK/runtime.sh update <backend-runtime-id> --image "$IMG" \
  --flavor runtime-s2-general-2x4 --env-file .env --from-cr

# Frontend (nhớ truyền lại build-arg NEXT_PUBLIC_*)
TAG="v$(date +%Y%m%d%H%M%S)"; IMG="$REPO/vng-meet-frontend:$TAG"
docker build --platform linux/amd64 \
  --build-arg NEXT_PUBLIC_API_URL="$BURL" \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="$SUPA_URL" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$SUPA_ANON" \
  -t "$IMG" ./frontend && docker push "$IMG"
bash $SK/runtime.sh update <frontend-runtime-id> --image "$IMG" \
  --flavor runtime-s2-general-2x4 --from-cr
```

> ⚠️ **Bẫy CORS:** redeploy backend dùng `--env-file .env`, nên hãy đảm bảo `FRONTEND_URL`
> trong `.env` đã chứa origin frontend đã deploy (mục 3), nếu không CORS sẽ chỉ còn localhost.

### 6.5. Cấu hình Supabase cho bản deploy

Login chạy OAuth với `redirectTo = window.location.origin` (= URL frontend đã deploy),
nên phải whitelist URL đó trong **Supabase → Authentication → URL Configuration**:

- **Site URL**: `https://<frontend-endpoint>...vngcloud.vn`
- **Redirect URLs**: thêm `https://<frontend-endpoint>...vngcloud.vn/**` (giữ thêm
  `http://localhost:3000/**` nếu vẫn dev local)

Azure redirect URI **không đổi** — vẫn là Supabase callback
`https://<project-ref>.supabase.co/auth/v1/callback`.

### 6.6. Theo dõi & quản lý

```bash
bash $SK/runtime.sh list                      # liệt kê runtime
bash $SK/runtime.sh get <runtime-id>          # trạng thái / version
curl -s -o /dev/null -w "%{http_code}\n" <endpoint-url>/health
```

Xem logs/metrics bằng skill `/agentbase-monitor`; xoá toàn bộ tài nguyên bằng
`/agentbase-teardown`. Chi tiết các skill xem `greennode-agentbase-skills/README.md`.

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
