---
title: 'ADR-0023 — CI coverage partitions for heavy Apps'
status: accepted
normative: true
date: 2026-11-14
amended: 2026-11-23
axial: false
related:
  - docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md
  - docs/kit/architecture/adr/0009-kit-namespace-polarity-inheritance-marker.md
  - docs/kit/testing/ops-model.md
  - docs/kit/testing/coverage.md
  - docs/kit/testing/critical-path.md
  - docs/kit/product-consumer-contract.md
summary: 'CI coverage partitions for heavy Apps; full floors apply at merge'
---

# ADR-0023 — CI coverage partitions for heavy Apps

The operator accepted this capacity choice on 2026-11-14; go-silex/unkillable-kit#54 tracks the Kit change.
The acceptance covers the decisions below only.
On 2026-11-15 the operator amended D2, D4, D6, D7, D8 and D10: one reusable workflow call per declared App, and a partition plan that is never empty.
On 2026-11-23 [ADR-0024](./0024-root-single-quality-gate.md) D5 amended D1, D2, D6, D7, D8, D10 and the rejected empty-plan skip for pull-request plans.
It grants no merge, deployment or Product adoption admission; each keeps its own review, proof and authorization.

## Context

The `ci` check must prove the whole quality DAG within 300 seconds, including every producer's queue, setup, installation, artifact and report handling, receipts, join and cleanup ([ops model](../../testing/ops-model.md#ci-runtime-budget)).
The Coverage plan gives each App one dedicated job, so one App's single Vitest run can bound the whole DAG.
A longer timeout, paid or larger runners, removed tests, lowered floors and weakened per-file isolation are excluded.
Hosted runs vary with the VM and the queue, and the cause of slow legs is not identified: this decision adds capacity and is not a causal fix.

## Decision

### D1 — Partition declarations

A partition declaration `apps/<name> <N>` asks CI to run that App's coverage as `N` parts, with `N` from 2 to 4.
Kit declarations live in the `COVERAGE_PARTITIONS` array of `scripts/kit/test-coverage.sh`.
Product declarations live in the Product-owned `config/product/coverage-partitions.txt`: one declaration per line, `#` comments allowed.
The coverage runner validates them whenever it resolves the discovered Coverage bar, including in local `validate:full`.
A malformed line, a workspace outside `apps/*`, a count outside 2 to 4, a duplicate (also across Kit and Product) or a workspace outside the discovered Coverage bar fails.

The Kit permanently declares `apps/example-api 2` (D10), so every Kit run, and every Product run that inherits it, exercises the path.
This declaration is the Kit self-proof, not a capacity claim about that App.

### D2 — Two execution topologies, one bar

Local Root stays canonical.
`validate:full` runs every workspace, declared or not, as one monolithic `bunx vitest run --coverage` under its complete configured floors; the literal recipe body and its step order are unchanged.
When a run includes `test:coverage`, Root validates the declarations once, before its first task, and relays the coverage script's diagnostics if they are invalid.
Declarations never change local execution.

CI is the second topology for the same bar.
`--coverage-plan` omits declared Apps, and `--coverage-parts-plan` emits one descriptor per declared App: `id` equal to `apps__<name>`, `workspace`, `count` and `indices`, the part indices 1 to `count`.
Together the two plans cover the discovered bar exactly once.
When the topologies disagree, the local monolithic run is the reference.

### D3 — Parts produce RAW evidence, never a receipt

`scripts/kit/root-gate.ts` dispatches the part and merge modes, and `scripts/kit/root-gate-parts.ts` implements them.
`bun run validate:full -- --ci-coverage-part <workspace> <index>/<count> --raw <dir>` requires the declared count and runs the canonical runner invocation with only native additions:
`--shard=<index>/<count>`, the `default` and `blob` reporters with the blob output path, and `0` for the four global thresholds.
The App configuration is unchanged, so test membership, isolation, pool, `maxWorkers`, `include` and `exclude` are unchanged; the silent-exclusion check still applies.

A successful part writes one blob and the exclusive-create manifest `part-<index>-<count>.json`.
The manifest holds `version`, `kind`, `workspace`, `index`, `count`, the CI identity, `vitestVersion`, `blobSha256`, `exitCode` and `complete`.
A failed part writes no manifest and uploads nothing.

This RAW evidence never authorizes and never enters the receipts directory.
It is uploaded as `coverage-raw-<run>-<attempt>-<workspace__>-<index>-of-<count>`, which the join's `root-coverage-<run>-<attempt>-*` receipt pattern cannot match, and is retained for one day.

