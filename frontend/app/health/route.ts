// Health check required by GreenNode AgentBase Runtime (must return 200).
export const dynamic = "force-dynamic";

export function GET() {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
