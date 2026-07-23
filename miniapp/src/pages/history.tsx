import ClockArrowRotateLeft from "@gravity-ui/icons/ClockArrowRotateLeft";

// Tab Lịch sử — placeholder, chưa nối BE.
export default function HistoryPage() {
  return (
    <div className="placeholder-page">
      <ClockArrowRotateLeft
        className="placeholder-page__icon"
        width={40}
        height={40}
      />
      <div className="placeholder-page__title">Lịch sử</div>
      <div>Lịch sử đặt phòng của bạn sẽ hiển thị ở đây.</div>
    </div>
  );
}
