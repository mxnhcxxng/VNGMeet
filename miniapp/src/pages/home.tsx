import Magnifier from "@gravity-ui/icons/Magnifier";
import Binoculars from "@gravity-ui/icons/Binoculars";
import MapPin from "@gravity-ui/icons/MapPin";
import Calendar from "@gravity-ui/icons/Calendar";
import Clock from "@gravity-ui/icons/Clock";

import favicon from "@/static/favicon-white.png";
import { useDisplayName } from "@/services/auth";
import { availableRooms, upcomingEvent } from "@/services/mock";

// Màn Home theo Figma (node 286-9472). Icon dùng bộ @gravity-ui/icons y hệt
// bản web, font Inter (khai báo ở index.html + app.scss). Dữ liệu đang mock.
export default function HomePage() {
  const name = useDisplayName() ?? "bạn";

  const actions = [
    { key: "find", label: "Tìm phòng", Icon: Magnifier },
    { key: "scout", label: "Săn phòng", Icon: Binoculars },
    { key: "direction", label: "Chỉ đường", Icon: MapPin },
  ];

  return (
    <div className="home">
      <div className="home__hero">
        <div className="home__topbar">
          <img className="home__favicon" src={favicon} alt="zMeeting" />
          <span className="home__appname">zMeeting</span>
        </div>

        <div className="home__greeting">Xin chào, {name}</div>

        <div className="menu-card">
          <div className="menu-card__title">
            Chọn một nhu cầu{" "}
            <span className="menu-card__title-muted">
              phù hợp nhất với bạn
            </span>
          </div>
          <div className="menu-card__sep" />
          <div className="menu-card__actions">
            {actions.map(({ key, label, Icon }) => (
              <button key={key} className="menu-action" type="button">
                <span className="menu-action__icon">
                  <Icon width={24} height={24} />
                </span>
                <span className="menu-action__label">{label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <section className="home-section">
        <div className="home-section__title">Lịch sắp tới</div>
        <div
          className="event-card"
          style={{ backgroundImage: `url(${upcomingEvent.image})` }}
        >
          <div className="event-card__overlay" />
          <div className="event-card__body">
            <div className="event-card__title">{upcomingEvent.room}</div>
            <div className="event-card__row">
              <Calendar width={16} height={16} />
              <span>{upcomingEvent.date}</span>
            </div>
            <div className="event-card__row">
              <Clock width={16} height={16} />
              <span>{upcomingEvent.time}</span>
            </div>
            <div className="event-card__row">
              <MapPin width={16} height={16} />
              <span>{upcomingEvent.location}</span>
            </div>
            <button className="event-card__cta" type="button">
              Xem chi tiết
            </button>
          </div>
        </div>
      </section>

      <section className="home-section">
        <div className="home-section__title">Phòng trống hôm nay</div>
        <div className="room-grid">
          {availableRooms.map((room) => (
            <div key={room.id} className="room-card">
              <div
                className="room-card__media"
                style={{ backgroundImage: `url(${room.image})` }}
              >
                <span className="room-card__badge">
                  <Clock width={14} height={14} />
                  {room.duration}
                </span>
              </div>
              <div className="room-card__info">
                <div className="room-card__name">{room.name}</div>
                <div className="room-card__time">{room.time}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
