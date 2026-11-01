import { createHmac, timingSafeEqual } from "node:crypto";

/** How an incoming request proves it really came from the source. */
export type Verification =
  /**
   * Fathom (Standard Webhooks / Svix-style): headers `webhook-id`, `webhook-timestamp`,
   * `webhook-signature` ("v1,<base64> v1,<base64>"); secret `whsec_<base64>`;
   * HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`, base64-encoded.
   * Docs: https://developers.fathom.ai/webhooks#verifying-webhooks
   */
  | { type: "fathom"; secretEnv: string; toleranceSeconds?: number }
  /**
   * Generic HMAC-SHA256 over the raw body.
   * - format "plain": header value is `${prefix}${digest}` (e.g. GitHub: prefix "sha256=", hex).
   * - format "stripe": header is `t=<unix>,v1=<hex>[,v1=...]`, signed payload `${t}.${rawBody}`,
   *   with replay protection (toleranceSeconds, default 300).
   */
  | {
      type: "hmac-sha256";
      secretEnv: string;
      header: string;
      format?: "plain" | "stripe";
      prefix?: string;
      encoding?: "hex" | "base64";
      toleranceSeconds?: number;
    }
  /** Shared secret in the URL, e.g. `/api/in/foo?token=...`. Compared in constant time. */
  | { type: "url-token"; tokenEnv: string; param?: string }
  /** No verification. Only for trusted/internal senders. */
  | { type: "none" };

export interface VerifyInput {
  rawBody: string;
  headers: Headers;
  url: URL;
  env: Record<string, string | undefined>;
  nowSeconds: number;
}

export type VerifyResult = { ok: true; deliveryId?: string } | { ok: false; reason: string };

const DEFAULT_TOLERANCE = 300; // 5 minutes

/** Constant-time string comparison that does not leak length via early exit. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still do a comparison so timing is similar, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function withinTolerance(ts: string | null | undefined, now: number, tolerance: number): boolean {
  if (!ts || !/^\d+$/.test(ts)) return false;
  return Math.abs(now - parseInt(ts, 10)) <= tolerance;
}

export function verifiedEnvNames(v: Verification): string[] {
  switch (v.type) {
    case "fathom":
    case "hmac-sha256":
      return [v.secretEnv];
    case "url-token":
      return [v.tokenEnv];
    case "none":
      return [];
  }
}

export function verify(v: Verification, input: VerifyInput): VerifyResult {
  switch (v.type) {
    case "none":
      return { ok: true };

    case "url-token": {
      const expected = input.env[v.tokenEnv];
      if (!expected) return { ok: false, reason: "token env not set" };
      const got = input.url.searchParams.get(v.param ?? "token") ?? "";
      return safeEqual(got, expected) ? { ok: true } : { ok: false, reason: "bad token" };
    }

    case "fathom": {
      const secret = input.env[v.secretEnv];
      if (!secret) return { ok: false, reason: "secret env not set" };
      const id = input.headers.get("webhook-id");
      const ts = input.headers.get("webhook-timestamp");
      const sigHeader = input.headers.get("webhook-signature");
      if (!id || !ts || !sigHeader) return { ok: false, reason: "missing webhook-* headers" };
      if (!withinTolerance(ts, input.nowSeconds, v.toleranceSeconds ?? DEFAULT_TOLERANCE)) {
        return { ok: false, reason: "timestamp outside tolerance" };
      }
      const keyB64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
      const key = Buffer.from(keyB64, "base64");
      const expected = createHmac("sha256", key)
        .update(`${id}.${ts}.${input.rawBody}`)
        .digest("base64");
      const candidates = sigHeader
        .split(" ")
        .filter(Boolean)
        .map((s) => {
          const comma = s.indexOf(",");
          return comma >= 0 ? s.slice(comma + 1) : s;
        });
      return candidates.some((c) => safeEqual(c, expected))
        ? { ok: true, deliveryId: id }
        : { ok: false, reason: "signature mismatch" };
    }

    case "hmac-sha256": {
      const secret = input.env[v.secretEnv];
      if (!secret) return { ok: false, reason: "secret env not set" };
      const headerVal = input.headers.get(v.header);
      if (!headerVal) return { ok: false, reason: `missing ${v.header} header` };

      if (v.format === "stripe") {
        let t: string | undefined;
        const sigs: string[] = [];
        for (const part of headerVal.split(",")) {
          const eq = part.indexOf("=");
          if (eq < 0) continue;
          const k = part.slice(0, eq).trim();
          const val = part.slice(eq + 1).trim();
          if (k === "t") t = val;
          else if (k === "v1") sigs.push(val);
        }
        if (!t || sigs.length === 0) return { ok: false, reason: "malformed signature header" };
        if (!withinTolerance(t, input.nowSeconds, v.toleranceSeconds ?? DEFAULT_TOLERANCE)) {
          return { ok: false, reason: "timestamp outside tolerance" };
        }
        const expected = createHmac("sha256", secret).update(`${t}.${input.rawBody}`).digest("hex");
        return sigs.some((s) => safeEqual(s, expected))
          ? { ok: true }
          : { ok: false, reason: "signature mismatch" };
      }

      const digest = createHmac("sha256", secret)
        .update(input.rawBody)
        .digest(v.encoding ?? "hex");
      const expected = `${v.prefix ?? ""}${digest}`;
      return safeEqual(headerVal.trim(), expected)
        ? { ok: true }
        : { ok: false, reason: "signature mismatch" };
    }
  }
}
