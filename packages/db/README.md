# @kit/db

D1 database helpers and a SQLite test adapter; it does not own application schema composition.

## Entry points

- `@kit/db`: D1 client and database utilities.
- `@kit/db/testing`: SQLite-backed D1 test adapter.

## Composition

- Kit dependencies: none.
- Known consumers: `packages/auth`, `packages/comments`, `packages/flows`, `packages/notifications`, `packages/tasks`, `apps/example-api`.
- Caller rules: [architecture decision](../../docs/kit/architecture/adr/0012-kernel-persistence-request-context.md).

## Development

- Where to add: `src/index.ts` for D1 helpers; `src/test/sqlite-d1.ts` for the test adapter.
- Test: `bun run --filter @kit/db test`
- Typecheck: `bun run --filter @kit/db typecheck`
