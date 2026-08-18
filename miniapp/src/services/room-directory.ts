import { api } from "@/services/api";
import type { DirectoryRoom } from "@/types";

// Cache cấp module cho GET /api/rooms/directory (gần như tĩnh trong 1 phiên):
// màn "Chỉ đường" render ngay từ cache rồi nạp ngầm, còn màn "Lịch sử" đọc ké để
// suy sức chứa phòng khi dựng phiên săn. Sống trong phiên, mất khi reload app.
let cachedRooms: DirectoryRoom[] | null = null;

// Danh sách đã cache, hoặc null nếu chưa nạp lần nào.
export function peekRoomDirectory(): DirectoryRoom[] | null {
  return cachedRooms;
}

// Nạp mới từ backend rồi cập nhật cache (stale-while-revalidate ở nơi gọi).
export async function loadRoomDirectory(): Promise<DirectoryRoom[]> {
  const { rooms } = await api.roomsDirectory();
  cachedRooms = rooms;
  return rooms;
}

// Tìm phòng theo email (khoá chính), fallback theo tên.
export function findRoom(
  rooms: DirectoryRoom[],
  email?: string | null,
  name?: string | null,
): DirectoryRoom | undefined {
  const mail = (email ?? "").trim().toLowerCase();
  const label = (name ?? "").trim().toLowerCase();
  return rooms.find((room) => {
    if (mail && (room.email ?? "").trim().toLowerCase() === mail) return true;
    return Boolean(label) && room.name.trim().toLowerCase() === label;
  });
}
