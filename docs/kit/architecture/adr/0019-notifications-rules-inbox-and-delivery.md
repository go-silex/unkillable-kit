---
title: 'ADR-0019 — Notifications: rules, Inbox and external Delivery'
status: accepted
normative: true
date: 2026-10-22
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
---

# ADR-0019 — Notifications: rules, Inbox and external Delivery

Accepted on 2026-10-22. The repository contains `packages/notifications`, its schema and repositories, the catalogued `0023_notifications.sql`, and notification routes and services in `example-api`. The App composes `createNotificationService` and wires Task and Flow producers; regression suites for this composition and producers are present. User/email Delivery Workflow admission, reconciliation and execution are implemented; Slack and Organization/email remain uncomposed. These are partial implementation evidence, not proof that every contract below or its integration proofs is delivered. Live or deployed delivery remains unproven; acceptance is not deployment proof.

## Context and decision

Apps need one extractible Notifications capability for action-required notices, rather than separate implementations of preferences, recipient isolation and delivery guards. The first consumers are task assignment and flow approval in `example-api`. Product Notification types remain in Product Apps.

The Kit supplies `@kit/notifications`: a pure registry/resolver/Channel contract, an email layout, and separate schema/repository exports. The App owns its registry and copy, source authorization, `notify`/`resolve` composition, HTTP routes, bindings and producer wiring. **Access first, then Inbox always, then external Channels.**

A Cloudflare Workflow owns each complete external Delivery, with a stable instance identity. Automatic admission is bounded to 24 hours from intent creation, with retention of at least three days; only positive native evidence proves admission. Ambiguous admission is retried with the same ID inside that window, never by restarting or replacing the execution; after the deadline uncertainty remains visible without automatic recreation. The Workflow owns retries and finalization, and Cron only requests bounded admission or observes the owner. There is no Notifications Queue, generic outbox engine or `@kit/jobs` extraction for a fictitious second Queue consumer. ADR-0020 details that protocol; Slack installation, secrets and adapter are specified in ADR-0021.

## D1 — Ownership and access

| Owner                                                      | Interface responsibility                                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@kit/notifications`                                       | Pure type declarations, registration, resolution and email layout; no D1, bindings, `fetch`, ambient clock or global registry                          |
| `@kit/notifications/schema` and `@kit/notifications/repos` | Capability tables, atomic admissions, scoped queries and conditional receipts; no HTTP auth, runtime restart or custom scheduler                       |
| App                                                        | Producer authority, recipient ids and source ACL, registry/renderers/catalogues, current access facts, service factory, routes and Workflow entrypoint |
| Cloudflare Workflows                                       | Entire external Delivery and its failure retries; admission/reconciliation contract in ADR-0020, no second owner                                       |
| `@kit/slack/notifications`                                 | Implements the Channel interface with a **type-only** import from notifications; notifications never imports Slack                                     |

`orgId` is the Organization that owns the source. It is not the browser's selected Organization or the sender's Organization. Every recipient must be a real member of that Organization, which must be active. A type with `moduleId` also requires the recipient's effective Module **read** access: Deployment availability, Organization enablement and their Role–module grant. The sender's grants or support bypass never substitute for these checks.

The producer chooses explicit User ids using the action's authorization predicate, then excludes Users who cannot see the source according to its object ACL. The engine repeats membership/Module checks at admission, Inbox access and every external attempt. It does **not** re-read the source or object ACL at Inbox read or delivery: the emission-time display parameters may remain visible after loss of source-only access, while the source route returns 404. Stored parameters must be suitable for that disclosure.

A User's Inbox is scoped by `orgId + subject`, without support bypass. Organization administration uses `manage_notifications`, added to `OrgCapability`, its minimum-role map and the App guard wrapper with minimum `admin`. Support reads of administration metadata may use the existing explicit, logged super_admin read bypass; no new break-glass write route is introduced. A Platform Role never becomes an implicit notification recipient.

## D2 — Registry and pure resolution contract

### Registry

```ts
import type { z } from 'zod'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type SourceRef = Readonly<{ kind: string; id: string }>
type Selector =
  | Readonly<{ kind: 'type' | 'category'; value: string }>
  | Readonly<{ kind: 'all' }>
type InboxContent = Readonly<{ title: string; body: string; href: string }>
type EmailContent = Readonly<{ subject: string; text: string; html?: string }>
type RenderInput<P, L extends string> = Readonly<{
  orgId: string; source: SourceRef; params: P; locale: L; href: string
}>
type NotificationDefinition<S extends z.ZodType, M extends object, L extends string> = Readonly<{
  category: string
  moduleId?: string
  params: S
  channels: readonly (keyof M & string)[]
  defaultOn: readonly (keyof M & string)[]
  organizationDestinations?: true
  render: {
    in_app(input: RenderInput<z.output<S>, L>): InboxContent
  } & { [C in keyof M]?: (input: RenderInput<z.output<S>, L>) => M[C] }
}>
// Private construction brand; callers obtain it through defineNotificationType.
declare const notificationDefinition: unique symbol
type RegistryEntry = Readonly<{
  [notificationDefinition]: true
  params: z.ZodType; category: string; moduleId?: string
  channels: readonly string[]; defaultOn: readonly string[]
  organizationDestinations?: true
}>
type Registry = Readonly<Record<string, RegistryEntry>>
declare function defineNotificationType<S extends z.ZodType, M extends object, L extends string>(
  definition: NotificationDefinition<S, M, L>,
): NotificationDefinition<S, M, L> & RegistryEntry
declare function defineNotificationRegistry<const R extends Registry>(definitions: R): Readonly<R>
```

The Record key is the stable Notification type. Registration applies the ASCII key grammars and bounds in D5 to type/category/Channel keys, including dynamically supplied JavaScript definitions; Unicode keys are invalid, not transliterated. It validates unique external Channels, `defaultOn ⊆ channels`, an Inbox renderer and a renderer for every declared Channel. `in_app` is implicit and forbidden in both external arrays. Renderers and their message types belong to the App; the core has no Slack dependency.

Zod validates frozen, JSON-serializable display parameters both at admission and consumption. No secrets, tokens, private comments, rendered HTML snapshots or arbitrary provider payloads enter stored parameters. Parameter schemas must survive their JSON round-trip. Type changes must preserve retained rows; incompatible changes require an explicit data migration or a new type key, not an automatic legacy fallback. Missing types/renderers or corrupted parameters are configuration/data errors, never an invented authorized `on` result.

External Channels retain a declared order, but V0 executes fan-out: one Channel's failure never triggers another or suppresses Inbox. No escalation, digest or fallback chain is implemented.

### User rules

```ts
type Rule = Readonly<{
  selector: Selector; channel: string; enabled: boolean; locked: boolean
}>
type UserRule = Omit<Rule, 'locked'> & Readonly<{ locked: false }>
type AccessFacts = Readonly<{
  organizationActive: boolean; member: boolean; moduleReadable: boolean
}>
type RuleSource =
  | Readonly<{ level: 'deployment' | 'organization' | 'user'; selector: Selector }>
  | Readonly<{ level: 'type-default' }>
