---
title: 'ADR-0013 — Root and GitHub workflow ownership (resolves ADR-0009 D3)'
status: accepted
normative: true
date: 2026-09-01
amended: 2026-11-12
axial: false
related:
  - docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md
  - docs/kit/architecture/adr/0009-kit-namespace-polarity-inheritance-marker.md
  - docs/kit/product-consumer-contract.md
  - config/kit/zero-edit-zones.json
summary: 'Root and GitHub workflow ownership'
---

# ADR-0013 — Root and GitHub workflow ownership (resolves ADR-0009 D3)

Root files and `.github/workflows/*` use explicit ownership within the zero-edit model. The current decision and its enforcement limits are stated below.

## Context

ADR-0009 namespaced `{config,scripts,docs}/{kit,product}` and left root files plus GitHub workflows on an explicit `protected_files` list. That list was **not self-enforcing**: a newly added kit workflow that nobody added to `protected_files` was silently product-ownable.

GitHub only loads the **flat** `.github/workflows` directory. Nesting under `.github/workflows/kit/` is impossible — those files would never run.

Root files such as `package.json`, `biome.json`, `turbo.jsonc`, and `tsconfig.json` are auto-discovered by tools at the repository root. They cannot move under `config/kit/` without breaking that discovery.

`bun.lock` was already taken off the list as product workspace co-ownership ([Roxabi/roxabi-boilerplate-cf#114](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/114)). This ADR does not re-add it.

## Alternatives considered

### Option 1 — Thin root façades → real files under `config/kit/*`

- **Pros:** polarity-pure; root becomes a pointer
- **Cons:** `package.json` cannot be a façade; root indirection breaks tool auto-discovery; buys no ownership clarity
- **Verdict:** **Rejected** (D3)

### Option 2 — Naming convention for `.github/workflows/*`

- **Pros:** GitHub's flat dir stays; product files are greppable; inventory gate can fail closed
- **Cons:** existing kit workflows keep their names (no `kit-` rename)
- **Verdict:** **Accepted** for workflows, low-churn form (D1)

### Option 3 — Keep the explicit `protected_files` list for root files

- **Pros:** no path churn; tools keep auto-discovery; ownership is documented per file
- **Cons:** the list is long; it shrinks only after a real move or an explicit product-ownership decision
- **Verdict:** **Accepted** for root files (D2, D4)

## Decision

### D1 — Workflows classified by convention

Reserved filename prefix `product-` marks **product-owned** workflows. The gate matches the `product-` basename prefix, so `product-*.yml` and `product-*.yaml` both classify — GitHub loads either extension, and an extension-scoped rule would leave `foo.yaml` unclassified.

Every other **tracked** workflow file under `.github/workflows` **MUST** appear in `protected_files`. An unlisted, non-`product-` workflow **FAILS** the inventory gate as unclassified.

GitHub only loads the flat `.github/workflows` dir, so nesting under `workflows/kit/` is impossible. Classification is naming convention + list.

Machine encoding in `config/kit/zero-edit-zones.json`:

- `workflow_dir`: `.github/workflows`
- `workflow_product_prefix`: `product-`

Gate messages (exact):

```text
check-zero-edit-zones: unclassified workflows under .github/workflows (name product-*.yml / product-*.yaml or add to protected_files):
  UNCLASSIFIED WORKFLOW <path>
workflow inventory gate failed (ADR-0009 D6, ADR-0013)
```

No existing workflow is renamed.

### D2 — Root files keep the explicit list

Root kit surfaces stay on `protected_files`. The list is [`config/kit/zero-edit-zones.json`](../../../../config/kit/zero-edit-zones.json) `#protected_files`, which zero-edit enforces; this table adds only why each path is kit-owned and never protects a path by itself (do not shrink here):

| Path                                                 | Why kit-owned                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lefthook.yml`                                       | Local quality gates (pre-commit / commit-msg / pre-push); products must not edit this file or fork hooks through a tracked Lefthook local overlay. Zero-edit does not detect that overlay (amendment 2026-10-13)                                                                                                                                                                                                                                         |
| `package.json`                                       | Workspace root and kit scripts (`validate:full`, `zero-edit`, …); cannot be a façade                                                                                                                                                                                                                                                                                                                                                                     |
| `bunfig.toml`                                        | Bun install policy (`minimumReleaseAge` supply-chain gate); Bun reads it from the repo root, and a product copy would silently relax it                                                                                                                                                                                                                                                                                                                  |
| `turbo.jsonc`                                        | Turborepo task graph; auto-discovered at repo root                                                                                                                                                                                                                                                                                                                                                                                                       |
| `biome.json`                                         | Formatter/linter; Biome auto-discovers at repo root                                                                                                                                                                                                                                                                                                                                                                                                      |
| `knip.ts`                                            | Unused-file/export/dependency gate; the protected root `knip` script loads it with `--config knip.ts`, so a root file Knip would discover first is never loaded by that script. Knip still merges a root `package.json#knip` key under it, which `package.json` protection closes                                                                                                                                                                        |
| `tsconfig.json`                                      | Root TypeScript compiler defaults                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `AGENTS.md`                                          | Agent constitution                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GLOSSARY.md`                                        | Kit glossary; governs prose, renames nothing                                                                                                                                                                                                                                                                                                                                                                                                             |
| `README.md`                                          | Kit onboarding and documentation pointer                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `.node-version` · `.nvmrc`                           | Node major the Workers Builds and Pages images read; they read both names, the kit ships only `.node-version`, and `.nvmrc` is listed so a product cannot add a second Node declaration (Roxabi/roxabi-boilerplate-cf#316)                                                                                                                                                                                                                               |
| `pnpm-workspace.yaml`                                | Knip reads it at the repo root whatever `--config` names, and its `packages` list replaces `package.json#workspaces`; the kit runs on Bun and ships none, and the path is listed so a product cannot remove a workspace from the Knip gate (Roxabi/roxabi-boilerplate-cf#422). Not seen: a gitignored copy, an ignored file under `protected_prefixes`, and `skip-worktree` / `assume-unchanged`. CI is the guardrail (Roxabi/roxabi-boilerplate-cf#426) |
| `commitlint.config.js` · `.cjs` · `.mjs` · `.ts`     | Conventional Commits config. The commit-msg runner pins `commitlint.config.cjs`, runs from an empty process cwd, and exports the checkout `GIT_DIR` and `GIT_WORK_TREE` so cosmiconfig cannot discover product meta configs while `core.commentChar` still comes from the checkout (amendment 2026-10-13). The other listed names remain kit-owned, not an exhaustive discovery denylist; the hook does not load them                                    |
| `docker-compose.yml`                                 | Local Mailpit email sink for kit demo                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `.license-policy.json`                               | Allowed licenses for `licenseChecker`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `.claude/settings.json`                              | Claude plugin and marketplace enablement                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `docs/agents/issue-tracker.md`                       | Tracker contract omp-build skills read at this fixed path (`tool_mandated_paths`, ADR-0009 D1 amendment)                                                                                                                                                                                                                                                                                                                                                 |
| `.github/PULL_REQUEST_TEMPLATE.md`                   | Kit PR checklist (security + CP mapping)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `.github/dependabot.yml` · `.github/dependabot.yaml` | Kit dependency policy; only the canonical `.yml` Product scan may diverge (D5). Kit ships no `.yaml`, and Products must not add one                                                                                                                                                                                                                                                                                                                      |
| `.github/workflows/ci.yml`                           | Primary CI gate (`bun run validate:full`); does not deploy                                                                                                                                                                                                                                                                                                                                                                                               |
| `.github/workflows/deploy-main.yml`                  | Retired no-op; showcase CD is Cloudflare Builds                                                                                                                                                                                                                                                                                                                                                                                                          |
| `.github/workflows/secret-scan.yml`                  | CI TruffleHog secondary secret scan                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `.github/workflows/merge-on-green.yml`               | kit-ci App merge after green checks and a current exact-head authorization receipt; labels are hints, not authority ([CI App setup](../../ci-app-setup.md#reviewed-head-authorization))                                                                                                                                                                                                                                                                  |
| `.github/workflows/pr-title.yml`                     | Conventional Commits PR title check                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `.github/workflows/dependabot-automerge.yml`         | Evaluate eligible Dependabot updates and publish an authorization receipt bound to the captured head and base after `check-deps-guard.ts` passes                                                                                                                                                                                                                                                                                                         |
| `.github/workflows/dependabot-alert-slack.yml`       | Dependabot CVE alerts → Slack                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `.github/workflows/close-linked-issues.yml`          | Close issues referenced with closing keywords on merge                                                                                                                                                                                                                                                                                                                                                                                                   |
| `.github/workflows/deploy-gate.yml`                  | Fast-forwards `deploy/<branch>` (the Cloudflare production branch) to the newest first-parent commit that descends from it, whose required push runs are all green and whose range has no red Secret scan (Roxabi/roxabi-boilerplate-cf#256); never calls Cloudflare                                                                                                                                                                                     |

The kit does not ship `.semctx/`, `.github/workflows/semctx.yml`, or the `semctx-working-empty` attestation. Semantic change-impact gating, Plane B contracts, and the commit/push guard are out of kit ownership; product clones must not reintroduce those paths under zero-edit.

### D3 — Façades rejected

Option 1 is rejected: `package.json` cannot be a façade, root indirection breaks tool auto-discovery, and it buys no ownership clarity.

### D4 — `protected_files` shrinks only after a real move or explicit product ownership

The list does not shrink by deleting rules. A path leaves the list only after it is moved under a kit namespace (or otherwise relocated) **or** after an explicit product-ownership decision.

`bun.lock` stays **out** (kit [Roxabi/roxabi-boilerplate-cf#114](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/114) — product workspace co-ownership). Do not re-add it.

`.dev/stack.yml` is product-owned. `scripts/kit/check-stack-contract.ts` compares it to the inheritance commit in product mode and checks shape only in kit mode. A product fills `name`, `backend.path`, and `release.component` so they differ from upstream, and either a differing `frontend.path` or the canonical null scalar `frontend: null`; `landing.mode` stays the inherited default (`merge-on-green` or `native`). The gate rejects an upstream tree containing `config/product/inheritance.json`, but does not prove `upstreamCommit` is a kit tip: an ancestor without that file can launder the baseline, as with zero-edit.

**Amendment (2026-11-11, [Roxabi/roxabi-boilerplate-cf#591](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/591)) — API-only `frontend: null`.** Replace the whole `frontend` block with `frontend: null` and keep that scalar on upgrade. No frontend App is required. The guard compares values, not filesystem existence. `~`, an implicit empty value, `Null`, a quoted string, a missing `frontend`, and a partial map still fail.

Products accept the `GLOSSARY.md` rename and do not retain a root `CONTEXT.md`. The protected root `knip` script pins `--config knip.ts`; a product config discovered earlier by bare Knip is not loaded by that script. The [CP-KNIP non-claims](../../testing/critical-path.md#env--i18n--license--import-boundary--non-claims) inventory remaining inputs.

The commit-msg runner resolves the message path, exports checkout `GIT_DIR` and `GIT_WORK_TREE`, runs in an empty temporary directory and passes absolute `--cwd`, `--config` and `--edit` paths. This isolates commitlint and cosmiconfig discovery while preserving the checkout's `core.commentChar`; it does not close other runners' discovery or per-developer Node settings.

Products must not fork kit hooks, including by committing a Lefthook local overlay. Zero-edit does not detect tracked overlays; per-developer `LEFTHOOK*` variables and Git `core.hooksPath` can also skip or replace hooks. CI backs up quality gates, `secret-scan.yml` backs up secret scanning, and GitHub write ACLs back up deny-upstream. **Commit-message rules have no CI backstop**: `pr-title.yml` lints only the PR title.

### D5 — Content-bound customization at an externally fixed path

**Amendment (2026-11-12).** This rule applies only when an external tool fixes the path, a Kit-owned pure renderer derives all permitted content from the tracked Product inventory, and zero-edit recomputes and compares those bytes exactly. Each additional path requires an ADR amendment; this is not a general Product configuration escape hatch.

The only path is `.github/dependabot.yml`, fixed by GitHub. It stays in `protected_files`. A Product may replace inherited bytes only with `scripts/kit/configure-product-dependabot.cjs` output, derived from every tracked Product `apps/*/package.json` outside protected paths. The nonempty Bun-only version scan has explicit directories and inherited cooldown; it never scans root manifests or inherited workflows. The alternative `.github/dependabot.yaml` name is reserved and protected; Products must not create it. Arbitrary YAML, disabled scans and stale generated inventories fail, including with a time-boxed exception. An unchanged inherited `.yml` remains legacy, not evidence of Product isolation.

When the generated file diverges, the renderer and ownership policy must match the inherited baseline even if exceptions cover them: an exception on either cannot redefine canonical content. Other marker-lineage, full-history and expiry checks remain. The generator requires a committed baseline and marker; finish the upgrade merge, regenerate, then commit any refresh through normal hooks before final gates or pushing. Inherited Actions pins and protected manifests still change in the Kit; Product-only pins use ordinary reviewed Product changes.

Rejected alternatives: free Product-owned YAML admits arbitrary scans; permanent or repeated configuration exceptions do not establish bounded ownership; `/apps/*` plus `exclude-paths` relies on scan filtering to exclude Example Apps rather than enumerating protected-path ownership.

`directories` / `exclude-paths` are scan controls, not a workspace mutation boundary. The shared `bun.lock` remains fully reviewed and co-owned; no hosted App-only root-lock regeneration is proved. Cross-owner PRs fail zero-edit and automatic admission. Use the [manual update route](../../security-dependabot.md#kit-and-product-ownership) when needed, never filtered/restored robot diffs or a wholesale lock transplant. The [consumer contract](../../product-consumer-contract.md#product-dependabot-configuration) owns upgrade ordering and migration limits.

## Consequences

### Positive

- The explicit list becomes **self-enforcing**: a new kit workflow that is not listed now fails the gate, instead of being silently product-ownable.
- Product consumers add workflows as `product-*.yml`.
- Root tool auto-discovery is unchanged.

### Negative

- Kit workflow filenames stay mixed (no `kit-` prefix); classification is prefix-for-product + list-for-kit.
- The root list remains long until a later move or ownership decision.

### Neutral

- Existing nine workflows are not renamed.
- ADR-0009 D1 / D6 are unchanged; D1–D4 resolve D3, and D5 adds only the bounded fixed-path configuration rule.

## Non-goals

- Renaming existing workflows
- Moving `tooling/`
- Re-opening ADR-0009 D1 / D6
- Deleting workflow files

## Acceptance

- Workflow classification: `product-*.yml` = product-owned; every other tracked workflow **MUST** be in `protected_files`; unclassified fails the inventory gate
- Root files stay on the explicit list with per-file rationale; the list does not shrink in this ADR
- Façades rejected with recorded reasons
- `bun.lock` remains unprotected (Roxabi/roxabi-boilerplate-cf#114)
- Consumer contract states the `product-*.yml` rule
- D5 permits only canonical generated `.github/dependabot.yml` bytes, with baseline-equal renderer/policy and a nonempty Product manifest inventory; exceptions cannot widen it.
- `.github/dependabot.yaml` remains protected and forbidden in Products; Kit ships none.

## Refs

- Kit issue [Roxabi/roxabi-boilerplate-cf#110](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/110)
- [ADR-0009](./0009-kit-namespace-polarity-inheritance-marker.md) D3 / D6
- [`config/kit/zero-edit-zones.json`](../../../../config/kit/zero-edit-zones.json)
- [`scripts/kit/check-zero-edit-zones.sh`](../../../../scripts/kit/check-zero-edit-zones.sh)
