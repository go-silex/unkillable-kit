---
title: 'ADR-0019 — Notifications: rules, Inbox and external Delivery'
status: accepted
normative: true
date: 2026-10-22
amended: 2026-11-21
axial: false
related:
  - GLOSSARY.md
  - docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md
  - docs/kit/architecture/adr/0003-multi-tenant-rbac-modules.md
  - docs/kit/architecture/adr/0004-email-transport-cf-default.md
  - docs/kit/architecture/adr/0007-tasks-comments-kernel.md
  - docs/kit/architecture/adr/0010-list-page-cursor-envelope.md
  - docs/kit/architecture/adr/0012-kernel-persistence-request-context.md
  - docs/kit/architecture/adr/0014-openapi-from-hono-routes.md
  - docs/kit/architecture/adr/0018-durable-execution-ownership.md
  - 'Roxabi/roxabi-boilerplate-cf#469'
  - 'Roxabi/roxabi-boilerplate-cf#470'
summary: 'Notifications: rules, Inbox, persistence and producer contracts'
supersedes_notes: >
  2026-11-21: body trimmed to decisions, rationale and limits; implementation detail now lives only in the cited code and tests. No decision changed.
---

# ADR-0019 — Notifications: rules, Inbox and external Delivery

Accepted on 2026-10-22. The repository contains `packages/notifications`, its schema and repositories, the catalogued `0023_notifications.sql`, and notification routes and services in `example-api`. The App composes `createNotificationService` and wires Task and Flow producers; regression suites for this composition and producers are present. User/email Delivery Workflow admission, reconciliation and execution are implemented; Slack and Organization/email remain uncomposed. These are partial implementation evidence, not proof that every contract below or its integration proofs is delivered. Live or deployed delivery remains unproven; acceptance is not deployment proof.

Amendment 2026-11-14: absent-code specifications linked below are non-normative design notes; the decisions remain binding.

## Context and decision

Apps need one extractible Notifications capability for action-required notices, rather than separate implementations of preferences, recipient isolation and delivery guards. The first consumers are task assignment and flow approval in `example-api`. Product Notification types remain in Product Apps.

The Kit supplies `@kit/notifications`: a pure registry/resolver/Channel contract, an email layout, and separate schema/repository exports. The App owns its registry and copy, source authorization, `notify`/`resolve` composition, HTTP routes, bindings and producer wiring. **Access first, then Inbox always, then external Channels.**

A Cloudflare Workflow owns each complete external Delivery, with a stable instance identity. Automatic admission is bounded to 24 hours from intent creation, with retention of at least three days; only positive native evidence proves admission. Ambiguous admission is retried with the same ID inside that window, never by restarting or replacing the execution; after the deadline uncertainty remains visible without automatic recreation. The Workflow owns retries and finalization, and Cron only requests bounded admission or observes the owner. There is no Notifications Queue, generic outbox engine or `@kit/jobs` extraction for a fictitious second Queue consumer. ADR-0020 details that protocol; Slack installation, secrets and adapter are specified in ADR-0021.

## D1 — Ownership and access

Implementation: `packages/notifications/src/resolve.ts` and `apps/example-api/src/services/notifications/service.ts`.

The Kit owns pure registration, resolution and Channel contracts, plus separate schema and repositories; the App owns authority, registry, routes and composition. Cloudflare Workflows own complete external Delivery.

