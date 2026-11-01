import { handleWebhook } from "../../src/handler.js";

// Vercel Node.js runtime, Web-standard handler: request.text() gives the raw body,
// so signatures are checked over the exact bytes the sender signed.

function sourceFrom(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1] ?? "");
}

export async function POST(request: Request): Promise<Response> {
  return handleWebhook(request, sourceFrom(request));
}

export async function GET(): Promise<Response> {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405,
    headers: { "content-type": "application/json", allow: "POST" },
  });
}
