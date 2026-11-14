# Testing

## Ops model — local first, CI guardrail

CI minutes and red loops on GitHub are costly (Free private, agents, merge-on-green). **Policy:**

```text
Developer / agent workstation
  pre-commit  → Biome (staged)           # fast
  pre-push    → bun run validate:full + applicable tooling self-tests
         ↓
  push only when green locally
         ↓
GitHub CI     → same applicable gates    # guardrail only
         ↓
merge-on-green (current exact-head authorization receipt + checks)
```

After Biome, pre-commit restages the indexed ACMR paths as literal names using tracked-only updates, including already-indexed files under ignore rules. It does not discover ignored untracked neighbors, and staged deletions remain deletions. `test:lefthook-deletes` exercises these index boundaries.

| Layer                               | Role                                                                                                                                                                                                                                    | Cost expectation                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Lefthook pre-push**               | **Primary kit bar** — `validate:full` plus selected `validate:tooling`                                                                                                                                                                  | Accept wall-clock; fix here                   |
| **CI** (check `ci`)                 | **Secondary kit bar** — same tree gate and tooling selection if hooks skipped or local env lied                                                                                                                                         | Should almost always be green if pre-push ran |
| **Product CI** (`product-validate`) | **Product bar** — typecheck/test/build for `apps/<product>-*` via **copied** templates ([`product-validate.example.sh`](.././templates/product-validate.example.sh), [`product-ci.example.yml`](.././templates/product-ci.example.yml)) | Product repos only; not kit CI                |
| **Secret scan**                     | Orthogonal security                                                                                                                                                                                                                     | Always — **two passes, see below**            |

`validate:full` retains current-tree checks; `validate:tooling` runs the gate tooling self-tests. Local pre-push queries the actual push remote once, comparing the advertised predecessor and supported PR bases. The push target must match `origin`; `main` is required, and absent `staging` is allowed only after a successful listing. Existing bases must be local ancestors. A local app-only skip also requires network access, authentication and an existing verifiable PR: read-only GitHub context must prove its exact base and head refs. Missing, ambiguous or unauthenticated PR context, missing or new predecessors, unknown remotes, unavailable objects, non-ancestor synthetic merges and other uncertainty select the lane conservatively. A Kit push to `main` always selects it; a non-HEAD source is refused because the current tree cannot attest the pushed commit. CI compares the push event's before SHA or the PR base with the head. The selector owns the input classes and discovery rules. Automatic discovery matches literal, root-relative test references, not dynamically constructed or indirect paths; authors adding tooling dependencies must update the input classes.

For that proof, the authenticated `gh` API must return exactly one open PR for the destination branch, with the advertised old head SHA and ref, both repositories matching the push origin, and base `main` or `staging`. Zero or multiple PRs, API failure, observed fork, unknown or stale targets, and initial branches run the lane. This local optimization covers the configured push repository and the positively identified same-repository PR only; it does not attest unobserved external PRs. CI selects independently from the actual event.

In Product mode the selector validates context before skipping inherited tooling self-tests. A zero-edit exception covering a tooling input or changes to Product configuration, manifests or the shared, unprotected `bun.lock` select the lane; uncertainty also runs it. The CI tooling job always validates selection and conditionally skips checkout, installation and tooling steps; the aggregate requires a successful job and valid selection, not a skipped job. Run `bun run validate:tooling` explicitly when needed. These self-tests do not replace live current-tree checks, Product validation or secret scanning.

### CI runtime budget

The quality jobs and final `ci` join each request a five-minute execution timeout. The root `package.json` remains the gate's source of truth; meeting the budget must not remove controls, lower coverage floors or weaken test isolation.

The measured quality path includes every producer's queue, checkout, installation, all controls, report and receipt handling, and the final join and cleanup. Cancellation, `always()` steps and runner cleanup can outlive a timeout; use actual workflow and job timestamps and a complete success verdict to prove ≤300 seconds for the whole DAG. Per-job timeout settings are not that proof and do not change independent Product workflow timeouts.

Distinguish cold task/transform caches from warm runs, and record the runner, cache state and complete exit status. A cached tool download is not a cached task result. Local measurements are not evidence of GitHub runner performance; successful real CI evidence is required separately in the kit and a product consumer.

The measured multi-file Auth, Flows, UI, Example API and Example Web suites use all available CPUs only when the existing `CI` flag is non-empty. Without it, Vitest's run/watch worker defaults remain unchanged. Local Root executes each selected ordered recipe sequentially and fails fast. `COVERAGE_CHANGED_BASE` is a local seam and cannot execute the Root gate.

