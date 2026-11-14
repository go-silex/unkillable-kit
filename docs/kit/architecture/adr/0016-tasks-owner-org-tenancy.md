---
title: 'ADR-0016 — Tasks owner-Organization tenancy: implementation and rollout'
status: proposed
normative: false
date: 2026-10-03
axial: false
related:
  - docs/kit/architecture/adr/0003-multi-tenant-rbac-modules.md
  - docs/kit/architecture/adr/0007-tasks-comments-kernel.md
  - docs/kit/architecture/adr/0008-kit-schema-identity-product-compose.md
  - docs/kit/architecture/adr/0012-kernel-persistence-request-context.md
  - apps/example-api/migrations/0018_tasks_assignees_org.sql
  - apps/example-api/migrations/0019_tasks_org_fk_contract.sql
  - apps/example-api/migrations/0020_tasks_stage_org_guard.sql
  - packages/tasks/src/repos.ts
summary: 'Tasks owner-org tenancy'
---

# ADR-0016 — Tasks owner-Organization tenancy: implementation and rollout

## Status and scope

This record remains **proposed, non-normative**. It records current implementation and operational hazards already cited by immutable SQL and source comments; it does not accept a future tenancy architecture. The accepted task capability is stated autonomously in ADR-0007. Removing future projection material does not authorize cross-Organization reads or change membership-based access.

## Context and rationale

Task-family repositories and database constraints defend against a caller addressing a child through another Organization. App-only checks cannot protect direct repository consumers; weaker package SQL sketches cannot represent the applied tenancy contract. Existing SQL and repository behavior are described below, not claimed deployed on any remote database.

## Observed implementation

### D1 — Tenant of record

Task-family `org_id` is the owning Organization. It is not another acting or reading Organization. The existing API resolves scope through Organization membership; there is no Kit Organization-binding/projection surface.

### D2 — Database constraints and rollout boundary

`0018_tasks_assignees_org.sql` adds/backfills nullable assignee `org_id` and owner-first indexes. `0019_tasks_org_fk_contract.sql` re-backfills, purges assignees/links whose Organization disagrees with their tasks, and rebuilds those child tables with NOT NULL and composite parent+Organization FKs. It carries its actual released-SHA contract marker; the source does not establish production application.

Never rebuild the `kit_tasks` parent as a cosmetic refactor: dropping a parent can fire ON DELETE CASCADE for Product-owned children unknown to the Kit. Existing `0020_tasks_stage_org_guard.sql` instead uses an additive stage unique index and insert/update/replacement triggers. Future table rebuilds must preserve these guards; they do not retroactively validate pre-existing rows.

The current expand/contract protocol requires the expanded Worker before the contract. For every live database, inspect the two exact purge-count queries in the 0019 header before any separately authorized apply. Non-zero counts require inspection and explicit purge approval; recovery is D1 Time Travel, not a reverse migration. This documentation change applies no SQL.

### D3 — Repositories

Existing-row task-family operations require owner `orgId`. Reads are scoped; deletion proves ownership before changing children; `insertLink` verifies both endpoints; `updateTask` refuses identity/ownership fields. Assignee reads join through the owning task across the expand window; writes are chunked for D1 and replacement is atomic with its returned added/removed delta. Package types do not replace those runtime guards.

### D4 — Assignees

The Example App validates `assigneeIds` against members of the owning Organization and returns a validation field error for strangers. Tasks does not import auth or add a FK to Better Auth membership. Removing a member does not automatically erase old assignee rows; no member-removal lifecycle is delivered by this record.

## Alternatives, consequences and limits

App-only isolation leaves direct repository callers unprotected. Composite child constraints and owner-scoped operations preserve the existing Organization model but require careful expand/deploy/contract rollout. Polymorphic comments still require App-owned cleanup rather than a generic task FK. Source and local fixture coverage cannot prove a remote apply, a Product migration or acceptance of this proposal.
