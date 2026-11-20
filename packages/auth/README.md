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

`resolveDualAuth` authenticates keys and returns `scopes: ApiKeyScope[]`; `createRequireAuth` exposes them as `keyScopes` in the request context. Neither enforces route scopes. Each App must install a default-deny policy for API keys, explicitly declare the required scope for each allowed method and route, and enforce it alongside Organization and Role checks. The Example and Starter Apps each implement a central gate; other Apps do not inherit them. `allowsApiKeyScope(identity, requiredScope)` is an optional predicate: it permits sessions and checks exact membership for keys, but does not replace tenant or RBAC authorization.

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

## Google sign-in (opt-in)

Pass `google: { clientId, clientSecret, allowedDomains }` to `createBetterAuth`.
Use a Google OAuth **Web application** client and register
`<auth-origin>/api/auth/callback/google` as its redirect URI, where
`<auth-origin>` is the scheme and host of `BETTER_AUTH_URL`. Do not append
`/api/auth` twice if `BETTER_AUTH_URL` already includes it. The App supplies
the client credentials from secret storage and a non-empty list of DNS domains.
Domains are normalized to lowercase and matched exactly. Invalid configuration
throws at construction; omit `google` to leave the provider unconfigured.

Only existing users can sign in: the verified Google ID token must report
`email_verified: true` and an `hd` matching both the email domain and the
allowlist. Google accounts without a hosted-domain claim are refused. Google
accounts link by the same email; inactive accounts cannot open a session.
Provider tokens are discarded before account persistence and are not logged.

The App owns the sign-in button and must pass its login page as Better Auth's
`errorCallbackURL` when starting sign-in. Without it, the default is `/login`
on the first trusted origin. The redirect flow supplies `error` codes:
`unable_to_get_user_info` (invalid token or identity policy), `signup_disabled`
(no existing user), `account_inactive` (disabled or unreadable account),
and `google_email_mismatch` (a linked identity's email changed). Better Auth may
also return protocol errors such as `invalid_code` or `state_not_found`.
Direct Google ID-token sign-in and manual account linking are unsupported.

This option supplies no login UI, deployment secrets, or product domain list.

## Development

- Where to add: `src/org-roles.ts` for access roles; `src/react/` for forms; `src/repos/` for persistence.
- Test: `bun run --filter @kit/auth test`
- Typecheck: `bun run --filter @kit/auth typecheck`
