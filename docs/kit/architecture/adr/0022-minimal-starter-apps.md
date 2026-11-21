---
title: 'ADR-0022 — Minimal starter Apps'
status: accepted
normative: true
date: 2026-11-14
amended: 2026-11-21
axial: false
supersedes_notes: >
  2026-11-21: decision 6 drops the unenforced 60-file / 4,000-line cap; `extract-dry-run`
  now checks that the starter API keeps only the `core` and `audit` schema sets.
  Decision 4 names `create-product.sh`, which already copies the starters.
related:
  - AGENTS.md
  - GLOSSARY.md
  - docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md
  - docs/kit/architecture/adr/0012-kernel-persistence-request-context.md
summary: 'Minimal starter Apps and shared request policy'
---

# ADR-0022 — Minimal starter Apps

Decided by the operator on 2026-11-14.

## Context

Independent Product deployments need a small, type-checked starting point organized around business modules, without adopting the optional capability showcase.

## Decisions

1. The Kit owns `apps/starter-api`, a Hono Worker, and `apps/starter-web`, a Vite and TanStack Router App. They provide authentication, Organization tenancy and audit, without opt-in capabilities.
2. API business modules live under `src/modules/<module>/` and own their routes, service, repository access and tests; cross-cutting wiring lives under `src/platform/`. Exactly one neutral sample module uses only the `core` and `audit` schema sets. It introduces no Product domain.
3. `example-*` remains the composition proof for opt-in capabilities, not the minimal starting point.
4. These Apps are the copy source of `scripts/kit/create-product.sh`. They do not depend on `example-*`; the script's rename map covers their package names, Worker names and titles.
5. Shared authentication requirements, Organization context resolution and auth route mounting belong to their owning `@kit/*` package. Both API Apps consume that policy; the existing example HTTP behavior remains unchanged.
6. Both starters participate in the root gate with their own coverage floors. `extract-dry-run` refuses a starter API manifest whose schema sets are not exactly `core` and `audit`. Adding an opt-in capability to a starter requires an amended decision; the starter must not become a second example.

## Consequences

The starter is maintained and tested as a real workspace rather than as an unvalidated template. Its minimal scope makes optional integrations and Product-specific behavior explicit follow-on work. Deployment is outside this decision's implementation.

## Alternatives rejected

- A template outside the workspace would escape ordinary type-checking and drift.
- Reusing `example-*` would couple a minimal Product to opt-in demonstrations and their technical-layer layout.
- Generator-only templates would hide the source from normal workspace validation and delay feedback until generation.
