// Base URL của backend VNGMeet. KHÔNG có dấu "/" ở cuối — path trong api.ts tự thêm "/".
//
// Đang trỏ về endpoint AgentBase public để deploy/test trên điện thoại thật.
// (Local dưới đây chỉ dùng khi chạy web/simulator cùng máy với backend.)
export const API_BASE =
  "https://endpoint-43d00107-bcbd-4907-ade0-e87008a842b3.agentbase-runtime.aiplatform.vngcloud.vn/api";
// export const API_BASE = "http://localhost:8000/api";
