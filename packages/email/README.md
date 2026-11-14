# @kit/email

Email ports and message templates; it does not own product-specific message content.

## Entry points

- `@kit/email`: Worker-safe email ports and templates.
- `@kit/email/server`: server-side SMTP and logging transport helpers.

## Composition

- Kit dependencies: `@kit/core`.
- Known consumers: `packages/auth`, `apps/example-api`.
- Caller rules: [architecture decision](../../docs/kit/architecture/adr/0004-email-transport-cf-default.md).

## Development

- Where to add: `src/templates/` for templates; `src/ports.ts` for transports.
- Test: `bun run --filter @kit/email test`
- Typecheck: `bun run --filter @kit/email typecheck`
