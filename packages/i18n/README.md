# @kit/i18n

Locale engine and React adapter; it does not own application message catalogs.

## Entry points

- `@kit/i18n`: locale engine and locale helpers.
- `@kit/i18n/react`: React locale adapter.

## Composition

- Kit dependencies: none.
- Known consumers: `apps/example-api`, `apps/example-web`.
- Caller rules: [architecture decision](../../docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md).

## Development

- Where to add: `src/index.ts` for locale logic; `src/react.ts` for the React adapter.
- Test: `bun run --filter @kit/i18n test`
- Typecheck: `bun run --filter @kit/i18n typecheck`
