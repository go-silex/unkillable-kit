# @kit/flows

Incubating governed plan and run primitives; it does not own application workflow wiring. See [ADR-0005](../../docs/kit/architecture/adr/0005-flows-platform-agentic-workflows.md).

## Entry points

- `@kit/flows`: plan checking, authority and snapshot primitives.
- `@kit/flows/schema`: flow database tables.
- `@kit/flows/repos`: plan and run repositories.
- `@kit/flows/run`: run execution and persistence helpers.

## Composition

- Kit dependencies: `@kit/db`.
- Known consumers: `apps/example-api`, `apps/example-web`.
- Caller rules: [architecture decision](../../docs/kit/architecture/adr/0005-flows-platform-agentic-workflows.md).

## Development

- Where to add: `src/check.ts` for plan checks; `src/repos/` for persistence; `src/run/` for execution.
- Test: `bun run --filter @kit/flows test`
- Typecheck: `bun run --filter @kit/flows typecheck`