type ExternalDecision = Readonly<{
  channel: string; enabled: boolean; locked: boolean; source: RuleSource
}>
type UserResolution =
  | Readonly<{ admitted: false; reason: 'organization_inactive' | 'not_member' | 'module_denied' }>
  | Readonly<{ admitted: true; inbox: true; external: readonly ExternalDecision[] }>
declare function resolveUserNotification(input: Readonly<{
  typeKey: string; type: RegistryEntry; access: AccessFacts
  deploymentRules: readonly Rule[]
  organizationRules: readonly Rule[]
  userRules: readonly UserRule[]
}>): UserResolution
```

1. Denied Organization/membership/Module access returns `admitted:false`: no Notification or Delivery. For a type without a Module, `moduleReadable=true` is supplied explicitly.
2. Otherwise admit one Inbox Notification **before and independently of external rules**. No rule targets Inbox; there is no `in_app` Delivery.
3. For each declared external Channel, select the most specific matching rule **within each level**: type > category > `all`. Then apply the selected Deployment lock, else Organization lock, else first defined value in User > Organization > Deployment > type default order.
4. A User never locks. An unlocked Deployment off is a default, not a veto: an Organization may lock Slack on above it. A broad lock does not override a more specific rule at its own level; only that level's selected rule participates in the cross-level comparison.
5. **Email locked-on is invalid at every level.** Validate at write and SQL boundaries; invalid persisted rules fail closed for external Channels, never silently become on. `in_app`, unknown Channels and a rule that cannot match any declared Channel/type are rejected.

| Deployment / Organization / User                                       | External result; authorized Inbox remains present                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| locked-off / locked-on / on                                            | off, Deployment                                                                |
| unlocked-off / locked-on Slack / off                                   | on, Organization                                                               |
| unlocked-off / unlocked-off / on                                       | on, User                                                                       |
| category locked-off plus type unlocked-on at Deployment / absent / off | off, User; the Deployment type rule supersedes its category rule at that level |
| all absent                                                             | type default; an undeclared Channel is never added by `all`                    |

`mandatory` is **not exposed by the V0 registry or resolver**. Its reserved semantics are: a type-declared Channel bypasses rules only after access checks; absent address still skips. Only security or a legal/contractual obligation whose loss could harm a User/Organization qualifies, not business importance. Authentication reset, magic link and invitation emails remain outside this engine permanently, synchronous on EmailPort. A future Mandatory Channel requires its first concrete need and additive interface change; this ADR does not force any V0 email.

### Organization destinations

```ts
type DestinationFacts = Readonly<{
  configured: boolean; selector: Selector
  organizationActive: boolean; moduleEffective: boolean
}>
declare function resolveOrganizationDestination(input: Readonly<{
  typeKey: string; type: RegistryEntry; channel: string
  destination: DestinationFacts; deploymentRules: readonly Rule[]
}>): Readonly<{ enabled: boolean; reason: string }>
```

A destination must still exist and match its selector, the type must opt in, and the Organization's Module must be available/enabled. The selected Deployment **locked-off** rule is a ceiling. Unlocked defaults do not veto an explicitly configured destination; locked-on cannot create a missing destination or bypass type opt-in. Organization/User rules govern Users, not collective destinations.

Collective delivery is independent of recipient count, including zero. One destination produces one Delivery, not one per User. Each configured address has one selector; several distinct destinations are allowed. A destination is not an artificial User, has no Inbox and does not borrow an administrator's Role. Slack channels may contain guests/Slack Connect members; opting in is a reviewed disclosure decision. `tasks.assigned` never opts in; flow destination copy excludes prompts, tool arguments, receipts and private source content.

## D3 — Channel, rendering and App service

### External Channel

```ts
type ChannelResult =
  | Readonly<{ status: 'sent' }>
  | Readonly<{ status: 'retryable'; code: string; retryAfterSeconds?: number }>
  | Readonly<{ status: 'permanent'; code: string }>
type Channel<Input extends { orgId: string }> = Readonly<{
  send(input: Input): Promise<ChannelResult>
}>
type AddressResolution<A> =
  | Readonly<{ status: 'ready'; address: A }>
  | Readonly<{ status: 'unavailable'; code: string }>
  | Readonly<{ status: 'retryable'; code: string; retryAfterSeconds?: number }>
