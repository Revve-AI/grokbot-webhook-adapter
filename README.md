# grokbot-webhook-adapter

[![CI](https://github.com/Revve-AI/grokbot-webhook-adapter/actions/workflows/ci.yml/badge.svg)](https://github.com/Revve-AI/grokbot-webhook-adapter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Trigger **Grok Bot routine webhooks** from services that can't send a custom `Authorization` header,
such as Fathom, GitHub, Stripe, or anything that signs its webhooks.

Grok Bot routine webhooks expect an `Authorization` header carrying the routine's webhook key. Most
webhook senders only let you enter a URL, but they sign each request instead. This adapter is a
tiny Vercel function that sits in between:

```
Fathom / GitHub / Stripe / ...  ──signed POST──▶  /api/in/<source>  ──Authorization: Bearer <key>──▶  Grok Bot routine
```

For each request it:

1. looks up the source config for `/api/in/<source>`,
2. verifies the sender's signature (or URL token) over the **raw** request body,
3. optionally trims the payload to the fields you care about,
4. forwards `{ "source", "receivedAt", "deliveryId"?, "payload" }` as JSON to that source's Grok Bot
   routine webhook, adding the auth header.

| Situation | Response |
|---|---|
| unknown source, or a source whose env vars aren't all set | `404` |
| signature or token check fails (incl. timestamp more than 5 min off) | `401` |
| forwarded successfully | `200 {"ok":true}` |
| Grok Bot returned non-2xx or didn't answer within 10 s | `502` (most senders retry) |
| method other than `POST` | `405` |

There's no database, no runtime dependencies, and nothing to pay for: Vercel's free Hobby plan is enough.

## Quick start

```bash
git clone https://github.com/Revve-AI/grokbot-webhook-adapter.git
cd grokbot-webhook-adapter
npm install
npm run check   # typecheck + tests
```

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FRevve-AI%2Fgrokbot-webhook-adapter&env=FATHOM_WEBHOOK_SECRET,FATHOM_TARGET_URL,FATHOM_TARGET_KEY&envDescription=Fathom%20webhook%20secret%20and%20the%20Grok%20Bot%20routine%20webhook%20URL%20and%20key&envLink=https%3A%2F%2Fgithub.com%2FRevve-AI%2Fgrokbot-webhook-adapter%23environment-variables)

Or by hand:

1. Fork or clone this repo into your own GitHub account.
2. In Vercel: **Add New… → Project**, import the repo, framework preset **Other** (no build command needed).
3. Under **Settings → Environment Variables**, add the variables for the sources you use (see below).
4. Deploy. Redeploy after changing env vars, because they only apply to new deployments.
5. Check that `https://<your-app>.vercel.app/api/health` returns `{"ok":true}`.

## Fathom setup

1. Create a Grok Bot routine with a **webhook** trigger. Copy its **Webhook URL** and **Webhook key**
   from the routine panel into `FATHOM_TARGET_URL` and `FATHOM_TARGET_KEY`.
2. In Fathom, go to **Settings → API Access**, generate an API key if needed, then **Manage → Add Webhook**.
3. Set the destination URL to `https://<your-app>.vercel.app/api/in/fathom`.
4. Choose which recordings trigger it and include **summary** and **action items**.
5. Copy the webhook secret (`whsec_…`) into `FATHOM_WEBHOOK_SECRET` and redeploy.
6. Record a short test meeting. Shortly after it ends, Fathom sends the webhook and your routine runs.

### How Fathom requests are verified

Fathom uses the [Standard Webhooks](https://www.standardwebhooks.com/) (Svix-style) scheme, as
documented at <https://developers.fathom.ai/webhooks#verifying-webhooks>:

- headers `webhook-id`, `webhook-timestamp` (unix seconds), `webhook-signature` (`v1,<base64>`, possibly several separated by spaces)
- signed content: `${webhook-id}.${webhook-timestamp}.${rawBody}`
- key: the base64-decoded part of the secret after `whsec_`
- HMAC-SHA256, base64-encoded, compared in constant time; timestamps more than 5 minutes off are rejected

The tests check this against the reference [`standardwebhooks`](https://www.npmjs.com/package/standardwebhooks) library.

### What your routine receives

The payload is trimmed to the useful fields of Fathom's
[New meeting content ready](https://developers.fathom.ai/api-reference/webhook-payloads/new-meeting-content-ready)
event. The full transcript is dropped because it can be very large; remove `shape` from the `fathom`
entry if you want everything.

```json
{
  "source": "fathom",
  "receivedAt": "2026-01-01T12:00:00.000Z",
  "deliveryId": "msg_...",
  "payload": {
    "title": "Quarterly Business Review",
    "meeting_title": "QBR 2025 Q1",
    "meeting_type": null,
    "recording_id": 123456789,
    "url": "https://fathom.video/xyz123",
    "share_url": "https://fathom.video/share/xyz123",
    "meeting_url": "https://us02web.zoom.us/j/123456789",
    "created_at": "...", "scheduled_start_time": "...", "scheduled_end_time": "...",
    "recording_start_time": "...", "recording_end_time": "...",
    "calendar_invitees_domains_type": "one_or_more_external",
    "recorded_by": { "name": "...", "email": "...", "email_domain": "...", "team": null },
    "attendees": [{ "name": "...", "email": "...", "is_external": true }],
    "summary_markdown": "## Summary\n...",
    "action_items": [{ "description": "...", "assignee": { "name": "...", "email": "...", "team": null },
                       "completed": false, "recording_timestamp": "00:10:45",
                       "recording_playback_url": "..." }],
    "highlights": null,
    "crm_matches": null
  }
}
```

`deliveryId` is Fathom's `webhook-id`. It stays the same when Fathom retries a delivery, so you can use it to skip duplicates.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `FATHOM_WEBHOOK_SECRET` | for Fathom | Fathom webhook secret, `whsec_…` |
| `FATHOM_TARGET_URL` | for Fathom | Grok Bot routine **Webhook URL** |
| `FATHOM_TARGET_KEY` | for Fathom | Grok Bot routine **Webhook key**. The bare key or a full `Bearer …` value both work |
| `GITHUB_WEBHOOK_SECRET`, `GITHUB_TARGET_URL`, `GITHUB_TARGET_KEY` | optional | GitHub example source; disabled until all three are set |
| `STRIPE_WEBHOOK_SECRET`, `STRIPE_TARGET_URL`, `STRIPE_TARGET_KEY` | optional | Stripe example source; disabled until all three are set |

See [`.env.example`](.env.example).

## Adding a source

Adding a source means one config entry plus its env vars; no new files are needed. Edit `src/sources.ts`:

```ts
export const sources = {
  // ...
  linear: {
    verification: {
      type: "hmac-sha256",
      secretEnv: "LINEAR_WEBHOOK_SECRET",
      header: "Linear-Signature",
      encoding: "hex",
    },
    target: { urlEnv: "LINEAR_TARGET_URL", keyEnv: "LINEAR_TARGET_KEY" },
    shape: pick(["action", "type", "data", "url"]), // optional
  },
};
```

Set the env vars in Vercel, redeploy, and point the sender at `https://<your-app>.vercel.app/api/in/linear`.

**Verification types**

| `type` | Use for | Options |
|---|---|---|
| `fathom` | Fathom, or any Standard Webhooks / Svix sender | `secretEnv`, `toleranceSeconds` (default 300) |
| `hmac-sha256` | GitHub, Linear, Shopify and most others | `secretEnv`, `header`, `prefix` (e.g. `sha256=`), `encoding` (`hex` or `base64`); or `format: "stripe"` for `t=…,v1=…` headers with replay protection |
| `url-token` | senders that can only call a URL | `tokenEnv`, `param` (default `token`). Call `/api/in/<source>?token=…`; compared in constant time |
| `none` | trusted internal callers only | (none) |

**Target options:** `urlEnv` and `keyEnv`, plus optional `header` (default `Authorization`) and
`scheme` (default `Bearer`; use `""` to send the key with no prefix).

> **Note:** The default is `Authorization: Bearer <key>`. If your Grok Bot routine panel shows a
> different header format, set `header` and `scheme` on the target, or put the full header value in `*_TARGET_KEY`.

## Security

- Keep secrets **only** in your hosting provider's environment variables. This repo contains no secrets, and `.env*` files (except `.env.example`) are git-ignored.
- Every source should verify its sender; use `none` only for trusted internal callers.
- Signature and token comparisons are constant-time. Timestamped schemes (Fathom, Stripe) reject requests more than 5 minutes old to stop replays.
- Logs contain only the source name and the failure reason, never secrets, keys, or request bodies.
- A source with missing env vars responds exactly like an unknown source (`404`).
- To report a vulnerability, please open a private [security advisory](https://github.com/Revve-AI/grokbot-webhook-adapter/security/advisories/new) rather than a public issue.

## Contributing

Issues and pull requests are welcome.

1. Fork the repo and create a branch.
2. `npm install`, make your change, and add or update tests in `test/`.
3. Run `npm run check` (typecheck + tests). CI runs the same check on every push and pull request.
4. Keep it small: new sources should be a config entry in `src/sources.ts`, and a new verification type only if no existing one fits.

Never include real secrets, keys, or webhook URLs in code, tests, or issues.

## License

[MIT](LICENSE) © 2026 Revve AI
