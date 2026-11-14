# @kit/email

Email ports and message templates; it does not own product-specific message content.

## Entry points

- `@kit/email`: Worker-safe email ports and templates.
- `@kit/email/server`: server-side SMTP and logging transport helpers.

## Composition

- Kit dependencies: `@kit/core`.
- Known consumers: `packages/auth`, `apps/example-api`.
- Caller rules: [architecture decision](../../docs/kit/architecture/adr/0004-email-transport-cf-default.md).

## Transactional templates

`buildInviteEmailText`, `buildMagicLinkEmailText`, `buildResetPasswordEmailText`
and `buildWelcomeSetPasswordEmailText` require an explicit `locale` (`'fr'` or
`'en'`) and `productName`. The caller chooses the recipient's locale and supplies
the product's display name; there is no implicit locale or product branding.
`EmailLocale` and `EmailTemplateOptions` are exported for callers.

Each builder returns `{ to, subject, text, html }`. Interpolated values are
flattened to prevent line-break injection and escaped in HTML. Token links
still require `allowedOrigins` (and optionally `allowLoopbackHttp` for local
development); HTML escaping does not replace origin validation. `expiresHint`,
when supplied, is caller-provided copy and should match the selected locale.
The demo template is not transactional and retains its separate API.

## Development

- Where to add: `src/templates/` for templates; `src/ports.ts` for transports.
- Test: `bun run --filter @kit/email test`
- Typecheck: `bun run --filter @kit/email typecheck`