declare function renderNotificationEmail(input: Readonly<{
  content: EmailContent; manageRulesHref: string
  copy: Readonly<{ brand: string; manageRulesLabel: string }>
}>): EmailContent
```

The App resolves the address/current installation after access/rules, before `send`; unavailable means a stored skipped Delivery, not a fourth Channel result or false sent. Inputs remain org-scoped and provider-specific: the Slack input may require installation/generation/address/content without pushing those types into the core.

A Channel performs one attempt, classifies errors and returns a stable, scrubbed code; it never sleeps, retries itself, creates an execution or decides a durable retry plan. `retryAfterSeconds` is finite non-negative seconds, not milliseconds or an ambiguous timestamp. ADR-0020 owns how the Workflow schedules the next failed attempt. Sent means accepted by the configured transport, not receipt or reading by a User.

Inbox is rendered server-side at read time, using the App's `@kit/i18n` catalogues and the client's exact supported `Accept-Language` value. The existing `resolveLocale` does not parse regional tags or q-values: absent, unsupported or composite values fall back to `defaultLocale`. Email and Slack render at attempt time in the App default locale. No new User locale column is introduced.

The type renders email subject/body; the Kit layout guarantees a rules-management link in **both text and HTML**, with App-provided brand/link copy. The URL is constructed from trusted App configuration, never request Host/Origin or an arbitrary parameter URL; text/attributes are escaped. EmailPort's `{to,subject,text,html?}` shape is unchanged: no List-Unsubscribe header, public unsubscribe route or one-click claim. Every V0 email can be disabled through the authenticated User rules screen. Existing staging allowlist, From pin and subject-prefix protections remain in effect.

CF rate/daily/internal errors are retryable; malformed address/payload, allowlist rejection, unverified sender and suppressed/forbidden recipient are permanent. Unknown network/outcome failures are retryable, not evidence of no effect. `{ok:false}` from an EmailPort is not sent. Classify observed provider codes at the email adapter; do not claim EmailPort already guarantees an error taxonomy or expose exception text. Slack error mapping, supported Block Kit subset and link-preserving truncation belong to ADR-0021; the Kit's 4,000-character text bound is stricter than Slack's provider truncation limit.

### Service factory

```ts
import { z } from 'zod'
const deliveryRefSchema = z.strictObject({
  orgId: z.string().min(1).max(256),
  kind: z.enum(['user', 'organization']),
  id: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
})
type DeliveryRef = Readonly<z.infer<typeof deliveryRefSchema>>
type NotifyInput<R extends Registry> = {
  [K in keyof R & string]: Readonly<{
    orgId: string; type: K; source: SourceRef
    userIds: readonly string[]; actorId?: string; params: z.input<R[K]['params']>
  }>
}[keyof R & string]
type ResolveInput = Readonly<{
  orgId: string; source: SourceRef; types?: readonly string[]; userIds?: readonly string[]
}>
type NotifyResult = Readonly<{
  createdNotificationIds: readonly string[]; createdDeliveries: readonly DeliveryRef[]
}>
type ResolveResult = Readonly<{
  resolvedNotifications: number; skippedDeliveries: number; resolvedOrganizationDeliveries: number
}>
type NotificationService<R extends Registry> = Readonly<{
  notify(input: NotifyInput<R>): Promise<NotifyResult>
  resolve(input: ResolveInput): Promise<ResolveResult>
}>
type NotificationAppPorts = Readonly<{
  recipientAccess(input: { orgId: string; userIds: readonly string[]; moduleId?: string }):
    Promise<ReadonlyMap<string, AccessFacts>>
  rules(input: { orgId: string; userIds: readonly string[] }): Promise<Readonly<{
    deployment: readonly Rule[]; organization: readonly Rule[]
    users: ReadonlyMap<string, readonly UserRule[]>
  }>>
  destinations(input: { orgId: string; type: string; moduleId?: string }):
    Promise<readonly ConfiguredDestination[]>
  admit(input: AdmissionBatch): Promise<NotifyResult>
  resolve(input: ResolveInput & { now: number }): Promise<ResolveResult>
  ensureDeliveryAdmission(ref: DeliveryRef): Promise<void>
  reportFailure(input: { operation: 'admission'; ref: DeliveryRef; code: string }): void
}>
declare function createNotificationService<const R extends Registry>(input: Readonly<{
  registry: R; ports: NotificationAppPorts; now: () => number; newId: () => string
}>): NotificationService<R>
```

The App factory closes these ports over its adapters; it does not move bindings into the pure package. `ConfiguredDestination` and `AdmissionBatch` are defined in D5. `notify` and `resolve` are server-only calls: no client route, MCP tool or flows tool exists.

`notify` validates type/source/ids/parameters before writing, deduplicates User ids and excludes `actorId` **only when provided**. Missing access facts fail closed. It creates an Inbox Notification for each authorized recipient, independently resolves external Channels, and adds collective destinations from Organization configuration, never producer-supplied destinations. Data-access errors fail the operation rather than becoming invented on rules or authority; only the supplied caller owner may retry a real failure. An external on/off decision never suppresses an authorized Inbox. Atomicity guarantees apply to successful admission, not to an unavailable database.

Admission writes each Notification and its initial external Delivery intentions atomically. Conflicting active Notifications cause no new row, parameter overwrite or Delivery. After commit, the App requests admission of only newly created Deliveries using their stable identities. A failed/ambiguous runtime admission does not roll back Inbox or send directly; it is reported, remains represented by its admission receipt, and follows ADR-0020's bounded reconciliation. A repeated `notify` does not republish prior work.

`resolve` is idempotent and never marks read. Omitted `types` means all types of that source; omitted `userIds` means all Users **and** collective Deliveries. Provided `userIds` restricts to those Users and never resolves collective delivery. Explicit empty arrays are no-op, not all. Changes to Notification resolution and pending Delivery skips share a batch. No caller may supply another Organization through a filter or patch.

## D4 — Producers and best-effort flow ports

| Type                       | Declaration and recipients                                                                                                                                                                                                                             | Resolution                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks.assigned`           | Category `tasks`; `moduleId:'tasks'`; external order email then Slack, both **on by default**; no destination opt-in. Notify added assignees, filtered with each recipient's Audience/object ACL. `actorId` is the assigning User.                     | Removed assignee: that User only. Deleted/done/terminal-stage task: all. Reopening alone does not re-notify.                                  |
| `flows.approval_requested` | Category `flows`; `moduleId:'flows'`; email then Slack, both **on by default**; `organizationDestinations:true`. Explicit members satisfying `canDecideFlowApproval` / `FLOWS_ADMIN_ROLES`; **no actorId**, including a run started by its sole owner. | Decision row approved/rejected: route resolves immediately; expiration: close port; cancellation: route resolves before Workflow termination. |

The dogfood payload schemas are App-owned and strict. Tasks retain only a display title; approval copy is generic and derives its authenticated link from the source tuple. No sender name, User email, plan prompt or approval instruction is retained.

```ts
import { z } from 'zod'
import { MAX_TASK_TITLE_LEN } from '@kit/tasks'
const assignedParams = z.strictObject({
  taskTitle: z.string().min(1).max(MAX_TASK_TITLE_LEN),
})
const approvalRequestedParams = z.strictObject({})
```

Task source is `{kind:'task',id:taskId}`. Approval source is `{kind:'flow_approval',id:JSON.stringify([runId,taskId])}`: simultaneous approvals in one run are distinct. Cancellation resolves each approval source from the immutable Runner View, never a live plan or an ambiguous prefix query. Source links still enforce current source-route auth/ACL.

```ts
// Additive to TaskMutationEvent; not audit metadata.
type AssigneeDelta = { added: string[]; removed: string[] }
// assignees?: AssigneeDelta

type ApprovalNotice = Readonly<{ orgId: string; runId: string; taskId: string }>
type ApprovalNotificationPorts = Readonly<{
  opened?: (notice: ApprovalNotice) => Promise<void>
  closed?: (notice: ApprovalNotice & Readonly<{
    outcome: 'approved' | 'rejected' | 'expired' | 'cancelled'
  }>) => Promise<void>
}>
// Additive driveFlowRun input: approvalNotifications?: ApprovalNotificationPorts
```

The App computes task deltas at create/update: creation adds all assignees; differences are sets without duplicates; unchanged assignments omit the field. Assignment membership alone does not prove object visibility. Existing callers without these optional additions keep their behavior.

Opening and closing callbacks run inside dedicated, stably named steps of the **caller-owned plan Workflow**, using the existing idempotent read/write step retry limit of three retries. Retry follows an actual failed callback; it is not a continuation or a fresh run. After owner-native exhaustion, log a scrubbed structured failure and continue the plan. No nested retry loop, custom recovery record, restart or Queue forwarding is introduced. Callback count is not exactly-once under replay. `notify`'s active uniqueness is not a permanent opening-event fence: approval opening also requires the App lifecycle guard below; task reassignment must remain possible.

These callbacks are **bounded best-effort**: loss of a Notification or resolution is admitted. They must never approve a task, undo a D1 decision, change the run's authority, or fail the run solely because the notification callback exhausted retries. A Workflow terminated by cancellation may not execute its close callback; decision/cancellation routes therefore resolve independently, including already-decided/already-cancelled idempotent success paths. Resolution failure is reported without reversing the committed business decision. A stale Inbox/action-required notice may remain until a later legitimate resolution or retention; its link confers no authority.

### Approval opening lifecycle guard — App producer, not generic Delivery

The App `opened` callback treats the current org-scoped D1 run, its persisted task receipt and approval decision as the lifecycle authority. The opening is eligible only if the run is still `running`, the immutable Runner View identifies that approve task, its D1 receipt is `waiting`, and there is no `approved`, `rejected` or `expired` decision row. Missing/deleted/closed runs, cancelled runs, non-waiting tasks and any terminal approval decision cannot authorize an opening. A failed/corrupt read is an actual callback failure, not an invented open state. This reads lifecycle facts for **emission**, not object ACL/content at Inbox read or external send.

