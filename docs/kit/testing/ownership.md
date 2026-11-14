# Testing

## Ownership (axial — PRIMARY = packages)

| Layer                                         | Owns tests for                                                                                          | Does **not** own                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **`packages/*`**                              | Public API of the capability (crypto, AppError, `joinObjectKey`, UI primitive contracts, MCP allowlist) | Product scenarios (e.g. the reference frame's artefact, slug 409, `private_key` read mode) |
| **`apps/example-*`**                          | Composition: Hono + D1/R2, dual auth wire, demo IDOR, CORS, cookies, design-system smoke                | Re-implement package crypto N times                                                        |
| **`apps/<product>-*`** (product repositories) | Product risks of its own domain (e.g. upload modes, archive extraction, serving product content)        | Forks of `@kit/*` stacks                                                                   |
| **`scripts/kit/*` / `tools/*`**               | Architecture gates (kit-bar script names live in root `package.json`, not here)                         | Domain behaviour                                                                           |

### Session-bound Impersonation

`packages/auth/src/repos/impersonation.test.ts` owns independent role permissions,
session-bound delegation persistence and transactional start/configuration audit rollback.
`apps/example-api/src/test/impersonation/{eligibility,audit,boundaries}.test.ts` composes
real Better Auth cookies, SQL migrations and SQLite: default-deny eligibility,
Organization and target boundaries, read/write business access, sensitive-route refusal,
live grant changes, stale-context refusal (including Bearer fallback attempts), mandatory
pre-dispatch audit and return despite audit failure.

Frontend contracts in `apps/example-web/src/lib/impersonation.test.ts`, `api.test.ts`
and `components/auth-gates.test.tsx` protect identity transitions, cache/request fences,
same-session synchronization and recovery-only behavior when `/me` fails. A successful
business dispatch is not implied by an audit record: the recorded action is an attempt.

Local browser proof uses the actual example UI and API with Better Auth and disposable
SQLite through the Node adapter. Observed paths include read-mode mutation refusal,
target-owned business writes, cross-tab return and recovery-only UI during a `/me`
outage. Holding successful start/stop responses after server commitment while triggering
stale-query visibility refreshes does not produce a false lifecycle failure.

This is not proof of a deployed Cloudflare runtime, external audit retention,
product-specific route admission or successful completion of every audited attempt.
Product routes must be admitted explicitly; an unlisted route remains refused.

### Notifications pure core

`packages/notifications/src/*.test.ts` exercises the public root: registration and identifier boundaries, frozen JSON parameters, access-first User resolution, specificity before cross-level locks, invalid external rules failing closed without removing Inbox, independent Organization destinations, terminal/resolved delivery eligibility and escaped email layouts with rules links in both formats.

`rule-snapshot.test.ts` protects the resolver observation boundary: changing accessor-backed rules cannot turn a captured email locked-off value on, bypass a collective ceiling or apply one changing rule Channel value to multiple Channels. Organization destination regressions reject nonmatching selectors even when the destination's selector getter or its nested `kind` getter changes during resolution. Both resolvers reuse canonical rule and destination selector values after access checks; these tests assert decisions and eligibility, not incidental property-read counts.

`apps/example-api/src/lib/notifications-dogfood.test.ts` owns composition of `tasks.assigned` and `flows.approval_requested`: App schemas/renderers, email and Slack defaults, rule overrides and distinct collective opt-ins. These declarations do not wire Notification producers or exercise a provider.

The root remains pure. E2 adds separate schema/repos exports; the following persistence proofs do not establish live membership hydration, producer wiring, Workflow execution/retries or email/Slack delivery.

### Notifications persistence

The Package repository suites cross the public `/schema` and `/repos` interfaces against all real, sorted Example App migrations with foreign keys enabled. They cover scoped Inbox visibility before pagination/count/read-all, Deployment/global-User/Organization rule ownership, atomic configuration audit and no-op suppression, active uniqueness and later-statement rollback, independent read/resolved timestamps, conditional terminal receipts and bounded retention.

`admission-reconciliation.test.ts` exercises the ADR-0020 observation contract: positive proof and first admission date are monotone, stale responses preserve the latest check time, expiry does not invent provider failure, and wrong identity or Organization cannot mutate a receipt. The unified User/Organization candidate query covers frozen `asOf`, fair strict keysets, eligibility boundaries and maximum-size ASCII cursors under the existing 512-character cap.

`cursor-keys.test.ts` and the shared core cursor regression preserve raw JSON own keys through decoding, then require the public admission and Inbox parsers to reject unknown `__proto__` keys. All three regressions failed before the shared-decoder correction and passed afterward; local workerd also exercised both rejection paths alongside ordinary valid pagination. No endpoint-specific key suppression or prototype-pollution claim is introduced.

A throwaway local Miniflare/workerd D1 smoke applied all 21 journal migrations, including `0023_notifications.sql`. Two concurrent HTTP callers admitted one active Notification/Delivery; same-ID replay did not add a Channel. It also exercised cross-Organization refusal, resolution/re-admission, later-child rollback, expiry/late proof with terminal protection, mixed-kind pagination/fairness and isolated purge. This is local D1 runtime evidence, not Cloudflare production or durable Workflow proof. The ordinary Package suites use the SQLite-backed D1 adapter and alone do not prove concurrent native D1 execution.

The pure core and persistence share the unchanged Package coverage floors. The App supplies the deterministic Workflow digest and never-reused Delivery IDs; repository validation checks identity coverage, shape and fixed deadline, not the digest computation. Purged history is not a permanent deduplication journal.

### Notifications HTTP composition

`apps/example-api/src/test/notifications/*.test.ts` crosses the shipped Hono HTTP interface with real Better Auth sessions, real org-bound keys and all applied migrations. It extends CP-IDOR/CP-UNAUTH by resource: subject/Organization isolation, session-only refusal, role/capability checks, read-only support access, live Module visibility before pagination/count/read-all, and idempotent read timestamps, including first read and replay of retained resolved rows.

The same suites exercise global User rules without administration audit, configured lock provenance independently of live availability, decisive rules beyond 100 newer rows in each of the three scopes, metadata-only Delivery lists, and atomic administration audit with no-op suppression and trigger-induced rollback. Cursor continuations cover each list with exact key validation and the largest migration-valid timestamp/id boundaries; the personal-rule endpoint actually produces and consumes its 392-character boundary cursor without crossing owners. Type/effective continuations use the largest keys produced by the fixed App registry, not hypothetical 128/64-character keys absent from that registry. Delivery creation dates also leave room for the required 24-hour admission deadline. Unicode display content remains permitted.

API catalogue tests join the existing Web catalogue tests in `i18n:check`. HTTP locale cases cover French/English, exact-header fallback, content/cache headers, trusted source links and scrubbed failures for incompatible retained parameters or missing definitions. Schema failures preserve the common field-error/request-ID envelope. All five JSON mutations reject missing and unsupported media types as safe 400 responses without writes, while preserving anonymous/session-only precedence. This regression failed with a 500 before the shared error-boundary correction. The Package's scoped `hasInboxNotification` public regression protects replay-versus-404 without an unscoped lookup; read-all retains the existing visible-row semantics.

A throwaway Miniflare/workerd smoke applied all 21 real journal migrations and exercised the actual App with native D1 and real password sign-in/cookies. It observed localized Inbox content and headers, cursor continuation, read isolation/replay, live Module/custom-role grant changes, global personal rules, a configured locked-but-unavailable preview, admin RBAC and atomic audit rollback/no-op, metadata secrecy, strict queries, media-type refusal and authenticated-key refusal. A separate Draft 2020-12 JSON Schema check accepted the actual nonempty native Deployment Delivery response, rejected unknown metadata and trailing-newline ids, and checked the projected external-Channel grammar including the `in_app` exclusion.

A managed Chromium smoke signed in an Organization owner with no Platform role, selected the run's Organization and loaded the actual Inbox approval URL in the shared App run view. The same account was redirected away from the `/admin` run entry. The navigation suite also exercises the approval request and preserves the Platform gate; link-rendered dashboard buttons retain native link semantics. These are bounded local HTTP/browser proofs, not production, source-object authorization, Workflow resumption, provider sending or durable Delivery execution.

### Notifications App service and producers

The App service suites exercise `notify` / `resolve` with real persistence adapters and all applied migrations: factual Organization/membership/Module access, external locks that preserve Inbox, actor exclusion only when supplied, full rule and destination pagination, independent collective intentions with zero User recipients, stable Delivery digests/deadlines, active deduplication and independent read/resolved state. The generic App assembly retains unconditional source resolution. E4 established the five persistence ports; E5 adds mandatory admission runtime ports and a separate real resolve-only factory.

Task regressions cross the existing HTTP mutation surface and consumed mutation-event hook. A real-HTTP tracer failed before producer wiring because the assigned recipient's Inbox was empty. A second regression reproduced a successful-path race: removal paused before its resolution SQL, a later HTTP reassignment created a notice, and the earlier removal then processed it. The Task-specific adapter now supplies trusted SQL predicates to the existing repository batch. Notification resolution and pending Delivery skips observe the same current Task/stage/assignment facts at SQL time. Regressions preserve a later new notice, an old notice reused by deduplication, its read state and pending Delivery identities; delayed post-notify removal and close/reopen compensation use the same guarded paths. The repository suites separately protect generic scope, filter/no-op semantics, both guarded lifecycle pairs and terminal Delivery preservation.

Flow producer and route regressions cover exact owner/admin recipient sets, non-admin members with Flows write, an admin retaining read but denied write, sole-owner eligibility without actor exclusion, distinct approval tuples, current sealed Runner View/receipt/decision facts, pre/post admission closure, corrupt/read failures and decision/cancellation repair. A matching configured collective destination makes closed replay assert complete unchanged Notifications and both User and Organization Delivery rows, not only Inbox counts. Resolution is still bounded best-effort: a failed compensation or exhausted callback can leave a stale notice, and a cancelled owner need not run its closing callback. Successful business writes remain committed. Producer-time object ACL/action eligibility is not continuous source-content revocation; retained parameters remain subject to ADR-0019's minimal-disclosure contract and source links still require current route authority.

A throwaway Miniflare/workerd smoke applied all 21 real journal migrations, obtained real Better Auth cookies and exercised the actual App, native D1 and actual `FlowRunWorkflow`: Task assignment/lifecycle and Inbox isolation, pending Delivery identity/deadline metadata, approval/cancellation and direct public-callback replay after closure without restarting the original owner. Instrumentation only at the Workflow's notification-service boundary observed two controlled opening failures followed by creation on attempt three, and four exhausted failures followed by a waiting D1 approval and successful business execution after approval. The class and P2 native steps were unchanged. A separate controlled `sendEvent` failure proved decision persistence, immediate resolution and closed-state replay; this is not a claim that native termination makes wake fail—the local runtime accepted that wake.

The same native D1 smoke paused a historical Task removal immediately before its real guarded resolution, completed reassignment through HTTP, then resumed the earlier operation. The fresh active Inbox row and its pending Delivery rows remained byte-for-byte unchanged, including Workflow identity, fixed deadline and admission receipt fields. This exercises the SQL-time guard on native D1, in addition to the permanent SQLite-adapter race regressions.

The extended native closed-replay proof also configured a matching collective Slack destination, captured complete resolved Notifications and both Delivery kinds, and independently checked the collective Workflow digest and fixed deadline. Reinvoking the public opening callback left all three scoped row sets unchanged.

These are bounded local proofs, not Cloudflare production, provider sending, a new UI surface or durable Delivery execution. E4 persists real `pending` intentions with fixed 24-hour admission horizons but creates no Delivery owner and performs no admission reconciliation. If E5 arrives after that original horizon, an E4 intention is not eligible for a newly created owner merely because it remains pending; automatic eventual sending is not promised.

### Notifications email Delivery owner

The App's `notifications-delivery` suites exercise stable identity, deadline rechecks, monotone admission, strict native-result projection, terminal protection, unsupported slots, retry-envelope validation and email classification. Service regressions preserve postcommit results, fresh-only handoff and sibling continuation. Their explicit memory Workflow adapter models identity/presence; it does not execute a native Workflow.

A throwaway Miniflare/workerd smoke applied all 21 real migrations, used real Better Auth cookies and crossed the actual Task HTTP producer into `NotificationDeliveryWorkflow`, native D1 and a controlled local EMAIL RPC service. It exercised response-lost and concurrent admission, retained terminal replay, missing/foreign rows, strict completion output and before/at/after-horizon admission. An isolated public instance deletion models post-retention absence: the old intention is not rearmed. It is not proof of automatic retention expiry.

The same native smoke exercised fresh address hydration and current membership, Module and rules on retry, including a rule beyond the first 100 rows; source resolution won the final receipt CAS. Local transport acceptance followed by lost acknowledgement produced a possible duplicate. A checkpointed send followed by a trigger-induced finish failure completed through native finish retry without a second physical send. A documented structured CF permanent error produced a failed receipt; unknown interruptions remained retryable.

An isolated actual `NotificationDeliveryWorkflow` run exhausted its native send policy with unmodified timers: exactly six physical local EMAIL calls, then native completion with `failed/delivery_retries_exhausted`. The App and D1 did not drive a retry loop, and no private timer acceleration or owner restart was used.

Native D1 maintenance exercised one unified page of 100 old candidates, sibling-Organization progress after an isolated purge failure and the pre-cascade child state through a test-only delete observer. The actual Worker `scheduled` handler was also invoked with a future `scheduledTime`, preserving the server clock, page bound and sibling isolation. The Package retention suite separately proves batch selection, terminal preservation, Organization isolation and rollback. The existing server Organization inventory is not globally bounded; only each Organization's reconciliation page and purge batch are bounded.

The approved D6 amendment is separately exercised by the actual production retry helpers inside the native engine: a 75.25-second hint schedules 76,000 milliseconds and the unaccelerated callback occurs no earlier. Explicit constant backoff prevents the runtime's default multiplier from changing the dynamic schedule. No undocumented timer controls are used. These are local runtime proofs, not Cloudflare production, effective account retention, recipient receipt or exactly-once guarantees. Default native success/error retention must still be operationally verified before deployment.

A native component proof uses real E2 rows and the production retry-result helper: a hint above 86,400 seconds returns `failed/retry_after_exceeds_budget` in one callback, without a retry. A rejected diagnostic D1 write preserves a 75.25-second hint and the native 76,000-millisecond delay. The result is controlled at the component boundary; unchanged `EmailPort` has no provider-hint field, so this is not an end-to-end provider-hint claim.

An isolated staging runtime exercises the actual owner with explicit synthetic HTTPS origins and controlled EMAIL RPC: allowed recipients preserve the staging subject prefix, From and both footer formats; a disallowed domain fails without a transport call. The initial fixture's loopback origins were rejected by the existing non-development policy; the fixture, not that policy, was corrected.

E5 composes only User/email. Unsupported Slack and Organization/email intentions remain uncertain until their original admission window closes, without a fabricated provider failure. The authenticated footer currently opens `/api/me/notification-rules` on the configured API origin; no E6a preferences UI, public unsubscribe route or real provider delivery is claimed.

### Shared test support

Share technical mechanics, not a global scenario or mock framework. Keep fixtures inside the Package or App that owns their data.

| Seam                | Shared support                                                                                                                                                                        | Remains local                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| SQLite-backed D1    | `@kit/db/testing` (`createSqliteD1`), separate from the production entry point                                                                                                        | DDL or real migrations, foreign-key mode, records and database lifetime in each wrapper |
| API composition     | `apps/example-api/src/test/api-fixture.ts`: app/env/db composition, demo seed options, sign-in and request headers                                                                    | Scenario data, historical migrations, R2 and Workflow doubles                           |
| Web pages and hooks | `apps/example-web/src/test/`: provider harness, lightweight `query-client.ts` registry, fresh QueryClient and memory history, Me/Organization factories, strict `apiFetch` dispatcher | Plans, runs, Role–module grants and concurrency scenarios                               |

Synthetic API fixtures may inject `hashFixtureCredential` from the App's test support. Its in-memory promises reuse the real hasher's immutable result for an exact synthetic password within that loaded file instance; rejected entries are evicted and the helper rethrows to its caller. The seeders' pre-existing best-effort catch behavior is unchanged. Same-password fixture accounts deliberately share salt and hash, but databases, records and sessions remain fresh. Default seed calls, credential creation, password changes, sign-in and verification retain real crypto. The default-seed salt and cross-context reset oracles protect that boundary; this fixture optimization is not proof of independent salts for fixture accounts.

For client error contracts, cover both `ApiError` envelopes and non-envelope
`HttpError` responses, including status-based consumer behavior and 401 callbacks
whose synchronous or asynchronous failures must not replace the HTTP rejection.
Keep network failures distinct from HTTP responses; never rely on raw error bodies
as user-facing messages.

- **API:** request `Cookie` uses cookie pairs; raw `Set-Cookie` remains response data for flag assertions. Pass the Organization explicitly when required. In Flows fixtures, `provisionOperatorWriteOnAcmeOverHttp` requires HTTP `201`; `seedOperatorWriteOnAcme` establishes a DB precondition. Choose the layer deliberately — no HTTP-to-repository fallback.
- **Web:** declare method/path handlers at the `apiFetch` seam; unexpected requests fail teardown even if a query catches the rejection. Client HTTP-contract tests keep the real client seam. Render errors fail too: an intentional negative case declares a narrow, test-scoped `allowRuntimeError` that must actually match an observed error. RegExp allowances are evaluated as stateless predicates, including global/sticky patterns. The shared renderer records caught errors before invoking a caller's `onCaughtError`; a callback cannot suppress the guard. Logs remain visible. Route tests await destination content, not just an updated URL or an absent fallback. `apps/example-web/src/test/support-guards.test.tsx` exercises the guard contracts with real caught render errors, caller callbacks and swallowed unexpected requests.
- **Lifetime:** the D1 adapter owns no Vitest hooks. Wrappers register `onTestFinished` immediately after each native SQLite allocation, before pragma, DDL or migrations can throw; the real-D1 fixture disposes Miniflare, including failed startup. The shared Web outer `aroundEach` owns capture and aggregate cleanup, so an ordinary failing consumer teardown does not skip support cleanup or erase the original failure. It unmounts DOM before clearing caches and restoring globals, spies, environment, clocks and storage, even after a guard fails. The next-consumer test retains a populated QueryClient across a failing teardown and checks that its cache was cleared. Spies and globals are restored before ending capture, which restores the captured console method only if its wrapper is still installed on that same object and detaches listeners from their original attachment target. Explicit guard assertions validate and drain the ledger without ending capture; only the outer finalizer releases it. Cleanup runs after consumer finish callbacks; its failures do not retroactively invoke `onTestFailed`. Shared setup also supports per-file Node environments: browser listeners and storage are used only when a DOM exists, while console-error capture and non-DOM cleanup remain active.

Console-mock compatibility covers spies created on the captured console method. A retained Vitest mock predecessor uses its public `mockRestore()` before a second ownership check, so composed suite/body spies cannot reinstall a retired predecessor; ordinary direct logger predecessors remain intact. This carries Vitest's reset semantics: standalone `vi.fn` configuration is not preserved losslessly, and a borrowed spy's restorer retains its original target. It is not a general mock-owner resolver.

`apps/example-web/src/test/shared-finalization.test.ts` runs a non-discovered failure fixture through the real Web configuration in an isolated child process. It requires separate consumer/finalizer diagnostics, a successful following consumer, restored storage and a visible body marker. The child deliberately exits `1`; the ordinary parent test must pass. Only this failure-fixture child disables coverage; ordinary Web coverage and thresholds are unchanged. The runner derives the executed fixture's include path from `import.meta.url`, so Knip sees the actual dynamic entry without changing analyzer defaults or ignores.

`packages/db/src/sqlite-d1.test.ts` runs the same binding scenarios against the adapter and **actual local D1** through pinned Miniflare/workerd. It belongs to ordinary Package `test` and `test:coverage`, not an opt-in command, and needs no Cloudflare credentials. It is a bounded binding-contract proof, not a substitute for migration, deployment-configuration or remote-D1 verification.

### Design-system e2e (local only)

- **Kit composition proof** (`@kit/ui` + admin shell in `example-web`).
- **Not** product e2e. Do not grow it into artefact/upload flows.
- **Local (API + web already up):** `bun run test:e2e:design-system` — fast when stack is warm.
- **Local one-shot (cold start):** `bun run test:e2e:ci` (`scripts/kit/e2e-ci.sh` — migrate, seed, start API+web, Chromium smoke, teardown).
- **Not** in GitHub Actions CI, `validate:full`, or Lefthook pre-push — Free minutes + flake risk; local-first gate stays machine-cheap.
- **CP-E2E** — proves: BA cookie login path + design-system overlays open without Base UI contract console errors. **Does not prove:** dual-auth, IDOR, org RBAC, product flows, a11y matrix.

### When product lands

- Product tests live only under `apps/<product>-*`.
- Kit banlist + extract remain green; product debt must not lower kit T0 floors.
- A product's own risks (for the reference frame: zip-slip, `private_key` → 404) become **mandatory product tests** when its code lands — not pre-baked as product fixtures inside packages.

---
