---
title: 'ADR-0007 — Tasks + comments as kit capability (incubating)'
status: accepted
normative: true
amended: 2026-10-03
axial: false
supersedes_notes: >
  2026-09-13: D1 « no D1/Drizzle in packages » superseded by ADR-0012 D2/D3 —
  each capability owns its Drizzle tables behind a `./schema` export and apps
  compose them. « No Worker bindings » is unchanged; applied SQL stays app-side.
related:
  - docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md
  - docs/kit/architecture/adr/0003-multi-tenant-rbac-modules.md
  - docs/kit/architecture/adr/0012-kernel-persistence-request-context.md
  - packages/tasks/
  - packages/comments/
summary: 'Tasks and comments as kit capabilities'
---

# ADR-0007 — Tasks + comments as kit capability (incubating)

## Context

Multiple products need a **work-item** core: boards and stages, staff/client visibility, assignees, subtasks and dependencies. Product-specific hierarchies and workflows remain outside the kernel.

The package is named **`@kit/tasks`**, with module id **`tasks`**. Without a shared kit model, each product reimplements visibility, stages, and link cycles.

## Decision

### D1 — Packages

Each capability owns its Drizzle tables and repositories, exported through `./schema` and `./repos` respectively. Apps compose them and own applied SQL, the Wrangler journal, routes and Worker bindings.

| Package             | Role                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **`@kit/tasks`**    | Zod task/stage/link model, visibility, opaque scope, link rules, stage helpers, optional mutation hooks and persistence schema |
| **`@kit/comments`** | Multi-target comments (`target_type` + `target_id`), same visibility enum and persistence schema                               |

### D2 — Task model (kernel)

- **`org_id` NOT NULL** (tenant spine ADR-0003)
- **Stages table**: `board_key` + stage rows (`position`, `is_default`, `is_terminal`); task has `stage_id`
- **`visibility`**: `internal` \| `shared` (not free-world “public”)
- **Opaque scope**: optional `scope_kind` + `scope_id` (both or neither) — product vocab (`project`, `client`, …); kit never interprets
- **Assignees**: M2M user ids
- **Links**: `parent` \| `blocks` \| `duplicates` — cycle check per kind; single incoming parent
- **No intake_status** in kit (product-only if needed)
- **No resource links** until a resource system exists
- **No recurrence** in V0
- **Project / phase / poles / GitHub** = product-only

**Current implementation, not a new architectural decision:** the example API validates assignees against the task organization's membership. The task repositories scope operations to the owner organization; catalogued migrations `0018` and `0019` add assignee organization ownership and composite task/organization foreign keys for assignees and links. Migration `0020` adds stage-organization guards. Applied migration history is deployment-specific; the files' presence does not establish that any particular database has applied them. Contract migration `0019` deletes mismatched rows, so operators must inspect its preflight counts before applying it.

### D3 — AudiencePort

Visibility enforcement uses **`staff` \| `external`**, resolved by the **product** (not hardcoded kit role names). Shared helpers live in `@kit/types` (`canViewByAudience`, `filterForAudience`, `canSetVisibility`). `@kit/tasks` and `@kit/comments` re-export domain names (`canViewTask`, `canViewComment`).

Apps **must** apply filter on every list/get (object ACL after module ACL — ADR-0003 D12).

### D4 — Comments

- Target: open `target_type` string (known: `task`, `project`, …) + `target_id`
- Visibility: same `internal` \| `shared`
- Compose: `taskCommentTarget(taskId)` helper

### D5 — Module ids

- `TASKS_MODULE_ID = 'tasks'`
- `COMMENTS_MODULE_ID = 'comments'` (optional separate enable; dogfood may co-enable)

### D6 — Incubate vs promote

|              |                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Incubate** | `@kit/tasks` and `@kit/comments` remain incubating and usable by products; packages own schemas and repositories, while apps own applied SQL.                                                                |
| **Dogfood**  | Delivered in Example App: `example-api` composes task and comment persistence and routes; `example-web` uses them. Migration files are present; application to a particular database is deployment-specific. |
| **Promote**  | Requires a stable schema, a green example, and **first real product compose**. Example dogfood alone does not promote the packages.                                                                          |

Package.json: mark incubating until promote. ADR presence ≠ promote (same class as flows D6).

### D7 — UI

Do **not** extract product task UI into the kit. Missing chrome comes from **shadcn** into `@kit/ui` (Date Picker, Combobox multi, …) in a later tranche. Kanban = product/example composition.

### D8 — Side-effects

Optional `TaskMutationHooks.afterMutation` only — apps own the single write path and notifications/audit.

## Consequences

- Products map their own scopes to `scope_*`; boards map to `board_key` + stage seeds.
- Resource attachment waits for a resource rail.
- Parallel to flows P0-incubating.

## Non-goals

- Product-specific task schema dumps
- Product-specific categories and hierarchies
- Intake approval workflow in kit
- Resource kind closed enum in kit
