# n8n-nodes-konexium

Check African suppliers with sourced evidence and route confirmed Watch changes into n8n workflows. MIT connector; no runtime dependencies.

## Install and credentials

After the owner publishes: in a self-hosted n8n instance, open **Settings → Community Nodes → Install**, enter `n8n-nodes-konexium`, and install. Editor discovery on n8n Cloud requires separate n8n verification. This package is not yet verified or available on npm.

Create **Konexium API** credentials with a workspace API key and server origin (default `https://api.konexiumai.com`, no path; HTTP loopback allowed locally). Requests use Bearer authentication. Credential testing calls `GET /api/v1/public/me`, costing 0 credits. Free `kxm_test_...` keys return deterministic fixtures and use 0 credits. Recipe placeholders are not issued keys.

Scopes: `read` for reads/testing, `lists:write` for Check, `monitoring:write` for Add, `webhooks:write` for the trigger. The key's workspace and environment determine all access.

## Operations and credits

| Operation        | API                                          | Notes                                                                                                                                                                                                  |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Company → Check  | POST `/bulk-verify`, GET `/bulk-verify/{id}` | One named company, country and expected sector; optional website and registration number. Returns the complete run with `rows[0].outcome`, verdict quotes/URLs, explanations, trace and credit totals. |
| Watch → Add      | POST `/watches`                              | Existing `workspaceCompanyId` and cadence (1–30 days). Obtain this ID through the public companies API; Check does not promise a Watch-ready ID.                                                       |
| Watch → List     | GET `/watches`                               | All watches, one n8n item per watch; API currently has no pagination.                                                                                                                                  |
| Konexium Trigger | POST/GET/DELETE `/webhooks`                  | Registers `monitoring.change_confirmed` on activation, checks all endpoint pages, and deletes on deactivation.                                                                                         |

Paths are relative to `/api/v1/public`. The current API requires a sector. Optional registration number checks that the **company website states that number**, rather than performing an exact registry-number lookup. Preserve returned registry/sanctions limitations and unknown outcomes.

Each live Check reserves up to **16 credits**: Ready costs 16, not matched/needs review costs 2, reused/unresolved/failed/duplicate rows cost 0. `actualCredits` is authoritative. No connector fee; existing API plans and recurring Watch limits/charges apply. The idempotency key is optional: left empty, the node derives one from the execution, item and company, so n8n retries never charge twice. Set your own key to deduplicate across executions.

Check polls every 3 seconds, with a 120-second total wait (10–300 configurable). A timeout reports the run UUID; server work continues. Reuse the key or retrieve that run with HTTP Request. Live latency is unmeasured; sandbox completes after 2 seconds. Programmatic style handles per-input start/poll processing and the trigger; n8n prefers declarative for single-call REST actions.

## Recipes

Import either inactive JSON file from `examples/`, replace placeholder credentials/IDs, and review before activation:

- **suppliers-sheet.json:** Google Sheets → Check each → write Verdict, Explanation, Sources and Credits back by Supplier ID. Headers: `Supplier ID`, `Company Name`, `Country`, `Sector`, `Website`, `Verdict`, `Explanation`, `Sources`, `Credits`. Use unique Supplier IDs; each run checks every row again. Item linking preserves row pairing. Start with a small sandbox sheet.
- **watch-to-slack.json:** Konexium Trigger → Slack notification with watch/company/change IDs. Select Slack credentials and channel. Companies must already be watched; fetch evidence through the public API when needed.

Use public HTTPS webhooks. HMAC-SHA256 verifies exact raw bytes with ±5-minute timestamp tolerance. `webhook.test` is acknowledged without starting a workflow. Deduplicate `webhookId` downstream. Signing secrets live in n8n node static data; restrict workflow/database/export access. Deactivate before changing credentials/server or rotating secrets, then reactivate. Sandbox endpoints expire after seven days. Inspect endpoint registrations after ambiguous activation failures; failed deletion retains cleanup state.

## Development and review

Node.js 22.16+:

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run lint
npm audit
```

Tests compile TypeScript and mock HTTP helpers; no backend/database is needed. Lint uses the unchanged official n8n strict configuration. `npm run check:n8n` also runs the recommended CLI wrapper; this sandbox's wrapper fails on `uv_os_get_passwd` before lint starts. See [research and review gates](../../docs/research/n8n-node.md). Verification requires matching public brand npm/GitHub metadata and GitHub Actions publication with provenance. The registry scanner cannot verify this unpublished package. Release remains the owner's step.
