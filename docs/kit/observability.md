# Observability (Chemin A kit)

## Always on (default)

- **Structured logs** via `@kit/core` `createLogger` / `child({ requestId })`
- Cloudflare Workers Logs: `[observability] enabled = true` + `head_sampling_rate = 1` (every invocation) in `apps/example-api/wrangler.toml` and `apps/mcp-example/wrangler.toml`; JSON lines from `createLogger` are indexed there
- `x-request-id` + body `requestId` on API errors
- `createBetterAuth` leaves Better Auth's default `warn` threshold in place and emits fixed `library_event` severity events rather than library messages, arguments or errors: database errors can contain bound credentials. Its HTTP handler and `fetch` alias also emit fixed `handler_exception` or `server_error_response` events for failures.

Better Auth 1.7.14's router otherwise forwards non-API errors to Better Call, which logs the raw error independently of the Better Auth logger. The factory requests propagation and converts non-API handler exceptions to an empty 500; this also converts exceptions before the router that previously propagated. API errors and returned responses retain their behavior. Diagnostic causes are intentionally lost.

This protects only this factory's Better Auth logger and HTTP handler paths. It does not sanitize direct `auth.api` callers, other App or library sinks, HTTP response bodies, Cloudflare serialization or independently constructed Better Auth instances; each remains its owner's responsibility.

`[observability]` is a non-inheritable wrangler key: `example-api` repeats it under `[env.production.observability]` (the deployed Worker). `mcp-example` has no `[env.*]`. `example-web` is a Pages project of static assets (`pages_build_output_dir`, no Worker code or Pages Functions): nothing runs server-side to log, so it carries no `[observability]`. Lower `head_sampling_rate` (0–1) per product if volume or cost requires it.

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
