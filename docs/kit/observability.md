# Observability (Chemin A kit)

## Always on (default)

- **Structured logs** via `@kit/core` `createLogger` / `child({ requestId })`
- Cloudflare Workers Logs: `starter-api`, `example-api` and `mcp-example` enable them in Wrangler; JSON lines from `createLogger` are indexed there. `starter-api` also enables Cloudflare Workers traces.
- `x-request-id` + body `requestId` on API errors
- `createBetterAuth` leaves Better Auth's default `warn` threshold in place and emits fixed `library_event` severity events rather than library messages, arguments or errors: database errors can contain bound credentials. Its HTTP handler and `fetch` alias also emit fixed `handler_exception` or `server_error_response` events for failures.

Better Auth 1.7.14's router otherwise forwards non-API errors to Better Call, which logs the raw error independently of the Better Auth logger.
The factory requests propagation and converts non-API handler exceptions to an empty 500; this also converts exceptions before the router that previously propagated. API errors and returned responses retain their behavior. Diagnostic causes are intentionally lost.

This protects only this factory's Better Auth logger and HTTP handler paths. It does not sanitize direct `auth.api` callers, other App or library sinks, HTTP response bodies, Cloudflare serialization or independently constructed Better Auth instances; each remains its owner's responsibility.

## Starter Worker configuration

[`apps/starter-api/wrangler.toml`](../../apps/starter-api/wrangler.toml) has only the top-level environment. It enables observability, Workers Logs and Workers traces explicitly, and sets `redact_query_string = true`.

Wrangler inherits `[observability]` as a whole. A named environment without its own block uses the top-level block unchanged. A named environment with `[env.<name>.observability]` replaces the entire block, including `logs`, `traces` and `redact_query_string`; Wrangler does not merge fields.

When adding a named environment to a Product copied from the starter, repeat the complete block in that environment. For example, for `staging`:

```toml
[env.staging.observability]
enabled = true
redact_query_string = true

[env.staging.observability.logs]
enabled = true

[env.staging.observability.traces]
enabled = true
```

Products may set `head_sampling_rate` (0–1) for logs and traces separately. `example-api` repeats its logs configuration under `[env.production.observability]`; `mcp-example` has no named environments. Static `example-web` has no Worker observability block.

Keep `redact_query_string = true` in every deployed observability block that enables traces. This setting removes query strings from request URLs in Cloudflare logs and traces. It does not redact URL paths, headers, cookies, bodies, application log messages or custom span attributes.

For Products using Kit password-reset emails, links sent before the Kit moved reset tokens from paths to queries can still expose a path token. Wait for those links to expire before enabling traces (one reset-token lifetime, one hour by default).

## Verify D1 placement

1. Identify the production D1 primary location, for example from a baseline D1 read span with
   `served_by_primary = true`. A D1 creation location hint is not proof of the primary's location.
   In the Product API's Wrangler config, set `[env.production.placement]` `region` (or
   `[placement]` if deploying the top-level config) to the supported `provider:region` nearest
   that primary. A [placement hint](https://developers.cloudflare.com/workers/configuration/placement/#specify-a-cloud-region)
   targets a nearby Cloudflare data center; it does not move D1 or pin the Worker to an exact colo.
2. After the change goes live, send an authorized request that makes a representative read
   against the production D1 binding. Open the read span in [Workers traces](https://developers.cloudflare.com/workers/observability/traces/).
   Check that `cloudflare.d1.response.served_by_primary` is `true` and
   `cloudflare.d1.response.served_by_colo` matches the known primary colo. Compare it with
   `cloudflare.colo` on the invocation span: the D1 value alone says where the query ran,
   not where the Worker ran.
3. If the exact colo is missing, record it as unverified. With `served_by_primary = true`, the
   [documented `cloudflare.d1.response.served_by_region`](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/#d1)
   can corroborate the primary region, not exact colocation. Compare D1 span durations on
   equivalent reads before and after to measure latency; SQL execution time excludes network
   time. Do not rely on the `cf-placement` header.

## Product options (env-guarded — not shipped by the kit)

Status `option produit` in [`stack.md`](./standards/stack.md) § I: the kit ships no SDK, dependency or wiring for these.

| Need                     | Tool                  | Notes                               |
| ------------------------ | --------------------- | ----------------------------------- |
| Error tracking           | Sentry (or GlitchTip) | Wire SDK only when `SENTRY_DSN` set |
| Aggregated logs + uptime | Better Stack          | Prod optional                       |
| Product analytics        | PostHog               | Only if real product events         |

Web analytics (Plausible) is deferred: opt-in hub, no phone-home default; an env-gated snippet is allowed only if a public SPA enters the hub. See the [stack standard](./standards/stack.md) for deferred choices.

**Do not** enable Sentry + PostHog + a web-analytics Session Replay together without reason.

## Example (commented — do not paste secrets)

```ts
// if (env.SENTRY_DSN) {
//   // init Sentry Workers SDK with release + requestId tag
// }
```

## Local

- `console` JSON is enough for `wrangler dev`
- Worker email = `EMAIL_TRANSPORT=log` (console, redacted). Mailpit is Node `@kit/email/server` only — not the wrangler inbox
