import PlanetEarth from "@gravity-ui/icons/PlanetEarth";
import Clock from "@gravity-ui/icons/Clock";
import MapPin from "@gravity-ui/icons/MapPin";
import ClockArrowRotateLeft from "@gravity-ui/icons/ClockArrowRotateLeft";

import type { BookingHistoryItem, BookingStatus } from "@/types";

// Nhãn + class màu cho chip trạng thái. "success" là mặc định theo Figma
// (xanh lá), thêm pending/cancelled để component tái dùng cho các trạng thái
// khác khi nối BE.
const STATUS_META: Record<BookingStatus, { label: string; className: string }> =
  {
    success: { label: "Thành công", className: "history-chip--success" },
    pending: { label: "Chờ duyệt", className: "history-chip--pending" },
    cancelled: { label: "Đã huỷ", className: "history-chip--cancelled" },
  };

// "2026-07-22" -> "22/7" (khớp Figma: bỏ số 0 ở đầu, 1 dấu gạch).
function formatShortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return d && m ? `${Number(d)}/${Number(m)}` : iso;
}

// Dữ liệu mock — thay bằng api.bookingHistory() khi có BE. Đã đủ shape để map
// thẳng. Trộn vài trạng thái để thấy đủ biến thể chip; các dòng đầu là "Thành
// công" khớp bản Figma.
const MOCK_HISTORY: BookingHistoryItem[] = [
  {
    id: "1",
    title: "Cuộc họp của cuongdm4",
    status: "success",
    office: "Amsterdam",
    date: "2026-07-22",
    start_time: "14:00",
    end_time: "16:00",
    location: "Tầng 3 - Toà V1",
  },
  {
    id: "2",
    title: "Sync team Mini App",
    status: "success",
    office: "Barcelona",
    date: "2026-07-20",
    start_time: "09:30",
    end_time: "10:30",
    location: "Tầng 5 - Toà V2",
  },
  {
    id: "3",
    title: "Phỏng vấn ứng viên BE",
    status: "pending",
    office: "Amsterdam",
    date: "2026-07-18",
    start_time: "15:00",
    end_time: "16:00",
    location: "Tầng 3 - Toà V1",
  },
  {
    id: "4",
    title: "Review sprint Q3",
    status: "cancelled",
    office: "Copenhagen",
    date: "2026-07-15",
    start_time: "11:00",
    end_time: "12:00",
    location: "Tầng 2 - Toà V1",
  },
  {
    id: "5",
    title: "Họp 1:1 với quản lý",
    status: "success",
    office: "Amsterdam",
    date: "2026-07-12",
    start_time: "16:30",
    end_time: "17:00",
    location: "Tầng 4 - Toà V2",
  },
];

// Tab "Lịch sử đặt phòng" (Figma 346-1292). Header xanh cố định + danh sách các
// thẻ lịch sử (ảnh phòng bên trái, thông tin bên phải). Hiện dùng mock data.
export default function HistoryPage() {
  const items = MOCK_HISTORY;

  return (
    <div className="history">
      <header className="history__header">
        <span className="history__header-title">Lịch sử đặt phòng</span>
      </header>

      {items.length === 0 ? (
        <div className="history__empty">
          <ClockArrowRotateLeft width={40} height={40} />
          <div className="history__empty-title">Chưa có lịch sử</div>
          <div>Các phòng bạn đã đặt sẽ hiển thị ở đây.</div>
        </div>
      ) : (
        <div className="history__list">
          {items.map((item) => {
            const status = STATUS_META[item.status];
            return (
              <div key={item.id} className="history-card">
                <div
                  className="history-card__media"
                  style={
                    item.image
                      ? { backgroundImage: `url(${item.image})` }
                      : undefined
                  }
                />
                <div className="history-card__body">
                  <div className="history-card__title">{item.title}</div>
                  <span className={`history-chip ${status.className}`}>
                    {status.label}
                  </span>
                  <div className="history-card__info">
                    {item.office && (
                      <div className="history-card__row">
                        <PlanetEarth width={16} height={16} />
                        <span>{item.office}</span>
                      </div>
                    )}
                    <div className="history-card__row">
                      <Clock width={16} height={16} />
                      <span>
                        {formatShortDate(item.date)} • {item.start_time} -{" "}
                        {item.end_time}
                      </span>
                    </div>
                    {item.location && (
                      <div className="history-card__row">
                        <MapPin width={16} height={16} />
                        <span>{item.location}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
