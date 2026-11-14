# @kit/notifications

Notification definitions, resolution and persistence; it does not own application delivery orchestration.

## Entry points

- `@kit/notifications`: definitions, rule validation, resolution and rendering.
- `@kit/notifications/schema`: notification database tables.
- `@kit/notifications/repos`: notification repositories.

## Composition

- Kit dependencies: `@kit/auth`, `@kit/core`, `@kit/db`, `@kit/types`.
- Known consumers: `apps/example-api`.
- Caller rules: [architecture decision](../../docs/kit/architecture/adr/0019-notifications-rules-inbox-and-delivery.md).

## Development

- Where to add: `src/registry.ts` for definitions; `src/resolve.ts` for resolution; `src/repos/` for persistence.
- Test: `bun run --filter @kit/notifications test`
- Typecheck: `bun run --filter @kit/notifications typecheck`
