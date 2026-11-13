---
title: 'ADR-0011 — Fold `tools/` into `scripts/kit` + `config/kit`'
status: accepted
normative: true
date: 2026-08-23
axial: false
related:
  - docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md
  - docs/kit/architecture/adr/0009-kit-namespace-polarity-inheritance-marker.md
  - docs/kit/product-consumer-contract.md
  - config/kit/zero-edit-zones.json
---

# ADR-0011 — Fold `tools/` into `scripts/kit` + `config/kit`

Closes the taxonomy hole left by [ADR-0009](./0009-kit-namespace-polarity-inheritance-marker.md) D2: `tools/` stayed a kit-owned dump that mixed **executables** and **policy data**. Products had no legal place for dedicated helpers except `scripts/product/`, and kit exemption registers sat next to checkers instead of under `config/kit/`.

Implements [Roxabi/roxabi-boilerplate-cf#120](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/120). Product file-length surface remains [Roxabi/roxabi-boilerplate-cf#118](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/118) (`config/product/file_exemptions.txt`).

## Context

ADR-0009 namespaced only `{config,scripts,docs}/{kit,product}`. `tools/` and `tooling/` were deferred (« taxonomy merge = later ADR »).

That left two rules in the same repo:

| After ADR-0009                  | `tools/` leftover             |
| ------------------------------- | ----------------------------- |
| code → `scripts/{kit,product}/` | checkers + worktree helpers   |
| data → `config/{kit,product}/`  | `*_exemptions.txt`, `qg.conf` |

Roxabi/roxabi-boilerplate-cf#118 had to invent `config/product/file_exemptions.txt` because putting a product register under `tools/` would require `tools/product/` and punch a hole in the `tools/` zero-edit prefix.

## Options Considered

### Option A — `tools/kit` + `tools/product`

- **Pros:** least path churn for leftover; mirrors the three namespaced trees
- **Cons:** fourth polarity root; zero-edit must stop treating `tools/` as a prefix and list files; products still confuse « tools » with kit checkers

### Option B — Fold into existing polarity (chosen)

- **Pros:** one rule: executable → `scripts/{kit,product}/`, data → `config/{kit,product}/`; no `tools/product/`; zero-edit prefixes stay `scripts/` + `config/`
- **Cons:** leftover / `package.json` / CP harnesses all move; one-release wrappers if anything still calls `tools/…`

### Option C — Leave `tools/` as the quality-gate island

- **Pros:** zero work
- **Cons:** Roxabi/roxabi-boilerplate-cf#118 already proved the split is load-bearing; folder-size and import-boundary would keep dual-editing `tools/*.txt`

## Decision

### D1 — Placement rule

```text
executable  → scripts/{kit,product}/
policy/data → config/{kit,product}/
```

No `tools/kit`. No `tools/product`. Product-owned helpers live in `scripts/product/` (or `apps/<product>-*/scripts/`). Products never add files under `tools/`.

### D2 — Kit map (from `tools/`)

| From                                                                                                                                  | To             |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `check_file_length.sh` · `check_folder_size.sh` · `check_lib.sh` · `licenseChecker.ts` · `worktree-setup.sh` · `worktree-teardown.sh` | `scripts/kit/` |
| `file_exemptions.txt` · `folder_exemptions.txt` · `import-boundary-exemptions.txt` · `qg.conf`                                        | `config/kit/`  |

Live kit register paths after cutover:

- `config/kit/file_exemptions.txt`
- `config/kit/folder_exemptions.txt`
- `config/kit/import-boundary-exemptions.txt`

Product registers (optional, absent = accept):

- `config/product/file_exemptions.txt` (Roxabi/roxabi-boilerplate-cf#118)
- `config/product/folder_exemptions.txt`
- `config/product/import-boundary-exemptions.txt`

Same fail-closed class as Roxabi/roxabi-boilerplate-cf#118: `apps/<product>-{api,web,mcp}/` only, explicit caps, no kit-path, no wildcard, kit-dup refused.

### D3 — `tools/` after cutover

`tools/` is not a polarity root. No permanent wrappers are part of the target; `extract-dry-run` fails closed when `tools/` exists and is non-empty (an empty directory is tolerated).

### D4 — `tooling/` stays

The remaining `tooling/` tree is outside this ADR. Its kit-owned contents retain their ownership pending separate decisions.

### D5 — Invoke sites

lefthook, `package.json`, `.dev/stack.yml`, and CP harnesses call `scripts/kit/…` and read `config/kit/…`. They do not honor a product-exported `QG_FILE_*` / `QG_FOLDER_*` as a live pin (same honesty as Roxabi/roxabi-boilerplate-cf#118: `env -u` is best-effort; pin = zero-edit invoke sites + CI clean env).

## Consequences

### Positive

- One ownership rule for agents and humans
- Product scripts have a real home (`scripts/product/`)
- Exemption dual-edit of `tools/*.txt` ends (with Roxabi/roxabi-boilerplate-cf#118 + the two sibling product registers)

### Negative

- Path churn across leftover, CI, tests, consumer contract
- Products that still patch `tools/file_exemptions.txt` must cut over (docs, one commit, same as Roxabi/roxabi-boilerplate-cf#118)

### Neutral

- Checkers keep the same 300-line / 40-file defaults
- Remaining `tooling/` ownership is explicitly deferred, not forgotten
