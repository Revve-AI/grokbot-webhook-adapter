import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Webhook } from "standardwebhooks";
import { handleWebhook, authHeaderValue, type Deps } from "../src/handler.js";
import { sources, shapeFathom } from "../src/sources.js";

const NOW = new Date("2026-11-01T15:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const FATHOM_SECRET = "whsec_" + randomBytes(24).toString("base64");

const fathomBody = JSON.stringify({
  title: "Quarterly Business Review",
  meeting_title: "QBR 2025 Q1",
  meeting_type: null,
  recording_id: 123456789,
  url: "https://fathom.video/xyz123",
  share_url: "https://fathom.video/share/xyz123",
  created_at: "2025-03-01T17:01:30Z",
  scheduled_start_time: "2025-03-01T16:00:00Z",
  scheduled_end_time: "2025-03-01T17:00:00Z",
  recording_start_time: "2025-03-01T16:01:12Z",
  recording_end_time: "2025-03-01T17:00:55Z",
  calendar_invitees_domains_type: "one_or_more_external",
  transcript_language: "en",
  transcript: [{ speaker: { display_name: "Alice" }, text: "hi", timestamp: "00:00:01" }],
  default_summary: { template_name: "general", markdown_formatted: "## Summary\nAll good." },
  action_items: [
    {
      description: "Email revised proposal",
      user_generated: false,
      completed: false,
      recording_timestamp: "00:10:45",
      recording_playback_url: "https://fathom.video/calls/xyz123?timestamp=645",
      assignee: { name: "Alice", email: "alice@acme.com", team: null },
    },
  ],
  calendar_invitees: [{ name: "Bob", email: "bob@client.com", email_domain: "client.com", is_external: true }],
  recorded_by: { name: "Alice", email: "alice@acme.com", email_domain: "acme.com", team: null },
});

function fathomHeaders(body: string, opts: { secret?: string; ts?: number; id?: string } = {}) {
  const id = opts.id ?? "msg_2x2zwLOcWaRTzsLK8KtbQt1FTk9";
  const ts = String(opts.ts ?? NOW_S);
  const key = Buffer.from((opts.secret ?? FATHOM_SECRET).slice("whsec_".length), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` };
}

const baseEnv = {
  FATHOM_WEBHOOK_SECRET: FATHOM_SECRET,
  FATHOM_TARGET_URL: "https://grokbot.example/routines/abc/webhook",
  FATHOM_TARGET_KEY: "test-key-123",
  GITHUB_WEBHOOK_SECRET: "gh-secret",
  GITHUB_TARGET_URL: "https://grokbot.example/routines/gh/webhook",
  GITHUB_TARGET_KEY: "gh-key",
  STRIPE_WEBHOOK_SECRET: "whsec_stripe_test",
  STRIPE_TARGET_URL: "https://grokbot.example/routines/stripe/webhook",
  STRIPE_TARGET_KEY: "stripe-key",
  GENERIC_URL_TOKEN: "s3cr3t-token",
  GENERIC_TARGET_URL: "https://grokbot.example/routines/generic/webhook",
  GENERIC_TARGET_KEY: "generic-key",
};

const testSources = {
  ...sources,
  generic: {
    verification: { type: "url-token" as const, tokenEnv: "GENERIC_URL_TOKEN" },
    target: { urlEnv: "GENERIC_TARGET_URL", keyEnv: "GENERIC_TARGET_KEY" },
  },
};

let fetchMock: ReturnType<typeof vi.fn>;
let deps: Partial<Deps>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
  deps = { env: { ...baseEnv }, fetch: fetchMock as unknown as typeof fetch, now: () => NOW, sources: testSources };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  new Request(`https://adapter.example${path}`, { method: "POST", body, headers });

describe("fathom", () => {
  it("accepts a valid signature and forwards a shaped payload with Bearer auth", async () => {
    const res = await handleWebhook(post("/api/in/fathom", fathomBody, fathomHeaders(fathomBody)), "fathom", deps);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(baseEnv.FATHOM_TARGET_URL);
    expect(init.headers.Authorization).toBe("Bearer test-key-123");
    const sent = JSON.parse(init.body);
    expect(sent.source).toBe("fathom");
    expect(sent.receivedAt).toBe(NOW.toISOString());
    expect(sent.deliveryId).toBe("msg_2x2zwLOcWaRTzsLK8KtbQt1FTk9");
    expect(sent.payload.title).toBe("Quarterly Business Review");
    expect(sent.payload.share_url).toBe("https://fathom.video/share/xyz123");
    expect(sent.payload.summary_markdown).toContain("All good");
    expect(sent.payload.action_items[0].description).toBe("Email revised proposal");
    expect(sent.payload.attendees).toEqual([{ name: "Bob", email: "bob@client.com", is_external: true }]);
    expect(sent.payload.transcript).toBeUndefined();
  });

  it("matches the reference Standard Webhooks implementation (Svix-style)", async () => {
    const wh = new Webhook(FATHOM_SECRET);
    const id = "msg_ref";
    const sig = wh.sign(id, NOW, fathomBody);
    const headers = { "webhook-id": id, "webhook-timestamp": String(NOW_S), "webhook-signature": sig };
    const res = await handleWebhook(post("/api/in/fathom", fathomBody, headers), "fathom", deps);
    expect(res.status).toBe(200);
  });

  it("accepts when one of several space-delimited signatures matches", async () => {
    const h = fathomHeaders(fathomBody);
    h["webhook-signature"] = `v1,AAAA ${h["webhook-signature"]}`;
    const res = await handleWebhook(post("/api/in/fathom", fathomBody, h), "fathom", deps);
    expect(res.status).toBe(200);
  });

  it("rejects a wrong secret with 401 and does not forward", async () => {
    const wrong = "whsec_" + randomBytes(24).toString("base64");
    const res = await handleWebhook(post("/api/in/fathom", fathomBody, fathomHeaders(fathomBody, { secret: wrong })), "fathom", deps);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a tampered body", async () => {
    const res = await handleWebhook(post("/api/in/fathom", fathomBody + " ", fathomHeaders(fathomBody)), "fathom", deps);
    expect(res.status).toBe(401);
  });

  it("rejects missing headers", async () => {
    const res = await handleWebhook(post("/api/in/fathom", fathomBody), "fathom", deps);
    expect(res.status).toBe(401);
  });

  it("rejects a replayed (stale) timestamp beyond 5 minutes", async () => {
    const res = await handleWebhook(post("/api/in/fathom", fathomBody, fathomHeaders(fathomBody, { ts: NOW_S - 301 })), "fathom", deps);
    expect(res.status).toBe(401);
  });

  it("never logs the secret, key, or body on failure", async () => {
    const spy = console.error as unknown as ReturnType<typeof vi.fn>;
    await handleWebhook(post("/api/in/fathom", fathomBody, fathomHeaders(fathomBody, { ts: 1 })), "fathom", deps);
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).not.toContain(FATHOM_SECRET);
    expect(logged).not.toContain("test-key-123");
    expect(logged).not.toContain("Quarterly");
  });
});

describe("hmac-sha256 (GitHub example)", () => {
  const body = JSON.stringify({ action: "opened", number: 1 });
  const sig = "sha256=" + createHmac("sha256", "gh-secret").update(body).digest("hex");

  it("accepts a valid X-Hub-Signature-256", async () => {
    const res = await handleWebhook(post("/api/in/github", body, { "X-Hub-Signature-256": sig }), "github", deps);
    expect(res.status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).payload).toEqual({ action: "opened", number: 1 });
  });

  it("rejects an invalid signature", async () => {
    const res = await handleWebhook(post("/api/in/github", body, { "X-Hub-Signature-256": "sha256=" + "0".repeat(64) }), "github", deps);
    expect(res.status).toBe(401);
  });
});

describe("hmac-sha256 stripe format", () => {
  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", created: 1, livemode: false, data: { object: {} }, extra: "dropped" });
  const sign = (t: number) => `t=${t},v1=${createHmac("sha256", "whsec_stripe_test").update(`${t}.${body}`).digest("hex")}`;

  it("accepts a valid Stripe-Signature and applies pick() shaping", async () => {
    const res = await handleWebhook(post("/api/in/stripe", body, { "Stripe-Signature": sign(NOW_S) }), "stripe", deps);
    expect(res.status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).payload.extra).toBeUndefined();
  });

  it("rejects an old timestamp", async () => {
    const res = await handleWebhook(post("/api/in/stripe", body, { "Stripe-Signature": sign(NOW_S - 600) }), "stripe", deps);
    expect(res.status).toBe(401);
  });
});

