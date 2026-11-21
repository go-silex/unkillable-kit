---
title: 'ADR-0003 — Multi-tenant organization, platform RBAC, dual-level modules'
status: accepted
normative: true
date: 2026-07-17
amended: 2026-11-21
axial: false
consensus: (archived operator notes)
supersedes_notes: >
  2026-07-30: A0 = HMAC session retired (see ADR-0002 amend).
  Phase B custom roles unparked as planned ship (after A4/invites UX);
  no longer « path only / park forever ».
  2026-09-18: D4 + phasing corrected — Phase B custom roles and per-module
  grants shipped 2026-07-31 (go-silex/silex-boilerplate#22) and are the live authority read by
  mintGrantForOrg; nothing renamed.
  2026-10-06: D10 widened from the invite/accept verbs to every Better Auth
  organization route, denied by path prefix; D8 SPA row no longer relies on the
  Better Auth active organization, whose set-active route that deny covers —
  Roxabi/roxabi-boilerplate-cf#394.
  2026-11-21: body trimmed to decisions, rationale and limits; implementation detail now lives only in the cited code and tests.
  D7 amended: dropping `kit_modules` is no longer tied to the cutover; it is a separate
  contract migration once no consumer reads the table.
summary: 'Organization tenancy, platform RBAC and dual-level modules'
---

# ADR-0003 — Multi-tenant organization, platform RBAC, dual-level modules

## Context

Chemin A kit must support multi-actor SaaS on Cloudflare (Workers · Hono · D1 · Better Auth):

1. **Client space** — users only see data for their client organization(s).
2. **Back-office** — staff operate across granted clients.
3. **Platform ops** — super admin configures what exists on the platform.
4. **Modules** — features can be available platform-wide, then enabled per client.
5. **Solo vs team client** — one person _or_ many people under the same client; one data model only.

This kit is the **schema SSoT**; product apps converge here.

Session identity is covered by [ADR-0002](./0002-session-hmac-interim-vs-better-auth.md) (`SessionPort`, **Better Auth only**, dual credential cookie \| `sk_`). This ADR covers **tenancy + authorization + modules** on top of identity. Org/RBAC surfaces assume BA session (HMAC retired).

Human + multi-agent consensus (architect, security-auditor, backend-dev):  
operator analysis archive.

## Options considered

### ω1 — Better Auth organization plugin + kit authz/modules (chosen)

- **Pros:** Aligns with BA session path; org/member/invitation APIs; less custom invite/membership code.
- **Cons:** Schema coupled to BA plugin versions; module matrix stays kit-side (dual mental model).

### ω2 — Kit-only organization / member / invitation tables

- **Pros:** Full control of every column and Phase B custom roles.
- **Cons:** Reimplements invites, active-org, edge cases while already on BA for sessions.

### ω3 — Kit tables now, migrate to BA organization later

- **Pros:** Ships org FKs before BA plugin wiring.
- **Cons:** Double migration; long IDOR window; rejected by panel.

## Decision

### D1 — Tenant is always `organization`

There is no separate solo-client model: a solo client has an organization and one owner membership;
the UI may hide the organization. Multi-user clients use the same model.
Organizations have a client or internal kind and an active, suspended or archived status.

### D2 — Identity spine vs kit authz plane

Better Auth core owns identity and sessions; its organization plugin owns organizations,
memberships and invitations. It is an optional Better Auth module, not a second auth product.
The kit owns platform roles, the module catalogue, per-org enablement and role-module grants.
Org/RBAC features require a Better Auth session; machine clients use org-bound `sk_` where allowed.
There is no HMAC session path.

### D3 — System org roles (Phase A)

The hierarchy is `owner > admin > member > reader`: owner has full org control,
admin manages members and org modules and writes business data, member has standard write,
and reader is read-only. System-role seed capabilities are defaults; current authorization
resolves per-organization role-module grants. The server rejects unconfigured role strings.

### D4 — Phase B custom roles (shipped 2026-07-31; status corrected 2026-09-18)

Custom roles and fine-grained grants are per organization, and are the live authority read
before a flows run is minted. There are no live shared platform templates with a null
organization; future templates are copy-on-create blueprints, not shared grant rows.
System roles remain system roles with seeded defaults. The `flows` seed intentionally grants
write to owner and admin, and disables member and reader; other modules follow the system seed.
Custom keys map through the membership role field; fine grants resolve kit-side, not solely
through Better Auth static access control.

Implementation: `apps/example-api/src/services/org-roles.ts`.

### D5 — Platform roles

Super admins configure the platform catalogue and global configuration, and may receive
explicit cross-org support flags. Staff access the back-office shell but tenant data only
through memberships; an absent platform role conveys no platform privilege.
Platform roles are kit-owned, not client-writable Better Auth user fields.
Org admins cannot set platform roles or platform module availability.

### D6 — Staff access = membership only

No parallel `org_grants` table: staff working on a client have a normal membership there.
The staff platform role opens the back-office UI and listing of their memberships, not all orgs.
Without membership, tenant access returns 404.

### D7 — Modules: two levels

The app owns the module registry; product domain strings do not belong in packages.
Super admins control platform availability and global configuration, masked on read.
Org admins or back-office users with `manage_modules` control per-org enablement only when
the module is available. The org-level lock is server-enforced when exposed by the API/UX.
End users consume effective modules according to their role grants.

**Effective access (normative):**

```text
can(user, org, module, op) =
  org.status = active
  AND membership active (or route-level super_admin flag)
  AND platform_modules.available
  AND organization_modules.enabled
  AND role_grant(role_key, module, op)   -- per-org role-module grants
  AND (op ≠ write OR grant allows write)
```

`kit_modules` was migrated to `platform_modules` (`enabled` → `available`) by the `core` catalog id `rbac_modules`. No Kit App writes or reads it.
The table stays: consumer code may still read it through `@kit/auth/repos/modules`, and a D1 drop is irreversible.
Dropping it is a separate contract migration (`-- kit:contract released=`, CP-MIGRATION-CONTRACT) with its own issue, once no consumer reads it.

Implementation: `apps/example-api/src/services/modules.ts` and `apps/example-api/src/services/org-roles.ts`.

### D8 — Org context on requests

The SPA keeps its selected org client-side. Authorization prefers an explicit org id in the
path, otherwise a validated `X-Org-Id` header; there is no Better Auth active-org fallback.
The Better Auth `set-active` route is denied along with the other organization routes (D10).
A mismatch is 403, never a silent wrong-tenant write. Every tenant data query is scoped to
the organization and fails closed.

**Kennel exemption (M-10):** Dogfood `demo_items` / `demo_notes` / demo uploads are
**subject-owned**. They MUST NOT take an `organization_id` column or `requireOrgContext` —
org-gating writes while listing by subject was the D11 hole. Tenant tables (orgs, tasks,
flows, comments) stay on D8. The `demo` module id stays in the catalogue/seed; it is
**not** items authorization.

Implementation: `packages/auth/src/hono.ts`.

### D9 — Super_admin support semantics

Cross-org support reads require an explicit per-guard super-admin opt-in and audit
(actor, org, action, requestId). Writes default off and are break-glass only on named
routes with explicit write opt-in and audit. Staff never bypass membership.
Support may diagnose with read; write is rare and explicit.

Implementation: `packages/auth/src/hono.ts`.

### D10 — Invitations (kit product APIs — B3 S2)

Kit-owned invite APIs write Better Auth invitation rows. Every Better Auth organization
route is denied before throttle or handler, including future routes under the prefix:
those routes skip the kit's role ceiling, org-status check and audit, so kit organization
APIs replace them. See the [Better Auth mount contract](../../product-consumer-contract.md#better-auth-mount).

Invites cannot grant owner or platform roles: owners may assign admin, member or reader;
admins may assign member or reader only.
Acceptance is email-bound, invitations are single-use with a seven-day TTL, and mutations
require sessions rather than `sk_`. Cross-tenant deletion returns 404, create/accept are
rate-limited, and an email send failure cancels the invitation and returns an error.

Implementation: `packages/auth/src/policy/better-auth-handler.ts` and
`apps/example-api/src/invitations.test.ts`.

### D11 — API keys (machine / MCP)

Session and Bearer `sk_` remain dual credentials (ADR-0002). Multi-tenant keys are bound
to one organization, with optional scopes; membership and active organization are rechecked
on every use. Subject-global multi-org keys are forbidden. Minting requires a session, not
another key without explicit policy.

**Kennel exemption (M-10):** tenant routes stay org-bound (a key minted for org A cannot
call `/api/orgs/{B}/...`). Kennel rows have no `organization_id`; the key authenticates
the subject and sees that subject's personal items/notes/uploads. That is not a multi-org key.

Implementation: `packages/auth/src/repos/keys.ts`.

### D12 — Guards (compose, fail-closed)

Compose identity, platform-role, organization-context, org-role and module guards.
Protected by default; public routes explicit. Prefer **404** on cross-tenant resource IDOR;
**403** on authenticated “not allowed” management actions.

Implementation: `packages/auth/src/hono.ts`; IDOR coverage: `apps/example-api/src/org-rbac.test.ts`.

### D13 — Package placement (ADR-0001)

Shared auth owns Better Auth org SQL composition, role constants, pure hierarchy helpers and
thin guard factories with injected ports, not product module IDs. Example apps own wiring,
routes, persona seed, module registry and integration tests. **No** empty `@kit/rbac` or
`@kit/tenancy` package in Phase A (promote only at two call sites or superseding ADR).

### D14 — Seed acceptance (kit demo)

The demo covers super admin, staff with multiple memberships, solo owner, team owner and
team reader, with modules enabled for one org and disabled for another.
IDOR / cross-role tests are a **quality gate** for tenant routes (see
`docs/kit/testing/critical-path.md` CP-IDOR extensions).

Implementation: `apps/example-api/src/seed/tenancy-data.ts` and `apps/example-api/src/org-rbac.test.ts`.

### D15 — Session-bound Impersonation

Impersonation is a separate, default-deny delegation, not the support bypass in D9.
A `super_admin` configures independent `read` and `write` permissions for each internal
Platform Role. Both the real operator and represented User must be members of the same
active Organization, including when the operator is a `super_admin`. Represented Users
cannot hold a Platform Role; self-delegation and chains are refused.

The verified Better Auth session remains the operator's session. A server-owned row pins its
session id, real actor, represented User, Organization and mode; it issues no target session
or credential. There is no additional duration limit or reauthentication step. Better Auth
validity and live membership, Platform Role, delegation permission and target Module grants
remain authoritative on every request.

The Example App admits explicit Organization-scoped business operations only. Target guards
still apply, with no operator privilege union or Organization bypass. Delegated reads do not
initialize business rows. Account/security changes, invitations, API keys, MCP/OAuth,
durable flow operations and personal subject-owned routes are refused, including effectful GET endpoints.

Clients send the exact public delegation id in `X-Impersonation-Id`, or `none` outside
Impersonation. This is a context fence, never a credential: stale or missing context cannot
silently execute as another principal, including through Bearer fallback after session loss.
`/api/me` is a recovery read and stop uses the real session. Revoked delegation authority
leaves a recovery-only identity with `active: false`, no target profile or memberships,
and no business access until explicit return.

Start and permission changes commit with their audit event atomically. Each admitted business
request first persists an attributed **attempt**, not a claim of a successful committed
mutation; failed trace persistence prevents dispatch. Stop conditionally deletes the expected
delegation independently of its best-effort audit. Previously admitted work can finish under
its captured identity; stopping does not promise rollback.

All tabs sharing the session use one represented User, a persistent actor/target banner and
explicit return, with principal-cache invalidation. V1 has no consent request, consent
configuration or status, target notification, delegation expiry, or step-up. Storage and
repositories are exported by `@kit/auth`; App-owned routing and operation policy compose them.
The additive `impersonation` core schema id is applied through the normal consumer schema-sync contract.

Implementation: `apps/example-api/src/middleware/impersonation.ts`.

## Consequences

One tenant model serves solo and multi-user clients; custom roles do not require a second
tenant system. The split reduces silent cross-tenant blast radius, but couples the kit to
Better Auth organization schema and migrations. Membership roles and kit module grants
remain two stores to reason about; custom roles increase authorization complexity and the
IDOR matrix must grow with them. Product apps define their own role vocabulary.

## Anti-patterns

- A solo-user client table that bypasses organizations, or platform roles set through
  invites, signup bodies or org-admin APIs.
- Staff acting across orgs without membership, or a default super-admin write-all bypass.
- Subject-global multi-org keys or mutations authorized by the BA active-org cookie alone.
- Module enablement only in BA static access control, without platform and org enablement.
- An empty RBAC package for later, or copying share-frame ACL/GitHub org rechecks as the tenancy spine.

## Related

- [ADR-0001](./0001-primary-axis-packages-compose-apps.md) — packages compose apps
- [ADR-0002](./0002-session-hmac-interim-vs-better-auth.md) — BA-only session + `sk_` dual-path
