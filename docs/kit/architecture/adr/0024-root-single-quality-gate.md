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
Root already reaches those Apps:

- `validate:full` runs lint, `turbo typecheck`, Knip, license, file-length, folder-size and import-boundary checks across the repository, and Product App paths fall within their scope.
  `turbo typecheck` runs the `typecheck` task that each workspace declares, and Biome applies its own file exclusions.
- The Coverage bar treats a `test:coverage` script as membership and runs Vitest with coverage for each member; a Product declares its tiers and partitions in `config/product/` ([ADR-0023](./0023-ci-coverage-partitions.md)).

The consumer contract, the ops model and the Product validation template say the opposite: Root stays Kit-only, and Product CI typechecks and tests Product Apps.
Inheriting Products therefore diverge.
A Product that copies the template typechecks its Apps twice.
One Product runs its suites under Root coverage, with floors and partitions; another runs them once, unpartitioned, in Product CI, where they bound its merge latency.
No check proves that Root still covers a Product App.
A Kit change that narrowed Root to Kit workspaces would keep `ci` green while those typechecks and tests stopped running.

Every Product run also repeats the Kit's own Coverage bar.
In a Product, Kit-owned workspaces match the pinned Kit revision, which the Kit's own CI has proven, apart from time-boxed zero-edit exceptions.
Their result changes with an upgrade, an exception, a lockfile change or a root configuration change.

## Decision

### D1 — One quality producer

Root is the only quality producer for every workspace, Kit and Product.
It owns lint, typecheck, Knip, license, file-length, folder-size and import-boundary checks, and tests under coverage floors.

Product CI builds deployment artifacts, such as the SPA build and the Worker dry-run of each deployed environment, and runs checks that only the Product can express.
It repeats no Root check: no typecheck, no test run, no `zero-edit` and no `deploy-gate:check`.

The consumer contract, the ops model, the Product templates and `scripts/kit/create-product-templates.sh` state this split.

### D2 — Enrollment

A Product App is a workspace at `apps/<name>` whose `apps/<name>/` prefix is not listed in `protected_prefixes` of `config/kit/zero-edit-zones.json` ([ADR-0009](./0009-kit-namespace-polarity-inheritance-marker.md) D2).
Coverage tiers do not decide ownership.
Each Product App declares a non-empty `typecheck` script and a `test:coverage` script; the existing tier check then requires its tier in `config/product/coverage-order.txt`.
Root core inventories Product Apps from the `apps/` tree and their manifests, independently of task selection.
It fails, naming the App and the missing item, when a Product App lies outside the root workspace discovery or lacks either script.
There is no opt-out.

### D3 — Self-proof

The Kit tooling self-tests run Root against a generic Product App fixture.
Both the bare Kit and a correctly enrolled fixture App pass.
The fixture exercises real Root core typechecking and the pull-request coverage path through the plan and the join.
A type error, a failing test, a missing `typecheck` script, a missing `test:coverage` script and a missing tier each fail at the intended check, with a cause that names the App.
A missing receipt for a selected Product App fails the join.
The fixture carries no Product name and needs nothing from an inheriting Product.
A Kit change that stops Root from typechecking or testing a Product App therefore fails in the Kit before any Product inherits it.

### D4 — Pull-request coverage selection

On a pull request, the coverage selection omits Kit-owned workspaces when every path changed between the trusted base and head is Product-owned.
Product-owned paths are the Product Apps (D2), the `product` namespaced trees under `config/`, `docs/` and `scripts/`, and Product workflows under the `product-` prefix ([ADR-0009](./0009-kit-namespace-polarity-inheritance-marker.md)).
This list does not redefine ownership.
Any other path selects the full bar: the lockfile, root manifests, root configuration, every Kit zone and any unclassified path.
Every Product workspace stays selected on every pull request.
Root validates the full bar and every declaration before it selects.
The selection uses the trusted pull-request base and head that `scripts/kit/select-tooling.ts` already binds.
Only a non-empty diff proven to contain Product-owned paths exclusively narrows the bar: an empty diff selects the full bar, and an unprovable context fails the plan.