describe("url-token", () => {
  it("accepts the right token", async () => {
    const res = await handleWebhook(post("/api/in/generic?token=s3cr3t-token", "hello"), "generic", deps);
    expect(res.status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).payload).toBe("hello");
  });
  it("rejects a wrong or missing token", async () => {
    expect((await handleWebhook(post("/api/in/generic?token=nope", "x"), "generic", deps)).status).toBe(401);
    expect((await handleWebhook(post("/api/in/generic", "x"), "generic", deps)).status).toBe(401);
  });
});

describe("routing and forwarding", () => {
  it("returns 404 for an unknown source", async () => {
    expect((await handleWebhook(post("/api/in/nope", "{}"), "nope", deps)).status).toBe(404);
    expect((await handleWebhook(post("/api/in/__proto__", "{}"), "__proto__", deps)).status).toBe(404);
    expect((await handleWebhook(post("/api/in/toString", "{}"), "toString", deps)).status).toBe(404);
  });

  it("returns 404 for a configured source whose env vars are missing", async () => {
    const env = { ...baseEnv } as Record<string, string | undefined>;
    delete env.GITHUB_TARGET_KEY;
    const res = await handleWebhook(post("/api/in/github", "{}"), "github", { ...deps, env });
    expect(res.status).toBe(404);
  });

  it("returns 405 for non-POST", async () => {
    const res = await handleWebhook(new Request("https://adapter.example/api/in/fathom"), "fathom", deps);
    expect(res.status).toBe(405);
  });

  it("passes a target HTTP failure through as 502", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const res = await handleWebhook(post("/api/in/fathom", fathomBody, fathomHeaders(fathomBody)), "fathom", deps);
    expect(res.status).toBe(502);
  });

  it("returns 502 when the target is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const res = await handleWebhook(post("/api/in/fathom", fathomBody, fathomHeaders(fathomBody)), "fathom", deps);
    expect(res.status).toBe(502);
  });

  it("supports a custom header name and scheme per source", async () => {
    const custom = {
      ...testSources,
      fathom: { ...sources.fathom!, target: { ...sources.fathom!.target, header: "X-Webhook-Key", scheme: "" } },
    };
    await handleWebhook(post("/api/in/fathom", fathomBody, fathomHeaders(fathomBody)), "fathom", { ...deps, sources: custom });
    expect(fetchMock.mock.calls[0]![1].headers["X-Webhook-Key"]).toBe("test-key-123");
  });

  it("does not double-prefix a key pasted with its scheme", () => {
    expect(authHeaderValue("Bearer abc", "Bearer")).toBe("Bearer abc");
    expect(authHeaderValue("abc", undefined)).toBe("Bearer abc");
    expect(authHeaderValue("abc", "")).toBe("abc");
  });

  it("shapeFathom passes non-objects through", () => {
    expect(shapeFathom("x")).toBe("x");
  });
});
