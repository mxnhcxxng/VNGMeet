import type { DirectoryRoom } from "./api";

export type CampusFloor = "F1" | "F2" | "F3";
export const CAMPUS_FLOORS: CampusFloor[] = ["F1", "F2", "F3"];

/** A room label on the map: always visible, hover shows the room info. */
export interface PlacedLabel {
  id: string;
  /** Room name shown on the label (DB name when matched, else the plan's). */
  name: string;
  /** Label centre in map (Figma frame) units. */
  cx: number;
  cy: number;
  /** Directory row for this room (capacity, floor, directions…), when found. */
  room: DirectoryRoom | null;
}

/**
 * One floor's map, exported from Figma "VNG Meet": the frame size, the plan
 * image filling it, and a label per room (centres, in frame px).
 */
export interface FloorMap {
  width: number;
  height: number;
  image: { src: string; x: number; y: number; width: number; height: number };
  labels: [name: string, cx: number, cy: number][];
  /** Short white leader lines from a label to its room: [x, y1, y2]. */
  leaders?: [x: number, y1: number, y2: number][];
}

export const FLOOR_MAPS: Record<CampusFloor, FloorMap> = {
  // Figma node 645:14048 (Frame 60).
  F1: {
    width: 3462,
    height: 1930,
    image: { src: "/campus-map/floor-1.jpg", x: 0, y: 0, width: 3462, height: 1930 },
    labels: [
      ["Stockholm", 1187, 823],
      ["Singapore", 1358.5, 730],
      ["Silicon Valley", 1401, 601],
      ["Sydney", 1434.5, 502],
      ["Tel Aviv", 1674, 459],
      ["Cambridge", 2008.5, 393],
      ["Harvard", 1896.5, 547],
      ["Oxford", 2184, 333],
      ["Stanford", 2419, 408],
      ["Yale", 2372.5, 708],
      ["Cornell", 2313, 779],
      ["Lyon", 2156.5, 846],
      ["Nottingham", 2042.5, 915],
      ["Mumbai", 1405.5, 1044],
      ["Sao Paulo", 1597.5, 1351],
      ["Manila", 1661.5, 1470],
      ["Yangoon", 2047, 1251],
      ["Jakarta", 2131, 1584],
      ["Ha Noi", 2488, 1317],
      ["Da Nang", 2547, 1425],
      ["Sai Gon", 2607, 1540],
      ["Beijing", 2866.5, 984],
      ["Nairobi", 3035.5, 859],
      ["Helsinki", 3190.5, 1126],
    ],
    leaders: [[2152, 1509.5, 1554]],
  },
  // Figma node 645:12235 (Frame 35).
  F2: {
    width: 3482,
    height: 1813,
    image: { src: "/campus-map/floor-2.jpg", x: 0, y: 0, width: 3482, height: 1813 },
    labels: [
      ["New York", 2023.5, 380],
      ["San Francisco", 2375, 397],
      ["Seattle", 2593.5, 279],
      ["2332", 2188, 942],
      ["DC", 2633, 951],
      ["Melbourne", 2079.5, 1336],
    ],
  },
  // Figma node 692:3049 (Frame 62).
  F3: {
    width: 3640,
    height: 1836,
    image: { src: "/campus-map/floor-3.jpg", x: 143, y: -16, width: 3497, height: 1891 },
    labels: [
      ["Rome", 396, 609],
      ["Manchester", 94.5, 756],
      ["Durham", 492, 935],
      ["Hangzhou", 325.5, 935],
      ["Bangalore", 1023.5, 242],
      ["Dubai", 556, 166],
      ["Madrid", 123, 859],
      ["Paris", 392, 679],
      ["Athens", 704.5, 1065],
      ["Amsterdam", 771.5, 1276],
      ["Barcelona", 575, 1272],
      ["Berlin", 384.5, 1168],
      ["Liverpool", 998, 89],
      ["Zurich", 1263.5, 606],
      ["Oslo", 1697.5, 764],
      ["Venice", 1314, 410],
      ["Tokyo", 1990.5, 496],
      ["Doha", 2327.5, 308],
      ["Seoul", 2771, 296],
      ["Taipei", 2849, 584],
      ["Vancouver", 2383, 955],
      ["Toronto", 2575.5, 886.5],
      ["Shanghai", 2775.5, 779],
      ["Shenzhen", 3065.5, 1167],
    ],
  },
};

// "Sài Gòn" / "Sai Gon" / "Saigon" all → "saigon"; doubled letters are folded
// so spellings like "Yangoon"/"Yangon" or "Cornel"/"Cornell" match too.
export function normalizeRoomName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/(.)\1+/g, "$1")
    .replace(/^standford$/, "stanford")
    .replace(/^vancover$/, "vancouver");
}

/** The floor's labels, each matched to its directory row by name. */
export function placeLabels(floor: CampusFloor, rooms: DirectoryRoom[]): PlacedLabel[] {
  const byName = new Map<string, DirectoryRoom>();
  for (const r of rooms) {
    const k = normalizeRoomName(r.name);
    if (k && !byName.has(k)) byName.set(k, r);
  }
  return FLOOR_MAPS[floor].labels.map(([name, cx, cy]) => {
    const room = byName.get(normalizeRoomName(name)) ?? null;
    return { id: name, name: room?.name ?? name, cx, cy, room };
  });
}
