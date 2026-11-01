import { sources as defaultSources, type SourceConfig } from "./sources.js";
import { verify, verifiedEnvNames } from "./verify.js";

export interface Deps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  now: () => Date;
  sources: Record<string, SourceConfig>;
  /** Timeout for the forward call, ms. */
  forwardTimeoutMs: number;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const SOURCE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Returns the source config if it exists AND all its env vars are set. */
export function resolveSource(
  name: string,
  deps: Pick<Deps, "env" | "sources">,
): { config: SourceConfig } | { missing: string[] } | null {
  if (!SOURCE_NAME.test(name) || !Object.prototype.hasOwnProperty.call(deps.sources, name)) return null;
  const config = deps.sources[name]!;
  const needed = [...verifiedEnvNames(config.verification), config.target.urlEnv, config.target.keyEnv];
  const missing = needed.filter((n) => !deps.env[n]);
  return missing.length ? { missing } : { config };
}

export function authHeaderValue(key: string, scheme: string | undefined): string {
  const s = scheme ?? "Bearer";
  if (!s) return key;
  return key.toLowerCase().startsWith(`${s.toLowerCase()} `) ? key : `${s} ${key}`;
}

export async function handleWebhook(request: Request, sourceName: string, partial: Partial<Deps> = {}): Promise<Response> {
  const deps: Deps = {
    env: process.env,
    fetch: globalThis.fetch,
    now: () => new Date(),
    sources: defaultSources,
    forwardTimeoutMs: 10_000,
    ...partial,
  };

  if (request.method !== "POST") return json(405, { error: "method not allowed" });

  const resolved = resolveSource(sourceName, deps);
  if (!resolved) return json(404, { error: "unknown source" });
  if ("missing" in resolved) {
    console.error(`[adapter] source "${sourceName}" disabled: missing env ${resolved.missing.join(", ")}`);
    return json(404, { error: "unknown source" });
  }
  const { config } = resolved;

  const rawBody = await request.text();
  const now = deps.now();
  const url = new URL(request.url);

  const result = verify(config.verification, {
    rawBody,
    headers: request.headers,
    url,
    env: deps.env,
    nowSeconds: Math.floor(now.getTime() / 1000),
  });
  if (!result.ok) {
    console.error(`[adapter] source "${sourceName}" verification failed: ${result.reason}`);
    return json(401, { error: "verification failed" });
  }

  let payload: unknown = rawBody;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // not JSON: forward as string
  }
  if (config.shape) {
    try {
      payload = config.shape(payload);
    } catch (err) {
      console.error(`[adapter] source "${sourceName}" shaping failed: ${(err as Error).message}; forwarding unshaped`);
    }
  }

  const body: Record<string, unknown> = { source: sourceName, receivedAt: now.toISOString(), payload };
  if (result.deliveryId) body.deliveryId = result.deliveryId;

  const targetUrl = deps.env[config.target.urlEnv]!;
  const key = deps.env[config.target.keyEnv]!;
  try {
    const res = await deps.fetch(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [config.target.header ?? "Authorization"]: authHeaderValue(key, config.target.scheme),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.forwardTimeoutMs),
    });
    if (!res.ok) {
      console.error(`[adapter] source "${sourceName}" forward failed: target returned HTTP ${res.status}`);
      return json(502, { error: "target failed", status: res.status });
    }
  } catch (err) {
    console.error(`[adapter] source "${sourceName}" forward failed: ${(err as Error).name}`);
    return json(502, { error: "target unreachable" });
  }

  return json(200, { ok: true });
}
