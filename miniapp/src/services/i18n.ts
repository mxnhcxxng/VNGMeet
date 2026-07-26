// Đa ngôn ngữ cho Mini App (Tiếng Việt / English) — cùng mô hình với bản web
// (frontend/lib/i18n.ts): key phẳng, English là nguồn gốc, Tiếng Việt override,
// thiếu key nào thì tự fallback về English. Nội suy {name} qua tham số `vars`.

export type Language = "en" | "vi";

export const DEFAULT_LANGUAGE: Language = "vi";

export const LANGUAGE_OPTIONS: { value: Language; label: string }[] = [
  { value: "vi", label: "🇻🇳 Tiếng Việt" },
  { value: "en", label: "🇬🇧 English" },
];

const en = {
  // --- Common -------------------------------------------------------------
  "common.retry": "Try again",
  "common.back": "Back",
  "common.continue": "Continue",
  "common.refresh": "Refresh",
  "common.meeting": "Meeting",
  "common.you": "you",
  "common.floor": "Floor {floor}",
  "common.building": "Bldg {building}",

  // --- Auth gate (layout) -------------------------------------------------
  "gate.authing": "Authenticating…",
  "gate.denied": "VNGMeet needs your phone number to sign in.",
  "gate.unlinked":
    "This phone number isn't registered in VNGMeet. Please link your Microsoft account first, then try again.",
  "gate.error": "Couldn't reach the server. Please try again.",
  "gate.allowPhone": "Allow sharing phone number",
  "gate.hello": "Hi {name}!",
  "gate.botLinked":
    "Zalo Bot linked successfully! Go back to the chat bot to continue.",
  "gate.botLinkFailed":
    "Failed to link Zalo Bot. The code may have expired — try again from the bot.",

  // --- Bottom navigation --------------------------------------------------
  "nav.home": "Home",
  "nav.history": "History",
  "nav.account": "Account",

  // --- Home ---------------------------------------------------------------
  "home.greeting": "Hi, {name}",
  "home.menuTitle": "Pick the option",
  "home.menuTitleMuted": "that fits you best",
  "action.find": "Find a room",
  "action.scout": "Scout a room",
  "action.direction": "Directions",
  "action.chatbot": "Chatbot",
  "home.upcoming": "Upcoming",
  "home.viewDetail": "View details",
  "home.freeToday": "Available rooms today",
  "home.freeTomorrow": "Available rooms tomorrow",
  "home.loadingRooms": "Loading available rooms…",
  "home.noRooms": "No matching rooms available",

  // --- History ------------------------------------------------------------
  "history.title": "Booking history",
  "history.all": "All",
  "history.upcoming": "Upcoming",
  "history.past": "Past",
  "history.loadFailed": "Couldn't load history",
  "history.empty": "No history yet",
  "history.emptyHint": "Rooms you've booked will show up here.",
  "status.success": "Success",
  "status.awaiting": "Awaiting",
  "status.pending": "Pending",
  "status.failed": "Failed",
  "status.canceled": "Canceled",

  // --- Find room ----------------------------------------------------------
  "find.title": "Find a room",
  "find.prevDay": "Previous day",
  "find.nextDay": "Next day",
  "find.loading": "Loading room schedule…",
  "find.loadFailed": "Couldn't load the room schedule.",
  "find.noRooms": "No matching rooms.",
  "find.hour": "Time",
  "find.hint": "Pick an available time slot to book a room",
  "cap.small": "Small",
  "cap.medium": "Medium",
  "cap.large": "Large",
  // Nhãn thứ trong tuần, bắt đầu từ Chủ nhật (index getDay()).
  "weekday.0": "Sun",
  "weekday.1": "Mon",
  "weekday.2": "Tue",
  "weekday.3": "Wed",
  "weekday.4": "Thu",
  "weekday.5": "Fri",
  "weekday.6": "Sat",

  // --- Booking modal ------------------------------------------------------
  "booking.subjectInstant": "{name}'s Meeting",
  "booking.subjectScheduled": "{name}'s Scheduled Meeting",
  "booking.subjectInstantNoName": "Meeting",
  "booking.subjectScheduledNoName": "Scheduled Meeting",
  "booking.titleRequired": "Please enter a meeting title.",
  "booking.invalidRoom": "Invalid room.",
  "booking.sessionReauth": "Session expired, re-authenticating…",
  "booking.notLinked":
    "Your account isn't linked to Microsoft yet, so booking isn't available. Please link Microsoft, then try again.",
  "booking.failed": "Booking failed, please try again.",
  "booking.instantHeader": "Book a room",
  "booking.scheduledHeader": "Schedule a booking",
  "booking.successInstantTitle": "Room booked",
  "booking.successScheduledTitle": "Schedule created",
  "booking.successInstantSub": "Please double-check your calendar in Outlook",
  "booking.successScheduledSub":
    "The system will book automatically at 12:00 AM. Please check your Outlook calendar afterwards.",
  "booking.backHome": "Back to home",
  "booking.meetingTitle": "Meeting title",
  "booking.meetingTitlePlaceholder": "Enter a meeting title",
  "booking.startTime": "Start time",
  "booking.endTime": "End time",
  "booking.attendees": "Attendee domains",
  "booking.attendeesPlaceholder": "Ex: cuongdm4, huyennn, anhdt11",
  "booking.description": "Description",
  "booking.descriptionPlaceholder": "Meeting description",
  "booking.book": "Book",
  "booking.scheduleInfo1":
    "The system will automatically book the room at 12:00 AM. However, due to high demand and limited room availability, the booking result cannot be guaranteed.",
  "booking.scheduleInfo2":
    "To ensure fairness, each user can have only one scheduled booking pending at a time, with a maximum booking duration of 3 hours.",

  // --- Meeting detail -----------------------------------------------------
  "detail.title": "Meeting details",
  "detail.viewMap": "View directions map",
  "detail.mapAlt": "Directions map",
  "detail.others": "+{count} others",
  "detail.descTitle": "Meeting description",
  "detail.descEmpty": "No meeting description",

  // --- Account / Settings -------------------------------------------------
  "settings.title": "Account",
  "settings.displayPreference": "Display",
  "settings.displayPreferenceDesc": "Switch between light and dark modes.",
  "settings.themeSystem": "System",
  "settings.themeLight": "Light",
  "settings.themeDark": "Dark",
  "settings.language": "Language",
  "settings.languageDesc": "Default language for VNGMeet.",
  "settings.langVi": "Tiếng Việt",
  "settings.langEn": "English",
  "settings.saved": "Settings saved",
  "settings.saveFailed": "Couldn't sync to the server, saved on this device.",
  "settings.savedLocalOnly": "Saved on this device.",
} as const;

