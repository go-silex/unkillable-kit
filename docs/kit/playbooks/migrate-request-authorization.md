# Migrate to request authorization

Upgrade from `unkillable-kit/v0.7.0` to `v0.8.0` using the request snapshot in
[ADR-0025](../architecture/adr/0025-request-authorization-snapshot.md). Keep the same issuer and
cookie configuration: the cutover itself requires no forced sign-in or D1 schema change.

## Replace the removed exports

Upgrade the App's `better-auth` dependency: the `@kit/auth` peer range changed from `>=1.2.0`
to `^1.7.27`. The new `@kit/auth/snapshot` entry point provides standalone read-only session
resolution and authorization facts. See the [auth entry points](../../../packages/auth/README.md#entry-points).

From `@kit/auth`:

- `BetterAuthLike`, `CreateBetterAuthSessionPortOpts`, `createBetterAuthSessionPort`,
  `ResolveSessionInput`, `SessionPort`, `SessionPayload`: pass the shipping issuer directly.
  On Hono use `authorization.session(c)`; for a standalone read use
  `resolveRequestSession({ db, headers, auth })` from `@kit/auth/snapshot`. It returns `null` or
  a session identity with `subject` (not `sub`), `sessionId` and `email`, not `exp`. It does not
  write cookies or refresh the session.
- `createRequireAuth`, `DualAuthPorts`, `RequireAuthContext`, `resolveDualAuth`: use
  `createRequestAuthorization<AppEnv>` from `@kit/auth/hono` and mount `authorization.requireAuth`.
  Replace injected ports with the issuer and primary D1 binding.
- `ApiKeyRecord`: no public lookup row replacement. Use the verified identity from
  `authorization.authenticateKey(c)` or the `ApiKeyAuthIdentity` type, not a row with a stored hash.
- `AuthMethod`, `allowsApiKeyScope`: use `AuthIdentity['method']` for the method type. Check the
  authenticated key's `scopes` against the route's required scope, then call `admitKeyScope`.
- `clearSessionCookieHeader`, `SessionCookieOpts`, `sessionCookieWireName`: no public wire-name or
  cookie-writing replacement. Keep cookie configuration with the issuer; for sign-out use
  Better Auth `POST /api/auth/sign-out`.

From `@kit/auth/hono`:

- `createKitRequireAuth`, `KitRequireAuthContext`: use `authorization.requireAuth` and your App's
  Hono environment type.
- `createKitOrgMiddleware`, `createOrgMiddleware`, `OrgContextPorts`, `OrgMiddlewareEnv`,
  `OrgMiddlewareVariables`: use the same authorization instance's Organization, Platform Role and
  Module guards. Use your App's Hono environment and variables and supply Module policy through
  `moduleFacts`, not callback ports.

From `@kit/auth/repos/keys`:

- `findApiKeyByPrefix`, `findActiveOrgApiKeyByPrefix`: use `authorization.authenticateKey(c)` for
  request authentication; there is no public prefix lookup replacement.

No public `@kit/mcp` or `@kit/mcp/hosted` exports were removed.

## Wire the matched endpoint

1. Create one authorization instance per App with `db` returning the primary D1 binding and
   `auth` supplying the shipping Better Auth issuer. Keep the Kit Better Auth account guard
   (`createBetterAuthHandler`) on `/api/auth/*`; keep session lifecycle writes with Better Auth.
2. Mount the instance's Organization and Module guards and `includeFacts(...)` middleware directly,
   not inside wrappers. Kit plans the matched endpoint before its first read. On a guarded terminal
   `app.all(...)`, register `authorization.allEndpoint` before the guards; never mount the marker
   with `app.use(...)`. An Organization-dependent route without a resolvable endpoint (such as an
   unmarked `app.all`) returns `503`. Remove ambiguous overlapping parameterized endpoints; Kit
   returns `503` for competing parameter patterns instead of loading either plan.
3. For a parsed Bearer, call `authenticateKey(c)`, enforce a default-deny route scope allowlist,
   then call `admitKeyScope(c)` before `requireAuth`. Use the path `orgId` or `X-Org-Id` for tenant
   selection; if both are present they must agree. See [API key scopes](../../../packages/auth/README.md#api-key-scopes).
4. Declare scoped, read-only Product projections with `defineAuthorizationFact`; register them
   with `includeFacts` and read them with `authorization.fact(c, descriptor)` after guards pass.
   Keep policy and I/O out of decoders. Supply separate Module availability and role-grant facts.
   Verify existing Organization provisioning and repair only grants meant to exist. Role reads,
   admin validation and Capability Grant minting no longer restore missing grants.

## Handle admission responses

- **`503`:** A failed or unreadable required authorization load returns a generic response without
  dispatching the guarded handler. Treat it as service unavailability, not bad credentials; do not
  clear the session. For example, unreadable account state on guarded `/api/me` now returns `503`
  instead of `401`.
- **`401`:** Reject an API key if its owner is inactive, is no longer a member of the key's
  Organization, or that Organization is inactive, even on non-tenant routes. The standard Kit
  guard already enforced all three in `v0.7.0`; now Kit also enforces them for Products migrating
  from custom key lookup ports. See [account state](../../../packages/auth/README.md#account-state).
- **`403` / `404`:** A valid, scope-admitted key targeting a different Organization gets `403`,
  as does a path/header conflict. For session callers without an allowed bypass, a nonmember gets
  `404` whether the Organization exists or not, and a member of a suspended Organization gets
  `403`. Super-admin bypass still requires an active Organization, is audited and needs explicit
  opt-in for writes. An unavailable Module returns `404` even with super-admin bypass.

## Enroll shipping Better Auth Apps in Root

1. In each shipping App's `package.json`, put `better-auth` in `dependencies` and set `kitBetterAuth`
   to the App-relative path of its sole shipping issuer module (for example `src/lib/better-auth.ts`).
   Use a named function declaration `export function createBetterAuth(env, baseURL)` whose final
   statement directly returns the single call to the named `createBetterAuth` import from
   `@kit/auth/factory` (alias the import). Do not substitute a test issuer.
2. For each App-root Wrangler release target, including named environments, use a relative,
   App-local runtime source `main` outside `dist` and `build`. Do not set `build.command` or
   `no_bundle = true` on enrolled targets. The Worker must reach a runtime call to the adapter
   imported directly from the enrolled module. For Root's local proof, bind D1 as `DB`, provide
   the configured `migrations_dir` (defaults to `migrations`), and mount working
   `POST /api/auth/sign-in/email` on that issuer. Workers that do not compose Better Auth need no
   enrollment (and can be unbundled), but their Wrangler release inputs must remain inspectable.
3. Align the shared Bun lockfile on one resolved `better-auth` version across workspaces, including
   nested resolutions, without editing Kit-owned files. Run `bun run validate:full`.

## Update hosted MCP tools, if used

- On `/mcp`, the shell selects the optional `X-Org-Id` before it loads authorization. In each
  Organization-scoped tool, call `authorization.forOrganization(validatedOperationOrgId)` and
  refuse `null` (missing or mismatched selection, inactive Organization or no membership). Then
  apply the tool's policy before reading scoped facts or dispatching. The header itself grants
  no access. Organization-free tools such as `whoami` need no header.
- Pass `denyFact` for deny-only policy on the same D1 binding: use a `hosted-grant` descriptor
  whose matching row signals denial. Keep `grantAdmission` for additional policy outside that
  binding. This applies to request admission and code/refresh exchange.
- On unavailable admission, expect `503` without revocation (`temporarily_unavailable` at
  `/token`). Clients should rely on HTTP status and the OAuth error code where present, not the
  error description. See [hosted shell](../../../packages/mcp/README.md#hosted-shell).