The existing Coverage plan runner first checks inheritance and zero-edit with Node and full Git history, before Bun setup, installations or coverage matrix expansion. Root core and coverage depend on that plan; the final `ci` join runs after a failed plan and requires its success and all required receipts. Missing, skipped or failed prerequisite evidence is never a successful join; a successful tooling job with valid selection may intentionally skip its tooling steps. Separate Product CI and Secret scan remain independent and blocking.

`test:dogfood-zero-edit` also exercises the canonical Product Dependabot configuration and Node-only inheritance preflight. Ownership fixtures reject protected Product manifest edits and noncanonical/disabled configurations; dependency-admission fixtures separately evaluate immutable Product identity and protected manifest paths while retaining whole-lock supply-chain checks. These local fixtures do not prove hosted Bun updater diffs, App-only shared-lock regeneration or GitHub runner savings.

CI runs its ordered Core complement on one hosted VM. The read-only Root `--coverage-plan` mode partitions the complete discovered Coverage bar: every App has a dedicated job, while Packages are distributed round-robin into groups of at most four, preserving their relative order inside each group. Packages in a group share a VM and filesystem, but each workspace runs in a separate canonical Root process through the same `bunx vitest run --coverage` invocation, with unchanged per-file isolation and coverage floors. The coverage script itself stays sequential when it runs more than one workspace. No runner-level worker override changes Product configurations.

Each workspace produces its own receipt. Ordinary workspace failures do not prevent later members of the group from running; any failure keeps the group red. Before the next invocation clears `coverage/`, the entire available report tree is moved into a workspace-qualified directory, including after a failed invocation. Receipt and report artifacts remain separate.

The final `ci` check requires every producer to succeed and a substantive current-run receipt join, bound to the actual checkout, run, attempt, recipe and runner. A monolithic Coverage receipt remains accepted; a shard set must name every discovered workspace, independently of how many workspaces share a runner. Fewer configured jobs alone prove neither a shorter workflow nor a reduction in billed usage; both require real CI measurements.

Receipt binding detects accidental stale, foreign or incomplete execution, not malicious changes to trusted workflow code. The pinned official artifact downloader fails on a digest mismatch by default; digest validation does not replace the receipt join.

Auth tests default to Node; files requiring a browser DOM opt in with `/** @vitest-environment happy-dom */`. The real forms renderer uses that environment, with explicit React Testing Library cleanup before the shared mock, global, environment, timer and storage restorers. Server tests retain their real behavior and per-file isolation; the coverage floors and test membership are unchanged.

Vitest 5.0.5 enables persistent transformed-module caching by default. A cold proof must control the resolved project cache directories and observed project compiler build caches, such as TypeScript `.tsbuildinfo`, before the complete gate starts, not just Turbo's task cache. Warming generated by steps inside that same cold-started gate is part of its measured work; a previously populated project cache is a different condition. This does not imply cold OS, tool, package or global Node caches.

### Merge residual (GitHub Free private)