### D4 — The merge is the only coverage verdict for a declared App

`bun run validate:full -- --ci-coverage-merge <workspace> --raw <dir> --receipt <path>` refuses an undeclared workspace and any receipt file name other than the canonical `root-coverage-<workspace__>.json`.
It then validates the RAW set before Vitest runs:

- the RAW directories are exactly parts 1 to `N` of that App, for its declared `N`, and nothing else;
- each directory holds exactly its blob and its manifest;
- each manifest names this workspace, its index and the declared count, the installed Vitest version, `complete: true` and exit code 0;
- each manifest's identity equals the merge job's own: repository, checkout SHA, run, attempt, recipe hash and runner hash;
- each blob matches its recorded SHA-256 digest.

The merge then runs native `vitest run --merge-reports` with coverage in the App directory, under the App's unchanged configuration.
The configured floors therefore apply once, to the merged full coverage map.
The replayed test files must equal the native `vitest list --filesOnly` listing, without duplicates, and every listed test and coverage path must lie inside the App.
The merge reads the App's summary at `coverage/<App directory name>/coverage-summary.json`, which `makeCoverage` in `packages/config/vitest-coverage.mts` writes when given that name, as every Kit App does; without it the merge fails closed with an explicit missing-summary error.
Only after all of these checks does the merge write the existing per-workspace receipt, with `partition: { count, blobs }` recording the blob digests.
The merge job uploads that receipt as `root-coverage-<run>-<attempt>-merge-<workspace__>` and its merged report as `coverage-<run>-<attempt>-merge-<workspace__>`, one name per App.
Part manifests and partial reports never authorize.

### D5 — Floors

Parts defer exactly the four global keys: `lines`, `functions`, `branches` and `statements`.
Every part's coverage denominator still includes every `include` file, so a part's percentage can only fall below the merged one: a deferred floor removes false failures, never adds a false pass.
A declared App must express its floors through those four global keys, as `makeCoverage` in `packages/config/vitest-coverage.mts` does; `perFile: true` reuses those keys and is deferred with them.
Glob-pattern thresholds and object-form `perFile` thresholds are not deferred, so the parts of such an App fail closed; partitioning it requires amending this decision.

### D6 — Join

`--ci-join` in `scripts/kit/root-gate.ts` recomputes the declarations and refuses them without the Kit `apps/example-api 2` one (D10).
It accepts only the `success` producer result (D8) and requires the Core receipt plus exactly one complete current-run coverage receipt per discovered workspace, as before.
A declared App's receipt must carry its declared count and that many blob digests; an undeclared workspace's receipt must carry no `partition`.
A mode or count mismatch fails closed.
The legacy monolithic `root-coverage.json` receipt is always refused, since a partition is always declared.
The `ci` check name, merge-on-green and deploy-gate inputs are unchanged.

### D7 — Workflow topology

In `.github/workflows/ci.yml`, the plan job also emits `parts` (D2).
The `coverage-partitions` job runs a matrix over those descriptors and calls the reusable `.github/workflows/coverage-app.yml` once per declared App with its `workspace`, `count` and `indices`.
Each call runs its parts as a matrix over `indices`, then its merge, which needs only that call's parts.
A slow or failing App therefore delays or fails only its own merge; no other App's merge needs its parts.
Parts and merges live neither in the existing `coverage` matrix nor in the final `ci` job: `needs` waits for every leg of a matrix, so either placement would put the slowest unrelated leg on each declared App's path.
The callee is a Kit workflow listed in `protected_files`, as [ADR-0009](./0009-kit-namespace-polarity-inheritance-marker.md) D3 requires.

### D8 — Producer result

The partition plan is never empty: `--coverage-parts-plan` refuses declarations without the Kit `apps/example-api 2` one (D10).
The `coverage-partitions` caller carries only the draft pull request guard that the other producers use, and no partition job has a plan-dependent `if`, so the [deploy runbook](../../deploy-cloudflare.md) push rules apply to them unchanged.
The final `ci` job passes `--ci-join --producers-result` `success` only when every producer, `coverage-partitions` included, succeeds with a valid tooling selection, and `failure` otherwise; the join accepts only `success`.
The skip doctrine is unchanged: missing, skipped or failed required evidence never yields a successful join, and no sentinel or no-op job stands in for a partition.

### D9 — Runner identity

The runner hash covers `root-gate.ts` and every non-test `root-gate-*.ts` module.
Parts, merges and the join therefore bind the same runner code.

### D10 — Ownership and retirement

