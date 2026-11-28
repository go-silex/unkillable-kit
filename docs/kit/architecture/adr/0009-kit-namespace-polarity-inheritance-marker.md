---
title: 'ADR-0009 — Kit/Product ownership zones: namespaces, root files, workflows and inheritance marker'
status: accepted
normative: true
date: 2026-08-21
amended: 2026-11-21
axial: false
supersedes_notes: >
  2026-11-21: absorbs ADR-0011 (fold of `tools/` into `scripts/kit` + `config/kit`)
  and ADR-0013 (root and GitHub workflow ownership); both files are removed.
  No decision changed: ADR-0011 now lives in D1 and D2, ADR-0013 D1–D5 in D3.
  Path inventories were replaced by `config/kit/zero-edit-zones.json`, the list
  zero-edit enforces.
related:
  - docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md
  - docs/kit/architecture/adr/0008-kit-schema-identity-product-compose.md
  - docs/kit/product-consumer-contract.md
  - config/kit/zero-edit-zones.json
  - scripts/kit/check-zero-edit-zones.sh
summary: 'Kit/product ownership zones and inheritance marker'
---

# ADR-0009 — Kit/Product ownership zones

Extends [ADR-0001](./0001-primary-axis-packages-compose-apps.md): apps compose `@kit/*`; product consumers merge an immediate upstream without dual-editing kit surfaces.

The lists live in `config/kit/zero-edit-zones.json`. Enforcement lives in `scripts/kit/check-zero-edit-zones.sh` (`bun run zero-edit`, part of `validate:full` and CI).
This record keeps why the zones look this way and what the gate does not prove.

## Context

A product may inherit the kit directly or through an operator-maintained mirror. Its immediate parent is the source whose merged commit it records.

Zero-edit must answer: _did this product patch kit paths since its last inherit?_
It must **not** answer: _is the local `upstream/main` tracking ref fetched?_

The prior polarity failed three ways:

- Blanket protection of `config/`, `scripts/kit/`, … pushed product machine state into `docs/product/` carve-outs.
- A default base of `upstream/main` turned a stale tracking ref into a false dual-edit (Roxabi/roxabi-boilerplate-cf#103).
- A CI-only base (`docs/product/kit-baseline` via `ZERO_EDIT_BASE_REF`) made local differ from CI, so operators skipped lefthook.

Two constraints come from outside the repository.
GitHub loads only the flat `.github/workflows` directory, so files under `workflows/kit/` would never run.
Root files such as `package.json`, `biome.json`, `turbo.jsonc` and `tsconfig.json` are auto-discovered at the repository root and cannot move under `config/kit/`.

### Alternatives considered

- **Kit-as-root + product islands only** (`config/product/` carve-out): viable; rejected for long-term clarity.
- **`config/kit` · `scripts/kit` · `docs/kit`**: accepted; the path encodes ownership.
- **Thin fix for Roxabi/roxabi-boilerplate-cf#103** (fallback to the kit baseline only): rejected as throwaway.
- **`tools/kit` + `tools/product`**: rejected; a fourth polarity root, and zero-edit would have to list files instead of prefixes.
- **`tools/` as a quality-gate island**: rejected; product exemption registers (Roxabi/roxabi-boilerplate-cf#118) proved the split is load-bearing.
- **Thin root façades pointing to `config/kit/*`**: rejected; `package.json` cannot be a façade, and root indirection breaks tool auto-discovery without adding ownership clarity.
- **`kit-` rename of existing workflows**: rejected; a `product-` prefix plus the protected list classifies with less churn.

## Decision

### D1 — Symmetric namespaces under `config/` · `scripts/` · `docs/`

```text
{config,scripts,docs}/kit/**      → kit-owned (protected)
{config,scripts,docs}/product/**  → product-owned
anything else under those three trees → inventory FAIL, except exact tool-mandated paths
```

There is no "rest of `config/` is product by default". A kit runbook under `docs/product/` is a process mistake caught by review; an unclassified path fails the machine gate.
"`*/kit`" means those three roots only, not a monorepo-wide rename of every kit path.

Placement rule: executables go to `scripts/{kit,product}/`, policy and data to `config/{kit,product}/`. Product helpers live in `scripts/product/` or `apps/<product>-*/scripts/`.
Invoke sites (lefthook, `package.json`, `.dev/stack.yml`, CP harnesses) call `scripts/kit/…` and read `config/kit/…`. They do not honor a product-exported `QG_FILE_*` / `QG_FOLDER_*` as a live pin.

**Tool-mandated paths (amendment 2026-09-25, Roxabi/roxabi-boilerplate-cf#259).** An external tool can read a kit file at a path the two namespaces cannot host.
Such a path is classified only when it is listed **exactly** in `tool_mandated_paths` and also in `protected_files`; the checker refuses an unprotected entry.
`protected_files` alone classifies nothing under the three trees, and a sibling or same-basename path is never covered. Adding an entry means naming the tool that fixes the path, in this ADR.
Entries today: `docs/agents/issue-tracker.md` (omp-build `/feature`, `dev-review`, `fix`, `issue-triage`). This is the single carve-out to "anything else → inventory FAIL".

### D2 — Surfaces that stay prefix- or list-protected

- `packages/`: kit.
- Kit apps are exactly the `apps/<name>/` entries of `protected_prefixes` (amendment 2026-10-01, Roxabi/roxabi-boilerplate-cf#318). Zero-edit refuses any other `apps/` entry shape there.
  Every other `apps/` directory is a product app, `apps/example-acme-api` included; adding or retiring a kit app is one edit of the list.
  `check-zero-edit-zones`, `check-migrations-contract`, `extract-dry-run`, `check-banned-strings` and `kit-schema-sync` read that list; shell gates read it through `scripts/kit/lib/kit-apps.sh`.
  Not yet migrated: the product exemption registers (`check_file_length.sh`, `check_folder_size.sh`, `check-import-boundaries.ts`) still recognise a product-app path by name (Roxabi/roxabi-boilerplate-cf#327).
- `apps/<product>-*`: product.
- `tooling/`: kit-owned prefix; its taxonomy is left to a later decision.
- `tools/`: not a polarity root. It stays absent or empty; there is no `tools/kit`, no `tools/product` and no permanent wrapper. `extract-dry-run` fails closed on any entry.

### D3 — Root and GitHub ownership

#### Workflows

The reserved basename prefix `product-` marks product-owned workflows. The gate matches the prefix, so `product-*.yml` and `product-*.yaml` both classify; GitHub loads either extension.
Every other tracked file under `.github/workflows` must be listed in `protected_files`. An unlisted, non-`product-` workflow fails the inventory gate as unclassified. No existing workflow is renamed.

#### Root files

Root kit surfaces stay on the explicit `protected_files` list. The zones file is the list; this ADR never protects a path by itself.
The list shrinks only after a path moves under a kit namespace or after an explicit product-ownership decision, never by deleting rules. Entries whose reason is not obvious:

- `bunfig.toml`: Bun reads the install policy (`minimumReleaseAge`) from the root; a product copy would silently relax it.
- `knip.ts`: the protected root `knip` script loads it with `--config knip.ts`, so a product config bare Knip would discover first is never loaded. `package.json` protection closes a root `package.json#knip` key.
- `pnpm-workspace.yaml`: Knip reads it at the root whatever `--config` names, and its `packages` list replaces `package.json#workspaces`. Listed so a product cannot remove a workspace from the Knip gate (Roxabi/roxabi-boilerplate-cf#422).
- `.nvmrc`: build images read both `.node-version` and `.nvmrc`; listed so a product cannot add a second Node declaration (Roxabi/roxabi-boilerplate-cf#316).
- `commitlint.config.{js,cjs,mjs,ts}`: kit-owned names, not an exhaustive discovery denylist. `scripts/kit/lefthook-commit-msg.sh` pins `commitlint.config.cjs` and runs from an empty directory, so cosmiconfig cannot discover product configs.

Outside the list: `bun.lock` is product workspace co-owned (Roxabi/roxabi-boilerplate-cf#114) and is not re-added. `.dev/stack.yml` is product-owned.
`scripts/kit/check-stack-contract.ts` checks its shape in kit mode and, in product mode, refuses weakening pinned review, landing and command fields against the inherited baseline; additive keys stay free.
An API-only product replaces the whole `frontend` block with the canonical scalar `frontend: null` (amendment 2026-11-11, Roxabi/roxabi-boilerplate-cf#591).
The stack check does not attest baseline provenance: an ancestor without `config/product/inheritance.json` can launder the baseline, as with zero-edit.

The kit ships no `.semctx/`, `semctx.yml` workflow or `semctx-working-empty` attestation; products must not reintroduce them. Products accept the `GLOSSARY.md` rename and keep no root `CONTEXT.md`.

#### Hooks

`lefthook.yml` is list-protected, and `.lefthook/` is a protected Kit prefix. Lefthook
looks there for the pre-push wrappers; they delegate to the gates under `scripts/kit/`.

Products must not fork kit hooks, including by committing a Lefthook local overlay (amendment 2026-10-13). Undetected does not mean permitted.
Zero-edit does not detect tracked overlays, and per-developer `LEFTHOOK*` variables or Git `core.hooksPath` can skip hooks.
CI backs up quality gates, `secret-scan.yml` backs up secret scanning, and GitHub write ACLs back up deny-upstream. Commit-message rules have no CI backstop: `pr-title.yml` lints only the PR title.

#### Content-bound customization at an externally fixed path

Amendment 2026-11-12. This applies only when an external tool fixes the path, a kit-owned pure renderer derives all permitted content from the tracked product inventory, and zero-edit recomputes and compares those bytes exactly.
Each additional path requires an amendment of this ADR; this is not a general product configuration escape hatch.

The only path is `.github/dependabot.yml`, fixed by GitHub; it stays in `protected_files`.
A product may replace the inherited bytes only with `scripts/kit/configure-product-dependabot.cjs` output, derived from every tracked product `apps/*/package.json` outside protected paths: a nonempty Bun-only scan with explicit directories and inherited cooldown, never root manifests or inherited workflows.
`.github/dependabot.yaml` is reserved, protected and forbidden in products. Arbitrary YAML, disabled scans and stale generated inventories fail, even under a time-boxed exception; an exception cannot redefine the renderer or the ownership policy.
An unchanged inherited `.yml` is legacy, not evidence of product isolation.

Rejected: free product-owned YAML admits arbitrary scans; permanent or repeated exceptions establish no bounded ownership; `/apps/*` plus `exclude-paths` relies on scan filtering to exclude example apps.
`directories` / `exclude-paths` are scan controls, not a workspace mutation boundary: the shared `bun.lock` stays fully reviewed and co-owned, and cross-owner PRs fail zero-edit and automatic admission.
Upgrade ordering and migration limits: [consumer contract](../../product-consumer-contract.md#product-dependabot-configuration). Manual updates: [security-dependabot](../../security-dependabot.md#kit-and-product-ownership).

### D4 — Inheritance marker = sole dual-edit base (SSoT)

`config/product/inheritance.json` records `{ "version": 1, "upstreamCommit": "<full SHA of the immediate parent tip actually merged>" }`. The kit and allowlisted mirrors carry no marker (kit mode).

The checker reads the marker directly, so local equals CI. It requires a full SHA present locally and ancestor of `HEAD`, and complete history: a shallow clone fails closed with an actionable message.
It diffs protected paths against that commit plus the dirty tree. It **never** uses `upstream/main` and **never** auto-fetches. `ZERO_EDIT_BASE_REF` is rejected; the legacy `docs/product/kit-baseline` is not a fallback.

**Threat model.** Zero-edit is a process and CI gate against _accidental_ modification of kit files in a product, including by AI agents. A green run attests the consumer contract; it does not prove provenance.
The marker is self-declared: a maintainer who sets `upstreamCommit` to a commit containing their kit-path edit empties the protected diff.
Provenance attestation and parent-remote fetch stay out of scope; they conflict with no-auto-fetch. Mitigations: the lineage and expiry rules below, independent-agent review on marker bumps, GitHub write ACLs, dogfood.

**Marker lineage (amendment 2026-10-03, audit RED-01).** The base must be an inherited kit or mirror tip, never a product commit.
Any base that hides a kit-path edit must contain that edit, hence be a product commit, and every product commit descends from the commit that first added the marker.
The checker therefore refuses a base whose ancestry contains a commit that _added_ the marker, reading full history so a merge cannot prune a side branch (`git log --full-history -m --no-renames --diff-filter=A`).
This closes pinning the marker to a product commit and the two-commit delete-and-re-add. Day-0 pins, re-inherit to a newer parent tip and mirror children stay accepted. `stack-contract:check` applies the same rule to its base.

Not adopted for lineage: forbidding marker deletion (`--diff-filter=D`) is subsumed and could reject legitimate history; a base tree free of product-owned namespaces cannot separate a legitimate mirror from a product; a base tree without the marker file is bypassed alone by delete-and-re-add.

**Residual (accepted, not closed).** A base predating the marker's introduction (the day-0 pin is self-declared and agent-reviewed, not proven), a product branch forked before that introduction and merged in, history rewrite or force-push, and forged author dates.
These need provenance attestation (non-goal) or GitHub ACLs.

**Exception expiry (amendment 2026-10-03, audit RED-02).** `exception_expiry` `{ max_days: 90, effective_from: "2026-10-03" }` caps an expiry granted or extended on or after `effective_from` at `max_days` after the grant day.
The grant day comes from git: the author date of the first-parent commit that last extended that entry's `expires`, or today for an uncommitted edit. Earlier exceptions are grandfathered until their own `expires`.
Rejected: a flat `expires ≤ today + 90`, which cannot tell a new exception from an existing one and would fail exceptions valid when granted. The cap guards against accidental open-ended exceptions; a rewritten author date defeats it.

### D5 — Mode detection (fail-closed)

| Condition                                                   | Mode                         |
| ----------------------------------------------------------- | ---------------------------- |
| Marker present + origin not kit-allowlisted                 | `product`                    |
| No marker + origin allowlisted (kit **or** declared mirror) | `kit`                        |
| Marker present on kit-allowlisted origin                    | **error**                    |
| No marker + unknown / product-shaped origin                 | **error** (never silent kit) |

The allowlist is `kit_origin_allowlist`. Mirrors are operator-extended entries added when first published, not inferred from topology; a product inheriting a mirror needs that mirror's entry. CI prefers `github.repository`; local normalizes the `origin` URL.
`ZERO_EDIT_MODE` is forbidden on the normal lefthook and CI path. A harness may set it only with an explicit test sentinel, such as a file under `tmp/` created by `dogfood-zero-edit.sh`.

### D6 — Inventory gate (classification, not intent)

Under `config/`, `scripts/` and `docs/`, every tracked path must be under `kit/` or `product/`, except exact tool-mandated paths, and every tracked workflow must be classified (D3). Unclassified fails.
The gate proves structural classification, not that no kit content was misplaced under `product/`; that remains a review and dogfood concern.

### D7 — SSoT paths

Zones, policy and kit-origin allowlist: `config/kit/zero-edit-zones.json`. Exceptions: `config/product/zero-edit-exceptions.json`, template `config/kit/zero-edit-exceptions.example.json`.
Marker: `config/product/inheritance.json`. Checker: `scripts/kit/check-zero-edit-zones.sh`. Contract: [`product-consumer-contract.md`](../../product-consumer-contract.md).

### D8 — Mirror fidelity (explicit non-claim)

Kit mode on an allowlisted **mirror** does not prove bit-for-bit parity with kit HEAD. Mirror drift is an **operator sync** concern (Roxabi/roxabi-boilerplate-cf#108), not priced by product zero-edit. Products pin the mirror tip they actually merged.

## Consequences

- Products own machine config under `config/product/` without dual-edit exceptions for being under `config/`.
- Local lefthook and CI share one base resolution, so local `validate:full` is the real gate.
- A new kit workflow that is not listed fails the gate instead of being silently product-ownable.
- Kit workflow filenames stay mixed (no `kit-` prefix), and the root list stays long until a move or ownership decision.

## Non-goals

- Auto-`git fetch` inside the checker
- Cryptographic or remote attestation of `upstreamCommit` provenance
- Requiring products to track kit HEAD when their parent is a mirror
- Enforcing mirror ≡ HEAD inside product zero-edit
- Moving `tooling/` under `scripts/kit`
- Renaming or deleting kit workflows
- Changing root or workflow ownership without an explicit decision
- Product-domain features

## Refs

- Epic Roxabi/roxabi-boilerplate-cf#105; root ownership Roxabi/roxabi-boilerplate-cf#110; `tools/` fold Roxabi/roxabi-boilerplate-cf#120.