Slack Channel interface remains a target: [non-normative design note](../design-notes/0021-slack.md#kitslacknotifications).

`orgId` is the Organization that owns the source. It is not the browser's selected Organization or the sender's Organization. Every recipient must be a real member of that Organization, which must be active. A type with `moduleId` also requires the recipient's effective Module **read** access: Deployment availability, Organization enablement and their Role–module grant. The sender's grants or support bypass never substitute for these checks.

The producer chooses explicit User ids using the action's authorization predicate, then excludes Users who cannot see the source according to its object ACL. The engine repeats membership/Module checks at admission, Inbox access and every external attempt. It does **not** re-read the source or object ACL at Inbox read or delivery: the emission-time display parameters may remain visible after loss of source-only access, while the source route returns 404. Stored parameters must be suitable for that disclosure.

A User's Inbox is scoped by `orgId + subject`, without support bypass. Organization administration, including destination management, requires `manage_notifications`, with minimum role `admin`. Support reads of administration metadata may use the existing explicit, logged super_admin read bypass; no new break-glass write route is introduced. A Platform Role never becomes an implicit notification recipient.

## D2 — Registry and pure resolution contract

### Registry

Implementation: `packages/notifications/src/registry.ts`.

Zod validates frozen, JSON-serializable display parameters both at admission and consumption. No secrets, tokens, private comments, rendered HTML snapshots or arbitrary provider payloads enter stored parameters. Parameter schemas must survive their JSON round-trip. Type changes must preserve retained rows; incompatible changes require an explicit data migration or a new type key, not an automatic legacy fallback. Missing types/renderers or corrupted parameters are configuration/data errors, never an invented authorized `on` result.

External Channels retain a declared order, but V0 executes fan-out: one Channel's failure never triggers another or suppresses Inbox. No escalation, digest or fallback chain is implemented.

### User rules

Implementation: `packages/notifications/src/resolve.ts`.

1. Denied Organization/membership/Module access returns `admitted:false`: no Notification or Delivery. For a type without a Module, `moduleReadable=true` is supplied explicitly.
2. Otherwise admit one Inbox Notification **before and independently of external rules**. No rule targets Inbox; there is no `in_app` Delivery.
3. For each declared external Channel, select the most specific matching rule **within each level**: type > category > `all`. Then apply the selected Deployment lock, else Organization lock, else first defined value in User > Organization > Deployment > type default order.
4. A User never locks. An unlocked Deployment off is a default, not a veto: an Organization may lock Slack on above it. A broad lock does not override a more specific rule at its own level; only that level's selected rule participates in the cross-level comparison.
5. **Email locked-on is invalid at every level.** Validate at write and SQL boundaries; invalid persisted rules fail closed for external Channels, never silently become on. `in_app`, unknown Channels and a rule that cannot match any declared Channel/type are rejected.

`mandatory` is **not exposed by the V0 registry or resolver**. Its reserved semantics are: a type-declared Channel bypasses rules only after access checks; absent address still skips. Only security or a legal/contractual obligation whose loss could harm a User/Organization qualifies, not business importance. Authentication reset, magic link and invitation emails remain outside this engine permanently, synchronous on EmailPort. A future Mandatory Channel requires its first concrete need and additive interface change; this ADR does not force any V0 email.

### Organization destinations

Implementation: `packages/notifications/src/resolve.ts`.

A destination must still exist and match its selector, the type must opt in, and the Organization's Module must be available/enabled. The selected Deployment **locked-off** rule is a ceiling. Unlocked defaults do not veto an explicitly configured destination; locked-on cannot create a missing destination or bypass type opt-in. Organization/User rules govern Users, not collective destinations.

Collective delivery is independent of recipient count, including zero. One destination produces one Delivery, not one per User. Each configured address has one selector; several distinct destinations are allowed. A destination is not an artificial User, has no Inbox and does not borrow an administrator's Role. Slack channels may contain guests/Slack Connect members; opting in is a reviewed disclosure decision. `tasks.assigned` never opts in; flow destination copy excludes prompts, tool arguments, receipts and private source content.

## D3 — Channel, rendering and App service

### External Channel

Implementation: `apps/example-api/src/notifications-delivery/email-channel.ts`.

The App resolves the address/current installation after access/rules, before `send`; unavailable means a stored skipped Delivery, not a fourth Channel result or false sent. Inputs remain org-scoped and provider-specific: the Slack input may require installation/generation/address/content without pushing those types into the core.

A Channel performs one attempt, classifies errors and returns a stable, scrubbed code; it never sleeps, retries itself, creates an execution or decides a durable retry plan. `retryAfterSeconds` is finite non-negative seconds, not milliseconds or an ambiguous timestamp. ADR-0020 owns how the Workflow schedules the next failed attempt. Sent means accepted by the configured transport, not receipt or reading by a User.

Inbox is rendered server-side at read time, using the App's `@kit/i18n` catalogues and the client's exact supported `Accept-Language` value. The existing `resolveLocale` does not parse regional tags or q-values: absent, unsupported or composite values fall back to `defaultLocale`. Email and Slack render at attempt time in the App default locale. No new User locale column is introduced.

The type renders email subject/body; the Kit layout guarantees a rules-management link in **both text and HTML**, with App-provided brand/link copy. The URL is constructed from trusted App configuration, never request Host/Origin or an arbitrary parameter URL; text/attributes are escaped. EmailPort's `{to,subject,text,html?}` shape is unchanged: no List-Unsubscribe header, public unsubscribe route or one-click claim. Every V0 email can be disabled through the authenticated User rules screen. Existing staging allowlist, From pin and subject-prefix protections remain in effect.

CF rate/daily/internal errors are retryable; malformed address/payload, allowlist rejection, unverified sender and suppressed/forbidden recipient are permanent. Unknown network/outcome failures are retryable, not evidence of no effect. `{ok:false}` from an EmailPort is not sent. Classify observed provider codes at the email adapter; do not claim EmailPort already guarantees an error taxonomy or expose exception text. Slack error mapping, supported Block Kit subset and link-preserving truncation belong to ADR-0021; the Kit's 4,000-character text bound is stricter than Slack's provider truncation limit.

### Service factory

Implementation: `apps/example-api/src/services/notifications/service.ts`. `notify` and `resolve` are server-only calls: no client route, MCP tool or flows tool exists.

`notify` validates type/source/ids/parameters, deduplicates User ids and excludes `actorId` **only when provided**. Missing access facts fail closed. It creates Inbox for each authorized recipient, independently resolves external Channels and adds collective destinations from Organization configuration, never the producer. Data-access errors fail the operation; only the supplied caller owner may retry. External decisions never suppress authorized Inbox. Atomicity applies to successful admission, not an unavailable database.

Admission atomically writes Notifications and initial Delivery intentions. Active conflicts add no row, overwrite or Delivery. After commit the App requests admission only for newly created Deliveries with stable identities. Failed or ambiguous runtime admission does not roll back Inbox or send directly; it is reported and represented by its receipt, with bounded reconciliation under ADR-0020. Repeated `notify` does not republish prior work.

Apps may batch business writes and admission atomically with live authorization.
The [`@kit/notifications` README](../../../../packages/notifications/README.md)
defines ordering and result slicing. The executor is separate; Workflow
admission is post-commit; flows are best-effort.

`resolve` is idempotent and never marks read. Omitted `types` means all types of that source; omitted `userIds` means all Users **and** collective Deliveries. Provided `userIds` restricts to those Users and never resolves collective delivery. Explicit empty arrays are no-op, not all. Changes to Notification resolution and pending Delivery skips share a batch. No caller may supply another Organization through a filter or patch.

## D4 — Producers and best-effort flow ports

Implementation: `apps/example-api/src/lib/notifications-dogfood.ts`, `apps/example-api/src/services/notifications/task-producer.ts` and `apps/example-api/src/services/notifications/flow-producer.ts`.

Task assignments notify added assignees only after their object ACL is checked; task types do not opt into Organization destinations. Flow approvals notify eligible decision makers, including a sole owner, and opt into Organization destinations. The dogfood payloads retain only a task display title or generic approval copy, never plan prompts or private instructions.

Task source is `{kind:'task',id:taskId}`. Approval source is `{kind:'flow_approval',id:JSON.stringify([runId,taskId])}`: simultaneous approvals in one run are distinct. Cancellation resolves each approval source from the immutable Runner View, never a live plan or an ambiguous prefix query. Source links still enforce current source-route auth/ACL.

The App computes task deltas at create/update: creation adds all assignees; differences are sets without duplicates; unchanged assignments omit the field. Assignment membership alone does not prove object visibility. Existing callers without these optional additions keep their behavior.

Opening and closing callbacks run inside dedicated, stably named steps of the **caller-owned plan Workflow**, using the existing idempotent read/write step retry limit of three retries. Retry follows an actual failed callback; it is not a continuation or a fresh run. After owner-native exhaustion, log a scrubbed structured failure and continue the plan. No nested retry loop, custom recovery record, restart or Queue forwarding is introduced. Callback count is not exactly-once under replay. `notify`'s active uniqueness is not a permanent opening-event fence: approval opening also requires the App lifecycle guard below; task reassignment must remain possible.

These callbacks are **bounded best-effort**: loss of a Notification or resolution is admitted. They must never approve a task, undo a D1 decision, change the run's authority, or fail the run solely because the notification callback exhausted retries. A Workflow terminated by cancellation may not execute its close callback; decision/cancellation routes therefore resolve independently, including already-decided/already-cancelled idempotent success paths. Resolution failure is reported without reversing the committed business decision. A stale Inbox/action-required notice may remain until a later legitimate resolution or retention; its link confers no authority.

### Approval opening lifecycle guard — App producer, not generic Delivery

The App `opened` callback treats the current org-scoped D1 run, its persisted task receipt and approval decision as the lifecycle authority. The opening is eligible only if the run is still `running`, the immutable Runner View identifies that approve task, its D1 receipt is `waiting`, and there is no `approved`, `rejected` or `expired` decision row. Missing/deleted/closed runs, cancelled runs, non-waiting tasks and any terminal approval decision cannot authorize an opening. A failed/corrupt read is an actual callback failure, not an invented open state. This reads lifecycle facts for **emission**, not object ACL/content at Inbox read or external send.

Every invocation rechecks the lifecycle before notifying and resolves instead if it has closed. After notifying, it reads the lifecycle again and resolves the exact source if it closed during admission. These operations remain inside the bounded best-effort owner step; failures retry there, starting with a fresh guard.

Thus successful `opened → closed/resolve → replay(opened)` observes the terminal D1 lifecycle and creates no fresh active Notification or Delivery. A read/resolution failure after commit, owner exhaustion, or a later race with an already in-flight external POST remains an accepted best-effort limit; this is not a transaction with the decision and not exactly-once callbacks or messages. An independent still-waiting approval in the same run remains eligible because the source/guard includes `taskId`. A wake failure never erases the D1 decision, so it cannot reopen emission. Task reassignment continues to use its own added-assignee event and may create a new Notification after resolution.

## D5 — Persistence and lifecycle contract

### Tables and constraints

Applied SQL in the App journal is SSoT under ADR-0012; `notificationsDrizzleSchema` is exported from `@kit/notifications/schema` and composed by the App. Add catalog id/set `notifications`, opt-in by Products. This catalog id is **not a new governed Module that can turn Inbox off**. SQL migration numbering is independent of this ADR number and must not reuse the reserved pending tasks contract migration.

Implementation: `apps/example-api/migrations/0023_notifications.sql` and `packages/notifications/src/schema/`.

Slack owns installation, identity and credential tables, not a second destination configuration table. Changing the installation or channel creates a new destination identity; selector changes recheck pending delivery without redirecting it. Deleting a destination must not cascade away its Delivery history; pending deliveries observe absence and skip.

A fan-out spanning several batches has per-batch, not global, atomicity.

### State transitions and idempotence

Implementation: `packages/notifications/src/repos/`.

Read and resolved are independent: resolution never fabricates a read. Active duplicate notifications preserve the original parameters and read state; a resolved notification may be created anew, as reassignment requires. Approval opening still requires the D4 lifecycle guard. Admission uncertainty is independent of Delivery status and is not provider failure.

Collective active identity is per source/type/destination, independent of the User fan-out. Complete source resolution closes its active identity even if the Delivery was already sent/failed; User-filtered resolution does not. Deleting/purging history ends the corresponding historical deduplication guarantee.

A completed provider call may race source resolution or another in-flight attempt; CAS makes the stored terminal state monotone but cannot cancel external effects. A skipped row is not forensic proof that no external message ever existed. No application lease/recovery loop is added to pretend otherwise.

### Repository and assembly surfaces

Implementation: `packages/notifications/src/repos/` and `apps/example-api/src/services/notifications/service.ts`. ADR-0020 specifies the owner admission contract.

### Retention

Default App variables: `NOTIFICATIONS_RETENTION_DAYS=90`, `NOTIFICATION_DELIVERIES_RETENTION_DAYS=30`, positive integers. Notifications expire from creation; terminal User/Organization Deliveries from `finished_at`. Cron purges bounded org-scoped batches, never retries an effect. Notification deletion cascades its User Deliveries; before expiry, pending children become skipped/`notification_expired`. A late owner finding no row stops without provider. Nonterminal User Deliveries, including unknown/expired admission, end with the Notification's 90-day cascade: this is retention, **not** a claim the provider failed. Nonterminal Organization Deliveries expire at their own created_at + 90 days; terminal ones expire at finished_at + 30 days. Neither uncertainty nor admission expiry retains rows forever. Purge may project a skip before deletion, but must not fabricate a provider failure or restart an owner. The same no-send-on-missing-row guard applies to a late owner.

Changing retention must preserve ADR-0020's owner/admission horizon constraints. No purge implies cancellation of an in-flight provider call, replay deduplication forever, account deletion cleanup or GDPR export. Absent membership makes data inaccessible immediately; a future member-removal path may add cleanup without relaxing guards.

## D6 — HTTP interface

Implementation: `apps/example-api/src/routes/notifications/`. Endpoints are session-only; there is no client emit, resolve or redrive route, or public unsubscribe endpoint.

Destination DTO remains a target: [non-normative design note](../design-notes/0021-slack.md#routes-génériques-des-destinations).

Types are catalogue metadata, never source parameters/Zod schema/renderers. `available` in effective rules reflects the access ceiling separately from the rule's boolean. Delivery administration reveals metadata only: no title/body/parameters, email, address credential or provider response. No Delivery-status surface is exposed to a User in V0.

Unimplemented destination routes: [non-normative design note](../design-notes/0021-slack.md#routes-génériques-des-destinations).

Organization admin routes require Organization context + capability; authenticated member/reader receive 403, another Organization receives 404. Inbox/read routes never enable a super_admin bypass. User rules are global subject-owned rows even when the UI previews the current Organization. Installation, Slack channel discovery and User-link routes are specified by ADR-0021; they do not duplicate these generic destination endpoints.

### Cursors, errors and UI

Implementation: `apps/example-api/src/routes/notifications/`.

Pagination is not snapshot-isolated: concurrent writes may skip or repeat items. Cursor scope is not authorization; future key or grammar changes must preserve encode-to-request closure. User rules are global even when the UI previews an Organization. Catalogue parity must cover API and web; the existing web-only check does not prove API parity.

## D7 — Audit

Admin rule changes use `notification.rule.set` / `notification.rule.delete`, allowlisted selector/Channel/booleans, actor, target id and org or null; no email/parameters/provider text. Mutation and audit insert commit together. An unchanged upsert or absent delete emits no invented change. The existing best-effort `appendAudit` alone does not satisfy atomic audit.

User rule mutations and read marks are **not audited**. Slack destination changes use `slack.destination_created`, `slack.destination_updated`, `slack.destination_deleted`, with allowlisted installation/channel/selector metadata, atomic with the configuration mutation. Slack installation/revocation/link audit is specified by ADR-0021 and shares this no-secret policy; the audit listing remains super_admin-only. Support read bypass uses the existing log contract, not a claim of a new Organization audit UI.

## D8 — Delivery guards, guarantees and required proof

The strict, server-built Workflow input is only `DeliveryRef`: `{orgId,kind:'user'|'organization',id}`. No address, body, actor grant, retry stage or credential from a caller is authority. Load by kind/id/org. Each attempt rechecks current Organization/membership/Module, unresolved Notification/source receipt, rules and destination/installation configuration before address resolution/render/send. A definitive denial/unavailability stores skipped; a lookup failure retries under the owner, never fabricates a durable denial. No source-object ACL recheck is added.

An absent or terminal Delivery stops without provider. Retryable failure records only observation; the existing Workflow retries it. Sent/permanent/skipped outcomes persist before success/final disposition. The Workflow checkpoints a successful send outcome, then finalizes D1 in a separate owner-native step: a D1 receipt-write failure retries finalization, never replays a checkpointed successful send merely to regenerate its receipt. Provider acceptance before the native send-step checkpoint remains ambiguous and may duplicate on owner retry. Attempts count entered engine attempts, not a forensic count of provider accepts. Workflow admission status and execution finalization must be reconciled as ADR-0020 defines, never by recreating a terminated/expired identity.

The guarantee is durable, at-least-once processing **after successful admission**, subject to eligibility, owner policy and retention; ineligibility can stop a Delivery before provider contact. It is not exactly-once delivery, guaranteed provider acceptance, freedom from concurrent effects, unconditional admission after outages, or Workflow atomicity with business writes. Task write → afterMutation has a pre-notification gap; best-effort flow callbacks can lose notices/resolution. An absent D1 receipt does not prove an owner never existed. Reconciliation cannot extend the safe identity-retention horizon.

The final recheck is not atomic with an external POST: a decision/rule may change in flight. Guarantee no new attempt after a recheck **observes** denial/resolution, not no external message after the wall-clock instant of decision. A failed resolution callback can leave stale notices. Source routes always enforce current authority regardless.

Tests for the implemented paths live alongside `packages/notifications/src/` and `apps/example-api/src/notifications-delivery/`; these do not prove a live deployment or the unimplemented Slack and Organization delivery paths.

## Existing seams and alternatives

- Reuse membership, Role and Module facts; reject sender or support grants as recipient authority.
- Reuse shared pagination and error shapes rather than custom collection envelopes or offset pagination.
- Use optional producer ports rather than implicit recipients or a notifications tool; callback exhaustion must not fail the business run.
- Keep schema and repositories in the capability and SQL, routes and copy in the App; reject a capability hub in `@kit/db` and a provider-specific pure core.
- Use a complete Delivery Workflow with stable identity and bounded admission rather than Queue publication recovery, custom leases, a one-consumer `@kit/jobs` extraction or an exactly-once provider claim.

## Consequences and non-goals

- Products compose the capability without copying auth, pagination, persistence or provider plumbing. `@kit/db` remains handle-only, and no Package imports an App.
- The registry requires deployment for new types. Frozen display parameters trade live source redaction for stable rendering; privacy depends on reviewed minimal content and source-route authorization.
- Stable Workflow admission removes the Queue-publication ambiguity without providing an eternal identity or exactly-once side effect. Owner outages and bounded best-effort producers remain explicit operational limits.
- New external library inventory for Notifications is empty: reuse existing Zod/Drizzle/Hono/i18n workspaces. A security-library need in Slack is evaluated in ADR-0021, not forbidden by a zero-dependency slogan; any new dependency requires current stable registry verification and an explicit ADR reason.
- Marketing/broadcast, account-level Notifications, mandatory implementation, realtime, escalation/digest, arbitrary outgoing webhooks, public unsubscribe, machine notification routes, all-Organization Inbox, notification tools and automatic operator redrive are outside V0. This ADR is not deployment proof or a second Product adoption.