The `ci.yml` and `coverage-app.yml` workflows, the runner and the coverage script stay Kit-owned under [ADR-0009](./0009-kit-namespace-polarity-inheritance-marker.md) D3.
A Product declares only in its `config/product/` namespace ([ADR-0009](./0009-kit-namespace-polarity-inheritance-marker.md)) and edits no App configuration or Kit zone; a declared App must already meet the D4 summary precondition.
The App stays the coverage unit ([ADR-0001](./0001-primary-axis-packages-compose-apps.md)); Packages cannot be declared.

Deleting a Product declaration returns that App to one dedicated coverage job with no other change; remove it when the App no longer needs the capacity.
The Kit declaration `apps/example-api 2` is required: the parts plan and the join refuse declarations without it and cite this decision, so removing it requires amending this decision.

## Adoption proof

Each repository proves the budget before its own admission.
The Kit qualifies and admits its Root change first.
A Product then inherits the merged Kit through its normal upgrade and qualifies its own real CI before its own admission.
No Product proof depends on an unmerged Kit, a Kit-only proof never stands in for a Product, and no Product dual-edits Kit zones.

A declaration is adopted only with both proofs:

- **Native equality:** for each declared App, merged CI coverage equals the local monolithic run of the same tree.
  The parts are disjoint and their union equals the native file listing, the test count is equal, and `coverage-summary.json` is equal per file and in totals, for covered and total counts of all four metrics.
  Any difference blocks adoption.
- **Hosted run:** a complete green run in the repository that holds the declaration exercises the path, with the whole DAG at or under 300 seconds from actual run and job timestamps, and records the RAW artifact sizes.

Fixture evidence in `scripts/kit/test-coverage-order.sh`, `scripts/kit/root-gate.test.ts` and `scripts/kit/ci-preflight.test.ts` is listed under **CP-COVERAGE-PARTITION** in the [critical path inventory](../../testing/critical-path.md); it replaces neither proof.

## Consequences

- **Budget:** parts and merges count toward the 300-second DAG with their own queue, setup, installation, RAW transfer, merge, report, receipt and cleanup.
  More legs mean more draws of slow VMs, and native sharding balances parts by file count, not duration.
  No result is guaranteed under VM or queue variance.
- **Concurrency:** each declared App replaces one coverage job with `N` parts and one merge.
  All jobs count against the account's concurrent-job limit (20 standard jobs on GitHub Free), and queued time counts against the same 300 seconds.
- **Minutes:** [GitHub bills](https://docs.github.com/en/billing/concepts/product-billing/github-actions) no compute for standard GitHub-hosted runners in public repositories, so in the public Kit the extra jobs cost queue time and concurrency, not billed minutes.
  In a private repository each extra job draws its runtime, rounded up per job to a whole minute, from the plan's included Actions usage.
  Products inherit the Kit declaration, so every private Product pays for the `example-api` parts and merge as well as for its own declarations.
- **Storage:** RAW blobs carry coverage maps and test results, and their size grows with the suite.
  One-day retention bounds their lifetime; in private repositories they still accrue against the artifact storage allowance shared with Packages (500 MB on GitHub Free), and an exhausted allowance can block uploads and so fail CI.
- **Second topology:** merged and monolithic coverage are different computations of one bar.
  A Vitest or coverage upgrade must keep the equality proof; the version check refuses blobs from a different Vitest version.
- **Reruns:** identity binds the run attempt, so recovering a failed part requires a full-attempt rerun, as for other receipts.
- **Reporters:** parts and merges use Kit-fixed test reporters, so App-configured reporter side effects do not run in CI for a declared App.

## Alternatives rejected

- A longer timeout, paid or larger runners, `isolate: false`, lowered floors or removed tests.
- Product-declared file lists or globs per part, which could exclude tests arbitrarily.
- A duration-balanced custom sequencer, which would tie test membership to timing data.
- Parts inside the existing `coverage` matrix, or the merge inside the `ci` join: both wait for the slowest unrelated leg.
- A skip rule for an empty plan, or a sentinel job standing in for it: the plan is never empty, and a plan-dependent `if` conflicts with the deploy-gate push rules.
- One parts matrix and one merge matrix shared by all Apps: every merge would wait for every App's parts.
- Static per-App jobs in `ci.yml`: a Product would have to edit a Kit workflow.
- A merge that polls for its parts, or a last part that merges: a second scheduler beside `needs`.
- A temporary Kit declaration for the proof only, which would leave the path unexercised afterwards.
- Extending the `coverage-order.txt` grammar, which would mix run order with CI topology.
