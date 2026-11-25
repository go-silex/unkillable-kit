---
title: 'ADR-0026 — Load a closed Kit authorization core at the route guard'
status: accepted
normative: true
date: 2026-11-25
axial: false
related:
  - docs/kit/architecture/adr/0002-session-hmac-interim-vs-better-auth.md
  - docs/kit/architecture/adr/0003-multi-tenant-rbac-modules.md
  - docs/kit/architecture/adr/0005-flows-platform-agentic-workflows.md
  - docs/kit/architecture/adr/0015-mcp-remote-oauth-worker.md
  - docs/kit/architecture/adr/0024-root-single-quality-gate.md
  - docs/kit/architecture/adr/0025-request-authorization-snapshot.md
  - 'go-silex/unkillable-kit#191'
summary: 'Closed Kit authorization core loaded at the route guard; Product policy after admission'
---

# ADR-0026 — Load a closed Kit authorization core at the route guard

The operator accepted these decisions on 2026-11-25; go-silex/unkillable-kit#191 tracks the Kit change.
The acceptance covers the decisions below only. It grants no release, deployment or Product adoption; each keeps its
own review, proof and authorization.

## Context

[ADR-0025](./0025-request-authorization-snapshot.md) removed repeated D1 reads from the Kit guards. It also made the
optimisation a contract: one D1 batch per request for all request authorization facts, Product facts included,
planned before Hono dispatches the route. To honour it the Kit predicts the matched endpoint before routing, compiles
Product policy from a declarative read language, computes a Product fingerprint and orders Product refusals.

Migrating two Products to v0.8.x surfaced these incompatibilities:

