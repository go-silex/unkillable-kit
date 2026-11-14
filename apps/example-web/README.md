# @kit/example-web

This React frontend demonstrates kit composition; it is not a product template.
See [start a product](../../docs/kit/playbooks/start-product.md#architecture-default--compose-do-not-clone).

## Source map

- `src/routes/` and `src/components/`: screens and UI composition.
- `src/lib/`, `src/messages/`, `src/content/`: helpers and application content.
- `src/test/`: test support.
- `src/main.tsx` and `src/routeTree.tsx`: entry and routing.

## Composition

- Kit dependencies: `@kit/api-client`, `@kit/auth`, `@kit/flows`, `@kit/i18n`, `@kit/types`, `@kit/ui`.
- This example is a deployable application, not a library.

## Local development

- Start: `bun run --filter @kit/example-web dev`.
- Test: `bun run --filter @kit/example-web test`
- Typecheck: `bun run --filter @kit/example-web typecheck`

## Where to add

- Routes: `src/routes/`.
- Tests: `src/test/` and colocated tests in `src/`.