1. At **every actual invocation/retry** of `opened`, read that current lifecycle inside the callback. Do not reuse an `open` result checkpointed separately before it. If the lifecycle is no longer open, do not call `notify`; idempotently `resolve` the approval source to close any earlier notice, then return.
2. If open, call `notify` for `flows.approval_requested` and the exact `(orgId,runId,taskId)` source, with no actor exclusion. The active unique constraint handles concurrent admissible calls, but is not the lifecycle proof.
3. After `notify` succeeds, **read the lifecycle again**. If it closed between the first read and notification commit, resolve that exact source across Users and collective destinations, even when the decision/cancel route already resolved before the new rows existed.
4. The lifecycle reads, notification and compensating resolution stay inside the existing bounded best-effort owner step. A failure propagates to that step's native retry; a retry starts again at the first live guard. Exhaustion logs and continues. No permanent dedup journal, new execution owner or generic ban on `notify` after resolution is introduced.

Thus successful `opened → closed/resolve → replay(opened)` observes the terminal D1 lifecycle and creates no fresh active Notification or Delivery. A read/resolution failure after commit, owner exhaustion, or a later race with an already in-flight external POST remains an accepted best-effort limit; this is not a transaction with the decision and not exactly-once callbacks or messages. An independent still-waiting approval in the same run remains eligible because the source/guard includes `taskId`. A wake failure never erases the D1 decision, so it cannot reopen emission. Task reassignment continues to use its own added-assignee event and may create a new Notification after resolution.

## D5 — Persistence and lifecycle contract

### Tables and constraints

Applied SQL in the App journal is SSoT under ADR-0012; `notificationsDrizzleSchema` is exported from `@kit/notifications/schema` and composed by the App. Add catalog id/set `notifications`, opt-in by Products. This catalog id is **not a new governed Module that can turn Inbox off**. SQL migration numbering is independent of this ADR number and must not reuse the reserved pending tasks contract migration.

Dates are safe integer epoch milliseconds in `0..Number.MAX_SAFE_INTEGER` (at most 16 decimal digits); derived deadlines must remain in that range. All Notifications-owned row ids that can enter a cursor (Notifications, rules, destinations and both Delivery tables) are **ASCII full-string identifiers** of length 1..256 matching `[A-Za-z0-9][A-Za-z0-9._-]*`. Type/category keys are 1..128 matching `[a-z][a-z0-9._-]*`; Channel keys use that same grammar with length 1..64. These characters require no JSON escaping and each occupies one UTF-8 byte. The policy applies to all such keys, not only a failing Unicode example.

```ts
const typeKeySchema = z.string().min(1).max(128).regex(/^[a-z][a-z0-9._-]*$/)
const channelKeySchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9._-]*$/)
const cursorRowIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const epochMsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
```

Apply these validations at registration, selectors/route inputs, repository writes and decoded keysets. The App's injected `newId` must return a collision-resistant ASCII id of length **1..254**, validated before writing its batch; the `u_`/`o_` prefixes leave Delivery ids within 256. A nonconforming generator is an App configuration error, never a value to silently truncate, normalize or transliterate. SQL constraints/repository admission preserve these persisted bounds so every selected key is encodable. Type/category selector values obey their key grammar; `all` forbids a request `value`.

Source kind remains ≤64 and source id ≤1024 characters; non-secret destination external ids remain non-empty ≤1024. Organization/User/actor identity references retain their id bounds and are scoped explicitly, not inserted into a cursor. Localized titles, bodies, display parameters, source ids, external addresses and catalogue text are **not** restricted to ASCII by this cursor policy. Parameters follow the type's bounded JSON schema. No FK targets Better Auth or a polymorphic source. Internal tenant FKs include Organization.

| Table                                                                                                     | Fields / constraints                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kit_notifications`                                                                                       | `id` PK; `org_id,user_id,type_key,source_kind,source_id,params_json,created_at` required; `module_id,read_at,resolved_at` nullable. Unique `(id,org_id)`; unique active `(org_id,type_key,source_kind,source_id,user_id) WHERE resolved_at IS NULL`.                                                         |
| `kit_notification_deliveries`                                                                             | `id` PK; `org_id,notification_id,channel,status,created_at` required. Unique `(org_id,notification_id,channel)`; FK `(notification_id,org_id)` → Notifications `(id,org_id)` CASCADE. Owner/attempt receipt fields below.                                                                                    |
| `kit_notification_organization_deliveries`                                                                | `id` PK; `org_id,destination_id,channel,type_key,source_kind,source_id,params_json,status,created_at` required; `module_id,resolved_at` nullable. Same owner/attempt receipt fields. Unique active `(org_id,destination_id,channel,type_key,source_kind,source_id) WHERE resolved_at IS NULL`. No Inbox row. |
| `kit_notification_destinations`                                                                           | `id` PK; `org_id,channel,external_id,selector_kind,selector_value,created_at,updated_at`; unique `(id,org_id)` and `(org_id,channel,external_id)`. One effective address + selector per row; no token.                                                                                                       |
| `kit_notification_deployment_rules`, `kit_notification_organization_rules`, `kit_notification_user_rules` | Rule id, selector kind/value, Channel, enabled/locked, created/updated dates. Deployment: neither org nor User. Organization: required `org_id`. User: required `user_id`, **no org**, `locked=0`. Unique natural selector/Channel key within that owner.                                                    |

User Delivery ids begin `u_`, Organization Delivery ids `o_`, followed by the App's collision-resistant id; both stay within 256 characters. The prefix provides a total ordering across the two tables.

Shared Delivery receipt fields: immutable `workflow_id`; `admission_status` (`pending`, `admitted`, `unknown`, `expired`); `admission_deadline_at`; nullable `admitted_at,last_admission_check_at`; `attempt_count DEFAULT 0`; nullable `last_attempt_at,error_code,finished_at`. These are admission/observation receipts, not an application execution cursor. The deadline is **intent created_at + 24 hours**, valid for the Free/Paid owner retention contract. No automatic create occurs after it. Expiration never marks provider failure: `pending`/`unknown` admission becomes `expired`, while an unproven Delivery remains pending. A later positive Workflow/get observation may establish admitted, but cannot authorize recreation. ADR-0020 defines the safe CAS updates, stable 70-character identity and owner retention preconditions. No `enqueued_at`, next-attempt timestamp, owner lease, application stage or custom retry budget is used.

`status IN ('pending','sent','failed','skipped')`; no `in_app` Channel. Booleans are 0/1; attempt counts non-negative; JSON valid. `all` selector is normalized to SQL value `'*'`. SQL and request checks forbid email enabled+locked and any User lock. `module_id` is derived from registration; it is not producer input. Registry/row disagreement refuses external effects rather than bypassing Module checks.

Slack owns installation/identity/credential tables, not a second destination configuration table. Its destination `external_id` is `JSON.stringify(['slack',installationId,slackChannelId])`; changing installation/channel creates a new destination identity. A selector change rechecks pending delivery without redirecting it elsewhere. Deleting a destination must not cascade away its Delivery history; pending deliveries observe absence and skip. The destination id references configuration logically, without a destructive FK coupling its history to configuration.

Indexes cover Inbox `(org_id,user_id,created_at DESC,id DESC)`, active uniqueness, `(org_id,source_kind,source_id)`, org Delivery status/date, admission-status/deadline scans and terminal `finished_at`. Apply Module/owner predicates **before** pagination/count/read-all. Reuse `D1_IN_ARRAY_CHUNK=80` for suitable IN queries; multi-row inserts calculate rows from the 100-parameter **per-statement** limit, not 100 recipients. A fan-out spanning several batches has per-batch, not global, atomicity.

### State transitions and idempotence

| Object                | Transition                                             | Consequence                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notification          | Create unread/unresolved; mark read once; resolve once | Read and resolved are independent timestamps: another person can finish an unseen action. Unread count requires **both null**. Resolving never fabricates a read.                               |
| Active Notification   | Duplicate notify                                       | SQL uniqueness wins atomically; preserve initial parameters/read state. Do not create Channels that became enabled later. Read but unresolved still deduplicates.                               |
| Resolved Notification | New notify of same source/type/User                    | New Notification allowed, needed for reassignment. Approval `opened` must first pass D4's current lifecycle guard; active-action uniqueness alone is not permanent opening-event deduplication. |
| Delivery              | pending → sent / failed / skipped                      | Terminal CAS, `finished_at` set; no automatic resurrection. Resolving its source skips pending only.                                                                                            |
| Admission receipt     | pending/unknown → admitted or expired under ADR-0020   | Independent of Delivery status. Unknown/expired does not prove absence or failure of the Workflow and is not a provider failure.                                                                |

Collective active identity is per source/type/destination, independent of the User fan-out. Complete source resolution closes its active identity even if the Delivery was already sent/failed; User-filtered resolution does not. Deleting/purging history ends the corresponding historical deduplication guarantee.

A completed provider call may race source resolution or another in-flight attempt; CAS makes the stored terminal state monotone but cannot cancel external effects. A skipped row is not forensic proof that no external message ever existed. No application lease/recovery loop is added to pretend otherwise.

### Repository and assembly surfaces

```ts
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { ListPage, ListQuery } from '@kit/types'
type Db = DrizzleD1Database<Record<string, unknown>>
type RuleScope = { level: 'deployment' } | { level: 'organization'; orgId: string }
  | { level: 'user'; userId: string }
