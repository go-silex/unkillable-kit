---
title: 'ADR-0002 — SessionPort: Better Auth only + Bearer sk_ dual-path'
status: accepted
normative: true
date: 2026-07-12
amended: 2026-11-21
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
  2026-11-21: body trimmed to decisions, rationale and limits; implementation detail now lives only in the cited code and tests. No decision changed.
related:
  - docs/kit/architecture/adr/0003-multi-tenant-rbac-modules.md
  - docs/kit/architecture/adr/0015-mcp-remote-oauth-worker.md
  - GitHub epic go-silex/silex-boilerplate#14 (B2 HMAC cut)
summary: 'Better Auth browser sessions + Bearer `sk_` dual path'
---

# ADR-0002 — SessionPort: Better Auth only + Bearer `sk_` dual-path

## Context

Chemin A needs browser sessions and machine credentials. Multi-tenant
organization, RBAC and modules require Better Auth; maintaining a second
session stack adds cost, wrong defaults and divergent login surfaces.

## Decision

### D1 — Browser session = Better Auth only

Browser sessions use Better Auth cookies, not SPA localStorage tokens;
machine authentication uses Bearer `sk_` credentials hashed at rest.
The frontend sends credentials with requests and retains the existing error envelope.

- Dual-path credential: **Bearer preferred when both present** (session cookie + `sk_`)

Implementation: `packages/auth/src/require-auth.ts` and
`packages/auth/src/better-auth-factory.ts`.

### D2 — HMAC retired

HMAC was retired on 2026-07-30 and must not be revived.

### D3 — SessionPort (normative)

Better Auth issues cookies; `SessionPort` only resolves and clears them.
Cookie naming uses the shared source of truth, never a hardcoded name.

The resolved `SessionPayload` also carries the verified Better Auth `sessionId` (never the cookie token). Impersonation binds to that record without minting a target session; its authority is defined by [ADR-0003 D15](./0003-multi-tenant-rbac-modules.md#d15--session-bound-impersonation). Custom port fixtures must preserve this provenance; cookie issuance and the session owner do not change.

`SessionPort` remains the boundary so products do not fork session parsing — it is **not** a multi-adapter plug forever.

Implementation: `packages/auth/src/better-auth-port.ts`.

### D4 — Secrets / fail-closed

- `BETTER_AUTH_SECRET` required (min length enforced) outside pure unit mocks
- `BETTER_AUTH_URL` required outside `development` \| `test` (or derived base URL rules documented in app)
- **No inference** of auth mode from secret presence
- Kit placeholder secrets forbidden when `ENVIRONMENT` is `staging` \| `production`

Implementation: `packages/auth/src/better-auth-env.ts`.

### D5 — Mount

Products must follow the [Better Auth mount contract](../../product-consumer-contract.md#better-auth-mount).
Never route caller input directly to `auth.api.*` or `auth.fetch` to bypass
the throttle. Better Auth's own limiter is disabled by the kit factory;
missing the kit throttle leaves the mount unthrottled.

Implementation: `packages/auth/src/policy/better-auth-handler.ts`.

### D6 — Credential comparison (normative)

Any comparison of a secret or a digest derived from one must use
`timingSafeEqualHex`, never ordinary equality on a digest. This applies to
`sk_` verification; password verification belongs to Better Auth crypto.
The Workers-safe comparison is constant-time for fixed-length hex digests.
Length mismatch returns false before the byte loop: digest length is an
accepted leak, constant for a given algorithm.

**Non-goal — lookup-path timing.** D6 governs the comparison primitive only.
The credential lookup path is not constant-time and is not claimed to be.
If a lookup distinguishes something an attacker does not already possess,
fix it at the call site rather than claiming a timing ceiling.

Implementation: `packages/auth/src/keys.ts`.

### D7 — Third client class (remote MCP) is ADR-0015

Browser cookie and Bearer `sk_` are unchanged. Remote agents store a **Worker-issued MCP access token** ([ADR-0015](./0015-mcp-remote-oauth-worker.md)). This section does not authorize HMAC revival, token passthrough, or using `sk_` as MCP OAuth.

### D8 — Verification credentials and magic-link GET

Verification identifiers use an unsalted digest suitable for high-entropy
tokens, not low-entropy secrets. Password reset revokes all sessions, including
sessions on other devices. Better Auth origin checks are enabled in production
and tests.

Implementation: `packages/auth/src/better-auth-factory.ts` and
`packages/auth/src/verification-identifier.ts`.

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

Existing plain verification rows remain readable until expiry; no destructive
cleanup is performed. Historical Better Auth 1.7.6 magic-link rows are
incompatible with 1.7.14 independently of the hashing change: request a new
link. Behavioral tests do not prove a deployment.

## Consequences

### Positive

- One session story for docs, seed, e2e and multi-tenant dogfood.
- ADR-0003 org/RBAC is available without choosing an adapter.

### Negative / accepted debt

- OAuth GitHub / social remains optional and outside this decision.
- Password reset and invites depend on email transport for real UX.

### Product inject recipe (updated)

See the [Better Auth mount contract](../../product-consumer-contract.md#better-auth-mount).

## Anti-patterns

- Reintroducing HMAC or a second custom password login stack.
- Storing session tokens in SPA localStorage or forking session crypto per app.
- Inferring auth from secrets or hardcoding the cookie name outside its shared helper.
- Using `hashApiKey` for user passwords.
- Claiming lookup-path constant-time behavior or treating a Better Auth cookie
  or `sk_` as the hosted MCP Bearer (ADR-0015).

## Related

- [ADR-0001](./0001-primary-axis-packages-compose-apps.md) — packages compose apps
- [ADR-0003](./0003-multi-tenant-rbac-modules.md) — multi-tenant (BA org spine)
- [ADR-0015](./0015-mcp-remote-oauth-worker.md) — hosted Streamable HTTP + Worker MCP OAuth
- GitHub epic **go-silex/silex-boilerplate#14** (B2 HMAC cut / BA-only) · historical go-silex/silex-boilerplate#5 Better Auth dual-path land · Roxabi/roxabi-boilerplate-cf#52
