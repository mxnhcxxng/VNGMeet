import { openShareSheet } from "zmp-sdk";

// Chia sẻ đường đi tới phòng họp qua openShareSheet của Zalo.
//
// Lưu ý API: openShareSheet KHÔNG hỗ trợ gộp text + ảnh trong cùng một sheet —
// mỗi `type` chỉ nhận đúng một loại nội dung (`text` chỉ có text, `image` chỉ có
// ảnh, không kèm caption). Theo yêu cầu: khi có ảnh sơ đồ thì ƯU TIÊN chia sẻ
// ẢNH; khi không có ảnh thì chia sẻ TEXT hướng dẫn đường đi.
//
// `openShareSheet` chỉ chạy trong app Zalo (@zaloOnly). Khi user bấm huỷ, promise
// vẫn resolve (status = 0); chỉ khi lỗi thật (ngoài app Zalo, tham số sai…) mới
// reject → trả về false để component hiện toast.

// Chuẩn hoá URL ảnh map thành URL tuyệt đối để phía Zalo tải được khi chia sẻ.
function toAbsoluteUrl(url: string): string {
  try {
    return new URL(url, window.location.origin).href;
  } catch {
    return url;
  }
}

// Dựng nội dung text hướng dẫn đường đi (dùng cho sheet `text` khi phòng chưa có
// ảnh sơ đồ). `intro` đã được component dịch sẵn (kèm tên phòng).
export function composeDirectionsText({
  intro,
  location,
  directions,
}: {
  intro: string;
  location?: string | null;
  directions?: string | null;
}): string {
  let text = intro.trim();
  const loc = (location ?? "").trim();
  if (loc) text += `\n${loc}`;
  const dir = (directions ?? "").trim();
  if (dir) text += `\n\n${dir}`;
  return text;
}

export async function shareDirections({
  text,
  map,
}: {
  text: string;
  map?: string | null;
}): Promise<boolean> {
  const imageUrl = (map ?? "").trim();
  try {
    if (imageUrl) {
      // Ưu tiên chia sẻ ảnh sơ đồ đường đi.
      await openShareSheet({
        type: "image",
        data: { imageUrls: [toAbsoluteUrl(imageUrl)] },
      });
    } else {
      // Không có ảnh → chia sẻ text hướng dẫn.
      await openShareSheet({ type: "text", data: { text } });
    }
    return true;
  } catch {
    return false;
  }
}