type DestinationRow = Readonly<{
  id: string; orgId: string; channel: string; externalId: string; selector: Selector
  createdAt: number; updatedAt: number
}>
type ConfiguredDestination = DestinationRow & Readonly<{ facts: DestinationFacts }>
type AdmissionBatch = Readonly<{
  orgId: string; type: string; moduleId: string | null; source: SourceRef; params: Json; now: number
  users: readonly Readonly<{
    id: string; userId: string; deliveries: readonly Readonly<{ id: string; channel: string }>[]
  }>[]
  organizations: readonly Readonly<{ id: string; destinationId: string; channel: string }>[]
}>
type InboxScope = { orgId: string; userId: string; readableModuleIds: readonly string[] }
type NotificationRow = Readonly<{
  id: string; orgId: string; userId: string; type: string; moduleId: string | null
  source: SourceRef; params: Json; createdAt: number; readAt: number | null; resolvedAt: number | null
}>
type DeliveryState = 'pending' | 'sent' | 'failed' | 'skipped'
type DeliveryRow = Readonly<{
  ref: DeliveryRef; channel: string; type: string; moduleId: string | null; source: SourceRef
  params: Json; userId: string | null; destinationId: string | null; resolvedAt: number | null
  status: DeliveryState; workflowId: string; admissionStatus: 'pending' | 'admitted' | 'unknown' | 'expired'
  admissionDeadlineAt: number; admittedAt: number | null; lastAdmissionCheckAt: number | null
  attemptCount: number; lastAttemptAt: number | null; errorCode: string | null
  createdAt: number; finishedAt: number | null
}>
type RuleRow = Rule & Readonly<{ id: string; createdAt: number; updatedAt: number }>
type AuditRow = Readonly<{
  id: string; actorUserId: string; orgId: string | null; targetId: string
  action: string // App allowlist; concrete rule actions are fixed in D7.
  meta: Readonly<Record<string, Json>>; createdAt: number
}>
type AdmissionOwnerIdentity = Readonly<{
  ref: DeliveryRef; workflowId: string; admissionDeadlineAt: number
}>
declare function admitNotifications(db: Db, input: AdmissionBatch,
  ownerIdentities: readonly AdmissionOwnerIdentity[]): Promise<NotifyResult>
declare function resolveNotifications(db: Db, input: ResolveInput & { now: number }): Promise<ResolveResult>
declare function listInbox(db: Db, scope: InboxScope, query: ListQuery & { unreadOnly: boolean }):
  Promise<ListPage<NotificationRow>>
declare function countUnread(db: Db, scope: InboxScope): Promise<number>
declare function markRead(db: Db, scope: InboxScope, input: { id?: string; now: number }): Promise<number>
declare function listRules(db: Db, scope: RuleScope, query: ListQuery): Promise<ListPage<RuleRow>>
declare function putRule(db: Db, scope: RuleScope, rule: Omit<RuleRow, 'createdAt' | 'updatedAt'>,
  now: number, audit?: AuditRow): Promise<RuleRow>
declare function deleteRule(db: Db, scope: RuleScope, id: string, audit?: AuditRow): Promise<boolean>
declare function loadDelivery(db: Db, ref: DeliveryRef): Promise<DeliveryRow | null>
// Additional @kit/notifications/repos exports for E2 -> E5.
// Named types and the storage/CAS contract are defined once in ADR-0020.
declare function listDeliveryAdmissionCandidates(
  db: Db, scope: Readonly<{ orgId: string }>, query: DeliveryAdmissionCandidatesQuery,
): Promise<ListPage<DeliveryAdmissionCandidate>>
declare function recordDeliveryAdmissionObservation(
  db: Db, input: RecordDeliveryAdmissionObservationInput,
): Promise<DeliveryAdmissionWriteResult>
declare function recordAttempt(db: Db, ref: DeliveryRef, now: number): Promise<boolean>
declare function recordRetryableFailure(db: Db, ref: DeliveryRef, code: string, now: number): Promise<boolean>
declare function finishDelivery(db: Db, ref: DeliveryRef,
  outcome: { status: Exclude<DeliveryState, 'pending'>; code?: string }, now: number): Promise<boolean>
declare function listDeliveryMetadata(db: Db, scope: { orgId: string }, query: DeliveryQuery):
  Promise<ListPage<DeliveryMetadata>>
declare function listDeploymentFailures(db: Db, query: DeliveryQuery):
  Promise<ListPage<DeliveryMetadata & { orgId: string }>>
