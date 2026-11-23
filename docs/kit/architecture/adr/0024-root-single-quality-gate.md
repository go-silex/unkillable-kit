---
title: 'ADR-0024 — Root is the single quality gate for Product Apps'
status: accepted
normative: true
date: 2026-11-23
axial: false
related:
  - docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md
  - docs/kit/architecture/adr/0009-kit-namespace-polarity-inheritance-marker.md
  - docs/kit/architecture/adr/0023-ci-coverage-partitions.md
  - docs/kit/product-consumer-contract.md
  - docs/kit/testing/ops-model.md
  - docs/kit/templates/product-validate.example.sh
  - scripts/kit/select-tooling.ts
summary: 'Root is the single quality gate; Product CI builds deployment artifacts'
---

# ADR-0024 — Root is the single quality gate for Product Apps

The operator accepted these decisions on 2026-11-23; go-silex/unkillable-kit#156 tracks the Kit change.
The acceptance covers the decisions below only.
It grants no merge, deployment or Product adoption admission; each keeps its own review, proof and authorization.

## Context

A Product adds its Apps under `apps/<product>-*` and inherits the Root gate unchanged ([ADR-0009](./0009-kit-namespace-polarity-inheritance-marker.md)).
Root already checks those Apps:

- `validate:full` runs lint, `turbo typecheck`, Knip, license, file-length, folder-size and import-boundary checks over every workspace that the root `workspaces` globs discover, Product Apps included.
- The Coverage bar discovers every workspace with a `test:coverage` script; a Product declares its tiers and partitions in `config/product/` ([ADR-0023](./0023-ci-coverage-partitions.md)).

The consumer contract, the ops model and the Product validation template say the opposite: Root stays Kit-only, and Product CI typechecks and tests Product Apps.
Inheriting Products therefore diverge.
A Product that copies the template typechecks its Apps twice.
One Product runs its suites under Root coverage, with floors and partitions; another runs them once, unpartitioned, in Product CI, where they bound its merge latency.
No check proves that Root still covers a Product App.
A Kit change that narrowed Root to Kit workspaces would keep `ci` green while those typechecks and tests stopped running.

Every Product run also repeats the Kit's own Coverage bar.
In a Product, Kit-owned workspaces are byte-identical to the pinned Kit revision, which the Kit's own CI has proven.
Their result changes only with an upgrade, a lockfile change or a root configuration change.

## Decision

### D1 — One quality producer

Root is the only quality producer for every workspace, Kit and Product.
It owns lint, typecheck, Knip, license, file-length, folder-size and import-boundary checks, and tests under coverage floors.

Product CI builds deployment artifacts, such as the SPA build and the Worker dry-run of each deployed environment, and runs checks that only the Product can express.
It repeats no Root check: no typecheck, no test run, no `zero-edit` and no `deploy-gate:check`.

The consumer contract, the ops model and the Product templates state this split.

### D2 — Enrollment

A Product App is a workspace under `apps/` that the Kit tiers of the Coverage bar do not list.
Each Product App declares a non-empty `typecheck` script and a `test:coverage` script, and is therefore on the Coverage bar, with a tier in `config/product/coverage-order.txt`.
Root core fails when a Product App lacks either script, and names the App and the missing script.
The check reads the workspace manifests, not the Turbo task graph, so a filter on a Root task cannot hide an App.
There is no opt-out.

### D3 — Self-proof

The Kit tooling self-tests run Root against a generic Product App fixture.
The bare Kit passes.
A type error, a failing test, a missing `typecheck` script, a missing `test:coverage` script and a missing tier each fail Root, with a cause that names the App.
The fixture carries no Product name and needs nothing from an inheriting Product.
A Kit change that stops Root from typechecking or testing a Product App therefore fails in the Kit before any Product inherits it.

### D4 — Pull-request coverage selection

On a pull request, the coverage plan omits Kit-owned workspaces when every path changed between the trusted base and head is Product-owned.
Product-owned paths are the Product Apps, the `product` namespaced trees under `config/`, `docs/` and `scripts/`, and Product workflows under the `product-` prefix ([ADR-0009](./0009-kit-namespace-polarity-inheritance-marker.md)).
The lockfile, root manifests, root configuration and every Kit zone select the Kit-owned workspaces.
The selection uses the trusted pull-request base and head that `scripts/kit/select-tooling.ts` already binds.

Push plans, Kit `main` included, always hold the complete Coverage bar, so every promoted push SHA carries the full proof.
The tests of a Kit-owned workspace read only Kit-owned paths; a check that must read Product paths belongs to Root core or tooling.

### D5 — Amendments to ADR-0023

- **D6, join:** on a pull request, the join recomputes the selection from the same context and requires exactly one complete receipt per workspace of the selected plan. Push joins are unchanged.
- **D8, producer result:** the partition plan is never empty on push. A pull-request skip may use only a job condition that the deploy-gate loader proves true on push, such as a `github.event_name != 'pull_request'` disjunct.
- **D10, Kit declaration:** `apps/example-api 2` stays required. It is planned on every push and on every pull request that selects Kit-owned workspaces.

### D6 — Adoption

The Kit ships D1 to D5 in one release whose notes carry the Product action.
Because the inherited D2 check fails an unenrolled App, a Product adopts in its upgrade pull request.
It enrolls each Product App, with floors through `makeCoverage` and partitions under [ADR-0023](./0023-ci-coverage-partitions.md) when an App needs them, and removes the calls that D1 forbids from its copied Product validation.
One Product pilots the release and proves the 300-second budget on hosted runs before other Products adopt.

## Consequences

- **Latency:** Product suites run in parallel Root coverage jobs and parts under the 300-second budget, instead of one sequential Product CI job. A suite that cannot meet the budget in four parts must get faster; this decision raises neither the partition cap nor the timeout.
- **Minutes:** in private Products, enrollment moves test minutes from Product CI to Root, and parts add setup time and per-job rounding. Pull-request selection removes Kit-owned coverage jobs from Product-only pull requests. Push runs keep their full cost.
- **Floors:** every Product App gets coverage floors, which the Product sets through `makeCoverage`.
- **Narrower pull-request proof:** a pull request that touches only Product-owned paths does not re-prove Kit-owned workspaces; its base push did, and its own push will. A time-dependent or flaky Kit test therefore surfaces on push, not on that pull request.
- **One topology:** the templates no longer offer a Product-side test path.
- **Upgrade:** the release requires a Product action, and an unenrolled Product App fails Root after the upgrade.

## Alternatives rejected

- Root strictly Kit-only, with Product Apps filtered out of typecheck, lint, Knip and coverage: every Product would rebuild the quality tooling, ADR-0023 Product partitions would lose their purpose, and Products that already rely on Root would lose coverage.
- The status quo: contradictory documents, two test topologies and no proof that Root covers Product Apps.
- Product typechecks kept in Product CI as a backstop: two producers for one check.
- An opt-in flag or a Product manifest for enrollment: an omission would again pass silently.
- Skipping Kit-owned coverage on push as well: the promoted SHA would lose the full proof.
- Reusing a pull-request verdict for its push, or caching coverage results across runs: the run that judges a SHA must produce its proof.
- Step-level skips inside Kit coverage jobs that are always scheduled: in private repositories each skipped job still bills a rounded minute.
