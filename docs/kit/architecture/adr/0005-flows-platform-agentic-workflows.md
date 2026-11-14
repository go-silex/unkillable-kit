---
title: 'ADR-0005 — Flows platform: governed plans + durable runs (agentic SaaS kit)'
status: accepted
normative: true
date: 2026-08-05
amended: 2026-11-14
axial: false
related:
  - docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md
  - docs/kit/architecture/adr/0002-session-hmac-interim-vs-better-auth.md
  - docs/kit/architecture/adr/0003-multi-tenant-rbac-modules.md
  - docs/kit/architecture/adr/0018-durable-execution-ownership.md
  - packages/ (target @kit/flows, later @kit/flows-ui)
  - Cloudflare Workflows / AI Gateway
  - 'Roxabi/roxabi-boilerplate-cf#16'
---

# ADR-0005 — Flows platform for agentic SaaS (Chemin A)

## Status

**Accepted** (2026-08-06) — direction + normative security AC after adversarial review. Implementation tracks **Roxabi/roxabi-boilerplate-cf#16** children (Roxabi/roxabi-boilerplate-cf#27–36), phased P0–P3.

## Context

SaaS “3.0 agentic-ready” needs more than chat: **repeatable work** that is:

1. **Declared** as a reviewable plan (intent as code — Nika-like)
2. **Governed** (authority from **grants**, plan permits only **narrow**; default-deny)
3. **Checked** before spend (schema, DAG, tools, ceilings) **and** metered at runtime where dynamic
4. **Durable** across failures and human waits (Cloudflare Workflows)
5. **Observable** (list runs, step timeline, enable/disable plans)
6. **Authorable** — **YAML MVP** for digestible plans; UI create/edit later (P3)

Without a kit axis, products invent Cron + Queue + ad-hoc agent loops → N×M drift, no shared console, no shared security model.

**Out of scope for this ADR:** shipping Cloudflare OS as kit; embedding Nika’s Rust binary; visual n8n builder day-1; product-domain plan strings inside packages.

### External inspiration (not dependencies)

| Source               | Steal                                                                                    | Refuse                                                            |
| -------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Nika** / nika-spec | Intent-as-code, `check` before spend, permits spirit, verbs, receipts                    | AGPL engine, full CEL, `exec` shell on Workers, conformance claim |
| **roxabi-factory**   | `job_id`=run lifecycle, workerEngine ≠ harness, tool ACL, control-plane console patterns | NATS/Quadlet/Python runtime as kit default                        |

## Options considered

### Option A — Ops-only repo forever (`roxabi-flows` standalone)

- **Pros:** Fast iterate; zero kit zero-edit risk
- **Cons:** Never extractible SaaS capability; dual-edit; no dogfood in `example-*`

### Option B — Full platform day-1 (builder UI + Gatekeepers + multi-tenant create for all roles)

- **Pros:** Vision complete early
- **Cons:** Scope bomb; empty packages; blocks other kit work

### Option C — **Platform packages, phased** (chosen)

- **Pros:** Aligns ADR-0001; dogfood; products compose; room to incubate
- **Cons:** Discipline required so ops/product plans stay out of `packages/*`

## Decision

### D1 — Capability = kit module (primary axis packages)

