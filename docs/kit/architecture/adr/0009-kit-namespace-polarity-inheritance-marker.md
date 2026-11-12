---
title: 'ADR-0009 — Kit namespace polarity (`*/kit`) + inheritance marker SSoT'
status: accepted
normative: true
date: 2026-08-21
amended: 2026-11-12
axial: false
related:
  - docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md
  - docs/kit/architecture/adr/0008-kit-schema-identity-product-compose.md
  - docs/kit/architecture/adr/0013-root-github-workflow-ownership.md
  - docs/kit/product-consumer-contract.md
  - config/kit/zero-edit-zones.json
---

# ADR-0009 — Kit namespace polarity (`*/kit`) + inheritance marker SSoT

Extends [ADR-0001](./0001-primary-axis-packages-compose-apps.md): apps compose `@kit/*`; product consumers merge an immediate upstream without dual-editing kit surfaces.

Closes the structural gap behind [Roxabi/roxabi-boilerplate-cf#103](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/103) (stale `upstream/main` ≠ dual-edit).

## Context

### Consumer chain

A product may inherit the kit directly or through an operator-maintained mirror. Its immediate parent is the source whose merged commit it records.

Zero-edit must answer: *did this product patch kit paths since its last inherit?*  
It must **not** answer: *is the local `upstream/main` tracking ref fetched?*

### Problem with the prior polarity

| Prior rule | Failure |
|------------|---------|
| Blanket-protect `config/`, `scripts/kit/`, … | Product machine state shoved into `docs/product/` carve-outs |
| Default base = `upstream/main` | Stale tracking ref → false FORBIDDEN dual-edit (Roxabi/roxabi-boilerplate-cf#103) |
| CI base = `docs/product/kit-baseline` via `ZERO_EDIT_BASE_REF` | Local ≠ CI; operators skip lefthook |

Allowlist islands (`docs/product/`, `scripts/product/`) worked but forced exceptions under kit-owned trees and duplicated “what is the base?” across file + env + remote.

### Alternatives considered

| Option | Verdict |
|--------|---------|
| **A** Kit-as-root + product islands only (`config/product/` carve-out) | Viable; rejected for long-term clarity |
| **B** `config/kit` · `scripts/kit` · `docs/kit` | **Accepted** — path encodes ownership |
| Thin Roxabi/roxabi-boilerplate-cf#103 fix (fallback to kit-baseline only) | Rejected as throwaway during B |

## Decision

### D1 — Symmetric namespaces under `config/` · `scripts/` · `docs/`

```text
{config,scripts,docs}/kit/**      → kit-owned (protected)
{config,scripts,docs}/product/**  → product-owned
anything else under those three trees → inventory FAIL, except exact tool-mandated paths below
```

There is no “rest of `config/` is product by default”. Ownership is via the two explicit namespaces or the exact tool-mandated carve-out. A kit runbook under `docs/product/` is a process mistake caught by review; an unclassified path fails the machine gate.

Scope note: “`*/kit`” in this ADR means those three roots only — not a monorepo-wide rename of every kit path.

**Amendment (2026-09-25, Roxabi/roxabi-boilerplate-cf#259) — tool-mandated paths.** An external tool can read a kit file at a path the two namespaces cannot host: the omp-build skills read `docs/agents/issue-tracker.md` and nothing else. Such a path is classified only when it is listed **exactly** in `config/kit/zero-edit-zones.json` `tool_mandated_paths`, and every entry must also be in `protected_files` (kit-owned, dual-edit protected; the checker refuses an unprotected entry). `protected_files` alone classifies nothing under the three trees, and a sibling or same-basename path is never covered. Adding an entry means naming the tool that fixes the path, in this ADR. Entries today: `docs/agents/issue-tracker.md` (omp-build `/feature`, `dev-review`, `fix`, `issue-triage`). This is the single carve-out to "anything else → inventory FAIL".

### D2 — Surfaces that stay prefix- or list-protected

Other ownership surfaces:

| Surface | Rule |
|---------|------|
| `packages/` | kit |
| `apps/example-api/` · `example-web/` · `mcp-example/` | kit |
| `apps/<product>-*` | product |
| `tooling/` | kit (taxonomy merge = later ADR) |
| `tools/` | folded by [ADR-0011](./0011-tools-fold-scripts-config-polarity.md) — do not add files; executable → `scripts/kit/`, data → `config/kit/` |

**Amendment (2026-10-01, [Roxabi/roxabi-boilerplate-cf#318](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/318)) — the kit-app list is `protected_prefixes`.** The `apps/` rows above are rationale, not a list. Kit apps are exactly the `apps/<name>/` entries of `config/kit/zero-edit-zones.json` `protected_prefixes`, and zero-edit refuses any other `apps/` entry shape there. `check-zero-edit-zones`, `check-migrations-contract`, `extract-dry-run`, `check-banned-strings` and `kit-schema-sync` read that list (the shell gates through `scripts/kit/lib/kit-apps.sh`). To them, an `apps/` directory the list does not name is a product app, `apps/example-acme-api` included, and adding or retiring a kit app is one edit of the list. Not yet migrated: the product exemption registers (`check_file_length.sh`, `check_folder_size.sh`, `check-import-boundaries.ts`) still recognise a product-app path by name ([Roxabi/roxabi-boilerplate-cf#327](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/327)).

### D3 — Root / GitHub ownership

Root kit files remain on the explicit `protected_files` list in `config/kit/zero-edit-zones.json`; the list may shrink only after a move or explicit ownership decision. GitHub loads a flat workflow directory: `product-` identifies product workflows and every other tracked workflow must be listed as protected. Unclassified workflows fail inventory. Root tool auto-discovery is retained; façades are rejected.

`bun.lock` is product workspace co-owned and is not protected. `.dev/stack.yml` is product-owned. `scripts/kit/check-stack-contract.ts` checks shape in kit mode and, in product mode, compares against the inherited baseline: it rejects new `review.roster` `never`, reduced `max_agents`, `landing.required_checks`, a `landing.mode` outside `merge-on-green | native`, changes or removal of pinned `commands.*`, any `bun.*version` key, non-canonical review/landing shapes, and unchanged product identity fields (`name`, `backend.path`, `release.component`, and `frontend.path` unless the whole `frontend` value is the canonical null scalar `frontend: null`). Additive keys stay free. The check does not attest baseline provenance. The kit no longer ships semctx surfaces.

**Amendment (2026-11-11, [Roxabi/roxabi-boilerplate-cf#591](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/591)) — API-only `frontend: null`.** An API-only product replaces the whole `frontend` block with the canonical null scalar `frontend: null` and keeps that scalar on upgrade. No frontend App is required. The guard compares values, not filesystem existence. `~`, an implicit empty value, `Null`, a quoted string, a missing `frontend`, and a partial map still fail `frontend.path`.

**Amendment (2026-11-12) — fixed-path Product Dependabot scan.** `.github/dependabot.yml` remains protected, with the content-bound customization in [ADR-0013 D5](./0013-root-github-workflow-ownership.md#d5--content-bound-customization-at-an-externally-fixed-path): the Kit generator's exact nonempty Product App scan is accepted instead of inherited bytes. The alternative `.github/dependabot.yaml` stays protected and forbidden in Products. This grants no manifest exception, package-name ownership, lockfile replacement or disabled scan. Other generated-file drift fails; unchanged inherited config is legacy only. Complete marker history, lineage and exception expiry remain unchanged.

ADR stance: **document the list; do not shrink it by deleting rules without a move or ownership decision.**

Workflows cannot live under `.github/workflows/kit/` (GitHub only loads the flat workflows dir). Classification = naming convention + list / inventory gate.

### D4 — Inheritance marker = sole dual-edit base (SSoT)

Product file:

```text
config/product/inheritance.json
```

Minimal schema:

```json
{
  "version": 1,
  "upstreamCommit": "<full SHA of immediate parent tip actually merged>"
}
```

| Consumer | `upstreamCommit` means |
|----------|------------------------|
| Product | Tip of its immediate kit or mirror parent actually merged |
| Kit or allowlisted mirror | **No** marker (kit mode) |

Checker:

1. Reads the marker directly (local == CI).
2. Requires full SHA, object present locally, ancestor of `HEAD`.
3. Requires complete history (a shallow clone fails closed) and a base that does **not** descend from the commit that introduced the marker file (*Marker lineage*, below).
4. Diffs protected paths against that commit (+ dirty tree).
5. **Never** uses `upstream/main` as base.
6. **Never** auto-`git fetch`.
7. Missing history → fail with actionable message (deepen checkout), not remote fallback.

**Threat model (honest):** zero-edit is a **process / CI gate** that guards against *accidental* modification of kit files in a product (including by AI agents), not a tamper-resistant boundary — a green run *attests* the consumer contract, it does not prove provenance. The marker is self-declared: a maintainer who sets `upstreamCommit` to a commit that already contains their kit-path edit empties the protected diff. Provenance attestation / parent-remote fetch stays **out of scope** (conflicts with no-auto-fetch). Mitigations: the lineage and expiry rules below, independent-agent review on marker bumps, GitHub write ACLs, dogfood.

**Marker lineage (amendment, 2026-10-03, audit RED-01).** The base must be an inherited kit/mirror tip, never a commit the product authored. Any base that hides a kit-path edit has to contain that edit, so it has to be a product commit, and every product commit descends from the commit that first added `config/product/inheritance.json`. The checker therefore refuses a base whose ancestry contains a commit that *added* the marker (`git log --full-history -m --no-renames --diff-filter=A -1 <base> -- config/product/inheritance.json`; `--full-history -m` so a merge cannot prune a side branch). This closes both realistic launders: pinning the marker to a product commit that edited a kit file, and the 2-commit delete-and-re-add (C1 drops the marker and edits a kit file, C2 re-adds the marker pinned to C1 — C1 descends from the marker's first introduction). Accepted unchanged: day-0 pin, re-inherit to a newer parent tip after a merge (the parent tip never added a product marker), and mirror children (the mirror carries `packages/feedback` and `docs/product/*` but never the marker). `stack-contract:check` applies the same rule to the base of its stack comparison. The ancestry is only readable in full history, so a shallow clone fails closed; the documented CI checkout is already `fetch-depth: 0`.

Candidates evaluated and not adopted:

| Candidate | Why not |
|---|---|
| No deletion of the marker in history (`--diff-filter=D`) | Subsumed: a delete-and-re-add only hides an edit if the new base contains it, and that base descends from the first introduction. Adds a rule that could reject a legitimate history without closing anything more |
| Base tree free of product-owned namespaces (`config/product/**`, apps outside the kit set) | A legitimate mirror can contain product-owned paths; tree content cannot separate a mirror from a product |
| Base tree must not contain the marker file (previous `stack-contract` check) | Kept as a special case of the lineage rule, but alone it is bypassed by the delete-and-re-add |

**Residual (accepted, not closed):** a base that predates the marker's introduction (the day-0 pin is self-declared and independently agent-reviewed, not proven), a product-authored branch forked before that introduction and merged in, history rewrite / force-push, and forged author dates. These need provenance attestation (non-goal) or GitHub ACLs.

**Exception expiry (amendment, 2026-10-03, audit RED-02).** `exceptions[].expires` was bounded only by its format, so `2999-12-31` was a permanent dual-edit. `config/kit/zero-edit-zones.json` `exception_expiry` `{ max_days: 90, effective_from: "2026-10-03" }` caps an expiry **granted or extended on/after `effective_from`** at `max_days` after the grant day. The grant day is read from git, deterministically: the author date of the first-parent commit of the exceptions file that last extended that entry's `expires` (a new entry counts as extended; a shortening keeps the old grant day), or today for an uncommitted edit. Exceptions granted before `effective_from` are grandfathered until their own `expires`. Rejected: a flat `expires ≤ today + 90` — it cannot tell a new exception from an existing one, so it would fail exceptions that were valid when granted (a 91-day expiry, expiries in 2027) on the first run, while the owner decision is to cap only new or modified exceptions. The cap guards against accidental open-ended exceptions; a rewritten author date defeats it (same non-goal as above).

The product checker requires `config/product/inheritance.json` and rejects `ZERO_EDIT_BASE_REF`; the legacy baseline is not a fallback. It never uses `upstream/main`.

### D5 — Mode detection (fail-closed)

| Condition | Mode |
|-----------|------|
| Marker present + origin not kit-allowlisted | `product` |
| No marker + origin allowlisted (kit **or** declared mirror) | `kit` |
| Marker present on kit-allowlisted origin | **error** |
| No marker + unknown / product-shaped origin | **error** (never silent kit) |

**Allowlist SSoT:** machine list in `config/kit/zero-edit-zones.json` with at least the kit repo id. Additional mirrors are **operator-extended entries** in that file when first published, not inferred from topology. A direct product classifies once `inheritance.json` is present; a product inheriting a mirror needs that mirror's allowlist entry after inherit.

CI prefers `github.repository`; local normalizes `origin` URL.

**`ZERO_EDIT_MODE`:** forbidden on the normal lefthook / CI path. Harness may set it only when an explicit test sentinel is also set (e.g. file under `tmp/` created by `dogfood-zero-edit.sh`); otherwise ignore or fail closed. Prefer fixture trees over env override when practical.

### D6 — Inventory gate (classification, not intent)

Under `config/` · `scripts/` · `docs/`, every tracked path must be under `kit/` or `product/`, except exact tool-mandated paths listed in zones. Unclassified → fail.

This gate proves **structural classification**, not “no kit content was ever misplaced under `product/`”. Misplacing kit prose under `docs/product/` remains a review / dogfood concern.

Same spirit for `.github/workflows/*`: unclassified workflow → fail (not silent product-owned).

### D7 — Relocated SSoT paths (post-migration)

| Role | Path |
|------|------|
| Zones + policy + kit-origin allowlist | `config/kit/zero-edit-zones.json` |
| Exceptions template | `config/kit/zero-edit-exceptions.example.json` |
| Exceptions (product) | `config/product/zero-edit-exceptions.json` |
| Inheritance marker | `config/product/inheritance.json` |
| Checker | `scripts/kit/check-zero-edit-zones.sh` |
| Consumer contract | `docs/kit/product-consumer-contract.md` |

### D8 — Mirror fidelity (explicit non-claim)

Kit mode on an allowlisted **mirror** does not prove bit-for-bit parity with kit HEAD. Mirror drift is an **operator sync** concern ([Roxabi/roxabi-boilerplate-cf#108](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/108)), not priced by product zero-edit. Products correctly pin the mirror tip they actually merged.

## Consequences

- Products may own machine config under `config/product/` without dual-edit exceptions for “being under `config/`”.
- Merge-upstream DX stays path-stable for `packages/` and example apps; only `config|scripts|docs` reshape once.
- Local lefthook and CI share one base resolution path → restores “local `validate:full` is the real gate”.
- Consumers migrating from the legacy baseline must move to the inheritance marker.
- Root kit surfaces remain on `protected_files`; `bun.lock` is product workspace co-owned.

## Non-goals

- Auto-`git fetch` inside the checker
- Cryptographic / remote attestation of `upstreamCommit` provenance
- Requiring products to track kit HEAD when their parent is a mirror
- Enforcing mirror≡HEAD inside product zero-edit
- Moving `tooling/` under `scripts/kit`
- Changing root or workflow ownership without an explicit decision
- Product-domain features


## Refs

- Epic: [Roxabi/roxabi-boilerplate-cf#105](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/105)
- Children: [Roxabi/roxabi-boilerplate-cf#106](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/106) move · [Roxabi/roxabi-boilerplate-cf#103](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/103) regress · [Roxabi/roxabi-boilerplate-cf#108](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/108) mirror · [Roxabi/roxabi-boilerplate-cf#109](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/109) product · [Roxabi/roxabi-boilerplate-cf#107](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/107) kill transitional · [Roxabi/roxabi-boilerplate-cf#110](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/110) root debt
- Contract (pre-move path): [`docs/kit/product-consumer-contract.md`](../../product-consumer-contract.md)
