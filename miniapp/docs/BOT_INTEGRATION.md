# Zalo Bot ↔ VNGMeet Chat Integration

Tích hợp chat của VNGMeet vào **Zalo Bot Platform** (`bot.zaloplatforms.com`) — kênh
chat text-only, kiểu Telegram. Bot dùng lại **chính agent chat** mà Mini App đang
dùng (endpoint `/api/chat/*`), không tách logic.

> Zalo Bot Platform KHÁC Zalo OA. Bot Platform **không hỗ trợ** button/inline
> keyboard/quick-reply/native command menu (đã xác minh). Vì vậy mọi thao tác điều
> khiển đều qua `/lệnh` dạng text; `/help` là cơ chế khám phá lệnh.

## Kiến trúc

```
Zalo Bot ──webhook──► POST /api/bot/webhook (verify X-Bot-Api-Secret-Token, ack 200)
                          │  (xử lý nền, không chặn webhook)
        ┌─────────────────┼──────────────────┐
   Command router     Session/link store   Zalo client (sendMessage, chunk<2000)
   (/ ở đầu câu)      chat_id→{account,      │
        │             current_thread}        │
        ├── /lệnh (code cứng, không AI)       │
        └── text thường ──► mint session JWT ─► send_chat_message (agent /chat/*)
```

**Điểm mấu chốt:** `request` trong `chat.py`/`bookings.py` chỉ dùng để resolve auth
(header `Authorization: Bearer`). Nên bot **mint session JWT** cho tài khoản đã link
(`auth.mint_zalo_session`) rồi dựng **synthetic `Request`** mang bearer đó, replay
qua `send_chat_message`/`list_chat_threads` **không sửa `chat.py`**.

## Bộ lệnh

| Lệnh | Việc | Cần link? |
|---|---|---|
| `/start` | Chào + hướng dẫn | Không |
| `/help` | Menu lệnh | Không |
| `/whoami` | Tài khoản + thread hiện tại; chưa link → điều hướng Mini App | Không (cửa ngõ) |
| `/new [tiêu đề]` | Tạo đoạn chat mới | Có |
| `/recent` | Liệt kê đoạn chat gần đây (đánh số) | Có |
| `/switch <n>` | Chuyển sang đoạn chat số n | Có |
| _text thường_ | Chat với agent trong thread hiện tại | Có |

- Nhận diện lệnh **chỉ khi `/` là ký tự đầu câu** → `2/3/2002`, `/etc/hosts` là text thường.
- Lệnh lạ → `MSG_UNKNOWN` ở mọi trạng thái (không đẩy vào AI).

## Trạng thái xác thực

| | Điều kiện | Hành vi lệnh gated & chat |
|---|---|---|
| **S0** chưa link | không có `auth_user_id` | `MSG_NOT_LINKED` + deep-link pairing |
| **S1** OK | link + `get_graph_token` thành công | chạy bình thường |
| **S2** hết hạn | link nhưng Graph token fail | `MSG_SESSION_EXPIRED` + deep-link reauth |

`/start` `/help` `/whoami` chạy ở mọi trạng thái.

## Liên kết tài khoản (pairing qua Mini App)

1. User chưa link nhắn bot → bot tạo **mã pairing** (bảng `bot_pairings`, TTL
   `BOT_PAIRING_TTL_SECONDS`) và gửi deep-link `…?bot_pair=<code>`.
2. User mở Mini App (đã phone-auth) → FE đọc `bot_pair` → `POST /api/bot/link {code}`.
3. Backend consume mã, lưu `chat_id → { auth_user_id, claims(profile_id/sub/…) }`
   vào `bot_links`, rồi báo thành công ngay trong khung chat bot.

> `claims.profile_id` là **bắt buộc**: session Zalo resolve user thẳng từ
> `profile_id` (không có email @), thiếu nó thì request replay sẽ 503.

## Files

