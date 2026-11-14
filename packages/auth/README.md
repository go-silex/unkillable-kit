# @kit/auth

Authentication primitives and integration surfaces; it does not own product-specific identity policy.

## Entry points

- `@kit/auth`: environment, sessions, keys and organization access helpers.
- `@kit/auth/schema`: authentication database tables.
- `@kit/auth/factory`: Worker authentication factory and email integration.
- `@kit/auth/react`: React authentication forms and helpers.
- `@kit/auth/hono`: Hono authentication middleware.
- `@kit/auth/repos/*`: individual repository modules under `src/repos/`.
- `@kit/auth/repos/memory-d1`: explicitly unavailable as a public export.

## Composition

- Kit dependencies: `@kit/core`, `@kit/db`; optional peers `@kit/email`, `@kit/ui`.
- Known consumers: `apps/example-api`, `apps/example-web`, `packages/mcp`, `packages/notifications`.
- Caller rules: [architecture decision](../../docs/kit/architecture/adr/0003-multi-tenant-rbac-modules.md).

## API key scopes

New keys must explicitly store a comma-separated selection of `read`, `write` and `admin` in `scopes`. The scopes are independent: `admin` does not imply `read` or `write`. The migration backfills existing keys with all three scopes. Malformed stored scope strings grant no scopes.

`resolveDualAuth` returns `scopes: ApiKeyScope[]` for API-key identities; `createRequireAuth` exposes them as `keyScopes` in the request context. Use `allowsApiKeyScope(identity, requiredScope)` at each protected route in addition to organization and role checks. It allows sessions through unchanged and requires exact membership for keys; it does not replace tenant or RBAC authorization.

## Development

- Where to add: `src/org-roles.ts` for access roles; `src/react/` for forms; `src/repos/` for persistence.
- Test: `bun run --filter @kit/auth test`
- Typecheck: `bun run --filter @kit/auth typecheck`
