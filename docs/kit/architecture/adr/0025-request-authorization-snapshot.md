---
title: 'ADR-0025 — Load authentication and authorization facts once per request'
status: accepted
normative: true
date: 2026-11-24
amended: 2026-11-25
supersedes_notes: >
  2026-11-25: D3 adds an opt-in hosted MCP mode where validated tool input
  designates the Organization, with one bounded D1 read per scoped dispatch
  (go-silex/unkillable-kit#181). Header selection stays the default, unchanged.
axial: false
related:
  - docs/kit/architecture/adr/0002-session-hmac-interim-vs-better-auth.md
  - docs/kit/architecture/adr/0003-multi-tenant-rbac-modules.md
  - docs/kit/architecture/adr/0005-flows-platform-agentic-workflows.md
  - docs/kit/architecture/adr/0012-kernel-persistence-request-context.md
  - docs/kit/architecture/adr/0015-mcp-remote-oauth-worker.md
  - docs/kit/architecture/adr/0024-root-single-quality-gate.md
  - 'go-silex/unkillable-kit#162'
summary: 'One authorization snapshot per request; one D1 batch for its facts'
---

# ADR-0025 — Load authentication and authorization facts once per request

## Context

Each guard can repeat a D1 read made by another guard on the same request. `getSession` can read the session and User after its account guard already read both. API-key scope and route guards can both resolve the key. Organization and Module guards then use separate ports, and Products needing another fact add another read. A join in one repository cannot remove round trips between those ports.

Baseline at `9f2b53b` (`unkillable-kit/v0.7.0`): the [round-trip suites](../../testing.md#d1-round-trip-ceilings) from
go-silex/unkillable-kit#160 passed 59 tests. The table records local test binding calls for the complete request
after setup, not production latency and not values inferred from ceilings.

| Request                                              | Session | Organization-bound API key |
| ---------------------------------------------------- | ------: | -------------------------: |
| Example `GET /api/me`                                |      13 |                         11 |
| Example `GET /api/orgs/:orgId`                       |      12 |                         11 |
| Example `GET /api/tasks/stages`                      |      24 |                         23 |
| Example `GET /api/auth/get-session`, without refresh |       8 |                          — |
| Starter `GET /api/orgs/:orgId/members`               |       6 |                         10 |

To reproduce, record `countD1RoundTrips(...).count` after dispatch in the Example and Starter
`src/test/d1-route-fixture.ts` probes. Run `bun run --cwd apps/example-api test` with `d1-auth-round-trips.test.ts`
and `d1-round-trips.test.ts`, and `bun run --cwd apps/starter-api test` with `d1-budgets`.
For hosted MCP, wrap the `workerFetch` DB binding only for the `whoami` call in `apps/mcp-example/src/http-oauth.test.ts`
(`PKCE + localhost DCR + demo identity` case). That probe measured one D1 call, excluding provider KV operations.
Use the real HTTP handlers, dispose of the instrumentation afterward, and do not replace `count` with `assertAtMost`:
the latter only detects exceeded ceilings.

## Decision

### D1 — One request, one load, guards still decide

The Kit loads applicable session, User account state, Organization status, membership and Organization Role, Platform
Role, Module facts and App facts in one D1 `batch` on the authentication binding. Read current facts for each request
using the authoritative D1 path, not an unconstrained read replica or a cache. The batch is a round-trip optimization,
not a requirement that authorization and the operation commit together. A change visible to the authoritative store
before the next request's load is enforced by that request; work already admitted can finish. No snapshot crosses
requests or becomes a Runner View, Capability Grant, session, or OAuth token.

The Hono adapter lazily shares one load, including concurrent callers or a failed load, privately in the request
context. The result is read-only: a discriminated credential identity, scoped core authority facts and typed App
facts. It contains no cookie token, plaintext API key, stored key hash or OAuth token. Existing handler context fields
are projections after the relevant guard succeeds, not mutable inputs to other Kit guards. There is no setter for the
snapshot or its App facts.

Requests with no applicable facts or no locally usable credential need no authorization batch. Load only the facts the
dispatch plan needs, including a minimal plan for recovery; do not run unrelated App reads. A database failure or
unreadable required result is not confirmed absence. It stops dispatch with a generic `503`, no partial facts or
implicit allow. Decided denials retain their status and ordering; `503` can precede a denial which depends on a failed
load.

Before the first load, fix one plan for the matched endpoint, including its credential mode, Organization selection
and registered facts. Global and wildcard middleware use the same endpoint plan as the later guards: Hono matches more
than one registration, and a global middleware's own `c.req.param('orgId')` need not see the endpoint's parameter.
Read parameters from the matched endpoint; do not reparse the raw URL, choose the first middleware match, or let a
later guard replace the plan. Ambiguous plans fail closed.

Take the trimmed path `orgId`, otherwise `X-Org-Id`. A missing or conflicting selector never loads a different
Organization's App facts. The Organization guard still reports selector errors only after authentication. Preserve
missing selection, path/header and key-pin mismatches, ordinary nonmember `404`, suspended member `403`, and
route-specific audited super-admin support. The Better Auth active Organization, the key pin, an OAuth claim or a
delegation row never substitutes for a selection required by the route.

### D2 — The App contributes reads, not a replacement guard

The composing App contributes typed, declarative read specifications. The Kit compiles them to parameterized `SELECT`
statements on the authentication binding. The input is a closed set of reads over registered tables and columns, with
safely quoted identifiers and bound values; no raw SQL, expressions capable of writes or side effects, executable
statements, or database handle. Reject unknown operations and columns before execution. Credential tables and
secret-bearing columns (including session tokens, key hashes and provider credentials) cannot be projected or accessed
indirectly by a Product spec. If a fact needs a Kit column, use only an explicitly exposed, non-secret projection. No
Product write can enter the batch by construction; this guarantee is about the batch interface, not a sandbox for
trusted App code.

Every descriptor selects one Kit-provided candidate scope: User, selected Organization (with or without a
membership/Role), represented User within the delegation's Organization, or hosted OAuth grant. The Kit inserts the
correlation predicates appropriate to the scope, including the compound subject/Organization/role or verified
User/grant/client keys when applicable. Product predicates may narrow but cannot replace those predicates. A
descriptor reuses that candidate in its own statement, not results from earlier batch entries. Put explicit bounds on
the read plan and keep it within D1 statement and binding limits; never truncate or paginate facts in a way that can
hide a denial.

The batch may read Product rows before the Kit admits the principal. The results remain private until admission: no
Product decoders, callbacks that receive the facts, handler access, or logging on refusal. Core guards consume the
normalized Module facts and the Kit interprets a D1-backed deny-only credential fact internally. Release other facts
through a typed accessor only after the credential, applicable key-scope or MCP grant check, Impersonation fence, and
Kit guards for the dispatch scope have succeeded. A Product guard can then use those facts to narrow its admitted
scope before the handler; no fact adds Kit authority. Sanitize failures without logging raw SQL, bind values or
returned rows.

The App owns its Module registry and supplies two facts separately: effective availability (available on the
Deployment and enabled in the Organization) and the current Role–module grant. The Kit decides `404` for an
unavailable Module and `403` for a missing or insufficient grant.
This amends [ADR-0003 D7](./0003-multi-tenant-rbac-modules.md#d7--modules-two-levels) only for explicit, audited super-admin support: the
bypass can dispense with membership and that membership's grant, but not the active Organization or effective
availability checks. [ADR-0003 D9](./0003-multi-tenant-rbac-modules.md#d9--super_admin-support-semantics) still
requires separate write opt-in. An unavailable Module now returns `404` even with bypass.

Only explicit provisioning may seed grants. A missing grant, including for a system role, is never repaired or inferred by a guard, ordinary read, administrative check or Capability Grant minting backstop. The same live Module facts constrain those paths; a seed is not runtime authority.

Impersonation loads the verified actor session and the represented User's facts separately, bound to the delegation
row's Organization and, on routes that require a selector, to the matching request Organization. Validate both
accounts and memberships, the live delegation permission and the represented User's Module grants without borrowing
the actor's Platform Role or bypass. The App retains its operation allowlist and context fence, including stale-fence
refusal when the cookie or delegation is lost and a Bearer is present. Preserve recovery-only `/api/me` and stop
according to [ADR-0003 D15](./0003-multi-tenant-rbac-modules.md#d15--session-bound-impersonation). A failed mandatory
audit attempt write prevents business dispatch; the write is not part of the read batch.

Neither Product facts nor the snapshot change Capability Grant provenance.
[ADR-0005 D4](./0005-flows-platform-agentic-workflows.md#d4--security-model-authority-dual-auth-tenancy) retains the separate
session-only run-start gate, Kit minting from server-derived Organization policy, and sealing with the actual
Kit-minted grant and Kit-built registry, not a client, plan, agent claim or snapshot projection.

### D3 — Credential selection and verification

- **Browser session.** Use the exact wire cookie name from the App's Better Auth emission configuration, including
  `__Secure-` when configured; never look for the other name. Match the reader's percent decoding and first occurrence
  for duplicate names. Split the decoded value at the final dot, decode its padded Base64 HMAC-SHA-256 signature, and
  verify with the configured Better Auth secret and Web Crypto `subtle.verify`, never string equality. This verifies
  Better Auth's existing MAC; it does not revive the retired Kit session scheme or change the API-key comparison
  primitive. Reject missing or malformed cookies and bad signatures without resolving a session from them. A verified
  token selects the session row; a missing or expired row, missing User or disabled account cannot authenticate. Check
  expiry in stored milliseconds as Better Auth does. `dont_remember` affects cookie persistence and refresh, not
  identity with refresh off. The cookie cache stays disabled. Snapshot resolution never calls `getSession`, refreshes
  a session, or mutates a cookie or row, even on expiry. Better Auth keeps issuance, refresh, revocation, cleanup,
  mount protections and the account guard on its own endpoints. This replaces the request-path `SessionPort` in
  [ADR-0002 D3](./0002-session-hmac-interim-vs-better-auth.md#d3--sessionport-normative) and specifies the separate
  signature primitive under D6.
- **API key.** A parsed nonempty Bearer retains priority; its format, lookup and verification failures never fall back
  to cookies. If the existing parser selects no Bearer, use the session path where the route allows it. The prefix
  selects a candidate row; its hash is checked in constant time before exposing facts. Require an unrevoked, unexpired
  key, a valid Organization binding, an active owning User and current membership in the key's active Organization,
  even on a non-tenant route. On tenant routes the key pin must equal the independently selected Organization; scopes
  narrow access through the App's route allowlist. The Impersonation fence can require both candidates in the same
  batch without granting cookie authority to the Bearer; a verified attached delegation and Bearer remain
  incompatible.
- **Hosted MCP.** The provider still authenticates and owns OAuth credentials, grant records and KV operations. After
  validating the provider-derived User/grant/client tuple, the shell uses the same Kit D1 loader for current User
  state and applicable App facts. For `/mcp`, fix the optional selected Organization from `X-Org-Id` before the batch
  and tool registration. The header confers no rights. An Organization-scoped tool must bind its validated operation
  to that same Organization and apply its access policy; missing or different scope is a tool refusal, not another
  batch or grant revocation. `whoami` does not require an Organization. Identity resolution and consent submission
  still check live User state; code/refresh keeps grant admission and needs no Organization. The Kit interprets a
  D1-backed deny-only grant fact in the relevant batch; `grantAdmission` stays a separate deny-only check for policy
  outside this binding and sees no batch results.
  Preserve [ADR-0015 D2](./0015-mcp-remote-oauth-worker.md#d2--worker-issued-token-only): request denial does not revoke, decided
  token-exchange denial revokes the affected grant, and unavailable admission does not revoke. Browser sign-out does
  not revoke OAuth. This decision amends [ADR-0015 D8](./0015-mcp-remote-oauth-worker.md#d8--shell-is-kitmcphosted)
  only to reuse the shared read-only fact interface for hosted admission and tool scope; it does not add a second
  policy hook or waive the second-consumer gate for other seams. Tests cover both resource and token consumers of the
  loader, not external Product adoption. KV operations and delegated HTTP requests are outside the D1 budget.

**Amendment (2026-11-25) — Organization selection at hosted tool dispatch** (go-silex/unkillable-kit#181).

Common MCP clients fix headers per server connection. Header selection therefore needs one
connection per Organization and changes the wire contract of tools that already name their
Organization in their arguments. A hosted App may opt in to tool-input selection instead. Header
selection stays the default and unchanged.

- **Selection is not authority.** After catalogue validation and the input budget, the App
  designates one Organization from the validated operation, or a server-defined default only when
  the selector is omitted, without a read. A nonempty `X-Org-Id` may only agree. Missing,
  ambiguous or conflicting selection refuses before any scoped read, and no refusal falls back to
  another Organization.
- **Outer admission stays unscoped.** `/mcp` keeps one primary D1 batch for the provider-verified
  tuple, live User state, the D1 grant denial and unscoped facts, plus the external deny-only
  policy. It loads no Organization facts.
- **One bounded read per scoped dispatch.** Each dispatch reaching admission takes one primary D1
  batch, bound to the original tuple and the designated ID: live User state, the D1 grant denial,
  Organization status, membership and only that tool's declared Organization facts. An active
  Organization and membership are required, without Platform Role bypass. This exempts the scoped
  path from D1's fixed HTTP plan and single load: dispatches share only outer admission, and
  scoped reads per HTTP request are bounded. The batch stays read-only.
- **The operation is authorized in that Organization.** The App's operation policy sees the
  validated operation, the admitted scope and only its declared policy facts. A core refusal runs
  no policy or App fact decoder, and business facts are decoded only after an affirmative
  decision, which also runs the handler on the admitted ID. No refusal exposes or logs private
  rows. An assigned Organization Role key is not a verified Role; trusted App code is not
  sandboxed (D2).
- **Refusal never revokes.** Outer failure keeps D1's HTTP responses. A scoped denial or
  unavailability fails only that call, as distinct sanitized tool errors, and revokes no OAuth.
  Provider and external policy denials apply on the next HTTP request once visible to their
  stores; D1 state is read again at each scoped dispatch. `/token`, identity and consent are
  unchanged.
- **The helper is an adapter, not a registry.** It returns a tool definition for the existing
  catalogue and adds no grant class or authority source ([ADR-0005](0005-flows-platform-agentic-workflows.md)
  D6). Organization admission stays distinct from grant authority. Whether tool-input selection
  becomes the hosted default, and how registry ∩ grants relates to this helper, are open decisions
  for the agents layer (invariant 7).

Opting in changes the mode, scoped tools and fact declarations together; reverting to header
selection drops headerless clients. Bounds, error codes, schema requirements and D1 counts live in
[`packages/mcp/README.md`](../../../../packages/mcp/README.md) and its tests.

The existing Impersonation fence rejects even a bare Bearer scheme when a delegation is attached, although the general credential parser does not select it as a key.

### D4 — Root proves the Better Auth version each App uses

Root checks the effective `better-auth` resolution across workspaces, including nested resolutions. More than one
version fails with each version and the workspaces resolving it. This is a cardinality check, not a version pin or a
global `better-auth` override. Kit manifests use compatible ranges and the shared lockfile fixes the version for each
repository. An incompatible protected range is fixed in the Kit first. The distinct opt-in OIDC version contract is
unchanged.

Every App composing the Better Auth server declares `better-auth` directly and supplies Root with the App-local
composition used by its shipping server. Root inventories server compositions independently of direct dependencies and
test registrations, including runtime use of `@kit/auth/factory` from an App without a declaration. An enrolled App
cannot substitute a separate test-only factory. Root proves the reference instance's factory resolves the same version
as the App, then executes the shared differential fixtures against that instance and the Kit verifier. A missing
composition, an undeclared or unresolved dependency, a differing resolution or an unexecuted fixture fails Root. The
check runs in Kit and inherited `validate:full`, including CI core when coverage selection narrows. Do not add a
parallel Product gate.

Use real cookies issued by the App's Better Auth composition and isolated data so expired-row cleanup by the reference
cannot affect the Kit's inputs.
Compare admission, User identity and verified session ID with `auth.api.getSession({ query: { disableCookieCache: true, disableRefresh: true }, ... })`, not cleanup side effects. Assert the expected
result independently on both paths so two unrelated failures cannot pass as parity. Cover valid, tampered signature,
wrong secret, expired (including the millisecond boundary), deleted, disabled User, missing and malformed cookie,
nondefault name, `__Secure-`, the wrong wire name, duplicate names, and `dont_remember`. Prove the snapshot does not
delete an expired row or set a cookie. Better Auth upgrades still require independent review.

Include a custom logical cookie name that already starts with `__Secure-`, using what the App actually emits as the expected wire name. For expiration, deletion and disablement, prove the same cookie admitted before changing the fixture state.

### D5 — One cutover, measured before and after

The implementation removes `createKitRequireAuth`, `createRequireAuth`, `createOrgMiddleware`,
`createBetterAuthSessionPort`, and exports that only wire the superseded path, including `createKitOrgMiddleware` and
`resolveDualAuth`. Keep pure helpers and standalone repositories with other uses; do not leave a compatibility adapter
that can restore the old guarded read chain. Migrate the Example and Starter compositions and the Product starter and
mount guidance together.

Use `GET /api/orgs/:orgId` in `apps/example-api` to prove exactly one binding call for the full session and key
requests. Load the existing response projection as an App fact, scoped to the selected principal and Organization.
Assert wire parity, including the member and audited support projections, path-only selection, and the single batch
carrying core and Product facts. Separately exercise an existing Module-guarded route with one authorization batch and
consumer-visible allow, unavailable `404` and insufficient-grant `403` outcomes. With audited support bypass on that
Module guard, prove an available Module is reachable without a membership grant and becomes `404` when unavailable.
Other routes can still perform business reads, audit and writes. Lower the measured go-silex/unkillable-kit#160
ceilings. Native Better Auth handler work and OAuth provider KV work are not promised one D1 call.

Assert the response and binding-call count on locally decidable refusals and verify recovery does not depend on an unrelated App fact.

Prove next-request refusals for sign-out, session revocation, account disable, membership removal, Organization
suspension, Module grant removal, key revocation and hosted MCP revocation at their own stores. After deleting a
system Role–module grant, also exercise an ordinary role-list read and the flows minting backstop to prove no lazy
initialization restores it. Test the authoritative D1 adapter path separately from the binding-call ceiling; the proof
must fail if a replica-capable, unconstrained read session is substituted. Prove hosted tool scope separately from
org-free `whoami`, as well as unavailable admission without revocation. Do not claim stronger consistency for OAuth KV
than [ADR-0015](./0015-mcp-remote-oauth-worker.md) or cancellation of work already admitted.

Security review must explicitly verify that no write can enter the extension batch and that refused principals'
Product facts are neither exposed nor logged. Exercise descriptor rejection. Give the privacy fixture a known
Product row and prove its decoder and accessor work on an admitted control. Where a refused request reaches the batch,
observe the fact in the binding response before verifying the request does not publish or log it or run its decoder.
Cover credential, scope, Module and failed-load refusals; for partial failure, keep the successful fact result in the
test binding. Locally rejected credentials separately prove no read.

Exercise Root from synthetic Product-owned App wiring and the shared lockfile: missing enrollment, missing direct
dependency, conflicting nested resolutions, and a separate test factory resolving the same version as the runtime
factory. Root must reject the latter despite version parity. The Example App is not proof of external Product adoption.

The release notes carry a `**Product action:**` entry. Each Product upgrades in its own repository: swap the auth
wiring, replace wrapping ports with batched facts, enroll its Better Auth Apps in the differential, align the shared
lockfile without modifying Kit-owned paths and run Root. Verify that existing Organizations were provisioned; review
any explicit repair without blanket backfill of absent grants. Call out that an unavailable Module now returns `404`
even with super-admin bypass. Existing sessions and cookies remain under the same configuration; the cutover itself
requires no D1 schema change or forced sign-in. Deploy and adoption are separate from this decision.

## Alternatives rejected

- Keep independent async ports or add `Promise.all`: a later callback still cannot use a result from the same prepared D1 batch; the number of calls does not fall to one.
- Keep `getSession` on the Kit path: it owns its own reads and session lifecycle and cannot join the Product statements in one batch.
- Cache sessions or policy across requests, or move OAuth tokens into D1: the first changes revocation semantics; the second replaces the provider's credential ownership without achieving a needed authorization property.
- Force one Kit-selected `better-auth` version: a pinned test dependency does not prove the version the App runs, and a global override substitutes the Kit's update policy for the Product's.
