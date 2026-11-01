import type { Verification } from "./verify.js";

/** Where to forward a verified event: a Grok Bot routine webhook. */
export interface Target {
  /** Env var holding the Grok Bot routine "Webhook URL". */
  urlEnv: string;
  /** Env var holding the Grok Bot routine "Webhook key". */
  keyEnv: string;
  /** Header to put the key in. Default "Authorization". */
  header?: string;
  /**
   * Prefix before the key, e.g. "Bearer" -> "Authorization: Bearer <key>". Default "Bearer".
   * Use "" to send the key as-is. If the key env value already starts with "<scheme> ",
   * it is not prefixed twice (so you can paste the full header value).
   */
  scheme?: string;
}

export interface SourceConfig {
  verification: Verification;
  target: Target;
  /** Optional payload shaping. Receives the parsed JSON body (or the raw string if not JSON). */
  shape?: (payload: unknown) => unknown;
}

// ---------- helpers for shaping ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keep only the listed top-level keys. */
export function pick(fields: string[]): (payload: unknown) => unknown {
  return (payload) => {
    if (!isObj(payload)) return payload;
    const out: Obj = {};
    for (const f of fields) if (f in payload) out[f] = payload[f];
    return out;
  };
}

/**
 * Fathom "New meeting content ready" payload -> compact meeting record.
 * Field names from https://developers.fathom.ai/api-reference/webhook-payloads/new-meeting-content-ready
 * The full transcript is dropped on purpose (it can be very large); everything else useful is kept.
 */
export function shapeFathom(payload: unknown): unknown {
  if (!isObj(payload)) return payload;
  const invitees = Array.isArray(payload.calendar_invitees) ? payload.calendar_invitees : [];
  const summary = isObj(payload.default_summary) ? payload.default_summary : null;
  const actionItems = Array.isArray(payload.action_items) ? payload.action_items : [];
  return {
    title: payload.title ?? null,
    meeting_title: payload.meeting_title ?? null,
    meeting_type: payload.meeting_type ?? null,
    recording_id: payload.recording_id ?? null,
    url: payload.url ?? null,
    share_url: payload.share_url ?? null,
    meeting_url: payload.meeting_url ?? null,
    created_at: payload.created_at ?? null,
    scheduled_start_time: payload.scheduled_start_time ?? null,
    scheduled_end_time: payload.scheduled_end_time ?? null,
    recording_start_time: payload.recording_start_time ?? null,
    recording_end_time: payload.recording_end_time ?? null,
    calendar_invitees_domains_type: payload.calendar_invitees_domains_type ?? null,
    recorded_by: payload.recorded_by ?? null,
    attendees: invitees.filter(isObj).map((i) => ({
      name: i.name ?? null,
      email: i.email ?? null,
      is_external: i.is_external ?? null,
    })),
    summary_markdown: summary?.markdown_formatted ?? null,
    action_items: actionItems.filter(isObj).map((a) => ({
      description: a.description ?? null,
      assignee: a.assignee ?? null,
      completed: a.completed ?? null,
      recording_timestamp: a.recording_timestamp ?? null,
      recording_playback_url: a.recording_playback_url ?? null,
    })),
    highlights: payload.highlights ?? null,
    crm_matches: payload.crm_matches ?? null,
  };
}

// ---------- the sources ----------
//
// Adding a source = add one entry here + set its env vars in Vercel. No new files.
// A source whose env vars are not all set is treated as disabled (404), so the
// examples below are safe to leave in until you configure them.

export const sources: Record<string, SourceConfig> = {
  // POST https://<app>.vercel.app/api/in/fathom
  fathom: {
    verification: { type: "fathom", secretEnv: "FATHOM_WEBHOOK_SECRET", toleranceSeconds: 300 },
    target: { urlEnv: "FATHOM_TARGET_URL", keyEnv: "FATHOM_TARGET_KEY" },
    shape: shapeFathom,
  },

  // Example: GitHub repo/org webhook (content type: application/json, secret set in GitHub).
  // Disabled until GITHUB_WEBHOOK_SECRET, GITHUB_TARGET_URL, GITHUB_TARGET_KEY exist.
  github: {
    verification: {
      type: "hmac-sha256",
      secretEnv: "GITHUB_WEBHOOK_SECRET",
      header: "X-Hub-Signature-256",
      prefix: "sha256=",
      encoding: "hex",
    },
    target: { urlEnv: "GITHUB_TARGET_URL", keyEnv: "GITHUB_TARGET_KEY" },
  },

  // Example: Stripe webhook endpoint (signing secret "whsec_..." from the Stripe dashboard).
  // Disabled until STRIPE_WEBHOOK_SECRET, STRIPE_TARGET_URL, STRIPE_TARGET_KEY exist.
  stripe: {
    verification: {
      type: "hmac-sha256",
      secretEnv: "STRIPE_WEBHOOK_SECRET",
      header: "Stripe-Signature",
      format: "stripe",
      toleranceSeconds: 300,
    },
    target: { urlEnv: "STRIPE_TARGET_URL", keyEnv: "STRIPE_TARGET_KEY" },
    shape: pick(["id", "type", "created", "livemode", "data"]),
  },

  // Example: any sender that can only call a URL. POST /api/in/generic?token=<GENERIC_URL_TOKEN>
  // generic: {
  //   verification: { type: "url-token", tokenEnv: "GENERIC_URL_TOKEN" },
  //   target: { urlEnv: "GENERIC_TARGET_URL", keyEnv: "GENERIC_TARGET_KEY" },
  // },
};