1. A bounded Product fact could not hold a complete visible set, and a stale write after losing write access returned
   `403` instead of `409` (go-silex/unkillable-kit#182). The fix, go-silex/unkillable-kit#183, added a Kit projection
   and fingerprint.
2. That fingerprint hashed the projected rows, not the Product's visibility; after losing all Module access a stale
   write returned `403` instead of the Product's `409`.
3. Valid overlapping routes returned `503`: the planner treats distinct matching patterns as ambiguous.
4. An address with no endpoint under a guarded Organization prefix returned `503`.
5. A broken Product schema masked core `404` and `403` refusals behind `503`, because one statement resolves Product
   columns even when no Product row is needed.
6. Hosted tools that name their Organization could not select it at dispatch, because outer admission selects the
   Organization from a header before any tool runs (go-silex/unkillable-kit#181). The draft
   go-silex/unkillable-kit#184 adds a second hosted mode with its own scoped reads.

The first five follow from the single-batch contract, the sixth from selecting before dispatch. Separately, Root
rejects an enrolled App that adds its own cookie to the native sign-in response (go-silex/unkillable-kit#188); this
decision corrects that proof as well, since the same migration needs it.

go-silex/unkillable-kit#160 measured about 6 ms at the median and 10 ms at p90 per D1 round trip, on one deployment
near the primary. For the Example Organization-detail session request, ADR-0025 counted 12 binding calls at v0.7.0; the
v0.8.x path uses one. Against a two-call path, the first ten removed calls are worth about 60 ms at that latency and
the eleventh about 6 ms. These are estimates, not measured end-to-end latency. The planner, the read language and the
fingerprint exist to fuse guards and Product facts into one call while keeping Product preconditions intact.

## Decision

### D1 — A closed Kit core, loaded by the route guards

The Kit owns a closed set of request authorization facts:

- the credential identity: browser session, Organization-bound API key, or hosted MCP principal (D6);
- the User's account state and Platform Role;
- for the selected Organization: its status and kind, the caller's membership and Organization Role, and its Module
  map (D3);
- the Impersonation delegation, when the App enables Impersonation.

The Kit reads them with fixed, bound `SELECT` statements over Kit tables, in one D1 `batch` on the primary binding:
never a read replica, a D1 Sessions bookmark or a cache. A load starts when the first Kit guard or identity helper
runs, after Hono has routed the request, so that guard's own route parameters are visible. It is memoised for the
request by credential and selection, including its failure, shared by concurrent callers, and never crosses requests.
A change visible to the primary before a request's load is enforced by that request; work already admitted can
finish. A request with no usable credential, or that reaches no Kit guard or identity helper, reads nothing.

Every Organization selection seen while serving a request must agree (D2), so a request loads at most twice: once
without an Organization, when a guard authenticates before any selection is visible, and once for its Organization.
The second load authenticates again and must reproduce the identity facts the first admitted: method, subject,
session or key and its scopes, account state, Platform Role and delegation. A decided refusal from the second load
applies; any other difference refuses as unavailable. The Organization admission uses only the second load's facts,
nothing derived from the first is reused, and a failed second load never falls back to the first.

A database failure, an unreadable required result or a duplicate required row is not confirmed absence: it stops
dispatch with a generic `503`, without partial facts, fallback identity or implicit allow. Concurrent callers waiting
on one load share its outcome. Decided denials keep their status.

### D2 — Selection and identifiers

The selection is the route's `orgId` parameter as routed and decoded for the guard that runs, otherwise `X-Org-Id`.
When both are present they must agree. An empty header counts as absent; a repeated header is refused even when its
values agree or arrive combined. A guard may instead receive an Organization chosen by the server; a path or header
naming another one is a `403` mismatch, never a silent switch
([ADR-0003 D8](./0003-multi-tenant-rbac-modules.md#d8--org-context-on-requests) gains this server choice, not a
fallback). An API key's binding, a hosted designation and a delegation's Organization must match the selection when
they apply, and never supply a required one. The Better Auth active Organization is neither a selector nor a binding.
Authentication still precedes selector errors, and credential authentication still checks its own binding; a
malformed or conflicting selector triggers no read for the Organization it names. A nonmember gets `404` and a
suspended Organization `403` for its member.

Identifiers are validated as text and compared exactly, never trimmed, case-folded or coerced: binary equality on
`TEXT`, with no column collation or numeric affinity, in every lookup, join and binding check over User, session, key,
Organization, membership, Organization Role, Module and delegation rows. A noncanonical value is refused, not
repaired. Product code that compares the same identifiers follows the same rule.

### D3 — Module facts

The Module map covers every Module row of the selected Organization, read in the same batch, so no guard has to
announce its Module before the load. A Module is available when the Deployment makes it available and the
Organization enables it; a missing row means unavailable. Its access comes from the Role–module grant of the admitted
member's Organization Role in that Organization, or of the represented User's Organization Role under Impersonation;
an absent grant gives no access. The audited super-admin bypass never makes an unavailable Module available
([ADR-0003 D9](./0003-multi-tenant-rbac-modules.md#d9--super_admin-support-semantics)).

The App still owns its Module registry and names Module IDs in its guards
([ADR-0003 D7](./0003-multi-tenant-rbac-modules.md#d7--modules-two-levels)). Role–module grants live in the optional
`rbac` schema set, so the App enables Module facts explicitly and must apply that set to the bound database. Without
the option, no statement references those tables, the view reports Module facts as disabled rather than as an empty
map, and creating a Module guard fails when the App is built. With it, a missing table is a `503`, not an empty map.
The Kit no longer accepts App-supplied Module descriptors.

### D4 — No global planning; guards and hooks

The Kit builds no endpoint plan and performs no authorization read in global middleware. The endpoint planner, the
`allEndpoint` marker and the `503` responses for ambiguous patterns or for a guarded prefix without an endpoint are
removed. Hono's matching and precedence decide which handlers run.

An address with no endpoint gets the router's behaviour. A Kit guard mounted on a prefix runs whenever Hono runs that
middleware: it may refuse first, and an admitted request then reaches the App's not-found handler. An App that wants
`404` before any credential check mounts its guards on endpoints.

Admission policies that Apps ran as global middleware become hooks of the authorization instance, run by the Kit
after the load and before it projects an identity:

- the route scope of API keys: default deny, synchronous, without I/O;
- the Impersonation policy: context fence, operation allowlist and mandatory attempt audit.

Hooks judge the request, its method and path, not the guard running them, so a prefix guard and an endpoint guard
reach the same decision. A policy keyed on route patterns admits a request only when at least one terminal
registration Hono matched for it is allowed and every one is, so an overlap or a fall-through cannot reach an
operation the policy refuses. Hono reports `.use` and `.all` registrations alike, so a matched `ALL` registration
counts as terminal unless it is a Kit guard, or a middleware registration the App identifies to the authorization
instance and that is matched before the first Kit guard; the App must never identify an operation handler as middleware.
Hooks receive only the verified inputs they decide on and cannot read the admitted view (D5). The Impersonation hook
runs once per request, with the delegation's Organization as a binding. A parsed Bearer never falls back to a cookie,
an attached delegation refuses any Bearer scheme, and a stale fence cannot turn a lost session into key authority.

Every Kit guard and identity helper runs this authentication step, so a route can mount only its most specific guard.
A session-only check (`requireSession`, `session(c)`) does not judge key route scope: a key is no session there, so it
is refused or answered `null`. The App also mounts the Kit's guard on its Better Auth mount: it refuses the Kit's
machine credentials there (API keys and hosted dispatches), leaves Better Auth's own Bearer tokens to it, and, when
Impersonation is enabled, applies the fence and delegation policy before Better Auth runs and admits sign-out as
recovery, without granting business or Platform authority; anonymous requests pass. Stop keeps its own route, under
the real actor's session. Public routes stay unguarded and carry no identity. The cutover inventories every handler
and helper the global middleware covered and gives each an explicit admission.

A hook that cannot decide, or an attempt audit that fails, stops dispatch with a sanitized `503`, distinct from a
decided denial, and without projection or business dispatch.

### D5 — Admitted view and Product policy

The Kit no longer compiles Product SQL, computes a Product fingerprint or orders Product refusals. Each Kit guard that
admits publishes its stage to a typed, deeply frozen, read-only view of the request:

- after authentication, the identity: method, subject, session ID or key binding and scopes, or hosted principal;
- the effective Platform Role: none under Impersonation, and for a hosted principal only on operations declared for it
  (D6);
- after Organization admission: the Organization ID, kind and status, the membership and Organization Role, whether
  the audited bypass was used, and the Module map.

The view holds only stages already admitted; a refused or pending stage publishes nothing. It never contains a cookie
token, key, key hash, OAuth token, raw row or driver error, and a Kit refusal returns and logs none of it. Module
entries describe access; they do not admit an operation.

Product code reads the view in the handler, or in a step it composes after the Kit guards that step requires. A step
composed before a Kit guard runs before that guard decides, so it causes no effect and discloses nothing the guard
could still refuse. The Product reads its own facts with its own code, recommended in at most one batch on the
primary binding per operation, scoped to the admitted subject and Organization. It reuses admitted facts instead of
reading them again and keeps its checks at the point of effect, including predicates inside its write statements.
Capability Grant minting and sealing keep their own session-only path and backstop
([ADR-0005 D4](./0005-flows-platform-agentic-workflows.md#d4--security-model-authority-dual-auth-tenancy)).

The Product chooses which Kit guards precede its own checks, and a Product check can only narrow Kit authority. For an
ordinary member session, a stale-write `409` that must precede Module refusals mounts only the Organization guard,
keeps `404` for every effectively unavailable Module (absent, disabled by the Deployment or by the Organization),
compares its precondition, then enforces Module access from the view before any effect. It computes the precondition
only from what the caller can currently see, so neither the comparison nor the refusal reveals state the caller can no
longer read. A match never replaces the operation's Kit checks or its point-of-effect checks. A broken Product schema
cannot mask a Kit refusal decided before Product I/O; a Product precondition placed before a Kit check can fail as
unavailable before that check.

### D6 — Hosted MCP selects the Organization at dispatch

Outer admission keeps ADR-0015's model. The provider authenticates and owns OAuth credentials, OAuth grant records and
KV operations. After it verifies the User/OAuth grant/client tuple, the shell loads live User state through the Kit
core. If the App configures `grantAdmission`, it runs on the resource request and on code and refresh exchanges and
must explicitly allow ([ADR-0015 D2](./0015-mcp-remote-oauth-worker.md#d2--worker-issued-token-only)); a request
denial does not revoke, a decided exchange denial revokes that OAuth grant, and unavailability never revokes. Omitting
it keeps provider and Kit admission. Live User checks on identity resolution, consent and exchanges are unchanged;
browser sign-out does not revoke OAuth. `grantAdmission` is not repeated per dispatch. Product-declared hosted facts
and the D1 deny fact are removed.

After outer admission, registration receives a capability for the verified principal. Only the shell creates it, and
it is valid only while that outer request is served. A tool dispatches through it, in process, to the App the shell is
composed with. Trusted tool code maps validated arguments to a declared operation and its route parameters; input
never supplies an arbitrary method, destination or header.

The App declares each hosted operation on its terminal handler, when it composes the App, optionally accepting the
hosted principal in a Platform Role guard and naming the Product headers a dispatch may carry; everything else is
denied. A guard mounted beside a handler, or a shared method and path, never declares it. Before dispatch, the
capability matches the destination with the App's own router and refuses, without running anything, unless the
registrations matched meet three conditions: ignoring identified middleware registrations matched before it, the first
is a Kit guard; an Organization-bound dispatch meets a Kit Organization guard before any terminal registration; and at
least one terminal registration is matched and every one is a declared hosted handler, with any other `ALL`
registration counted as terminal (D4). Kit guards check the declarations again for the registrations Hono actually
matched, so a guard refusal stops the operation before its handler runs. Identified middleware causes no business
effect before admission.

The Kit creates each dispatched request itself, without cookie or `Authorization`. Besides its own designation and JSON
`Content-Type`, the request carries only Product headers that every matched handler declared; credential, Organization
selection, framing, hop-by-hop and client-address headers cannot be declared. It privately associates the request with
the principal and designation; there is no public way to mark a
request. The receiving App claims that association once. A reused, cloned, forwarded or reconstructed request, a
network fetch or a dispatch after the outer request ends carries no hosted identity, and a guard refuses it as
unauthenticated. Kit guards authenticate a claimed request as the hosted principal, with no fallback to other
credentials and without super-admin bypass.

An Organization-scoped tool designates its Organization when it runs, from its validated input or from a server
default when the selector is omitted. A nonempty outer `X-Org-Id` constrains only Organization-bound dispatches: it is
compared exactly, and a repeated or different header refuses that call. Missing, malformed or conflicting designation
refuses before any scoped read, and a refusal never falls back to another Organization. Input selects scope and never
confers authority. The designation acts like an API key's Organization binding: the route selection must match it,
and a mismatch refuses, never reloads. An Organization-free dispatch never acquires an Organization: a guard that
requires one refuses it before any Organization read. Each dispatch takes one core load with live User state, and an
Organization-bound one adds active Organization, current membership, Organization Role and Module map.

An outer request allows eight dispatches through the capability, shared by all tools and Organizations, with or
without designation. The slot is taken before any await, after the designation validates; refused or unavailable
admissions keep it; an invalid designation, or a tool call that does not dispatch, takes none. Overflow refuses only
that call. Scoped refusals and unavailability fail only that call, with distinct sanitized errors, and revoke nothing.

Two Products already dispatch their tools in process to their own routes with a verified principal and a designated
Organization: one designates from validated input or a fixed default, the other from the single Organization it
finds through an Organization-free dispatch. Neither composes this seam yet; Kit tests must exercise both composition
shapes, and both Product pilots must compose the seam before v0.9.0 is published. The owner's acceptance of this
decision admits the seam under [ADR-0015 D8](./0015-mcp-remote-oauth-worker.md#d8--shell-is-kitmcphosted) without a
further owner exception.

### D7 — Session cookie and Root proof

The browser-session and API-key rules of
[ADR-0025 D3](./0025-request-authorization-snapshot.md#d3--credential-selection-and-verification) stay: the Kit
verifies the Better Auth cookie itself and never refreshes a session or writes a cookie.
[ADR-0025 D4](./0025-request-authorization-snapshot.md#d4--root-proves-the-better-auth-version-each-app-uses) stays,
including the single resolved `better-auth` version, enrolment, issuer provenance, the shipping-issuer and
extra-issuer checks, the differential and the inherited-Root negatives.

Root now proves the cookies the enrolled issuer emits, not the whole response. It parses each `Set-Cookie` field and
requires each issuer cookie exactly once in the mounted sign-in response, with the same value and attributes. It
refuses a missing or rewritten issuer cookie, a duplicate, and any other cookie whose exact name falls in an issuer
cookie's lookup or chunk family, prefixed or not. Unrelated App cookies pass. The mounted cookies must authenticate the
same User and session through both readers. Returning to Better Auth's native `getSession` on the request path is a
later decision, on measurement.

### D8 — Budget per admission step, measured per route

| Step                                     | Kit D1 batches | Product, advised                         |
| ---------------------------------------- | -------------- | ---------------------------------------- |
| HTTP request, identity                   | at most 1      | at most 1 batch per operation            |
| HTTP request, Organization admission     | at most 1 more | at most 1 batch per operation            |
| Hosted outer admission                   | at most 1      | `grantAdmission` I/O, counted separately |
| Each hosted dispatch (eight per request) | at most 1      | at most 1 batch per operation            |

A request whose first Kit guard already sees its selection uses one Kit batch; locally decided refusals can use none.
Better Auth handler work, `grantAdmission`, audit writes and business I/O are outside the Kit batch subtotal and
counted in the total; OAuth KV is not D1. Each Example and Starter route keeps a total binding-call ceiling per
credential through the real HTTP App ([testing](../../testing.md#d1-round-trip-ceilings)); an implementation records
counts before and after, separates Kit batches from other I/O, and justifies any increase.

### D9 — Invariants kept

This decision changes when and where facts are read, not what they authorize:

- freshness and next-request refusal for sign-out, session revocation, account disable, membership removal,
  Organization suspension, Role–module grant removal and key revocation, and for OAuth grant revocation once visible
  at its owning store;
- Organization isolation, credential precedence and the key binding;
- the Capability Grant ceiling and provenance: no view, hook or Product fact mints or widens a grant
  ([ADR-0005 D4](./0005-flows-platform-agentic-workflows.md#d4--security-model-authority-dual-auth-tenancy));
- the audited super-admin bypass and its separate write opt-in
  ([ADR-0003 D9](./0003-multi-tenant-rbac-modules.md#d9--super_admin-support-semantics));
- Impersonation ([ADR-0003 D15](./0003-multi-tenant-rbac-modules.md#d15--session-bound-impersonation)), including the
  recovery-only `/api/me` shape, stop under the real actor's session and the stale-fence refusal;
- Better Auth's native account guard on its own endpoints, and no Role–module grant repair by any guard or read;
- no Kit fact returned or logged on a Kit refusal, and checks at the point of effect.

### D10 — One cutover, proven

The implementation removes the endpoint planner and `allEndpoint`, `defineAuthorizationFact`,
`defineAuthorizationProjection`, `includeFacts`, `fact`, `moduleAuthority` and its fingerprint, the `moduleFacts`
descriptors, the hosted `facts`, `denyFact` and header-scoped `forOrganization`, and the public admission handshake
used by global middleware. No adapter restores them. Example, Starter, the MCP example, the stack standard and the
migration guide move in the same change. Example and Starter keep their wire responses, and the MCP example dispatches
to a guarded Organization route.

One guide migrates a Product from `unkillable-kit/v0.7.x` to `v0.9.0`. It also gives the replacement for each v0.8.x
surface removed: a `denyFact` barrier moves to `grantAdmission` before removal, a header-only hosted client designates
from tool input or a server default, and fingerprints issued under v0.8.1 stop matching. Sessions and cookies survive
where issuer configuration is unchanged; schema readiness is checked separately. `CHANGELOG.md` carries a
`**Product action:**` entry.

The cutover proves, through the real HTTP Apps:

- next-request refusal for each change listed in D9, and the primary binding independently of call counts;
- refusal privacy with a sensitive row present in the refused batch's results and an admitted control, on credential,
  scope, fence, Organization, Module and partial-batch refusals;
- two concurrent callers sharing one failed load, hook denial against hook failure, and a failed attempt audit, each
  with no projection or business dispatch;
- exact identifier comparison against case, whitespace, normalization and type lookalikes;
- the prefix, endpoint, `.route()`-mounted, OpenAPI, overlap, `.all()` fall-through, unknown-address and second-load
  paths, including a change of Organization Role, key scopes or delegation between the two loads;
- no Role–module grant repair on the role-list and Capability Grant minting paths;
- the applicable dispatch and refusal outcomes of go-silex/unkillable-kit#184 on the D6 seam, the designation from
  input or default, an Organization-free dispatch followed by an Organization-bound one, and provenance, replay,
  undeclared-destination, unguarded or mis-wired destination, undeclared handler sharing a declared method and path,
  and terminal `app.all` identified as middleware (each with no handler entered), and concurrent-cap negatives;
- the Root cookie cases of D7: addition, removal, attribute rewrite, duplicate, collision and another issuer.

Auth, Organization isolation, API keys, hosted MCP and Root changes receive an independent security review. v0.9.0 is
published only after two Product pilots pass on Kit `main`. The conflict cases of go-silex/unkillable-kit#182 move to
the Product that owns the precondition, and its pilot proves them: stale `409` and current `403` after a write-to-read
downgrade with identical visible rows, complete visibility beyond the former bound, no signal from changes the caller
cannot see, and the outcome it keeps after the loss of all Module access.

## Relation to earlier decisions

- **[ADR-0025](./0025-request-authorization-snapshot.md)** stays accepted for what survives. D1, D2 and D5 are
  replaced, except these parts of D2: Module ownership and the `404`/`403` semantics without App-supplied descriptors,
  the ADR-0003 D7 bypass amendment, the no-repair rule, the Impersonation rules and Capability Grant provenance. From
  D3, the browser-session and API-key rules and the standalone bare-Bearer fence stay; its hosted bullet is replaced by
  D6 here. From D4, only the mounted-cookie comparison changes (D7 here). Its frontmatter records the amendment, and
  its summary no longer promises one batch for all request facts.
- **[ADR-0015 D8](./0015-mcp-remote-oauth-worker.md#d8--shell-is-kitmcphosted)** gains the dispatch seam of D6 after
  its second-consumer rule, citing the two observed compositions without claiming adoption; its frontmatter records
  the amendment. The shared-fact reuse that ADR-0025 D3 granted the shell ends. The bounded second-consumer precedent
  of `consentPresentation`, the `grantAdmission` and `isReservedPath` owner exceptions and D8's other controls are
  unchanged. The further owner exception drafted in go-silex/unkillable-kit#184 is not adopted.
- **[ADR-0003 D8](./0003-multi-tenant-rbac-modules.md#d8--org-context-on-requests)** gains the server-chosen
  selection of D2; **ADR-0002 D3** keeps the Kit's cookie verification in place of the request-path `SessionPort`.

## Alternatives rejected

- **Extend v0.8.x.** Keep the planner, the read language, the fingerprint and a second hosted mode. Lowest nominal
  count, but the Kit keeps a second routing model and translates each Product's policy into its own language.
- **Native `getSession` now.** Simpler issuer ownership, but native hooks repeat reads and expiry cleanup can write;
  this waits for measurement.
- **A dispatch helper that runs the tool's policy and handler** (go-silex/unkillable-kit#184). Both Products dispatch
  to their own routes, where their guards and handlers already live.
- **Endpoint-declared machine scope checked by the endpoint guard.** A prefix guard cannot know whether an endpoint
  guard will run, so a key could reach an endpoint without one; judging the request keeps default deny without a plan.
- **Cache facts across requests.** It would change revocation semantics.

## Consequences

- A route whose first guard authenticates before the selection is visible pays one more round trip, about 6 ms under
  the reported placement; ceilings make it visible, and mounting the Organization guard first avoids it.
- Products own their policy reads, fingerprints and conflict semantics, and the tests that prove them.
- A Product read after the Kit load can observe a later state than the Kit facts. Both are fresh for the request;
  point-of-effect checks decide the write.
- A change to identity facts between a request's two loads refuses that request as unavailable; the next request
  decides on the new facts.
- Products that adopted v0.8.x locally migrate again; v0.8.0 and v0.8.1 stay tagged.