declare function createDestination(db: Db, input: {
  orgId: string; id: string; channel: string; externalId: string; selector: Selector
  now: number; audit: AuditRow
}): Promise<DestinationRow>
declare function updateDestinationSelector(db: Db, input: {
  orgId: string; id: string; selector: Selector; now: number; audit: AuditRow
}): Promise<DestinationRow | null>
declare function listDestinations(db: Db, orgId: string, query: ListQuery):
  Promise<ListPage<DestinationRow>>
declare function deleteDestination(db: Db, orgId: string, id: string, audit: AuditRow): Promise<boolean>
declare function purgeNotifications(db: Db, input: {
  orgId: string; now: number; notificationCutoff: number; deliveryCutoff: number; batchSize: number
}): Promise<{ notifications: number; deliveries: number; organizationDeliveries: number }>
```

The App admission adapter derives immutable owner identities/deadlines using ADR-0020, then passes them explicitly to the repository; identities must exactly cover the batch's Delivery refs. The repository imports no owner runtime. It inserts all rows for the batch atomically. Insert Deliveries only for a **newly inserted** Notification id, not the existing conflicting id. Missing rows return null; writes always include org, relevant owner and expected state. Patch inputs cannot move org/User/source/identity. Rule scope is a discriminated union: optional org must never turn a tenant read into a Deployment read. Destination write inputs contain configuration only; the App supplies fresh access `facts` separately for resolution. Address identity is immutable. Every destination create/update/delete commits with its allowlisted audit row; absence/unchanged state emits no invented change.

Admin rule writes require an audit argument at runtime and batch it with the mutation; User scope rejects audit. `markRead` without id updates only the caller's currently visible Notifications. `listDeploymentFailures` imposes failed status and is a separately authorized surface, not an unscoped variant hidden behind optional org. The two admission functions declared above and their public types `DeliveryAdmissionReceipt`, `DeliveryAdmissionCandidate`, `DeliveryAdmissionCandidatesQuery`, `DeliveryAdmissionObservation`, `RecordDeliveryAdmissionObservationInput`, `DeliveryAdmissionWriteResult` are part of **the same E2 repository delivery**, consumed by E5. [ADR-0020](./0020-notification-delivery-ownership.md), section **Contrat repository `@kit/notifications/repos` — E2 → E5**, is their single canonical definition for inputs/results, positive-observation CAS, monotonic timestamps, expiry and fair org-scoped pagination; this ADR identifies the package export/ownership, not a second CAS policy. E2 must deliver those exports alongside the other repos; E5 must not invent another storage interface or a generic resume/recover API.

### Retention

Default App variables: `NOTIFICATIONS_RETENTION_DAYS=90`, `NOTIFICATION_DELIVERIES_RETENTION_DAYS=30`, positive integers. Notifications expire from creation; terminal User/Organization Deliveries from `finished_at`. Cron purges bounded org-scoped batches, never retries an effect. Notification deletion cascades its User Deliveries; before expiry, pending children become skipped/`notification_expired`. A late owner finding no row stops without provider. Nonterminal User Deliveries, including unknown/expired admission, end with the Notification's 90-day cascade: this is retention, **not** a claim the provider failed. Nonterminal Organization Deliveries expire at their own created_at + 90 days; terminal ones expire at finished_at + 30 days. Neither uncertainty nor admission expiry retains rows forever. Purge may project a skip before deletion, but must not fabricate a provider failure or restart an owner. The same no-send-on-missing-row guard applies to a late owner.

Changing retention must preserve ADR-0020's owner/admission horizon constraints. No purge implies cancellation of an in-flight provider call, replay deduplication forever, account deletion cleanup or GDPR export. Absent membership makes data inaccessible immediately; a future member-removal path may add cleanup without relaxing guards.

## D6 — HTTP interface

Every endpoint uses `createRoute`, exact Zod schemas and `sessionOnlySecurity`. Start page queries from `listQuerySchema.omit({q:true})`, add only the documented filters and reject unknown keys; Notifications does not implicitly add search. `requireAuth` precedes `requireSession`; no credential gives 401, an authenticated `sk_` gives 403. There is no client emit/resolve/redrive route or public unsubscribe endpoint. All query keys are single-valued; repeated keys fail 400. Mutations use strict JSON bodies.

### DTOs

```ts
type Page<T> = { items: T[]; nextCursor: string | null; requestId: string }
type RuleDto = {
  id: string; selector: Selector; channel: string; enabled: boolean; locked: boolean
  createdAt: number; updatedAt: number
}
type InboxDto = {
  id: string; type: string; source: SourceRef; content: InboxContent
  createdAt: number; readAt: number | null; resolvedAt: number | null
}
type TypeDto = {
  type: string; category: string; moduleId: string | null
  channels: string[]; defaultOn: string[]; organizationDestinations: boolean
}
type EffectiveRuleDto = {
  type: string; channel: string; enabled: boolean; locked: boolean
  source: RuleSource; available: boolean
}
type DeliveryMetadata = {
  id: string; targetKind: 'user' | 'organization'; userId: string | null; destinationId: string | null
  type: string; channel: string; status: DeliveryState; errorCode: string | null; attemptCount: number
  admissionStatus: 'pending' | 'admitted' | 'unknown' | 'expired'
  createdAt: number; finishedAt: number | null
}
type DeliveryQuery = ListQuery & {
  status?: DeliveryState; channel?: string; type?: string; targetKind?: 'user' | 'organization'
}
type DestinationDto = {
  id: string; channel: string; externalId: string; selector: Selector
  createdAt: number; updatedAt: number
}
// The failure body is the existing ApiErrorBody from @kit/types, not a new envelope.
```

Types are catalogue metadata, never source parameters/Zod schema/renderers. `available` in effective rules reflects the access ceiling separately from the rule's boolean. Delivery administration reveals metadata only: no title/body/parameters, email, address credential or provider response. No Delivery-status surface is exposed to a User in V0.

### User routes

| Method and path                                       | Request                      | 200 response / additional scope                                    |
| ----------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| GET `/api/notification-types`                         | Page query                   | `Page<TypeDto>`; static App registry metadata                      |
| GET `/api/me/notification-rules`                      | Page query                   | `Page<RuleDto>` for subject, no Organization context               |
| PUT `/api/me/notification-rules`                      | `{selector,channel,enabled}` | `{rule:RuleDto,requestId}` natural-key upsert; locked always false |
| DELETE `/api/me/notification-rules/{ruleId}`          | No body                      | `{ok:true,requestId}` for subject-owned rule only                  |
| GET `/api/orgs/{orgId}/notifications/effective-rules` | Page query                   | `Page<EffectiveRuleDto>`; subject membership, no support bypass    |

| Method and path                                              | Request     | 200 response / additional scope                                                                       |
| ------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------- |
| GET `/api/orgs/{orgId}/notifications`                        | `filter=all | unread` default all + page query                                                                      | `Page<InboxDto>` for subject; Module filter before keyset; all includes retained resolved rows |
| GET `/api/orgs/{orgId}/notifications/unread-count`           | None        | `{unreadCount:number,requestId}` with the same visibility predicate                                   |
| POST `/api/orgs/{orgId}/notifications/{notificationId}/read` | `{}`        | `{ok:true,requestId}`; scoped lookup, first read only                                                 |
| POST `/api/orgs/{orgId}/notifications/read-all`              | `{}`        | `{ok:true,updated:number,requestId}`; currently visible rows, no concurrent-insert snapshot guarantee |

### Administration routes

| Method and path                                    | Request                                   | 200 response / authorization                                                       |
| -------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| GET `/api/platform/notification-rules`             | Page query                                | `Page<RuleDto>`; super_admin or staff                                              |
| PUT `/api/platform/notification-rules`             | `{selector,channel,enabled,locked}`       | `{rule:RuleDto,requestId}`; super_admin                                            |
| DELETE `/api/platform/notification-rules/{ruleId}` | No body                                   | `{ok:true,requestId}`; super_admin                                                 |
| GET `/api/platform/notification-deliveries`        | `channel?,type?,targetKind?` + page query | `Page<DeliveryMetadata & {orgId:string}>`; **failed only**, super_admin, not staff |

| Method and path                                                      | Request                                           | 200 response / authorization                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| GET `/api/orgs/{orgId}/notification-rules`                           | Page query                                        | `Page<RuleDto>`; manage_notifications                                                                              |
| PUT `/api/orgs/{orgId}/notification-rules`                           | `{selector,channel,enabled,locked}`               | `{rule:RuleDto,requestId}`; manage_notifications                                                                   |
| DELETE `/api/orgs/{orgId}/notification-rules/{ruleId}`               | No body                                           | `{ok:true,requestId}`; manage_notifications                                                                        |
| GET `/api/orgs/{orgId}/notification-deliveries`                      | `status?,channel?,type?,targetKind?` + page query | `Page<DeliveryMetadata>`; manage_notifications                                                                     |
| GET `/api/orgs/{orgId}/notification-destinations`                    | Page query                                        | `Page<DestinationDto>`; manage_notifications                                                                       |
| POST `/api/orgs/{orgId}/notification-destinations`                   | `{channel,externalId,selector}`                   | **201** `{destination:DestinationDto,requestId}`; manage_notifications; validate installed address and type opt-in |
| PUT `/api/orgs/{orgId}/notification-destinations/{destinationId}`    | `{selector}`                                      | `{destination:DestinationDto,requestId}`; address identity immutable                                               |
| DELETE `/api/orgs/{orgId}/notification-destinations/{destinationId}` | No body                                           | `{ok:true,requestId}`; manage_notifications                                                                        |

Organization admin routes require Organization context + capability; authenticated member/reader receive 403, another Organization receives 404. Inbox/read routes never enable a super_admin bypass. User rules are global subject-owned rows even when the UI previews the current Organization. Installation, Slack channel discovery and User-link routes are specified by ADR-0021; they do not duplicate these generic destination endpoints.

### Cursors, errors and UI

Page query is `limit?: integer 1..100` (default 50), `cursor?: string` ≤512 characters. Reuse ADR-0010 helpers from `@kit/core`, `limit+1` and `{items,nextCursor,requestId}`; no offset, total or resource-key envelope. Dates/cursors use epoch milliseconds. Exact decoded keys:

| List                                   | Keyset and order                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Inbox, rules, destinations, Deliveries | `{createdAt:number,id:string}`; `created_at DESC,id DESC`; seek lower date, or equal date and lower id |
| Registry types                         | `{type:string}`; lexical ascending                                                                     |
| Effective type/Channel rules           | `{type:string,channel:string}`; lexical ascending                                                      |

Decoded HTTP keysets must have exactly these keys, the D5 ASCII key/id grammars and bounds, and safe integer epoch dates. A Unicode/escaped/control-character identifier is not a valid key even if its character count fits. Unknown keys/malformed encoding fail generic 400 without exposing decoded contents. User/Organization scope is applied independently of cursor content; changing filters is an allowed seek, not authorization. Union Delivery ids have distinct kind prefixes for total order. Concurrent writes may skip/repeat items; pagination is not snapshot-isolated.

Every encoder output must be accepted again by the same ≤512-character request schema. With compact `JSON.stringify`, ASCII keys/ids requiring no escaping, and dates bounded by `Number.MAX_SAFE_INTEGER`, the static upper bounds are:

| Cursor                                                               | Maximum UTF-8 JSON bytes           | Maximum unpadded base64url characters              |
| -------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------- |
| `{type}`                                                             | `128 + 11 = 139`                   | `ceil(4 × 139 / 3) = 186`                          |
| `{type,channel}`                                                     | `128 + 64 + 24 = 216`              | `288`                                              |
| `{createdAt,id}`                                                     | `16 + 256 + 22 = 294`              | `392`                                              |
| Internal admission `{asOf,lastCheckAt,createdAt,kind,id}` (ADR-0020) | `3 × 16 + 14 + 258 + 45 + 6 = 371` | `ceil(4 × 371 / 3) = 495` (≤496 even with padding) |

The admission cursor uses `lastCheckAt=-1` for a null stored observation, because the shared generic record decoder accepts strings/numbers, not null. Its kind is at most `organization` (12 ASCII bytes), its id is bounded as above, and ADR-0020 defines its exact validation/order/paging policy. These are JSON record cursors through the existing helpers, not an array codec or a change to ADR-0010. The shared 512-character cap is retained. A raw cursor must be ASCII base64url and within that cap before decoding; after generic decode, the endpoint validates the exact key schema before SQL. Future key/grammar changes must re-establish encode→request closure rather than raising the shared limit or truncating an emitted cursor.

Use `AppError`/`toApiErrorBody` and existing error codes with body/header requestId: 400 VALIDATION_ERROR for schema/query/cursor/unsupported rule; 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND for foreign or unavailable row; 409 CONFLICT for duplicate destination configuration; 500 INTERNAL_ERROR scrubbed. Request validation field errors use the shared envelope. Existing rate limiting, if applied, retains its 429 contract; no new Notifications limiter is introduced.

Read/upsert are idempotent 200. Delete of an absent rule is idempotent within its owner scope and never removes another owner's row. A foreign/unavailable Notification read returns 404. Replaying mark-read preserves its original timestamp. Register static notification paths before parameterized routes.

Inbox responses include Content-Language, Vary: Accept-Language and Cache-Control: private, no-store. `example-web` sends `kit.locale` dynamically; it polls the current Organization's unread count every 60 seconds and on focus, not all Organizations. Rules UI shows the global User rule and current effective value/source, disabled controls for locks, and no in_app or mandatory configuration. Catalogue parity must cover both API and web: the existing web-only `i18n:check` is not proof of API parity.

## D7 — Audit

Admin rule changes use `notification.rule.set` / `notification.rule.delete`, allowlisted selector/Channel/booleans, actor, target id and org or null; no email/parameters/provider text. Mutation and audit insert commit together. An unchanged upsert or absent delete emits no invented change. The existing best-effort `appendAudit` alone does not satisfy atomic audit.

User rule mutations and read marks are **not audited**. Slack destination changes use `slack.destination_created`, `slack.destination_updated`, `slack.destination_deleted`, with allowlisted installation/channel/selector metadata, atomic with the configuration mutation. Slack installation/revocation/link audit is specified by ADR-0021 and shares this no-secret policy; the audit listing remains super_admin-only. Support read bypass uses the existing log contract, not a claim of a new Organization audit UI.

## D8 — Delivery guards, guarantees and required proof

The strict, server-built Workflow input is only `DeliveryRef`: `{orgId,kind:'user'|'organization',id}`. No address, body, actor grant, retry stage or credential from a caller is authority. Load by kind/id/org. Each attempt rechecks current Organization/membership/Module, unresolved Notification/source receipt, rules and destination/installation configuration before address resolution/render/send. A definitive denial/unavailability stores skipped; a lookup failure retries under the owner, never fabricates a durable denial. No source-object ACL recheck is added.

An absent or terminal Delivery stops without provider. Retryable failure records only observation; the existing Workflow retries it. Sent/permanent/skipped outcomes persist before success/final disposition. The Workflow checkpoints a successful send outcome, then finalizes D1 in a separate owner-native step: a D1 receipt-write failure retries finalization, never replays a checkpointed successful send merely to regenerate its receipt. Provider acceptance before the native send-step checkpoint remains ambiguous and may duplicate on owner retry. Attempts count entered engine attempts, not a forensic count of provider accepts. Workflow admission status and execution finalization must be reconciled as ADR-0020 defines, never by recreating a terminated/expired identity.

The guarantee is durable, at-least-once processing **after successful admission**, subject to current eligibility, owner policy and retention; a newly ineligible Delivery can terminate without a provider call. It is not exactly-once email/Slack, guaranteed acceptance by the provider, absence of concurrent in-flight effects, unconditional admission after an arbitrary outage, or a transaction with a business mutation. Task write → afterMutation has a pre-notification gap; bounded best-effort flow callbacks may lose notices/resolution. An admission receipt absent from D1 is not proof an owner never existed. Reconciliation cannot extend its safe identity-retention horizon.

The final recheck is not atomic with an external POST: a decision/rule may change in flight. Guarantee no new attempt after a recheck **observes** denial/resolution, not no external message after the wall-clock instant of decision. A failed resolution callback can leave stale notices. Source routes always enforce current authority regardless.

Required targeted proofs, in addition to the root gate at implementation delivery:

| Proof surface            | Acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pure public interface    | Full lock/specificity table; email lock rejection; authorized Inbox independent of all external settings; destination ceiling/opt-in/zero-User cases; no I/O                                                                                                                                                                                                                                                                                                                                                                               |
| Applied SQL/repos        | Concurrent active uniqueness; Notification+Delivery rollback; new admission after resolution; two independent read/resolved axes; owner/User/global scopes; composite FK cross-org negatives; admission observation CAS/monotonicity and fair org-page contract from ADR-0020; purge                                                                                                                                                                                                                                                       |
| Producers and ports      | Correct added/removed ids; each recipient's object ACL; optional actor exclusion; sole owner flow notified; `opened → closed/resolve → replay(opened)` creates no fresh active rows/owner refs; decision/cancel commit before late emission is resolved by the post-notify guard; two approvals in one run remain independent; a decision with failed wake still blocks replayed opening; callback read/resolve failure retries only under its bounded owner, then logs and continues; task reassignment after resolution remains possible |
| HTTP/security            | CP-IDOR/CP-UNAUTH per resource, session-only, no Inbox support bypass, metadata-only admin, User rules unaudited, atomic admin audit, exact keysets/OpenAPI, API/web catalogue parity; maximum-length valid ASCII keysets round-trip through cursor≤512, Unicode identifier keys rejected without restricting localized content, invalid newId rejected before batch write                                                                                                                                                                 |
| Delivery and crash paths | Repeated notify without new Delivery; terminal replay without provider; lost provider receipt permits duplicate; access/rule/source-resolution changes skip when observed; removed/replaced destination never redirects; admission-before/after-create ambiguity and retention boundaries per ADR-0020; independent durable-ownership review                                                                                                                                                                                               |

## Existing seams and alternatives

| Current evidence                                                                                                                            | Proposed use / rejected alternative                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/auth/src/hono.ts`, `packages/auth/src/org-roles.ts`, `apps/example-api/src/services/org-roles.ts`, `packages/flows/src/access.ts` | Reuse real membership, Role and Module facts; reject the sender/support grant as recipient authority.                                                                                                         |
| `packages/types/src/list.ts`, `packages/core/src/list-page.ts`, `packages/core/src/errors.ts`                                               | Reuse list/query/cursor/error shapes; reject custom collection envelopes and offset pagination.                                                                                                               |
| Existing task mutation hook and flows approve/step-io seams                                                                                 | Add optional producer ports; reject a notifications tool, implicit recipients and failing the run after best-effort callback exhaustion.                                                                      |
| ADR-0012 persistence split, ADR-0004 EmailPort and existing i18n catalogue composition                                                      | Package-owned schema/repos, App SQL/routes/copy; reject `@kit/db` as a capability hub or a provider-specific pure core.                                                                                       |
| ADR-0018 D2 plus owner choice in this session                                                                                               | Full Delivery Workflow, stable native identity and bounded admission; reject Queue publication recovery, custom leases/checkpoints, `@kit/jobs` for one consumer and a promised exactly-once provider effect. |

