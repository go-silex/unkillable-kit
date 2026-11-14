---
title: 'ADR-0022 — Minimal starter Apps'
status: accepted
normative: true
date: 2026-11-14
axial: false
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
4. These Apps are the copy source for a future `create-product` generator. They do not depend on `example-*`; a declared rename map covers their package names, Worker names and titles.
5. Shared authentication requirements, Organization context resolution and auth route mounting belong to their owning `@kit/*` package. Both API Apps consume that policy; the existing example HTTP behavior remains unchanged.
6. Both starters participate in the root gate with their own coverage floors. Each App is capped at 60 owned files and 4,000 lines, including tests and configuration, excluding generated files and dependencies. Raising either cap requires an amended decision; the starter must not become a second example.

## Consequences

The starter is maintained and tested as a real workspace rather than as an unvalidated template. Its minimal scope and size cap make optional integrations and Product-specific behavior explicit follow-on work. The generator and deployment are outside this decision's implementation.

## Alternatives rejected

- A template outside the workspace would escape ordinary type-checking and drift.
- Reusing `example-*` would couple a minimal Product to opt-in demonstrations and their technical-layer layout.
- Generator-only templates would hide the source from normal workspace validation and delay feedback until generation.