Push plans, Kit `main` included, always hold the complete Coverage bar, so every promoted push SHA carries the full proof.
The tests of a Kit-owned workspace read only Kit-owned paths; a check that must read Product paths belongs to Root core or tooling.

### D5 — Producers, join and ADR-0023

On a non-draft pull request, a coverage producer (the coverage matrix or the partition calls) is skipped before matrix expansion only when its selected list is empty.
Its job condition must remain provably true on push for the deploy-gate loader, for example through a `github.event_name != 'pull_request'` disjunct.
The join recomputes both selected lists from the trusted context.
It accepts `skipped` only for a producer whose recomputed list is empty, and otherwise requires success.
Core, applicable tooling evidence and exactly one complete current-run receipt per selected workspace remain required.
No sentinel job stands in for a skipped producer.
Push rules are unchanged.

For pull-request plans, this amends [ADR-0023](./0023-ci-coverage-partitions.md):

- **D1 and D10:** `apps/example-api 2` stays declared and is validated on every run.
  On a pull request it executes only when Kit-owned workspaces are selected; every push and every local run still exercises it.
- **D2 and D7:** the two CI plans together cover the selected bar exactly once, and the reusable workflow is called once per selected partitioned App.
- **D6 and D8:** the join and the producer result follow this decision; the partition plan is never empty on push.
- **Alternatives:** the rejected empty-plan skip is admitted for pull requests only, under the conditions above.

### D6 — Adoption

The Kit ships D1 to D5 in one release whose notes carry the Product action.
The Product templates and `scripts/kit/create-product-templates.sh` drop the Product-side typecheck and test calls, including the MCP calls that the generator injects.
Because the inherited D2 check fails an unenrolled App, a Product adopts in its upgrade pull request.
It enrolls each Product App, with floors through `makeCoverage` and partitions under [ADR-0023](./0023-ci-coverage-partitions.md) when an App needs them, and removes the calls that D1 forbids from its copied Product validation.
One Product pilots the release and proves the 300-second budget on hosted runs before other Products adopt.

## Consequences

- **Latency:** Product suites run in parallel Root coverage jobs and parts under the 300-second budget, instead of one sequential Product CI job.
  A suite that cannot meet the budget in four parts must get faster; this decision raises neither the partition cap nor the timeout.
- **Minutes:** in private Products, enrollment moves test minutes from Product CI to Root, and parts add setup time and per-job rounding.
  Pull-request selection removes Kit-owned coverage jobs from Product-only pull requests.
  Push runs keep their full cost.
- **Floors:** every Product App gets coverage floors, which the Product sets through `makeCoverage`.
- **Narrower pull-request proof:** a pull request that touches only Product-owned paths does not re-prove Kit-owned workspaces; its own push does.
  Its base push may itself have failed, so a Kit-owned failure, including a time-dependent or flaky test, surfaces on push rather than on that pull request.
- **One topology:** the templates and the generator no longer offer a Product-side test path.
- **Upgrade:** the release requires a Product action, and an unenrolled Product App fails Root after the upgrade.

## Alternatives rejected

- Root strictly Kit-only, with Product Apps filtered out of typecheck, lint, Knip and coverage: every Product would rebuild the quality tooling, ADR-0023 Product partitions would lose their purpose, and Products that already rely on Root would lose coverage.
- The status quo: contradictory documents, two test topologies and no proof that Root covers Product Apps.
- Product typechecks kept in Product CI as a backstop: two producers for one check.
- An opt-in flag or a Product manifest for enrollment: an omission would again pass silently.
- Coverage tiers as the source of App ownership: a risk-tier edit would change enrollment and pull-request selection.
- Skipping Kit-owned coverage on push as well: the promoted SHA would lose the full proof.
- Reusing a pull-request verdict for its push, or caching coverage results across runs: the run that judges a SHA must produce its proof.
- Step-level skips inside Kit coverage jobs that are always scheduled: in private repositories each skipped job still bills a rounded minute.
