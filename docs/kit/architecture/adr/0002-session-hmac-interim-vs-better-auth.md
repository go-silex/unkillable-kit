---
title: 'ADR-0002 — SessionPort: Better Auth only + Bearer sk_ dual-path'
status: accepted
normative: true
date: 2026-07-12
amended: 2026-11-09
axial: false
supersedes_notes: >
  2026-07-15: Better Auth first-class via AUTH_SESSION_ADAPTER.
  2026-07-30: HMAC session path retired — no upstream product consumers;
  kit dogfood and all new products use Better Auth only for browser sessions.
  Bearer sk_ dual-path unchanged.
  2026-08-09: D6 added — constant-time comparison made explicit for the sk_ verify
  path (was implemented but unstated, so nothing owned the rule).
  2026-08-23: D6 non-goal — lookup-path timing is not claimed (Roxabi/roxabi-boilerplate-cf#52).
  2026-09-16: third client class (remote MCP Worker token) lives in ADR-0015;
  this ADR is not reopened and HMAC stays retired.
  2026-10-06: recipe steps 2 and 6, the D1 login-surface row and the D5 mounted
  row defer to the Better Auth mount contract in product-consumer-contract.md,
  which owns the schema sets and the mount order (organization deny, kit
  throttle, handler) — Roxabi/roxabi-boilerplate-cf#394.
  2026-11-09: verification identifiers, password-reset session revocation and
  the retained magic-link GET residual — Roxabi/roxabi-boilerplate-cf#395.
related:
  - docs/kit/architecture/adr/0003-multi-tenant-rbac-modules.md
  - docs/kit/architecture/adr/0015-mcp-remote-oauth-worker.md
  - GitHub epic go-silex/silex-boilerplate#14 (B2 HMAC cut)
summary: 'Better Auth browser sessions + Bearer `sk_` dual path'
---

# ADR-0002 — SessionPort: Better Auth only + Bearer `sk_` dual-path

## Context

Chemin A kit needs dual **client** auth for demos and products:

1. **Browser SPA** — HttpOnly cookie + `credentials: 'include'`
2. **Machine / MCP** — Bearer `sk_` (hashed at rest)

HMAC-signed cookies shipped first as a Workers-native interim. Issue go-silex/silex-boilerplate#5 landed Better Auth behind `SessionPort` with an adapter switch (`hmac` | `better-auth`). Multi-tenant org/RBAC/modules (ADR-0003) **require** Better Auth.

**2026-07-30:** No product repo consumes this kit as `upstream` yet. Maintaining a dual session stack (HMAC + BA) is pure cost: wrong defaults, dual seeds, dual login surfaces, and false dogfood. **HMAC session path is retired.**

## Decision

### D1 — Browser session = Better Auth only

| Layer         | Kit (normative)                                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session       | `createBetterAuthSessionPort` + per-request `betterAuth` instance                                                                                                      |
| Cookie        | `kit_session` (overridable via `SESSION_COOKIE_NAME`) · HttpOnly · SameSite=Lax · Secure when not local                                                                |
| Login surface | BA handler on `/api/auth/*`, mounted per the [Better Auth mount contract](../../product-consumer-contract.md#better-auth-mount) (email/password; OAuth optional later) |
| API keys      | SHA-256 `sk_` via `hashApiKey` — **unchanged**                                                                                                                         |
| FE contract   | `credentials: 'include'` + error envelope — **unchanged**                                                                                                              |

**Stable FE/API contract:**

- Session auth via cookie (not localStorage token)
- Machine auth via `Authorization: Bearer sk_…`
- Error body `{ error: { code, message, details? }, requestId }`
- Dual-path credential: **Bearer preferred when both present** (session cookie + `sk_`)

### D2 — HMAC retired

| Removed / forbidden                 | Notes                                       |
| ----------------------------------- | ------------------------------------------- |
| `AUTH_SESSION_ADAPTER=hmac`         | Delete switch; do not document as supported |
| `createHmacSessionPort` as kit path | Not part of the public package API          |
| Demo PBKDF2 `POST /api/auth/login`  | Replaced by BA sign-in                      |
| Unset adapter → hmac                | N/A — no adapter enum for session stack     |

### D3 — SessionPort (normative)

Live surface (BA-only — HMAC `sign` / `verify` / `secret` **removed** from the port):

```ts
type SessionPort = {
  resolveSession({ cookieHeader?, headers? }): Promise<SessionPayload | null>
  clearCookieHeader(opts?): string
}
```

BA implements `auth.api.getSession({ headers })` inside `createBetterAuthSessionPort`.  
Cookie **issuance** is the BA HTTP handler. The port only **resolves** and **clears**.  
`originGuard` / `createBetterAuthSessionPort({ cookieName })` use **cookie name SSoT** (`sessionCookieName` / `SESSION_COOKIE_NAME`) — never hardcode.

The resolved `SessionPayload` also carries the verified Better Auth `sessionId` (never the cookie token). Impersonation binds to that record without minting a target session; its authority is defined by [ADR-0003 D15](./0003-multi-tenant-rbac-modules.md#d15--session-bound-impersonation). Custom port fixtures must preserve this provenance; cookie issuance and the session owner do not change.

`SessionPort` remains the boundary so products do not fork session parsing — it is **not** a multi-adapter plug forever.

### D4 — Secrets / fail-closed

- `BETTER_AUTH_SECRET` required (min length enforced) outside pure unit mocks
- `BETTER_AUTH_URL` required outside `development` \| `test` (or derived base URL rules documented in app)
- **No inference** of auth mode from secret presence
- Kit placeholder secrets forbidden when `ENVIRONMENT` is `staging` \| `production`

### D5 — Mount

| Mounted                                                                 | Not mounted              |
| ----------------------------------------------------------------------- | ------------------------ |
| BA `handler` on `/api/auth/*`, after organization deny and kit throttle | HMAC login/logout routes |

Mounting requires the catalog's `core` and `audit` sets; `audit` provides `rate_limit_buckets`. On the raw pathname, reject every Better Auth organization route with 404, then call `throttleBetterAuthRequest`, then the handler. Pass the raw request, `clientIp` unchanged, and a callback retrieving the verified Better Auth session id with refresh disabled. Never route caller input directly to `auth.api.*` or `auth.fetch` to bypass the throttle. Better Auth's own limiter is disabled by the kit factory; missing the kit throttle leaves the mount unthrottled.

### D6 — Credential comparison (normative)

Added 2026-08-09. The behaviour predates this section; the rule was implemented in
`@kit/auth` but stated nowhere, so no review or tool could own it.

- **Constant-time only.** Any comparison of a secret or of a digest derived from a secret goes
  through `timingSafeEqualHex`. Never `===` / `==` / `!==` on a digest — it leaks length and
  prefix through timing.
- Applies to the `sk_` verify path (`verifyApiKey`). Password verification is
  Better Auth crypto — kit does not compare password hashes.
- **Workers-safe:** no `node:crypto`; `timingSafeEqualHex` compares fixed-length hex via
  byte-wise XOR accumulation.
- Length mismatch returns `false` **before** the byte loop — an accepted, documented leak of
  digest _length_ only, which is a constant for a given algorithm.

- **Non-goal — lookup-path timing.** D6 governs the comparison primitive only. The credential
  _lookup_ path is not constant-time and is not claimed to be: after the prefix lookup, 0 to 2
  further D1 queries run depending on the record's shape (unknown prefix / no org / inactive org
  / no membership / org-bound). Reviews must not read D6 as a lookup-path guarantee. If a lookup
  ever distinguishes something an attacker does _not_ already possess, that is a finding to fix
  at the call site — not a reason to add a ceiling nobody can hold.

### D7 — Third client class (remote MCP) is ADR-0015

Browser cookie and Bearer `sk_` are unchanged. Remote agents store a **Worker-issued MCP access token** ([ADR-0015](./0015-mcp-remote-oauth-worker.md)). This section does not authorize HMAC revival, token passthrough, or using `sk_` as MCP OAuth.

### D8 — Verification credentials and magic-link GET

The factory hashes every Better Auth verification identifier with SHA-256 over UTF-8,
encoded base64url without padding. Kit-owned password-setting mints use the same
`resetPasswordIdentifier` helper; the email carries the raw token rather than
the stored identifier. This unsalted digest is intended for high-entropy tokens,
not low-entropy secrets.
The magic-link plugin leaves `storeToken` unset: the global verification layer
already hashes its identifier, and enabling both would double-hash. Password
reset revokes all sessions, including sessions on other devices. Better Auth
origin checks are explicitly enabled in production and tests.

**Decision:** retain `GET /magic-link/verify`, accepting the login-CSRF residual
in Roxabi/roxabi-boilerplate-cf#395. Better Auth checks callback URLs against
trusted origins (relative URLs are allowed), but its cross-site Fetch-Metadata
navigation gate applies to the magic-link request POST, not verification. An
attacker who owns an account and obtains its link can induce a victim to navigate
to it within the default five-minute TTL, signing the victim into the attacker's
account. Single-use consumption, default-disabled public signup and the kit
throttle limit the attack; they do not prevent it. SameSite=Lax does not prevent
the top-level navigation. Subsequent victim actions or sensitive input may be
visible in the attacker's account. A same-origin POST confirmation interstitial
would change the email and user experience and diverge from the plugin; the kit
accepts the residual rather than imposing that change. Revisit if sensitive
pre-login or wrong-account input is collected, magic link becomes the primary
login, or mail-scanner prefetch consumes links before users.

**Migration:** no schema change or deletion is required. In Better Auth 1.7.14,
hashed lookup falls back to the supplied plain identifier: pre-hash reset rows
and magic-link rows using the current `magic-link:<token>` identifier and typed
payload can therefore be found until expiry. Historical 1.7.6 magic-link rows
used a bare token and older payload; Better Auth 1.7.14 rejects those links
because its lookup is prefixed and its payload typed. This incompatibility
predates the hashing change and was already present with 1.7.14; request a new
link. Existing plain rows remain readable until expiry; no destructive cleanup
is performed. Targeted behavioral tests exercise both formats; they do not
prove a deployment.

## Consequences

### Positive

- One session story for docs, seed, e2e, multi-tenant dogfood.
- ADR-0003 org/RBAC always available on the kit path.
- Products clone → BA without choosing an adapter.

### Negative / accepted debt

- Breaking change for any **future** consumer that expected HMAC (none today).
- OAuth GitHub / social still **optional later** (not part of this ADR cut).
- Password reset / invites depend on email transport (CF Email epic) for real UX.

### Product inject recipe (updated)

1. Depend on `@kit/auth` + peer `better-auth` (peer required on the Worker that mounts BA).
2. Apply BA migrations via `kit-schema-sync` with the sets the [Better Auth mount contract](../../product-consumer-contract.md#better-auth-mount) names. Tables: `@kit/auth/schema`.
3. Set `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, and `CORS_ORIGINS` (required outside `development|test`). Cookie name optional. **No** `AUTH_SESSION_ADAPTER`.
4. Per-request: `createBetterAuth({ database, secret: getBetterAuthSecret(env), baseURL, emailPort?, emailConfig?, … })` from `@kit/auth/factory`. When supplying `emailPort`, also supply `emailConfig: { productName, fallbackLocale, resolveRecipientLocale }`. Env helpers from `@kit/auth`. Do **not** copy `example-api/src/lib/better-auth.ts` as the factory (it is only the Env mapping example).
5. `createBetterAuthSessionPort({ getAuth: () => c.get('betterAuth'), cookieName })` into `createRequireAuth`.
6. Mount Better Auth on `/api/auth/*` per the [Better Auth mount contract](../../product-consumer-contract.md#better-auth-mount).
7. Keep `findApiKeyByPrefix` for `sk_` dual-path.
8. Optional `onFirstSession` → product `tryFirstLogin`. It writes `audit_events`, which ships in the `audit` set that step 2 already syncs.

## Anti-patterns

- Reintroducing HMAC “just for demos”
- Dual login stacks (BA + custom password routes)
- Storing session tokens in SPA localStorage
- Inferring auth from secrets
- Hardcoding cookie name outside SSoT helper
- Forking session crypto per app instead of `SessionPort`
- Using `hashApiKey` for user passwords
- Claiming “full BA” while leaving HMAC in Quick Start
- Reading D6 as a lookup-path constant-time guarantee
- Treating a Better Auth cookie or `sk_` as the hosted MCP Bearer (ADR-0015)

## Related

- [ADR-0001](./0001-primary-axis-packages-compose-apps.md) — packages compose apps
- [ADR-0003](./0003-multi-tenant-rbac-modules.md) — multi-tenant (BA org spine)
- [ADR-0015](./0015-mcp-remote-oauth-worker.md) — hosted Streamable HTTP + Worker MCP OAuth
- `packages/auth/src/session-port.ts`, `better-auth-port.ts`, `require-auth.ts`, `cookie-name.ts`
- `apps/example-api/src/middleware/require-auth.ts` — `findKeyRecord` (lookup path; not D6)
- GitHub epic **go-silex/silex-boilerplate#14** (B2 HMAC cut / BA-only) · historical go-silex/silex-boilerplate#5 Better Auth dual-path land · Roxabi/roxabi-boilerplate-cf#52