Business decisions are recorded in [Roxabi/roxabi-boilerplate-cf#451](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/451), [Roxabi/roxabi-boilerplate-cf#452](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/452), [Roxabi/roxabi-boilerplate-cf#453](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/453), [Roxabi/roxabi-boilerplate-cf#454](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/454), [Roxabi/roxabi-boilerplate-cf#455](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/455), [Roxabi/roxabi-boilerplate-cf#456](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/456), [Roxabi/roxabi-boilerplate-cf#457](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/457), [Roxabi/roxabi-boilerplate-cf#458](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/458), [Roxabi/roxabi-boilerplate-cf#459](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/459) and [Roxabi/roxabi-boilerplate-cf#461](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/461). Owner/delivery admission, bounded approval callbacks, both dogfood external defaults and zero-User collective delivery include the explicit E0 session refinements; stale Queue claims are not normative. Definitions live in GLOSSARY, not a second implementation glossary here.

## Consequences and non-goals

- Products compose the capability without copying auth, pagination, persistence or provider plumbing. `@kit/db` remains handle-only, and no Package imports an App.
- The registry requires deployment for new types. Frozen display parameters trade live source redaction for stable rendering; privacy depends on reviewed minimal content and source-route authorization.
- Stable Workflow admission removes the Queue-publication ambiguity without providing an eternal identity or exactly-once side effect. Owner outages and bounded best-effort producers remain explicit operational limits.
- New external library inventory for Notifications is empty: reuse existing Zod/Drizzle/Hono/i18n workspaces. A security-library need in Slack is evaluated in ADR-0021, not forbidden by a zero-dependency slogan; any new dependency requires current stable registry verification and an explicit ADR reason.
- Marketing/broadcast, account-level Notifications, mandatory implementation, realtime, escalation/digest, arbitrary outgoing webhooks, public unsubscribe, machine notification routes, all-Organization Inbox, notification tools and automatic operator redrive are outside V0. This ADR is not deployment proof or a second Product adoption.