export type TranslationKey = keyof typeof en;

// Tiếng Việt override — thiếu key nào thì fallback về English lúc tra cứu.
const vi: Partial<Record<TranslationKey, string>> = {
  // --- Common -------------------------------------------------------------
  "common.retry": "Thử lại",
  "common.back": "Quay lại",
  "common.continue": "Tiếp tục",
  "common.refresh": "Làm mới",
  "common.meeting": "Cuộc họp",
  "common.you": "bạn",
  "common.floor": "Tầng {floor}",
  "common.building": "Toà {building}",

  // --- Auth gate ----------------------------------------------------------
  "gate.authing": "Đang xác thực…",
  "gate.denied": "VNGMeet cần số điện thoại của bạn để đăng nhập.",
  "gate.unlinked":
    "Số điện thoại này chưa được đăng ký trong VNGMeet. Vui lòng liên kết tài khoản Microsoft trước rồi thử lại.",
  "gate.error": "Không kết nối được máy chủ. Vui lòng thử lại.",
  "gate.allowPhone": "Cho phép chia sẻ số điện thoại",
  "gate.hello": "Xin chào {name}!",
  "gate.botLinked":
    "Đã liên kết Zalo Bot thành công! Quay lại chat bot để tiếp tục.",
  "gate.botLinkFailed":
    "Liên kết Zalo Bot thất bại. Mã có thể đã hết hạn, thử lại từ bot nhé.",

  // --- Bottom navigation --------------------------------------------------
  "nav.home": "Trang chủ",
  "nav.history": "Lịch sử",
  "nav.account": "Tài khoản",

  // --- Home ---------------------------------------------------------------
  "home.greeting": "Xin chào, {name}",
  "home.menuTitle": "Chọn một nhu cầu",
  "home.menuTitleMuted": "phù hợp nhất với bạn",
  "action.find": "Tìm phòng",
  "action.scout": "Săn phòng",
  "action.direction": "Chỉ đường",
  "action.chatbot": "Chatbot",
  "home.upcoming": "Lịch sắp tới",
  "home.viewDetail": "Xem chi tiết",
  "home.freeToday": "Phòng trống hôm nay",
  "home.freeTomorrow": "Phòng trống ngày mai",
  "home.loadingRooms": "Đang tải phòng trống…",
  "home.noRooms": "Không có phòng trống phù hợp",

  // --- History ------------------------------------------------------------
  "history.title": "Lịch sử đặt phòng",
  "history.all": "Tất cả",
  "history.upcoming": "Sắp tới",
  "history.past": "Đã qua",
  "history.loadFailed": "Không tải được lịch sử",
  "history.empty": "Chưa có lịch sử",
  "history.emptyHint": "Các phòng bạn đã đặt sẽ hiển thị ở đây.",
  "status.success": "Thành công",
  "status.awaiting": "Chờ phản hồi",
  "status.pending": "Đang chờ",
  "status.failed": "Thất bại",
  "status.canceled": "Đã hủy",

  // --- Find room ----------------------------------------------------------
  "find.title": "Tìm phòng",
  "find.prevDay": "Ngày trước",
  "find.nextDay": "Ngày sau",
  "find.loading": "Đang tải lịch phòng…",
  "find.loadFailed": "Không tải được lịch phòng.",
  "find.noRooms": "Không có phòng phù hợp.",
  "find.hour": "Giờ",
  "find.hint": "Vui lòng chọn khung giờ trống để đặt phòng",
  "cap.small": "Nhỏ",
  "cap.medium": "Vừa",
  "cap.large": "Lớn",
  "weekday.0": "CN",
  "weekday.1": "T2",
  "weekday.2": "T3",
  "weekday.3": "T4",
  "weekday.4": "T5",
  "weekday.5": "T6",
  "weekday.6": "T7",

  // --- Booking modal ------------------------------------------------------
  "booking.subjectInstant": "Cuộc họp của {name}",
  "booking.subjectScheduled": "Cuộc họp đã lên lịch của {name}",
  "booking.subjectInstantNoName": "Cuộc họp",
  "booking.subjectScheduledNoName": "Cuộc họp đã lên lịch",
  "booking.titleRequired": "Vui lòng nhập tiêu đề cuộc họp.",
  "booking.invalidRoom": "Phòng không hợp lệ.",
  "booking.sessionReauth": "Phiên đã hết hạn, đang xác thực lại…",
  "booking.notLinked":
    "Tài khoản chưa liên kết Microsoft nên chưa thể đặt phòng. Vui lòng liên kết Microsoft rồi thử lại.",
  "booking.failed": "Đặt phòng thất bại, thử lại nhé.",
  "booking.instantHeader": "Đặt phòng họp",
  "booking.scheduledHeader": "Hẹn giờ đặt phòng",
  "booking.successInstantTitle": "Đặt phòng thành công",
  "booking.successScheduledTitle": "Đã tạo lịch hẹn giờ",
  "booking.successInstantSub": "Vui lòng kiểm tra lại lịch trong Outlook",
  "booking.successScheduledSub":
    "Hệ thống sẽ tự động đặt vào 12:00 đêm. Vui lòng kiểm tra lại lịch trong Outlook sau đó.",
  "booking.backHome": "Trở về màn hình chính",
  "booking.meetingTitle": "Tiêu đề cuộc họp",
  "booking.meetingTitlePlaceholder": "Nhập tiêu đề cuộc họp",
  "booking.startTime": "Giờ bắt đầu",
  "booking.endTime": "Giờ kết thúc",
  "booking.attendees": "Domain người tham dự",
  "booking.attendeesPlaceholder": "VD: cuongdm4, huyennn, anhdt11",
  "booking.description": "Mô tả",
  "booking.descriptionPlaceholder": "Mô tả cuộc họp",
  "booking.book": "Đặt phòng",
  "booking.scheduleInfo1":
    "Hệ thống sẽ tự động đặt vào lúc 12:00 đêm. Tuy nhiên, do nhu cầu sử dụng cao và số lượng phòng có hạn nên kết quả đặt phòng sẽ không được đảm bảo.",
  "booking.scheduleInfo2":
    "Để đảm bảo tính công bằng, mỗi người chỉ được có 1 lịch hẹn giờ đặt phòng đang chờ xử lý tại một thời điểm, với thời lượng đặt tối đa 3 tiếng.",

  // --- Meeting detail -----------------------------------------------------
  "detail.title": "Chi tiết lịch họp",
  "detail.viewMap": "Xem sơ đồ chỉ đường",
  "detail.mapAlt": "Sơ đồ chỉ đường",
  "detail.others": "+{count} người khác",
  "detail.descTitle": "Mô tả cuộc họp",
  "detail.descEmpty": "Không có mô tả cuộc họp",

  // --- Account / Settings -------------------------------------------------
  "settings.title": "Tài khoản",
  "settings.displayPreference": "Giao diện",
  "settings.displayPreferenceDesc": "Chuyển giữa chế độ sáng và tối.",
  "settings.themeSystem": "Theo hệ thống",
  "settings.themeLight": "Chế độ sáng",
  "settings.themeDark": "Chế độ tối",
  "settings.language": "Ngôn ngữ",
  "settings.languageDesc": "Ngôn ngữ mặc định cho VNGMeet.",
  "settings.langVi": "Tiếng Việt",
  "settings.langEn": "English",
  "settings.saved": "Đã lưu cài đặt",
  "settings.saveFailed": "Chưa đồng bộ được lên máy chủ, đã lưu trên thiết bị này.",
  "settings.savedLocalOnly": "Đã lưu trên thiết bị này.",
};

const dictionaries: Record<Language, Partial<Record<TranslationKey, string>>> = {
  en,
  vi,
};

export function translate(
  lang: Language,
  key: TranslationKey,
  vars?: Record<string, string | number>,
): string {
  const dict = dictionaries[lang] ?? en;
  let str = dict[key] ?? en[key] ?? (key as string);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      // split/join thay cho replaceAll để không phụ thuộc lib ES2021.
      str = str.split(`{${k}}`).join(String(v));
    }
  }
  return str;
}

export type TFunction = (
  key: TranslationKey,
  vars?: Record<string, string | number>,
) => string;
