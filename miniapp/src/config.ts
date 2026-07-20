// Base URL của backend VNGMeet. KHÔNG có dấu "/" ở cuối — path trong api.ts tự thêm "/".
//
// Đang trỏ về endpoint AgentBase public để deploy/test trên điện thoại thật.
// (Local dưới đây chỉ dùng khi chạy web/simulator cùng máy với backend.)
export const API_BASE =
  "https://endpoint-f12e4a9b-9a45-4de3-958a-a398f9eb97b4.agentbase-runtime.aiplatform.vngcloud.vn/api";
// export const API_BASE = "http://localhost:8000/api";
