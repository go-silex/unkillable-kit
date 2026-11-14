# @kit/example-api

This Worker API demonstrates kit composition; it is not a product template.
See [start a product](../../docs/kit/playbooks/start-product.md#architecture-default--compose-do-not-clone).

## Source map

- `src/routes/` and `src/middleware/`: HTTP routes and guards.
- `src/services/`, `src/repos/`, `src/db/`: services and persistence.
- `src/flows-run/`, `src/jobs/`, `src/notifications-delivery/`: execution and delivery.
- `src/lib/`, `src/messages/`, `src/seed/`, `src/test/`: helpers, messages, fixtures and tests.
- `src/index.ts` and `src/app.ts`: entry and application composition.

## Composition

- Kit dependencies: `@kit/api-client`, `@kit/auth`, `@kit/comments`, `@kit/core`, `@kit/db`, `@kit/email`,
  `@kit/flows`, `@kit/i18n`, `@kit/notifications`, `@kit/storage`, `@kit/tasks`, `@kit/types`.
- Example consumer: `apps/example-web`.

## Local development

- Configure `.dev.vars` first: see [local onboarding](../../README.md#local-onboarding).
- Prepare local data: `bun run --filter @kit/example-api db:migrate`, then `bun run --filter @kit/example-api db:seed`.
- Start: `bun run --filter @kit/example-api dev`.
- Test: `bun run --filter @kit/example-api test`
- Typecheck: `bun run --filter @kit/example-api typecheck`

## Where to add

- Routes: `src/routes/`; mount them in `src/app.ts`.
- Tests: `src/test/` and colocated tests in `src/`.
