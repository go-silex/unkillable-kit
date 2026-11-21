---
title: 'ADR-0005 — Flows platform: governed plans + durable runs (agentic SaaS kit)'
status: accepted
normative: true
date: 2026-08-05
amended: 2026-11-21
axial: false
related:
  - docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md
  - docs/kit/architecture/adr/0002-session-hmac-interim-vs-better-auth.md
  - docs/kit/architecture/adr/0003-multi-tenant-rbac-modules.md
  - docs/kit/architecture/adr/0018-durable-execution-ownership.md
  - packages/ (target @kit/flows, later @kit/flows-ui)
  - Cloudflare Workflows / AI Gateway
  - 'Roxabi/roxabi-boilerplate-cf#16'
summary: 'Governed plans and durable runs'
supersedes_notes: >
  2026-11-21: body trimmed to decisions, rationale and limits; implementation detail now lives only in the cited code and tests. No decision changed.
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

Cloudflare Workflows owns durable steps, retries and hibernation; `@kit/flows` owns plan checking, authority and snapshots. Production should prefer AI Gateway budgets and must meter tokens at runtime. Interpreted plans are the default; `@cloudflare/dynamic-workflows` is reserved for products needing uploaded code.

**Forbidden:** custom Durable Object workflow engines, including when Workflows do not suffice; shell `exec` as a first-class verb on Workers.

**Platform limits:** step result size, step count, single-threaded steps and Workers for Platforms hosting constraints apply. The v0 schema caps tasks and payload policy; prefer D1/R2 references to large step returns. Document WfP incompatibility for products on dispatch namespaces.

Server-configured model IDs are minted into grants; plans only narrow them. Checking is the gate: the runner does not re-check the model at the provider call, and sealed runs keep their model IDs until they end even if the list changes. Implementation: `apps/example-api/src/services/flows-grant.ts`, `packages/flows/src/check-issues.ts`, `packages/flows/src/run/infer-step.ts`.

Every durable execution has exactly one supplied general-purpose owner. Kit or Product code may compose admission and steps but must not resume from its own progress record, deliberately retry to continue work that could have proceeded, replace an execution to reset its budget, or add a second owner.
Distinct executions may compose. Governed plan runs use Cloudflare Workflows; choosing another owner for them requires a new Kit ADR. Other Product execution/owner pairings require a Product ADR. Shell execution is not a Kit verb.

### D3 — Plan contract (Nika-inspired, not Nika binary)

Author and import plans as YAML; store canonical validated JSON. Safe parsing must fail closed on oversized or unsafe input. V0 supports allowlisted `invoke`, bounded single-shot `infer`, and human `approve`; `agent` is deferred and `exec` is never a Workers kit verb.

Checking revalidates the input, graph, registry and authority, and static token ceilings before spend. The grant's registry version must match; never silently default it at snapshot time. Static ceilings alone are not sufficient for dynamic spend.

Kit dogfood plans are generic; product-domain plans belong in the product app, DB or product-owned storage, not `@kit/*`. Implementation: `packages/flows/src/yaml.ts`, `packages/flows/src/schema.ts`, `packages/flows/src/check-issues.ts`.

### D4 — Security model (authority, dual auth, tenancy)

#### Authority split (adversarial fatal fix)

Organization/admin grants are the sole maximum power; plan permits only narrow them. Effective tools are the intersection of grant, permits and pinned registry. Every granted tool must have `grantClass: 'mintable'` in that registry; checking verifies this ceiling rather than trusting its producer.
Each registry tool declares `grantClass` explicitly; the pinned registry digest includes
tool names and grant classes, so same-version reclassification changes the digest.

Absent or empty permits fail closed for any effectful `invoke` or `infer`; an approve-only plan may have empty permits. Inference also requires explicit `allowsInfer: true`; a dummy tool permit does not grant inference.

Apps derive policy facts from the server session and organization module policy, never from client input, a plan or agent self-description. Only kit-minted grants and kit-built registries may seal a run. Constructor provenance is not proof that app-supplied policy facts are true; `checkPlan` checks conformity, not provenance.
The sealing boundary rejects unmarked grant and registry objects; copying either object
does not preserve provenance, and a matching version cannot substitute for it.

Credentials never belong in plan bodies; tools use Worker bindings and secrets. V0 advertises only tool permits, not `net` or `r2` until wrappers enforce them. Whole-value task-output bindings resolve from receipts, never environment or secrets; partial interpolation and secret-shaped argument keys are rejected.

Plan and registry digests are content-address indexes, not cryptographic integrity. The sealed plan body is authoritative. Republish identity is the posted YAML bytes, not the plan digest or semantic equivalence.
Implementations: `packages/flows/src/mint.ts`, `packages/flows/src/check-issues.ts`, `packages/flows/src/snapshot.ts`, `packages/flows/src/bindings.ts`, `packages/flows/src/plan-versions.ts`, `apps/example-api/src/services/flows-grant.ts`.