- `backend/app/bot.py` — toàn bộ logic bot (webhook, router, store, Zalo client, link).
- `backend/app/config.py` — thêm `zalo_bot_token`, `zalo_bot_secret_token`, `bot_pairing_ttl_seconds`.
- `backend/app/main.py` — `include_router(bot_router)`.
- `supabase/migrate_bot_links.sql` — bảng `bot_links`, `bot_pairings`.
- `miniapp/src/services/api.ts` — `api.linkBot(code)`.
- `miniapp/src/components/layout.tsx` — đọc `?bot_pair` và gọi link sau khi có session.

## Triển khai

### 1. Chạy migration Supabase
Chạy `supabase/migrate_bot_links.sql` trên DB (bảng `bot_links`, `bot_pairings`).

### 2. Biến môi trường (.env — tự thêm, KHÔNG commit)
```dotenv
# Zalo Bot Platform (lấy từ bot.zaloplatforms.com sau khi tạo bot)
ZALO_BOT_TOKEN=<bot_token_dạng_id:secret>
# Chuỗi bí mật tự đặt, phải trùng với secret khai báo lúc setWebhook
ZALO_BOT_SECRET_TOKEN=<chuỗi_ngẫu_nhiên_bạn_tự_đặt>
# Deep-link MỞ MINI APP để liên kết tài khoản (BẮT BUỘC để user link được).
# Phải trỏ Mini App, KHÔNG phải web frontend. Vd: https://zalo.me/s/<app_id>/
BOT_MINIAPP_LINK=https://zalo.me/s/<app_id>/
# (tuỳ chọn) hạn mã pairing, mặc định 600s
BOT_PAIRING_TTL_SECONDS=600
# (tuỳ chọn) hạn user xác nhận đặt phòng qua bot (Y/N), mặc định 60s
BOT_BOOKING_CONFIRM_TTL_SECONDS=60
```

### 3. Đăng ký webhook (chạy 1 lần, thay giá trị của bạn)
```bash
curl -X POST "https://bot-api.zaloplatforms.com/bot<ZALO_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<host-backend>/api/bot/webhook","secret_token":"<ZALO_BOT_SECRET_TOKEN>"}'
```
> Tên field secret (`secret_token`) theo quy ước; đối chiếu lại doc `setWebhook` của
> Zalo để chắc. Giá trị phải **trùng** `ZALO_BOT_SECRET_TOKEN` để verify header
> `X-Bot-Api-Secret-Token` thành công. Kiểm tra bằng `getWebhookInfo`.

## Giới hạn đã biết (MVP)

- **Xác nhận đặt phòng trên bot (Y/N + timeout)**: Zalo Bot không render button, nên
  khi agent tạo card `requires_confirmation`, bot lưu pending (`bot_links.pending_booking`)
  và cho user **trả lời Y (đồng ý) / N (huỷ)** (vẫn đính kèm button OA best-effort).
  Xác nhận trong **`BOT_BOOKING_CONFIRM_TTL_SECONDS`** (mặc định 60s); hết hạn bot tự
  push msg timeout. Confirm/reject/expire đều qua endpoint chung
  `POST /api/chat/bookings/action` (action `accept`/`reject`/`expire`). Trong lúc chờ,
  input khác Y/N chỉ nhận lời nhắc (đến khi timeout).
- Chỉ xử lý `message.text.received` (ảnh/sticker/voice bỏ qua).
- **Graph token cho bot**: deployment hiện dùng Graph token paste (`graph_token_pool`),
  KHÔNG dùng per-user Microsoft OAuth (`provider_tokens` trống). Khi bot user không có
  token qua provider_tokens, `_ensure_graph_token` lấy token từ `graph_token_pool`
  **CHỈ của chính user đó** (lọc `owner_key ∈ {profile_id, sub}`) rồi seed cache —
  KHÔNG mượn token toàn cục để tránh đặt phòng nhầm danh tính người khác. Cần:
  `SCHEDULED_TOKEN_ENCRYPTION_KEY` đúng để giải mã, và user đó phải có token
  `status=active` trong pool (tự paste Graph token trên web). Nếu user chưa có token
  riêng → S2 (không đặt phòng bằng token người khác).
- Deep-link đọc `bot_pair` từ query URL; nếu Zalo Mini App truyền launch param theo
  cách khác, chỉnh `readBotPairCode()` trong `layout.tsx`.
