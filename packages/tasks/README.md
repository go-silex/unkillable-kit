# @kit/tasks

Work item contracts, visibility and persistence; it does not own application authentication and product-specific workflows.

## Entry points

- `@kit/tasks`: task schemas, stages, visibility and links.
- `@kit/tasks/schema`: task database tables.
- `@kit/tasks/repos`: task repositories.

## Composition

- Kit dependencies: `@kit/db`, `@kit/types`.
- Known consumers: `apps/example-api`.
- Caller rules: [architecture decision](../../docs/kit/architecture/adr/0007-tasks-comments-kernel.md).

## Development

- Where to add: `src/schema.ts` for contracts; `src/repos.ts` for persistence; `src/stages.ts` for stages.
- Test: `bun run --filter @kit/tasks test`
- Typecheck: `bun run --filter @kit/tasks typecheck`
