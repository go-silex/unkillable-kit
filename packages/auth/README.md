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

## Account state

The Product decides who may call `disableAccount` and `enableAccount` from
`@kit/auth/repos/account-state`; both require the acting User and Organization,
and check that actor and target belong to that Organization. Disabling a User
revokes their existing sessions; enabling does not restore them. State is
Deployment-wide for that User, including their memberships in other Organizations.
When the audit set is mounted, pass its audit option to record the change.

Each request must use the live `isAccountActive` check when configuring session
and API-key authentication. An Organization-bound key is governed by its
subject (the User who owns the key), not by an Organization-wide status.
Missing Users, disabled Users and state-read failures are refused. Products
must sync and apply the account-state schema migration before deploying.

## Development

- Where to add: `src/org-roles.ts` for access roles; `src/react/` for forms; `src/repos/` for persistence.
- Test: `bun run --filter @kit/auth test`
- Typecheck: `bun run --filter @kit/auth typecheck`