The maintained merge gate uses an authenticated receipt bound to the repository, PR and exact head, not a `reviewed` or `deps-automerge` label. Dependabot receipts also bind the evaluated base SHA. See [CI App setup](.././ci-app-setup.md#reviewed-head-authorization) and [the guard](.././security-dependabot.md#auto-merge-guard).

On GitHub Free private, `merge-on-green` is **process**, not branch protection: no required checks or reviewers are implied.

Anyone with **write** (or admin) can:

- merge a PR in the UI / `gh pr merge` without the receipt and without waiting for `ci` + TruffleHog;
- push directly to `main`.

When configured, the maintained workflow scans eligible open PRs on trusted wakeups; a label is only a hint. It requires an open, mergeable, non-draft PR and a valid current receipt. The whole authenticated stream is read before selecting its newest record; a malformed, edited, wrong-scope or duplicate-operation selected record holds. Numeric issuer identity, predecessor and GraphQL edit/association proof are checked. A later withdrawal denies all lanes; a fresh explicit admission is required to reissue.

Initial evaluation checks admission before quality. An unadmitted PR is reported with its authorization reason; its quality is **not evaluated**, not green. An admitted PR receives the complete quality assessment. Default-ref dispatch still scans eligible open PRs; its configured-App mint diagnostic does not bypass admission or quality.

**Kit** evidence requires successful required CI and secret-scan checks; neither `neutral` nor `skipped` satisfies a required check. CI names match `ci`, `validate-full` or `lint-typecheck-test` case-insensitively; secret-scan names contain `TruffleHog` or `Secret scan`, case-insensitively. A Product check containing a secret substring is also required, not optional. Other checks may conclude `success`, `neutral` or `skipped`; pending or failing current evidence holds. The combined commit status must be `success` when present.

Listed check evidence seeds the Kit freshness assessment: it consults producers whose own suites are listed and proven same-PR producers of any listed workflow, not every run merely sharing a workflow ID. GitHub's explicit `latest` check-run listing can still retain checks from distinct suites. A rerun of an already-listed suite uses its latest exact attempt. Across different runs, replacement is limited to `pull_request` runs whose immutable workflow ID, event, head repository, head branch and SHA match the assessed PR. A complete all-state source-head PR listing with fewer than 100 results must prove that only that PR ever used the head, and the filtered PR timeline must show no manual base change, base deletion or automatic base relink. Current run-to-PR associations are not execution provenance.

For a listed workflow, the latest proven same-PR run's exact-attempt jobs count even before its own suite appears in the check snapshot: completed successful jobs can satisfy required success, while pending or nonpassing evidence holds. Independent or unproven contexts contribute only once their own suite has listed checks. An older suite's raw check is removed only when its job ID is proven to belong to that same suite and the replacement is proven by exact-attempt job membership. Unmatched, custom, foreign and null-App checks remain authoritative. Raw checks from the gate's own workflow are retained too: only the `merge-on-green` self job is excluded, so the separate revocation job can still block. A second complete head-run listing fences changes across all nonself runs; even unlisted activity changing during the read can transiently hold. Pending, failed or no-job evidence and a new-run race hold normally; malformed or partial API evidence, failed proof reads and exceeded caps are unreadable failures.

When branch history or a base-change event proves distinct contexts, the runs stay independent even if a newer run on the same head succeeds. Independently listed unrelated activity at that head can hold the candidate; an older skipped required check may also remain a hold. A rerun of the original draft run reuses its draft payload and cannot clear a skipped draft check. Inspect the actual context and proof first; a fork alone is not a hold, though unknown immutable head or history evidence is treated conservatively.

**Workaround, when appropriate:** a new head with canonical CI and normal fresh admission can reset the head's check evidence. This costs another CI run and review; it is containment, not a root correction or durable protection from recurrence. Never override or relabel the result, or waive required-check success.

The separate **Product** rule resolves the live base, reads Product declarations at immutable base and head, and requires each declared workflow's latest matching head run and exact-attempt jobs to succeed, with a post-job run re-read. Missing or invalid head declarations and skipped Product evidence hold.

Evaluation queues the head and exact receipt. Landing performs fresh quality checks, then the final fresh authorization read requires that exact receipt immediately before the SHA-pinned merge. A replacement on the same SHA requires new evaluation. After each sequential merge it resolves the next base again. Gate reads use `GITHUB_TOKEN`; a separately scoped CI App token performs the merge.

A `409` merge response is a stale hold for that candidate and the sequential loop continues to other candidates; any other merge-write error enters the `unreadable` bucket and makes the run red, despite that bucket's name.

Behavioral tests do not establish GitHub event delivery, live configuration or checkout provenance. GitHub reads and merge are separate, so external authorization, base or check changes after the final observation remain residual; older or alternative workflow definitions may omit the maintained guards. Append-only is a publisher convention, not immutable GitHub storage: trusted deletion or editing away of history can erase a fence. Returning to identical A without an accepted withdrawal may match again, although A never authorizes B. Trusted operators, default-branch writers and dispatchers, administrators and App managers remain inside the trust boundary.

Where repository rulesets are available, the operator can add the [CI App-only bypass ruleset](.././ci-app-setup.md#optional-main-ruleset) without replacing this gate. It restricts updates to the bypass actor, requires PRs and named `ci` and `TruffleHog` checks for non-bypass actors, and blocks force pushes and deletion. On the pull-request path the App bypasses the entire ruleset, including checks and PR requirements; the retained gate, App credentials and trusted workflow provenance therefore remain essential. Neither the ruleset nor this documentation proves configuration or closes the separate races and trusted-principal risks above. Free private repositories without available protection retain the writer bypass described above.

### Merge wakeup contract

A wakeup is an eligibility hint, never admission or evidence that a check passed. Every evaluation scans eligible open PRs, even when the payload names an old head, has no PR association or prioritizes another PR. The scan can merge another independently authorized, currently green PR.

| Transition                                                   | Wakeup and fresh decision                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A workflow finishes, including a rerun or corrected PR Title | `workflow_run: completed` uses `['**', '!Merge on Green']`, intended to include arbitrary names and exclude the reserved gate name. The exact configuration has bounded hosted evidence below; another producer with the reserved name is not a supported wakeup source. There is no success-only event filter; the gate still requires its checks and authorization. |
| Admission, replacement or withdrawal arrives after checks    | A created protocol comment can wake evaluation. The payload prefix is only a filter; the comment, issuer and PR association are fetched again and the authenticated stream is read in full.                                                                                                                                                                           |
| Base changes or `main`/`staging` advances                    | Base edits and pushes wake a fresh scan. Human synchronize/reopen retains its withdrawal job; Dependabot retains its separate capture and withdrawal path. A base push does not re-admit a Dependabot receipt bound to an earlier base SHA.                                                                                                                           |
| Combined status changes or an external check finishes        | A status event wakes a fresh read. GitHub suppresses `check_run`/`check_suite` events for Actions-associated heads, so an external check finishing last without another wakeup requires authorized default-ref dispatch.                                                                                                                                              |
| Delivery is missed or recovery is requested                  | Default-ref dispatch scans all eligible PRs and can merge them; it requires separate operational authorization. It retains the configured-App mint diagnostic even with an empty queue.                                                                                                                                                                               |

The pre-runner filter avoids ordinary or non-PR comments, unprivileged PR no-ops, irrelevant labels, title/body-only edits, off-default dispatch and Dependabot synchronize/reopen already handled by capture. Draft-to-ready relies on subsequent CI completion, not an early target-event scan. Other wakeups may race new check registration; fresh reads are not an atomic title-bound validation.

GitHub documents [workflow names and OR matching](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_runworkflows); that documentation alone does not establish this exact ordered negative pattern. [Event suppression and workflow-chain limits](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), including events created by `GITHUB_TOKEN`, mean delivery is not universal. Do not rely on a wakeup from a producer already two `workflow_run` levels deep: when GitHub suppresses it, recovery requires a separately authorized trusted default-ref dispatch. Concurrency retains at most one pending job; later wakeups can replace it even with `cancel-in-progress: false`. The running job is not canceled, and the surviving scan reads current state: this is not a durable FIFO queue.

**Bounded hosted filter observation.** The exact pattern was exercised in the public [qualification repository](https://github.com/go-silex/actions-wakeup-qualification) at head `3aaca282966ee2a3cf363d2096b8ca2f17412412`. Two dispatched producers and their observed descendants yielded ten successful runs/jobs, all on attempt 1. For each producer, the literal witness observed the first receiver completion W(R1), and the wildcard receiver observed the first witness completion R(W1); no receiver was observed with `Merge on Green` as parent during the 15-minute observation.

| Producer                                                                                        | First receiver R1                                                                       | First witness W1                                                                        | W(R1)                                                                                      | R(W1)                                                                                      |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| [PR Title](https://github.com/go-silex/actions-wakeup-qualification/actions/runs/43319637258)   | [R1](https://github.com/go-silex/actions-wakeup-qualification/actions/runs/43319677447) | [W1](https://github.com/go-silex/actions-wakeup-qualification/actions/runs/43319677457) | [W(R1)](https://github.com/go-silex/actions-wakeup-qualification/actions/runs/43319702507) | [R(W1)](https://github.com/go-silex/actions-wakeup-qualification/actions/runs/43319701387) |
| [Product CI](https://github.com/go-silex/actions-wakeup-qualification/actions/runs/43319642782) | [R1](https://github.com/go-silex/actions-wakeup-qualification/actions/runs/43319670244) | [W1](https://github.com/go-silex/actions-wakeup-qualification/actions/runs/43319670445) | [W(R1)](https://github.com/go-silex/actions-wakeup-qualification/actions/runs/43319694592) | [R(W1)](https://github.com/go-silex/actions-wakeup-qualification/actions/runs/43319697107) |

No depth-three chain children were created; this is consistent with a chain cutoff, not proof of its cause. The observation has no unnegated control and therefore does not prove that negation caused the absence. It does not establish universal delivery, attempt-two or failure behavior, Product authorization, merge safety or net savings.

Avoided runner allocations and added read-only evaluations are separate costs. Each full assessment uses two complete head-run listings and job pages for latest runs and observed older suites; when at least two candidate PR runs need provenance, it also reads one REST source-head listing and one GraphQL timeline. Landing assesses afresh without a shared cache. No net savings is established without measurement.

In one single-page replay with six workflow runs and an empty authorization scaffold, one full scan used 25 calls: 24 REST and one GraphQL. The open-PR listing accounted for one REST call, leaving 23 REST and one GraphQL for the PR. Admission-first rejection used about six REST calls plus protocol-comment proof and pages. The admitted full path retains the full quality cost; an admitted early quality failure also pays the preceding authorization reads. As a rough REST-only model for that fixture, use scan listing + `6U + 23A + 23L`, where `U` is unadmitted assessments, `A` admitted full assessments and `L` landing reassessments. Comment history, Product declarations, pagination and consumer histories vary; this is not a capacity guarantee or a claim that all PRs are admitted. GraphQL queries add separately costed points, not a fixed request-count equivalent.

GitHub documents a primary [`GITHUB_TOKEN` REST limit](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) of 1,000 requests per hour per repository, shared with other workflows using that token; Enterprise Cloud resource limits differ. GraphQL has a separate points budget. A primary 403 with zero remaining or an API rate-limit error, and a secondary 429, can make the gate unreadable/red and hold merges while affecting other workflows. Assess capacity per repository before admission or rollout. On the first such error or budget overrun, hold new admissions and seek an operator-approved safe containment or rollback decision; do not silently create a policy exception. Any rollback must preserve admission, revocation and required-check success: a full revert to older skipped-permissive semantics is not automatically safe. Disabling automation or limiting wakeups is a **mitigation** requiring separate authorization and manual recovery for lost automatic wakeups, not a correction.

Behavioral tests and event replays do not prove hosted delivery or configuration. The hosted filter observation above is bounded to that lab configuration. Other live completion, rerun, admission-last, withdrawal, status and external-check recovery, dispatch minting and concurrent-wakeup observations remain post-install qualification. A previous same-head draft-to-ready observation with a skipped old CI run and a successful new CI run from a different suite motivates the freshness requirement; it is not qualification of this revision.

**Secret scan: why it runs TruffleHog twice (do not collapse it back)**

`--only-verified` keeps the generic detectors quiet by reporting only what TruffleHog could
confirm against the issuing provider's API. A `sk_` key **this kit mints itself** has no such
provider, so it is always an _unverified_ finding — and that flag discards it **silently**.

Measured on trufflehog 3.96.0 (Roxabi/roxabi-boilerplate-cf#51 dual-pass — still true). Length-anchor fixtures
(3.97.0: `sk_<48hex>Z` hits, `sk_<49hex>` does not) live in
[`scripts/kit/trufflehog-detectors.yaml`](../../../scripts/kit/trufflehog-detectors.yaml).

| Invocation                                                     | Result                                               |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| `--only-verified` (generic pass)                               | `unverified_secrets: 0` → **exit 0, the key passes** |
| `--config=scripts/kit/trufflehog-detectors.yaml`, no such flag | `unverified_secrets: 1` → exit 183                   |
| same config over the whole repo                                | `unverified_secrets: 0` → no false positives         |

So: generic detectors keep `--only-verified`; kit-issued secrets get a **separate** pass
without it. Adding the detector while keeping the flag yields a green scan and zero coverage —
the failure mode is invisible, which is why this is written down rather than left to the diff.
Do **not** merge the two invocations, and do **not** add `--only-verified` to the custom pass.

Scope: both passes are **diff-scoped** (PR base…head; locally, commits after the origin base).
A secret force-pushed out of that window, or committed before the gates existed, is **not**
scanned — full-history job dropped (budget). Force-push on the current ref falls back to a
full scan of that run. `sk_<48hex>Z` is detected, `sk_<49hex>` is not. Rationale + regex:
[`scripts/kit/trufflehog-detectors.yaml`](../../../scripts/kit/trufflehog-detectors.yaml).

**Shared local and CI scan.** `scripts/kit/trufflehog-check.sh` runs a **repo-pinned** binary
(`.cache/trufflehog/<ver>/`, never `PATH`) and passes `--no-update` on every scan, since without it
TruffleHog replaces its own executable with the latest release (Roxabi/roxabi-boilerplate-cf#261).
CI invokes the same script with `--commits-only` and explicit range inputs. It must not use the
TruffleHog action: its base/head walk can miss introduced commits. The script checks that no action
`uses:` line is present and materializes each introduced commit's patch for both scanner passes.

The shared script returns exit 183 when either scanner pass fails, whether from findings or an
execution error. Inspect the scan output to distinguish them; earlier setup errors can exit 1.

**Publication text review.** The selected control is semantic review of every final outgoing title, body and comment part, with existing-tool scanning as an additional best-effort check. TruffleHog and Gitleaks may silently skip text classified as a file format; a clean exit is not complete-byte coverage or a confidentiality proof. No mandatory publisher gate, native adapter, scanner provisioning command or new scanner dependency is provided. The TruffleHog commit/staged gate above remains unchanged.

The existing publishers remain the owners. Direct `gh` and browser writes are not intercepted; customer data without recognizable credentials, attachments and linked content require semantic review. Forms and checklists are reminders, not enforcement. GitHub scanning is detection after publication. See [CONTRIBUTING](../../../CONTRIBUTING.md#public-safe-publication).

**Independent-lineage continuity.** The existing `test:dogfood-zero-edit` integration also exercises direct and legacy-mediated Products joining an independent public Kit root, then receiving an ordinary next upgrade. It checks actual identity/zero-edit/stack behavior, refusal of a fetched-but-unmerged pin, preservation of Product/exception/applied-migration records and absence of private ancestry in the public parent. These synthetic fixtures do not prove a final exported candidate, a real Product migration or hosted settings.

**Kit bar vs product bar**

| Gate                          | Scope                                                                                                                    | Who runs it                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `bun run validate`            | short kit loop — steps = root `package.json` `scripts.validate`                                                          | kit + product clones (kit zones)                                                      |
| `bun run validate:full`       | current-tree kit bar (pre-push + kit CI); root `package.json` owns its steps. **Does not** prove product apps are tested | pre-push + kit CI                                                                     |
| `bun run validate:tooling`    | gate tooling self-tests, selected as described above; root `package.json` owns its steps                                 | pre-push + kit CI when selected; manual full run                                      |
| product-validate / product-ci | product packages under `apps/<product>-*`                                                                                | product repo only (copy templates; never dual-edit kit `ci.yml` / `test-coverage.sh`) |

False green: product with real apps and only kit `validate:full` green is **not** product-tested.

### Commands

```bash
bun install                    # prepare → lefthook install if hooksPath unset (no dependency postinstall runs: trustedDependencies = [])

bun run validate               # short kit loop (package.json scripts.validate)
bun run zero-edit              # product must not diverge kit paths without exception (kit = config only)
bun run env:check              # schema ↔ .dev.vars.example (DX only)
bun run i18n:check             # messages contract (also in turbo test)
bun run license:check          # dependency SPDX allowlist: live scan + --self-test (UNKNOWN = warn)
bun run test:coverage          # floors + HTML under coverage/<pkg>/
bun run validate:full          # kit bar SSoT (package.json scripts["validate:full"]) — not product apps

# Before opening a PR on the kit (explicit habit even if hooks installed):
bun run validate:full

# Product bar (product repos only — after copying templates):
# bash scripts/product/validate.sh
# See docs/kit/templates/product-validate.example.sh + product-ci.example.yml
```

### Non-negotiable local discipline

| Rule                                 |                                                                                                                                                                                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install hooks                        | `bun install` — prepare installs only if `core.hooksPath` unset; the lefthook **postinstall** (`install -f`, [lefthook#1475](https://github.com/evilmartians/lefthook/issues/1475)) does not run because `trustedDependencies` is `[]` (`lefthook.yml` header) |
| **Forbidden** without written reason | `git push --no-verify`, `LEFTHOOK=0`                                                                                                                                                                                                                           |
| **Forbidden** product hook fork      | A tracked Lefthook local overlay disabling kit hooks (ADR-0013 D2); undetected does not mean permitted                                                                                                                                                         |
| If pre-push is red                   | Fix locally; do **not** “let CI tell us”                                                                                                                                                                                                                       |
| Docs-only exception                  | Still run hooks unless emergency; extract/banlist are cheap insurance                                                                                                                                                                                          |

Rationale: on Free private, branch protection is weak; **local pre-push is the process substitute**. Making CI the only full suite trains bypass culture and burns minutes on avoidable red.

### `better-sqlite3` ABI (local red herring)

Memory D1 tests load native `better-sqlite3`. After a **Node major upgrade**, suites may fail with `NODE_MODULE_VERSION` mismatch (e.g. module built for 127, runtime wants 137). That is **not** a product regression until rebuild is tried:

```bash
npm rebuild better-sqlite3
bun run validate:full
```

Historical Goal 002 exit evidence recorded this ABI mismatch; that historical evidence file is no longer in this repository.

---
