# Migrate to request authorization

Upgrade from `unkillable-kit/v0.7.x` to `v0.9.0` using the Kit authorization core in
[ADR-0026](../architecture/adr/0026-request-authorization-kit-core.md). If the Product already adopted
`v0.8.0` or `v0.8.1`, also apply [Replace the v0.8.x surface](#replace-the-v08x-surface). Keep the same
issuer and cookie configuration: existing sessions and cookies stay valid, and the cutover needs no
forced sign-in. Check schema readiness separately (see [Module facts](#enable-module-facts)).

## Replace the removed exports

Upgrade the App's `better-auth` dependency: the `@kit/auth` peer range is `^1.7.27`. See the
[auth entry points](../../../packages/auth/README.md#entry-points).

From `@kit/auth`:

- `BetterAuthLike`, `CreateBetterAuthSessionPortOpts`, `createBetterAuthSessionPort`,
  `ResolveSessionInput`, `SessionPort`, `SessionPayload`: pass the shipping issuer directly.
  On Hono use `authorization.session(c)`; for a standalone read use
  `resolveRequestSession({ db, headers, auth })` from `@kit/auth/snapshot`. It returns `null` or
  a session identity with `subject` (not `sub`), `sessionId` and `email`, not `exp`. It throws a
  `503` error when the database cannot be read, and an internal error when `auth` is not an issuer
  from the Kit factory. It does not write cookies or refresh the session.
- `createRequireAuth`, `DualAuthPorts`, `RequireAuthContext`, `resolveDualAuth`: use
  `createRequestAuthorization<AppEnv>` from `@kit/auth/hono` and mount its guards. Replace
  injected ports with the issuer and the primary D1 binding.
- `ApiKeyRecord`, `AuthMethod`, `allowsApiKeyScope`: no public lookup row. Use the admitted
  identity from `authorization.view(c)` or the `ApiKeyAuthIdentity` type, and declare route
  scopes in the `keyScope` hook.
- `clearSessionCookieHeader`, `SessionCookieOpts`, `sessionCookieWireName`: no public wire-name or
  cookie-writing replacement. Keep cookie configuration with the issuer; for sign-out use
  Better Auth `POST /api/auth/sign-out`.

From `@kit/auth/hono`:

- `createKitRequireAuth`, `KitRequireAuthContext`: use `authorization.requireAuth` and your App's
  Hono environment type.
- `createKitOrgMiddleware`, `createOrgMiddleware`, `OrgContextPorts`, `OrgMiddlewareEnv`,
  `OrgMiddlewareVariables`: use the same instance's Organization, Platform Role and Module guards.

From `@kit/auth/repos/keys`:

- `findApiKeyByPrefix`, `findActiveOrgApiKeyByPrefix`: no public prefix lookup. Kit guards
  authenticate the key.

## Compose the authorization instance

1. Create one instance per App:

   ```ts
   export const authorization = createRequestAuthorization<AppEnv>({
     db: (c) => c.env.DB, // the primary binding, never a D1 Sessions handle
     auth: (c) => c.get('betterAuth'),
     modules: true, // only with the `rbac` schema set applied
     keyScope: (route, scopes) => {
       const entry = keyScopeRoutes.find((r) => r.method === route.method && r.path === route.path)
       return Boolean(entry && scopes.includes(entry.scope))
     },
     middleware: [requestId, cors, bindPlatform], // global middleware functions, by identity
   })
   ```

   See the [Example API wiring](../../../apps/example-api/src/middleware/authorization.ts) and the
   [Starter wiring](../../../apps/starter-api/src/platform/auth.ts).
2. Remove every global admission middleware: no key gate, no Impersonation gate, no call that
   authenticates or admits before routing. Kit reads nothing until a guard or `session(c)` runs.
3. Mount the most specific guard on each protected route: `requireAuth`, `requireSession`,
   `requireOrgContext(opts)`, `requireOrgRole`, `requireOrgCapability`, `requirePlatformRole` or
   `requireModule(id, op)`. Every guard authenticates and runs the hooks itself, and `requireModule`
   also admits the Organization. Inventory every handler the removed global middleware covered and
   give each an explicit guard, or leave it public with no identity.
4. Mount `authorization.betterAuthMount` before the Better Auth handler on `/api/auth/*`. It lets
   anonymous requests through, refuses machine credentials, and applies the Impersonation fence.
5. The `keyScope` hook is synchronous and does no I/O. Without it, every API key is refused. Kit
   calls it for each terminal registration Hono matched and admits a key only when there is at
   least one and every call returns `true`. A throw or a non-boolean is a `503`. The hook receives
   the registration's method and path: Hono answers `HEAD` with a `GET` registration, so a key
   allowed to read that route may also send `HEAD`.
6. List each global `app.use` function in `middleware`; hoist inline middleware into constants
   first, and register them before any route guard. Hono reports `app.use` and `app.all` as `ALL`:
   an unidentified `ALL` registration, or an identified one matched after a Kit guard, counts as
   terminal, so a key or a hosted dispatch reaching it is refused. Never list an operation handler.
7. With Impersonation, pass `impersonation: { operation, fence, audit }`. `operation` classifies
   the request as `recovery`, `business` (Modules and `read`/`write`), `conflict` or `null`
   (unavailable during Impersonation), synchronously. `fence` reads the App's context header, and
   `audit` records each business attempt; an audit failure is a `503`. The view exposes the admitted
   delegation, so drop context variables the former gate set.

The Kit no longer plans the matched endpoint. Remove `authorization.allEndpoint`. Hono decides
overlaps and unknown addresses: an unknown address under a guarded prefix gets the guard's refusal
or the App's not-found handler, not a `503`.

## Read admitted facts and Product facts

- `authorization.view(c)` returns a frozen view of the stages admitted so far: `identity`,
  `delegation` (under Impersonation), `platformRole` and, after Organization admission,
  `organization` with its `id`, `kind`, `status`, `role`, `bypass` and `modules` map. A refused or
  pending stage is absent. The guards still set the `subject`, `sessionId`, `authMethod`,
  `keyOrganizationId`, `keyScopes`, `orgId`, `orgRole`, `orgBypass` and `platformRole` variables.
- Read Product facts with Product code in the handler, or in a step mounted after the guards it
  requires. Scope them to the admitted subject and Organization, and use at most one batch on the
  primary binding per operation. Reuse admitted facts instead of reading them again, and keep
  checks at the point of effect, including predicates inside write statements.
- A Product check only narrows Kit authority. A Module entry in the view describes access; it does
  not admit an operation by itself.

### Preserve a visibility-based write precondition

For an ordinary member session, a stale-write `409` that must precede Module refusals mounts only
`requireOrgContext()` and then, in Product code:

1. returns `404` for a Module that is absent, or disabled by the Deployment or the Organization
   (`view(c).organization.modules`);
2. computes the precondition from what the caller can currently see and compares it with the
   submitted value (`409` on mismatch, `400` when missing or malformed);
3. enforces Module access from the view (`403`) before any effect, then writes with its own
   point-of-effect predicates.

Neither the comparison nor the refusal may reveal state the caller can no longer read.

## Enable Module facts

`modules: true` makes the Kit read every Module row of the selected Organization, with
availability and the Role–module grant, in the same batch. The bound database must have the `rbac`
schema set applied; a missing table is a `503`, not an empty map. Without the option, the view
reports Module facts as `disabled` and creating `requireModule` throws when the App is built. Remove
App-supplied Module descriptors. Verify existing Organization provisioning and repair only grants
meant to exist; no read or guard restores a missing grant.

## Handle admission responses

- **`503`:** a failed or unreadable authorization load, a duplicate required row, a hook that
  cannot decide or a failed attempt audit returns a generic response without dispatching the
  handler. Treat it as service unavailability; do not clear the session.
- **`401`:** an API key is refused if its owner is inactive, is no longer a member of the key's
  Organization, or that Organization is inactive, even on routes without an Organization.
- **`400` / `403` / `404`:** a repeated or malformed `X-Org-Id` gets `400`. A valid key targeting a
  different Organization gets `403`, as does a path/header conflict or a selection that differs from
  one already seen in the request. Organization identifiers are compared exactly: the Kit no
  longer trims `X-Org-Id`, so a client must send the exact ID. For session callers without an allowed bypass, a nonmember
  gets `404` and a member of a suspended Organization gets `403`. Super-admin bypass still requires
  an active Organization, is audited and needs explicit opt-in for writes. An unavailable Module
  returns `404` even with bypass.
- A guard may receive an Organization chosen by the server through
  `requireOrgContext({ organizationId: (c) => id })`; a path or header naming another one is `403`.

## Enroll shipping Better Auth Apps in Root

1. In each shipping App's `package.json`, put `better-auth` in `dependencies` and set `kitBetterAuth`
   to the App-relative path of its sole shipping issuer module (for example `src/lib/better-auth.ts`).
   Use a named function declaration `export function createBetterAuth(env, baseURL)` whose final
   statement directly returns the single call to the named `createBetterAuth` import from
   `@kit/auth/factory` (alias the import). Do not substitute a test issuer.
2. In an enrolled App, every App-root Wrangler release target, including named environments, must
   use a relative, App-local runtime source `main` outside `dist` and `build`, without `build.command`
   or `no_bundle = true`. From each `main`, the App-local static dependency graph must reach a runtime
   call to `createBetterAuth` imported directly from the enrolled module. For each target's local
   proof, bind D1 as `DB`, provide the configured `migrations_dir` (defaults to `migrations`), and
   mount working `POST /api/auth/sign-in/email` on that issuer. An App that does not compose Better
   Auth can omit enrollment and use unbundled Workers, but release inputs must remain inspectable.
3. Align the shared Bun lockfile on one resolved `better-auth` version across workspaces, including
   nested resolutions, without editing Kit-owned files. Run `bun run validate:full`.

Root compares only the cookies the enrolled issuer emits on sign-in: each must appear once, with
the same value and attributes. An App may add its own unrelated cookies to that response; a cookie
whose name falls in an issuer cookie's family is refused.

## Update hosted MCP tools, if used

- Remove `facts`, `denyFact` and `authorization.forOrganization` from `createHostedMcpWorker`.
  Tools receive `register(server, { identity, env, dispatch })`. See the
  [hosted shell](../../../packages/mcp/README.md#hosted-shell).
- Declare each operation a tool may call on the App the shell is composed with, with
  `authorization.hosted(app, () => { /* register the route */ }, { platformRole: true })`.
  Omit `platformRole` unless the operation needs the hosted principal's Platform Role. Mount its
  Kit guards on the route as usual. A dispatch reaching an undeclared, unguarded or mis-wired route
  is refused before any handler runs.
- In each tool, map validated arguments to the declared method and path, and designate the
  Organization from the validated input or a server default: `dispatch.fetch({ method, path,
  organizationId, body })`. An Organization-free dispatch never acquires an Organization. A nonempty
  `X-Org-Id` on the outer `/mcp` request must equal the designation. Each `/mcp` request allows
  eight dispatches.
- A refused dispatch returns its Kit status; an unavailable one returns `503`. Neither revokes the
  OAuth grant. Unavailable outer admission still returns `503` without revocation
  (`temporarily_unavailable` at `/token`).

## Replace the v0.8.x surface

| Removed in `v0.9.0`                                                                                                         | Replacement                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `authenticateKey`, `admitKeyScope`, global key gate                                                                         | `keyScope` hook on the instance                                                                               |
| `delegation`, `admitFence`, `admitDelegation`, `assertDelegationModule`, `organizationSelection`, global Impersonation gate | `impersonation` hook on the instance; `view(c).delegation`                                                    |
| `allEndpoint`                                                                                                               | Remove; list global middleware in `middleware`                                                                |
| `moduleFacts` descriptors                                                                                                   | `modules: true`                                                                                               |
| `defineAuthorizationFact`, `includeFacts`, `authorization.fact`                                                             | Product query in the handler, after the guards; `view(c)` for admitted facts                                  |
| `defineAuthorizationProjection`, `moduleAuthority`, `X-Authority-Fingerprint`                                               | Product precondition after `requireOrgContext()` ([pattern](#preserve-a-visibility-based-write-precondition)) |
| hosted `facts`, `authorization.fact`, `forOrganization`                                                                     | `dispatch` capability with a designated Organization                                                          |
| hosted `denyFact`                                                                                                           | `grantAdmission`                                                                                              |

- Move a `denyFact` barrier into `grantAdmission` before upgrading, so the denial stays in force
  without a gap. `grantAdmission` runs on resource requests and code/refresh exchanges, may perform
  its own I/O, and must return `true` to allow.
- A hosted client that selected its Organization only through the outer `X-Org-Id` header must now
  designate it from tool input or a server default.
- Fingerprints issued under `v0.8.1` stop matching. A client holding one gets the Product's new
  precondition response and must read again.