`effect` is a retry hint, not authority or a registry digest input; do not conflate it with `grantClass` or MCP's descriptive `effect`. Missing or unknown effects default to write, without native invoke retries; read invokes can retry. Physical at-most-once execution is not claimed for read invokes or for concurrent executions of a step.

Effect receipts are recorded before the port call; a surviving started receipt normally fails closed without repeating the effect. Lost acknowledgement can therefore fail a run even if the port never ran. A persistent D1 outage can prevent recording failure closure.
Implementations: `packages/flows/src/run/invoke-step.ts`, `packages/flows/src/run/persist.ts`, `packages/flows/src/repos/run-mutations.ts`.

Run mutations and their events commit atomically; refused mutations append no event. Events are org-scoped, append-only, neither a second snapshot nor authority, and contain no output. Implementation: `packages/flows/src/repos/run-mutations.ts`, `packages/flows/src/repos/events.ts`.

#### Authn / authz

Flows routes require a session (ADR-0002); machine access through scoped keys is future
policy. V0 create, edit, enable, create-run and approval are org admin or owner operations;
later grants may open run or edit to members.
Every plan/run belongs to an organization and list/detail require membership.
Register `flows` in the platform module catalogue (ADR-0003).

Sensitive tool output is redacted at write time, not on read; step returns are not a secret channel and D1 logs must contain no secrets or tokens. Sensitivity is read from the live Worker registry, not sealed into the runner view or digest, so changes apply to later writes of in-flight runs. Unflagged tools retain capped raw text.
Implementation: `packages/flows/src/run/step-io.ts`, `apps/example-api/src/flows-run/workflow.ts`.

#### Run snapshot / RunnerView (adversarial TOCTOU + dual-field fix)

Create-run seals an immutable runner view. Persist only that view on the execution path, separately from grant audit; dispatch only its `executionTools`, never the grant allowlist or live plan row. Parse the view fail-closed on rehydration. Plan edits create new versions without changing in-flight runs.

Rehydration checks consistency, not grant provenance or a fresh grant mint. Blob tamper resistance depends on the trusted write path (an optional MAC may be added later); a sealed run retains its minted model IDs after a policy change. Implementation: `packages/flows/src/snapshot.ts`, `packages/flows/src/runner-view.ts`.

Disabling a plan blocks new runs. Cancellation is a best-effort Workflow termination, not a transactional kill of side effects: a tool already past the port may still finish, and termination failure does not roll back cancellation. Implementation: `packages/flows/src/repos/cancel.ts`, `packages/flows/src/run/drive.ts`.

Runner view shape is strict: a breaking change requires a version bump and dual-parse or migration, never silently loosen the parser. Older strict parsers reject views with the newer read-effect map; all-write views omit it for compatibility.

#### Runtime spend

Static check ceilings are necessary, not sufficient. Every `infer` and any later `agent` turn must meter tokens and hard-abort when the ceiling is crossed; prefer AI Gateway budget binding in production. Implementation: `packages/flows/src/run/infer-step.ts`.

#### HITL (P1, Roxabi/roxabi-boilerplate-cf#32 — option A)

Approval is an explicit, non-effectful task, not an unauthenticated Workflow continue. The app's principal-bound route requires a session, org admin or owner and matching run organization; `sk_` remains forbidden.

The org-, run- and task-scoped D1 approval decision is the only authorization. The route writes that decision; a Workflow event only wakes the driver and its payload is ignored. The driver re-reads the row and proceeds only on approval; a missing decision never authorizes continuation and timeout fails closed.
A lost wake after a decision can still proceed on a later read. An open approval suspends the run; independent ready tasks run after the decision.

Implementations: `apps/example-api/src/routes/flows.ts`, `apps/example-api/src/services/flows-approval.ts`, `packages/flows/src/run/approve-step.ts`, `apps/example-api/src/flows-run/workflow.ts`.

### D5 — Product console surface (phased)

The dogfood console lives in `apps/example-web`. `@kit/flows-ui` is **not built**: promote it only at a second consumer compose (a product or a second example path). Create/edit or agent-draft followed by check and human save is a later target, not a full visual builder.

### D6 — Incubation & promote gate

Incubation is temporary and must not indefinitely block kit green. Promote `@kit/flows` when its schema is stable, example dogfood exists and there is a second call site. Do not mint empty packages; product-domain compounds stay out of `packages/**`.

At extraction, `@kit/flows-ui` is presentational only: controls use server `allowedOperations`, with no role mirror. Catalogues, routes and org selection stay in the app; extraction requires the allowedOperations and run-id contracts and a consumer-contract row.

MCP `createToolCatalogue` owns executable tools; flows `createToolRegistry` owns authority declarations, with no handler. Unifying them merely for a name-and-digest shell would sacrifice the separation of authority from execution. The two remain distinct: no third registry or helper beside them. A shared source of truth must replace both callers, not add another factory.

There is no automated gate for the no-third-registry rule; it is a review-time decision. Revisit when a third consumer needs the same tool surface. The two implementations have different hardening, and divergence beyond those known differences is drift, not a decision. Implementations: `packages/flows/src/registry.ts`, `packages/mcp/src/catalogue.ts`.

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
