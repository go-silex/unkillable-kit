# @kit/ui

Reusable React components and styling; it does not own application-specific screens.

## Entry points

- `@kit/ui`: React components, hooks and theme helpers.
- `@kit/ui/styles.css`: shared global styles with Geist.
- `@kit/ui/globals.css`: alias for `@kit/ui/styles.css`.
- `@kit/ui/base.css`: the same shared styles without Geist; defaults to the system font stack.

## Composition

- Kit dependencies: none.
- Known consumers: `packages/auth`, `apps/example-web`.
- Caller rules: [UI kit contract](../../docs/kit/ui-kit.md).

## Development

- Where to add: `src/components/ui/` for components; `src/styles/` for styles; `src/theme.tsx` for themes.
- Test: `bun run --filter @kit/ui test`
- Typecheck: `bun run --filter @kit/ui typecheck`
