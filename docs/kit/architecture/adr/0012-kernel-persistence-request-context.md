---
title: 'ADR-0012 — Kernel persistence + request-context stratum'
status: accepted
normative: true
date: 2026-08-24
amended: 2026-11-14
axial: false
related:
  - docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md
  - docs/kit/architecture/adr/0003-multi-tenant-rbac-modules.md
  - docs/kit/architecture/adr/0005-flows-platform-agentic-workflows.md
  - docs/kit/architecture/adr/0008-kit-schema-identity-product-compose.md
  - 'Roxabi/roxabi-boilerplate-cf#137'
  - 'Roxabi/roxabi-boilerplate-cf#139'
  - 'Roxabi/roxabi-boilerplate-cf#142'
  - 'Roxabi/roxabi-boilerplate-cf#143'
  - 'Roxabi/roxabi-boilerplate-cf#144'
summary: 'Applied SQL + `@kit/auth/hono` are the persist/request-context kernel'
---

# ADR-0012 — Kernel persistence + request-context stratum

**Authority:** accepted 2026-08-24 by operator delegation on the Roxabi/roxabi-boilerplate-cf#137 goal session. Binding.

**Implemented:** [Roxabi/roxabi-boilerplate-cf#142](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/142) schema/repos/hono, [Roxabi/roxabi-boilerplate-cf#143](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/143) `@kit/flows/run`, [Roxabi/roxabi-boilerplate-cf#144](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/144) compose proof. Parent [Roxabi/roxabi-boilerplate-cf#137](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/137) closed. This ADR is the decision, not the move.

This decision covers capability-owned persistence, request context and the FlowRun driver. The catalog identifies kit SQL by module ID and hash; the example API journal supplies its applied bytes. Package migration sketches are not an apply source.

## Problem

Keeping generic tables, org middleware and the FlowRun driver inside the dogfood app forces products to copy runtime code. Promoting drifted package migration sketches would instead weaken the applied tenancy model.

## Options considered

### Option A — Keep applied SSoT in `example-api`; products keep syncing from the dogfood app

- **Pros:** zero file move; D3 as written stays true
- **Cons:** S1 remains fatal; second compose still copies runtime; D6 polarity (import factory) does not extend to schema/repos/hono

### Option B — Promote drifted `packages/*/migrations` sketches as the new apply path

- **Pros:** files already sit under packages
- **Cons:** **S5 violation.** Applied `0012_flows_plans_runs.sql` has composite FK `(plan_id, org_id)` + integer ms. `packages/flows/migrations/0001_flows_plans_runs.sql` has single-column `plan_id` + text timestamps. Sketch promote would drop org-scoped FK.

### Option C — Catalog applied kit-generic bytes and expand existing schema/hono surfaces (chosen)

- **Pros:** applied FK/types win; polarity matches `@kit/auth/schema` + `./react`; `@kit/db` stays handle-only
- **Cons:** the dogfood journal remains the source and Wrangler apply path until a separately decided retarget

## Decision

### D1 — Applied bytes and catalog identity (S5)

The catalog `config/kit/kit-schema-modules.json` is the source of module IDs, source paths and SHA-256 pins. Its current kit SQL source is the applied `apps/example-api/migrations/*` journal, which Wrangler also uses. `kit-schema-sync` verifies those catalogued bytes and appends them to each product's own journal; local journal filenames are not kit identity. Do not rewrite applied files or reuse a published module ID for changed bytes.

`packages/*/migrations` are sketches, not the product apply path or a hash source. Never apply a sketch that lost composite `(plan_id, org_id)`. Retargeting Wrangler requires a separate accepted decision.

Evidence that forbids Option B:

|             | Applied `0012_flows_plans_runs.sql` | Sketch `packages/flows/migrations/0001` |
| ----------- | ----------------------------------- | --------------------------------------- |
| Plan/run FK | Composite `(plan_id, org_id)`       | Single-column `plan_id`                 |
| Timestamps  | Integer ms                          | Text                                    |

`kit-schema-sync` hashes **promoted applied bytes**, never sketches.

### D2 — Schema export per capability

| Export                 | Owns                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@kit/tasks/schema`    | Tasks tables                                                                                                                                                                                              |
| `@kit/comments/schema` | Comments tables                                                                                                                                                                                           |
| `@kit/flows/schema`    | Plans / runs / related flow tables                                                                                                                                                                        |
| `@kit/auth/schema`     | Tenancy/RBAC: orgs, memberships, modules, roles, grants, `api_keys`, `audit_events`, `rate_limit_buckets` (expand existing — **not** a new `@kit/orgs` unless file-length/folder-size forces a later ADR) |

**Never** declare tables in `@kit/db`.

Product compose: `{ ...kitSchema, ...productTables }`. `demo_*` stays in `apps/example-api`.

### D3 — Repos live behind the schema they own

`@kit/db` = handle + types + `D1_IN_ARRAY_CHUNK` / `mapInChunks` (and `createDb` if that is the existing factory). Not a table home. Not a disclaimer that « schemas live in apps ».

`@kit/db` also owns D1 driver-error classification, but no tables. `isUniqueConstraintError` is the one procedure: `(extended: SQLITE_CONSTRAINT_UNIQUE|PRIMARYKEY)` on a `D1_ERROR:` message when that suffix is present, otherwise the engine prefix `UNIQUE constraint failed:` at the start of a cause message. A PRIMARY KEY duplicate is a unique conflict. Bound params and `.code` are not an identity. Exported test helpers `toWorkerdD1Error` and `callSqlite` are the only rethrow shape for in-memory D1 doubles.

### D4 — Request context is `@kit/auth/hono`

`requireOrgContext` / `requireOrgRole` / `requireOrgCapability` / `requireModule` ship as `@kit/auth/hono` — same polarity as `@kit/auth/react`.

No Worker middleware on the SPA graph. App keeps a thin Env / wrangler apply path.

### D5 — FlowRun driver is package-exportable

`@kit/flows/run` exports the existing `drive` / `persist` / `invoke-step` / `infer-step` / `ports`. The App keeps `WorkflowEntrypoint` and Wrangler `[[workflows]]`; persistence uses kit flow tables. Execution is **snapshot-only** (`parseRunnerView`; never reread live `flow_plans`). Infer binding is outside this decision. The runtime remains **incubating** until a second call site.

### D6 — Catalog is SSoT for `core`

**Amendment (2026-11-14):** Fresh Products now default to `core,audit`; existing manifests retain their recorded selections. See [ADR-0008 D4](./0008-kit-schema-identity-product-compose.md#d4--sync-is-append-only) for the current rule.

`--modules core` is **whatever catalog `set: core` lists**. Omitted `--modules` selects `core` plus the product manifest's recorded sets; an explicit omission of a recorded set with unapplied IDs fails closed. Published module IDs and hashes, not dogfood journal numbers, define identity.

### D7 — New catalog ids stay out of this promote

INV-03 (`demo_*` org-scope) and INV-04 (`api_keys.organization_id NOT NULL`) are **new catalog ids** (or a narrowed D8 scope), not silent extras on the mechanical Roxabi/roxabi-boilerplate-cf#142 promote. Prefer a sibling if they need new applied SQL.

## Consequences

### Positive

- Second compose imports schema + `requireOrg*` the way it already imports `@kit/auth/factory`
- S5 keeps composite org FK
- D4 table vs catalog contradiction closes
- ADR-0001 test becomes implementable for persist+context

### Negative

- Dogfood D1 journal filenames stay product-local until wrangler retarget

### Neutral

- Persist/runtime S1 is priced to instantiated code after Roxabi/roxabi-boilerplate-cf#142+143+144. ADR-0005 D6 stays incubating (no second compose).
- A named tenant and a second product compose remain unproven.

## Anti-patterns

| Anti                                                                                   | Why                                                                    |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Promote `packages/flows/migrations/0001` (or any sketch that lost `(plan_id, org_id)`) | **S5** — weaker tenancy than applied                                   |
| Put kit-generic tables in `@kit/db`                                                    | Handle-only; D2                                                        |
| New `@kit/orgs` / `@kit/tenancy` without file-length force + ADR                       | D11 — expand `@kit/auth/schema`                                        |
| Worker org middleware imported from SPA / `@kit/auth/react` graph                      | D4 polarity                                                            |
| Bind infer or leave incubating while claiming D6 met                                   | Roxabi/roxabi-boilerplate-cf#141 out; ADR-0005 D6                      |
| Fold INV-03 / INV-04 into the mechanical promote                                       | D7 — new catalog ids                                                   |
| Kitchen-sink PR (Roxabi/roxabi-boilerplate-cf#142+143+144)                             | One concern per `/ship`                                                |
| Treat this ADR as the move                                                             | Decision only; Roxabi/roxabi-boilerplate-cf#142/143/144 implemented it |

## Non-goals

- Flows console (Roxabi/roxabi-boilerplate-cf#33)
- Infer vs invoke binding (Roxabi/roxabi-boilerplate-cf#141 — sibling under Roxabi/roxabi-boilerplate-cf#16)
- Second product app
- `@kit/agents`
