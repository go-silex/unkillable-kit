# @kit/core

Shared error, logging, parsing and pagination helpers; it does not own product-specific error codes.

## Entry points

- `@kit/core`: errors, logger, parsing and list pagination helpers.

## Composition

- Kit dependencies: `@kit/types`.
- Known consumers: `packages/auth`, `packages/email`, `packages/notifications`, `apps/example-api`.
- Caller rules: [architecture decision](../../docs/kit/architecture/adr/0010-list-page-cursor-envelope.md).

## Development

- Where to add: `src/errors.ts` for errors; `src/list-page.ts` for pagination.
- Test: `bun run --filter @kit/core test`
- Typecheck: `bun run --filter @kit/core typecheck`
