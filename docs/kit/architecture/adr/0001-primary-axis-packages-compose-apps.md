---
title: 'ADR-0001 — Primary axis: platform packages compose deployable apps'
status: accepted
normative: true
date: 2026-07-12
amended: 2026-10-03
axial: true
supersedes_notes: >
  2026-10-03: Context line "Dual mission monorepo … future product apps (P1)" is
  obsolete. This repository is kit-only (AGENTS.md § Mission); product apps live in
  consumer repositories that inherit the kit. The decision and the primary axis are
  unchanged; nothing is superseded.
  2026-10-03 (Roxabi/roxabi-boilerplate-cf#350): Axis 3 and the Test name no
  product family; the product-app example is `apps/<product>-*` and the Test
  forbids a product package under `packages/*`. Wording only; the decision and
  the primary axis are unchanged.
summary: 'Platform packages compose deployable apps'
---

# ADR-0001 — Primary axis: platform packages compose deployable apps (Chemin A kit)

## Context

This repository ships the Chemin A Cloudflare SaaS kit; product apps live in consumer repositories inheriting it through `upstream` ([consumer contract](../../product-consumer-contract.md)). Without a primary axis, implementers risk N×M drift (auth/errors/storage forked per app, or product domain leaking into packages).

## Axes

1. **Platform concern** — `packages/*` (`@kit/*`)
2. **Deployable** — `apps/*` (examples in the kit; product apps in consumers)
3. **Product domain** — only under `apps/<product>-*`
4. **Internal layers** (secondary) — routes → services → repos inside each API app

## Decision

**Primary axis = platform packages.** Deployable apps compose packages; they own domain logic and entrypoints only.

**Test:** Adding a second product creates `apps/<product>-*` and imports `@kit/*` — it does not copy AppError/auth/db/storage stacks, and does not add a product package under `packages/*`.

## Alternatives and implementation

Product-first or deployable-first organization duplicates cross-cutting capabilities; a layer-first split risks coupling unrelated domains. Platform packages instead keep reusable capabilities separate from app composition. The workspace contains packages and synthetic example apps; their presence does not prove external product adoption or deployment.

## Consequences

- New CF SaaS → new apps under `apps/` in a consumer repository
- New cross-cutting capability → package when ≥2 call sites or ADR
- Extract dry-run: no product-share compounds under `packages/**` or `apps/example-*/**`
- Product schemas (e.g. artefacts) live in product apps, not `@kit/db`

## Anti-pattern signals

- Product markers under `packages/` (`share/{slug}`, `private_key` product mode, `share_publish`, Shlink)
- Local `class AppError` under `apps/` instead of `@kit/core`
- Same platform helper reimplemented in ≥3 apps (three-strikes → promote package)

## Expected debt

- Domain types not shared across products until a second product needs them
- Example apps must stay non-trivial enough to force real package APIs
- Layer discipline inside apps is process-enforced
