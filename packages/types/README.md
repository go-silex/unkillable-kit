# @kit/types

Shared audience, list and error contracts; it does not own product-specific domain types.

## Entry points

- `@kit/types`: audience, list and error contracts.

## Composition

- Kit dependencies: none.
- Known consumers: `packages/core`, `packages/comments`, `packages/tasks`, `packages/notifications`, `packages/api-client`, `apps/example-api`, `apps/example-web`.
- Caller rules: [architecture decision](../../docs/kit/architecture/adr/0003-multi-tenant-rbac-modules.md).

## Development

- Where to add: `src/audience.ts` for visibility; `src/list.ts` for list contracts.
- Test: `bun run --filter @kit/types test`
- Typecheck: `bun run --filter @kit/types typecheck`
