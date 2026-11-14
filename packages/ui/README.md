# @kit/ui

Reusable React components and styling; it does not own application-specific screens.

## Entry points

- `@kit/ui`: React components, hooks and theme helpers.
- `@kit/ui/styles.css`: shared global stylesheet.
- `@kit/ui/globals.css`: the same shared global stylesheet.

## Composition

- Kit dependencies: none.
- Known consumers: `packages/auth`, `apps/example-web`.
- Caller rules: [architecture decision](../../docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md).

## Development

- Where to add: `src/components/ui/` for components; `src/styles/` for styles; `src/theme.tsx` for themes.
- Test: `bun run --filter @kit/ui test`
- Typecheck: `bun run --filter @kit/ui typecheck`
