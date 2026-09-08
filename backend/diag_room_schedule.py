"""Chẩn đoán vì sao một phòng báo TRỐNG nhưng lại DECLINE khi đặt thật.

Chạy tại thư mục backend/:
    venv/bin/python diag_room_schedule.py nairobi
    venv/bin/python diag_room_schedule.py nairobi taipei seoul

Vấn đề nó trả lời: app chỉ có DUY NHẤT một nguồn sự thật cho free/busy là
`availabilityView`, và với phòng lỗi cấu hình thì view đó toàn "0" — giống
từng byte với một phòng thật sự rảnh. Script này gọi getSchedule THÔ (không
qua graph.get_schedule nên không drop gì) và in ra mọi field đi kèm, để tìm
field nào phân biệt được "trống thật" với "không đọc được".

KHÔNG in token. Chỉ in metadata của response.
"""

import asyncio
import sys

import httpx

from app.config import get_settings
from app import token_pool

s = get_settings()
WANTED = [a.strip().lower() for a in sys.argv[1:]] or ["nairobi"]


def _rooms():
    from app.supabase_client import get_supabase

    rows = (
        get_supabase()
        .table("meeting_room_metadata")
        .select("id, name, email, in_use, office, capacity")
        .eq("in_use", True)
        .execute()
        .data
        or []
    )
    suspect, control = [], []
    for r in rows:
        blob = f"{r.get('name') or ''} {r.get('email') or ''}".lower()
        (suspect if any(w in blob for w in WANTED) else control).append(r)
    # 3 phòng control để so sánh — phòng bình thường trông thế nào.
    return suspect, control[:3]


async def main():
    if not s.supabase_enabled:
        print("[stop] supabase_enabled=False")
        return

    suspect, control = _rooms()
    if not suspect:
        print(f"[stop] không thấy phòng in_use nào khớp {WANTED}")
        return

    probe = suspect + control
    print(f"[rooms] nghi vấn={[r['name'] for r in suspect]} "
          f"control={[r['name'] for r in control]}")

    token = token_pool.get_active_token()
    if not token:
        print("[stop] pool không có token ACTIVE — mở app đăng nhập rồi chạy lại")
        return
    print(f"[token] lấy được từ pool (len={len(token)})")

    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo

    tz = ZoneInfo(s.timezone)
    today = datetime.now(tz).date()
    start_iso = f"{today.isoformat()}T00:00:00"
    end_iso = f"{(today + timedelta(days=s.availability_days)).isoformat()}T00:00:00"
    expected = s.availability_days * (24 * 60 // s.availability_slot_minutes)

    body = {
        "schedules": [r["email"] for r in probe],
        "startTime": {"dateTime": start_iso, "timeZone": s.timezone},
        "endTime": {"dateTime": end_iso, "timeZone": s.timezone},
        "availabilityViewInterval": s.availability_slot_minutes,
    }
    async with httpx.AsyncClient(timeout=60) as c:
        resp = await c.post(
            "https://graph.microsoft.com/v1.0/me/calendar/getSchedule",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Prefer": f'outlook.timezone="{s.timezone}"',
            },
            json=body,
        )
    print(f"[http] {resp.status_code} (window {start_iso} -> {end_iso}, "
          f"interval {s.availability_slot_minutes}m, expect {expected} slots)")
    if resp.status_code != 200:
        print(resp.text[:600])
        return

    by_name = {r["email"].lower(): r for r in probe}
    print()
    for item in resp.json().get("value", []):
        sid = str(item.get("scheduleId") or "")
        room = by_name.get(sid.lower()) or {}
        tag = "NGHI VAN" if room in suspect else "control "
        view = item.get("availabilityView") or ""
        items = item.get("scheduleItems") or []
        wh = item.get("workingHours")
        err = item.get("error")
        nonfree = sum(1 for ch in view if ch != "0")
        print(f"--- [{tag}] {room.get('name') or '?'} <{sid}>")
        print(f"      error         : {err if err else 'none'}")
        print(f"      view length   : {len(view)} (expect {expected})")
        print(f"      non-free slots: {nonfree}  <-- 0 nghia la TRONG SUOT {s.availability_days} NGAY")
        print(f"      scheduleItems : {len(items)}")
        print(f"      workingHours  : {'present' if wh else 'MISSING'}")
        if wh:
            print(f"        daysOfWeek={wh.get('daysOfWeek')} "
                  f"{wh.get('startTime')}-{wh.get('endTime')} tz={(wh.get('timeZone') or {}).get('name')}")
        # 08:00-18:00 hôm nay: 40 slot đầu tiên sau offset 32 (8h * 4)
        print(f"      today 08-18h  : {view[32:72] or '(empty)'}")
        print()

    print("DIEN GIAI:")
    print("  - error != none            -> Graph bao loi that; graph.get_schedule da drop dung.")
    print("  - non-free 0 + items 0 +   -> Graph khong doc duoc lich phong nay nhung KHONG bao loi.")
    print("    workingHours MISSING        Day la discriminator can dung de chan scout.")
    print("  - non-free 0 + workingHours-> Phong that su rang. Khong duoc coi la loi.")
    print("    present                     So sanh voi control de biet dau la binh thuong.")


asyncio.run(main())
