# @kit/comments

Multi-target comment contracts and persistence; it does not own product entity wiring.

## Entry points

- `@kit/comments`: comment schemas, audience and visibility helpers.
- `@kit/comments/schema`: comment database tables.
- `@kit/comments/repos`: comment repositories.

## Composition

- Kit dependencies: `@kit/db`, `@kit/types`.
- Known consumers: `apps/example-api`.
- Caller rules: [architecture decision](../../docs/kit/architecture/adr/0007-tasks-comments-kernel.md).

## Development

- Where to add: `src/schema.ts` for contracts; `src/repos.ts` for persistence.
- Test: `bun run --filter @kit/comments test`
- Typecheck: `bun run --filter @kit/comments typecheck`