| Package (target)    | Role                                                                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`@kit/flows`**    | Plan schema, YAML loading, checking, grant∩permits, registry, snapshots and access helpers; `@kit/flows/run` exports the durable run driver. Apps provide bindings and ports.                                              |
| **`@kit/flows-ui`** | **Not minted (Roxabi/roxabi-boilerplate-cf#33, operator decision B, 2026-09-29).** The P2 console lives in `apps/example-web` (`/admin/flows`). Promote at a second consumer compose (a product or a second example path). |

Apps compose packages:

- `apps/example-api` — routes, D1 composition and `FlowRunWorkflow` adapter; it imports `driveFlowRun` from `@kit/flows/run` and currently injects `inferMock`, not a live inference provider.
- `apps/example-web` — `/admin/flows` dogfood (**P2 / Roxabi/roxabi-boilerplate-cf#33**)
- Products — same packages + **product tools + product plans** under `apps/<product>-*` only

**Runner contract:** execute only `RunnerView.executionTools` (never grant allowlist). Persist **`runnerView` JSON only** on the Workflow path; rehydrate with **`parseRunnerView`** (fail-closed). Grant audit is a **separate** object from `createRunSnapshot` — do not collocate on the runner blob.

**Axial test (ADR-0001):** second product adds tools/plans in its app — it does **not** fork the runner or copy D1 run tables into a local god module.

**Promote:** incubate allowed; promote package surface when schema stable + example dogfood + second consumer compose (a product or a second example path). Accepting this ADR licenses incubation — it does **not** alone justify an empty or single-consumer package forever.

### D2 — Runtime = Cloudflare Workflows (do not reimplement durable engine)

```text
YAML plan  →  parse (budget)  →  Zod  →  checkPlan(plan, grants, registry)
                                          ↓ pass
                               create-run snapshot (immutable)
                                          ↓
                               Workflow instance (run)
                                 step.do / sleep / waitForEvent
```

| Layer                                                          | Owner                                                                                                      |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Durable steps, retries, hibernation                            | **CF Workflows**                                                                                           |
| Plan language, grants∩permits, check, snapshot, tool allowlist | **`@kit/flows`**                                                                                           |
| LLM routing / budgets                                          | **AI Gateway** (prod preferred) + env model ids + **runtime token meter**                                  |
| Optional dynamic tenant code load                              | `@cloudflare/dynamic-workflows` only if product needs upload-and-run **code**; default = interpreted plans |

**Forbidden:** custom Durable Object workflow engines, including when Workflows do not suffice; shell `exec` as a first-class verb on Workers.

**Platform limits (normative awareness):** step result size, step count, single-threaded steps, Workers for Platforms hosting constraints. V0 schema **caps** tasks / payload policy (refs to D1/R2 preferred over large step returns). Document WfP incompatibility for products on dispatch namespaces.

**Amendment (2026-09-29, Roxabi/roxabi-boilerplate-cf#227):** model ids come from server env `FLOW_ALLOWED_MODELS` (comma-separated; unset or blank is `[]`), minted into `CapabilityGrant.allowedModels`. `checkPlan` is the only gate: empty list + any infer is `EMPTY_MODELS`; a missing or unlisted effective model (`task.infer.model ?? plan.model`) is `MODEL_NOT_GRANTED`. Plan model strings only narrow. The runner forwards that same effective model to the InferPort. **Non-claim:** the runner does not re-check the id at the provider call, and runs sealed before a list change keep their model ids until they end — `RunnerView` does not carry the list and `runnerViewVersion` stays 1.

Every durable execution has exactly one supplied general-purpose owner. Kit or Product code may compose admission and steps but must not resume from its own progress record, deliberately retry to continue work that could have proceeded, replace an execution to reset its budget, or add a second owner. Distinct executions may compose. Governed plan runs use Cloudflare Workflows; choosing another owner for them requires a new Kit ADR. Other Product execution/owner pairings require a Product ADR. Shell execution is not a Kit verb.

### D3 — Plan contract (Nika-inspired, not Nika binary)

#### Authoring & storage

| Surface                   | Format                   | Rules                                                           |
| ------------------------- | ------------------------ | --------------------------------------------------------------- |
| **Author / import (MVP)** | **YAML**                 | Human/agent digestible; required MVP path                       |
| **Canonical stored plan** | **JSON** (Zod-validated) | D1 body + digest; runner consumes this                          |
| Parse                     | safe-load only           | Max bytes; no custom tags / merge bombs; fail closed before Zod |

Minimum plan surface (**flows v0**):

```text
flows: v0
plan:
  id · description?
  model? · max_tokens  # REQUIRED when any task uses infer
permits:
  tools: []          # V0 only — net/r2 deferred until enforced wrappers
tasks:
  <id>:
    after?: [taskId…]
    invoke?: { tool, args? }
    infer?:  { prompt, max_tokens?, model? }
    approve?: { note?, timeout_hours? }  # HITL; not effectful; default timeout 24h, max 168
# agent: deferred until runtime meter + step budget model exist
```

| Verb      | Meaning on CF                                                       | V0                                             |
| --------- | ------------------------------------------------------------------- | ---------------------------------------------- |
| `invoke`  | Allowlisted tool from registry                                      | **yes**                                        |
| `infer`   | Bounded LLM call (single-shot)                                      | **yes**                                        |
| `approve` | Human gate; not effectful; continues only on an org+run D1 decision | **yes** (Roxabi/roxabi-boilerplate-cf#32)      |
| `agent`   | Leashed tool-loop                                                   | **deferred** (schema reject until meter ships) |
| `exec`    | Shell                                                               | **never** on Workers kit                       |

- **`checkPlan(planInput, grants, registry)`** is pure: **re-runs Zod** on `planInput` (`unknown`), then unknown tools, DAG edges/cycles, missing/empty authority, tools outside **effective** allowlist, static token ceilings → fail **before** first token
- **`grant.registryVersion`** required and must match registry; never silently default-filled on the snapshot

- Plans in kit dogfood = **generic** (e.g. echo → infer summary) — **zero** Roxabi/Silex business strings in `packages/*`
- Product plans live in product app, DB, or product-owned storage — not promoted into `@kit/*` as domain content

### D4 — Security model (authority, dual auth, tenancy)

#### Authority split (adversarial fatal fix)

```text
org/admin capability grants  →  max power (registry tools declared mintable + allowsInfer)
plan.permits.tools           →  may only NARROW grants
effective.tools = grants.allowedTools ∩ plan.permits.tools ∩ registry
every grants.allowedTools entry MUST be grantClass 'mintable' in the pinned registry
sealing a run MUST receive the minted grant object and a kit-built registry
infer allowed only if grant.allowsInfer === true
```

- **Absent or empty plan permits** with any effectful task (`invoke` **or** `infer`) → **fail-closed** at check (NEP-0003 spirit: no ambient authority)
- Plan **cannot expand** beyond grants
- **`allowsInfer` (option A):** `infer` is **not** ambient via a dummy tool permit — grant must set `allowsInfer: true` or check fails `INFER_NOT_GRANTED`
- **Grant provenance:** apps derive policy facts from the server session and organization module policy, never the plan or client body. Kit-owned `mintCapabilityGrant` mints the grant; permits only narrow it and `allowsInfer` stays explicit.
- Credentials never in plan body; tools use Worker bindings / secrets
- **Amendment (2026-09-29, Roxabi/roxabi-boilerplate-cf#232) — whole-value bindings only.** `invoke.args` string leaves may be plain data or exactly `${{ tasks.<id>.output }}` (whole value). Partial interpolation, `.output.foo`, `env.*`, and `secrets.*` fail check as `BINDING_NOT_WHOLE`. Env/secret-shaped arg **keys** fail as `ARG_KEY_FORBIDDEN` (values are not scanned). Binding targets are unioned into sealed `after` at `createRunSnapshot` (authored YAML/`plan_json` are not rewritten). Resolution is `resolveWholeBindings` at the Worker invoke port / `runInvokeStep` from receipt outputs only — never env. Unresolved → `BINDING_UNRESOLVED`. A `Roxabi/roxabi-boilerplate-cf#231` redacted output resolves to `[redacted]`.
- **V0 permits fields:** `tools` only. Do not advertise `net`/`r2` until kit wrappers enforce them
- **plan_digest / registry contentDigest:** content-address **index** only (FNV-1a, not crypto integrity); sealed plan body is authoritative
- **Amendment (2026-09-29) — republish identity is the posted YAML bytes (Roxabi/roxabi-boilerplate-cf#228).** `plan_digest` remains an FNV-1a index. It is not integrity, not identity, and not consulted when matching. One D1 statement inserts version `MAX+1` only if no row in the same `(org_id, plan_key)` stores the same `yaml_source` (TEXT `=`, BINARY collation, so a byte compare). The service then re-reads the lowest byte-equal version and confirms it with SHA-256. Identical bytes return that row (HTTP 200, same id/version), including when publishes overlap. Different bytes, including the same parse, are a new version (HTTP 201). Null `yaml_source` never matches. A unique-constraint failure on `(org_id, plan_key, version)` re-reads the lowest byte-equal row: identical bytes → 200; otherwise 409 `PLAN_VERSION_RACE` (retryable), not "already exists". Id / `(id, org_id)` collisions are not mapped to that reason.
- **Amendment (2026-09-18) — the ceiling is verified, not only produced (Roxabi/roxabi-boilerplate-cf#243 red-team).** The registry class was an optional effect word (`read | write | external`) read by one constructor: a grant built outside `mintCapabilityGrant` — or one outlived by a server-side tightening under the same `registryVersion` label — reached a sealed run with tools the policy had excluded, and an omitted class silently minted nothing. Three changes make the property real instead of conventional: the class is a **declared, required** decision (`grantClass: 'mintable' | 'never'`, an undeclared or unknown value is refused at `createToolRegistry`), `checkPlan` **re-verifies** every `grant.allowedTools` entry against the pinned registry (`TOOL_NOT_GRANTABLE`), and `contentDigest` seals `name:grantClass` so a reclassification cannot hide behind the version label. `resolveEffectiveAuthority` stays a pure intersection — the gate is `checkPlan`, which is what `createRunSnapshot` runs.
- **Amendment (2026-09-18, second pass) — conformity is not provenance (red-team on the first pass).** Verifying the tool sub-ceiling was necessary and not sufficient: `checkPlan` can prove a grant stays inside the mintable set, but `allowsInfer` comes from policy facts no registry carries, so a forged grant copying the mintable set and asserting `allowsInfer: true` sealed an infer run the org policy refused. Provenance is therefore recorded rather than inferred — `mintCapabilityGrant` marks the grants it mints, `createToolRegistry` marks the registries it builds (module-private `WeakSet`s in `packages/flows/src/provenance.ts`, never exported from the barrel), and `createRunSnapshot` refuses anything unmarked (`GRANT_NOT_MINTED`, `REGISTRY_NOT_KIT_BUILT`). A mark proves the object came out of the kit constructor, not that the policy facts were true: facts provenance stays app-owned (invariant 3). `checkPlan` remains conformity-only, so the dry-run/check endpoint keeps working on any well-formed grant. Same pass: a permitted tool the registry no longer declares mintable now reports `TOOL_NOT_GRANTABLE` instead of `TOOL_NOT_GRANTED`, so a server-side tightening stops reading as "this plan tried to expand its authority".
- **Amendment (2026-09-29) — `effect` is a retry hint only (Roxabi/roxabi-boilerplate-cf#234).** `FlowToolDefinition.effect?: 'read' | 'write'` is projected by `createToolRegistry` (absent or any non-`'read'` value → stored `'write'`) and sealed onto optional `RunnerView.toolEffects` for tools in `executionTools` **only when at least one sealed effect is `'read'`** — all-write seals omit the key so pre-Roxabi/roxabi-boilerplate-cf#234 `.strict()` parsers still accept write-only `snapshot_json` without a version bump (D4 schema-evolution rule: do not silently loosen `.strict()` / bump only with dual-parse). When the map is present (any read), older strict schemas that do not name `toolEffects` reject the blob — those runners must be on the Roxabi/roxabi-boilerplate-cf#234 parser. `runInvokeStep` sets `retries.limit` to `3` iff the sealed effect is `'read'`, else `0`, and **does not** catch-convert port throws before step retries on the read path (after the limit is exhausted it writes `INVOKE_FAILED`). Missing map on a legacy / all-write snapshot ⇒ every tool write (no ambient retry). `effect` is **not** an input to `mintCapabilityGrant`, `checkPlan` allowlists, or `contentDigest` (digest stays `name:grantClass`); flipping effect must not look like a registry-version change. Do not conflate with `grantClass` or with the `@kit/mcp` descriptive `effect`. `RUNNER_VIEW_VERSION` stays `1`.
- **Amendment (2026-09-29, Roxabi/roxabi-boilerplate-cf#227) — model ids are minted, not named by the plan.** `FLOW_ALLOWED_MODELS` is parsed in the example-api grant factory and passed as `OrgPolicyFacts.allowedModels`. `mintCapabilityGrant` copies the sorted unique list. The field is required on `CapabilityGrant` (never defaulted to allow-all). Effective model is `task.infer.model ?? plan.model`; missing both is `MODEL_NOT_GRANTED`. If `plan.model` is set and any infer exists, it must be in the list even when every task overrides it. Invoke/approve-only plans are not bound by the list, and a malformed list is a server error for infer plans only. The runner passes the same effective model to the InferPort. **Non-claim:** no re-mint on rehydrate, so a run sealed before the list changes keeps its model ids until it ends, and the runner does not re-check the id at the provider call.

- **Amendment (2026-09-29, Roxabi/roxabi-boilerplate-cf#230) — append-only `flow_run_events`.** Status CAS and task-receipt writes append an org-scoped event (`kind` `status`|`receipt`). Events are not a second snapshot and do not grant tools. No `output` column (redaction is Roxabi/roxabi-boilerplate-cf#231). List always filters `org_id`.

- **Amendment (2026-11-12) — run mutations and their events are atomic.** Claim, state/receipt persistence, orphan receipt scrub and Workflow-create failure commit the accepted run mutation and every generated event in one D1 batch. An event insertion failure rolls back the mutation and preceding event inserts. Receipt-only persistence compares the Organization and prior receipt. Bundle persistence compares the Organization, state, receipt, error and owner field from its prior read, not the caller's identity. Failed-run closure additionally restricts the owner to the supplied instance or an unclaimed row and compares state, receipt, error and owner against its prior read. A refused mutation appends no event and an idempotent claim does not append a second claim event.

#### Authn / authz

| Concern                 | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authn transport         | Session cookie **or** Bearer `sk_` (ADR-0002)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **V0 flows capability** | **Org admin** (or owner) only for create/edit/enable/create-run/HITL approve                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Later                   | Open run (and optionally edit) to members / all users via grants                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sk_` V0                | Prefer **read** of runs/status; mint scoped keys before allowing create-run via API key                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Multi-tenant            | Every plan/run row **`org_id` NOT NULL**; list/detail enforce membership (IDOR tests from P0)                                                                                                                                                                                                                                                                                                                                                                                                             |
| Module catalogue        | Register **`flows`** in platform modules (ADR-0003); V0 = available + admin write path                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Receipts                | Write-time redaction: `sensitiveOutput` tools persist `REDACTED_OUTPUT_MARKER` (`[redacted]`) in D1 — not a read-time filter. Step returns omit tool text (`{ outcome }` / `{ outcome, tokens }`) and are not a secret channel. The flag lives on the live Worker registry (`isSensitive` beside `hasTool`), is **not** sealed into RunnerView/`contentDigest`, and a flip applies to later writes of in-flight runs. Unflagged tools keep capped raw text (dogfood `echo`). No secrets/tokens in D1 logs |

- **Effect receipts and retries.** An effect step (`invoke`, `infer`) commits `started` before calling its port. Ordinarily a surviving `started` receipt closes as `fail` / `RECEIPT_LOST` without another port call; an open run remains running until rollup, while an already-terminal run receives only a receipt scrub. The exception is a native Workflow retry for an invoke whose sealed effect is `read`: it may resume the port from `started` without writing `started` again, with up to three retries. Exhausted read retries write `INVOKE_FAILED`. Write and unknown effects have zero native retries. Thus physical at-most-once execution is not claimed for read invokes. Recorded `ok`, `fail` or `skip` return without another port call; approvals use `waiting`, never `started`.

  `interpretRun` never treats `started` as ready or waiting: dependents cascade-skip and the rollup fails. Terminal persistence and the port-free `persist:receipt-lost` failure step scrub remaining `started` receipts to `RECEIPT_LOST`; an open run fails and an already-terminal run receives a receipt-only scrub, preserving terminal status and error. A committed `started` whose acknowledgement is lost can fail even if the port never ran. The claimed native Workflow instance remains the single Durable owner. `persistRunBundle` uses compare-before-write predicates and an atomic state/receipt/event batch; this is not a claim of at-most-once port execution against concurrent executions of the same step. A claim or persistence exception before the first `started` also attempts a port-free failure close, restricted to the same instance or the still-unclaimed row; a refused claim never closes another owner. The original exception propagates, and a persistent D1 outage can prevent recording that close.

#### Run snapshot / RunnerView (adversarial TOCTOU + dual-field fix)

On **create-run**, `createRunSnapshot` returns:

| Output           | Persist on execution path?                      | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`runnerView`** | **Yes** (`snapshot_json` / Workflow payload)    | `runnerViewVersion: 1` · `orgId` · `actorId` · `planId` · `planDigest` · `sealedPlan` · `executionTools` · `toolEffects?` (optional sealed `read`/`write` map for invoke retries — Roxabi/roxabi-boilerplate-cf#234; **emitted only when any execution tool is `read`**; absent ⇒ write) · `registryVersion` · `registryContentDigest` · `ceilings` (`hardMaxTokens`, `staticTokenBudget`, `planMaxTokens?`) · `allowsInfer` · `createdAt` |
| **`grantAudit`** | **Separate only** (audit log / optional column) | Full grant allowlist + `allowsInfer` — **never** for tool dispatch                                                                                                                                                                                                                                                                                                                                                                         |

- Persist **only** `JSON.stringify(runnerView)` into `snapshot_json` — never the dual `{ ok, runnerView, grantAudit }` result object
- Rehydrate with **`parseRunnerView(unknown)` only** (required AC for Roxabi/roxabi-boilerplate-cf#30): rejects `grantAudit` / unknown keys; `executionTools ⊆ permits`; every invoke tool ∈ `executionTools`; ceilings re-derived from `sealedPlan`; `planDigest` consistency; empty permits + effectful fail-closed
- **Not** full grant re-mint on rehydrate — provenance stays the create-run mint. Tamper resistance of the blob = trusted write path (+ optional MAC later)
- **Amendment:** create-run mint is kit-owned `mintCapabilityGrant`; rehydrate/`parseRunnerView` stays consistency-only — a sealed run keeps its minted model ids until it ends even if the env list shrinks. Permits may only narrow the minted grant; `allowsInfer` stays explicit.
- Runner **must** execute the **runner view**, never the live plan row; dispatch **only** `executionTools`
- Plan edits create a new version; in-flight runs unchanged
- `enabled=false` blocks **new** runs; cancel/kill = best-effort Workflow terminate (document non-idempotent tool risk)
- **Amendment (Roxabi/roxabi-boilerplate-cf#226):** `POST /api/flows/runs/{runId}/cancel` (session + org owner/admin; same rule as HITL decide — no `super_admin` shortcut; `sk_` 403). CAS `queued|running → cancelled`, then best-effort `FLOW_RUN.get(runId).terminate()`. Already `cancelled` → 200 idempotent (no second terminate required). `succeeded|failed` → 409. Terminate failure is logged and does **not** roll back the row. An in-flight step that already passed the port may still finish; the driver re-checks status before `invoke` / `infer` / approve wait and refuses the port when cancelled (`DriveNonRetryableError('cancelled')`). `persistRunBundle` already refuses non-`queued|running`, so a late write cannot reopen `cancelled`. Cancel is **not** a transactional kill of side effects.
- **Schema evolution:** `runnerViewVersion` literal `1`; breaking shape requires bump + dual-parse / migrate — do not silently loosen `.strict()`

#### Runtime spend

- Static `check` ceilings are **necessary, not sufficient**
- Every `infer` (and later `agent` turn) **meters tokens** and hard-aborts when ceiling crossed
- Prod: prefer AI Gateway budget binding when available

#### HITL (P1, Roxabi/roxabi-boilerplate-cf#32 — option A)

- Human gate as an explicit `approve` task (not an effectful invoke). `after` edges unchanged. `approve` is not effectful: empty permits pass an approve-only plan.
- **Not** raw unauthenticated `waitForEvent` from the internet. Approve only via the app route: session + org admin (V0) + run membership (`org_id` match). `sk_` stays 403.
- **Option A (recorded 2026-09-25):** the org- and run-scoped D1 row in `flow_run_approvals` is the only authorization. `step.waitForEvent` only wakes the Workflow; the event payload is ignored. On wake the driver re-reads the row; no row means it does not continue. Timeout fails closed (`APPROVAL_TIMEOUT`). A lost wake with a written row still proceeds on the next read (including timeout).
- A `waiting` receipt is produced only for an `approve` task. Only an org+run+task D1 row with `decision=approved` turns it into `ok`. A Workflow event only wakes. Without an approval the task fails only via its own `expired` row at the deadline or after 8 wakes with no row (`APPROVAL_TIMEOUT`), a `rejected` row, or a missing wait port.
- V0: an open approve suspends the run; independent ready tasks run after the decision.

### D5 — Product console surface (phased)

| Phase  | Ship                                                                                                                                                                                                                                                                                 | Non-goal yet                 | Tracking                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------ |
| **P0** | Schema + YAML + `check` + grant∩ + snapshot + D1 + Workflows thin + Vitest + dogfood + admin helpers                                                                                                                                                                                 | UI, builder, `agent`, net/r2 | Roxabi/roxabi-boilerplate-cf#28–30                                 |
| **P1** | API list/create plan/run, enable/disable, HITL principal-bound                                                                                                                                                                                                                       | Drag-drop editor             | Roxabi/roxabi-boilerplate-cf#31–32                                 |
| **P2** | `/admin/flows` in `example-web` (list, timeline, enable/disable, HITL approve on run detail — Roxabi/roxabi-boilerplate-cf#288). Promote `@kit/flows-ui` at a second consumer compose (a product or a second example path) — not before (Roxabi/roxabi-boilerplate-cf#33 decision B) | —                            | Roxabi/roxabi-boilerplate-cf#33 · Roxabi/roxabi-boilerplate-cf#288 |
| **P3** | Create/edit or agent-draft → check → human save                                                                                                                                                                                                                                      | Full n8n parity              | Roxabi/roxabi-boilerplate-cf#34                                    |

### D6 — Incubation & promote gate

| Gate                        | Rule                                                                                                                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Incubate**                | Temporary playground OK; must not block kit green indefinitely                                                                                                                                                                                                                                           |
| **Promote `@kit/flows`**    | Schema stable + `example-api` dogfood + **second call site**                                                                                                                                                                                                                                             |
| **Promote `@kit/flows-ui`** | second consumer compose (a product or a second example path). Presentational only; controls from the server `allowedOperations`, no role mirror; catalogs, routes and org selection stay in the app. Needs the allowedOperations and run-id contracts; the consumer-contract row is added at extraction. |
| **No empty packages**       | No `@kit/flows` stub without check + tests                                                                                                                                                                                                                                                               |
| **Banlist**                 | Product domain compounds never under `packages/**`                                                                                                                                                                                                                                                       |
| **No third tool registry**  | MCP `createToolCatalogue` and flows `createToolRegistry` stay forked — **decided, not deferred** (amendment below). A shared SSOT would be a promote that **replaces** both callers — never a third factory beside them                                                                                  |

**Amendment (2026-09-18) — the fork is the decision (Roxabi/roxabi-boilerplate-cf#246).** The two factories are not two spellings of one concept: `createToolCatalogue` owns executable tools (Zod input/output, `execute`, MCP server registration, budget and public-error wrapping) while `createToolRegistry` owns authority — name-keyed declarations with a `grantClass` that `mintCapabilityGrant` turns into a Capability Grant ceiling, with no handler at all (invocation is an app-supplied port). Unifying them today buys a shared name-plus-digest shell and costs the property that the authority surface holds no execution path. That property is **enforced, not asserted**: `createToolRegistry` projects `name` / `description` / `grantClass` / optional `effect` (retry hint only — Roxabi/roxabi-boilerplate-cf#234) instead of spreading the caller's object, so an `execute` never reaches a registry entry — proved by `packages/flows/src/registry.test.ts`. So: **duplication assumed**, no unification issue kept open, and the D6 rule above still forbids a third factory or a helper sitting beside the two. The reason is repeated where a reader of either package meets it — `packages/flows/src/registry.ts`, `packages/mcp/src/catalogue.ts` and both barrels. The field-name collision that blocked this decision is closed by [Roxabi/roxabi-boilerplate-cf#243](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/243) (`effect` stays descriptive in `@kit/mcp`, `grantClass` carries authority in `@kit/flows`); [Roxabi/roxabi-boilerplate-cf#234](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/234) reintroduces a flows-side `effect` strictly as a non-authority retry hint sealed on `RunnerView.toolEffects`.
**Limits of this decision, stated so nobody over-reads it.** No gate implements "no third tool registry": it is a review-time rule, enforced by this ADR and by the doc comments in both packages, not by a script. The revisit trigger is likewise human — a third consumer needing the same tool surface — and the two surfaces are already unequal in hardening (flows validates names, freezes entries and proxies the map; the catalogue validates nothing and iterates the caller's live array). Divergence beyond those points is drift, not decision, and belongs to the package that promotes it.

### D7 — Explicit non-goals

- Porting Nika CLI / AGPL engine into Workers
- Claiming Nika-spec conformance
- Replacing FastMCP / `McpAgent` product MCP surfaces
- Cloudflare OS gadgets as default kit shell
- Visual workflow builder as P0
- Multi-repo split of `@kit/flows`
- Shell `exec` verb on Workers
- Self-granted plan permits as sole authority model

## Consequences

### Positive

- Clear home for agentic orchestration in Chemin A
- Products get console + governance without inventing runners
- Aligns durable work with CF Workflows
- Adversarial holes closed in normative AC

### Negative

- Multi-PR surface
- V0 admin-only narrower than end-state “everyone”
- Risk of overbuilding builder before engine solid

### Neutral

- `@kit/jobs` may later **trigger** flows
- Dynamic Workflows lib reserved for advanced code loading

## Anti-patterns

- Product plan copy in `@kit/flows` defaults
- Ambient tool access
- **Self-granted permits without grant intersection**
- **Runner reading live plan row after create-run**
- `waitUntil` multi-day pipelines instead of Workflows
- Claiming “agentic ready” = chat only
- Unauthenticated Workflow continue as “HITL”
- Advertising `permits.net` / `r2` before enforcement

## Related

- [ADR-0001](./0001-primary-axis-packages-compose-apps.md) · [ADR-0002](./0002-session-hmac-interim-vs-better-auth.md) · [ADR-0003](./0003-multi-tenant-rbac-modules.md) · [ADR-0018](./0018-durable-execution-ownership.md)
- CF Workflows · AI Gateway · [Nika](https://nika.sh/) (concepts)
- Epic: [Roxabi/roxabi-boilerplate-cf#16](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/16) · children Roxabi/roxabi-boilerplate-cf#27–36
