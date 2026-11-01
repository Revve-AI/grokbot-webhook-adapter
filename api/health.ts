export function GET(): Response {
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
}
