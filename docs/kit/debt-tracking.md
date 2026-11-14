# Debt tracking (kit)

> **SSoT** for suppression markers in Chemin A.  
> Inspiration: kit-factory debt-tracking — **simpler**: no full registry, no Python audit JSON.  
> Gate: `bun run debt:check` · self-test: `bun run test:debt` · CP-DEBT in [`testing.md`](./testing/critical-path.md).

---

## Why

Biome / TypeScript strictness will tighten (plan 007 Phase C). Silent `biome-ignore` and
`@ts-expect-error` accumulate into invisible debt. This policy **surfaces** untagged and
stale markers on stderr so debt is **visible and reviewable**.

**Honest defaults:** untagged suppressions **fail** (exit 1). Expiry stays **warn**
(exit 0) — a green `validate:full` does **not** prove stale debt is gone until
`DEBT_EXPIRY_MODE=fail`. Expiry uses a **file last-commit proxy** (any meaningful
touch resets the clock), not line-level blame.

**Checker reliability:** `warn` tolerates **stale debt**, not an inability to determine it. When expiry needs a Git lookup for an unpinned marker, unavailable Git, a failing Git command, or nonempty invalid Git output is a hard check failure (exit 1), never a clean result. `off`, hard-pinned markers, and scans with no eligible marker do not preflight Git; a successful Git query with empty output means the file has no history and is not stale.

---

## Grammar

Every suppression in **`apps/`** and **`packages/`** must carry `DEBT:<slug>` after the reason:

```ts
// biome-ignore lint/suspicious/noExplicitAny: FastMCP Zod boundary — DEBT:fastmcp-zod-boundary #68
// @ts-expect-error legacy binding — DEBT:legacy-wrangler-env #19
```

| Element         | Rule                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Markers scanned | `biome-ignore`, `@ts-expect-error`, `@ts-ignore`                                                                                    |
| Scope           | `apps/**`, `packages/**` (`.ts` / `.tsx`) — not `scripts/kit/` / `tools/`                                                           |
| Slug            | kebab-case: `[a-z0-9]+(-[a-z0-9]+)*`                                                                                                |
| Separator       | `— DEBT:` or `- DEBT:` (em/en dash or hyphen before `DEBT:`)                                                                        |
| Issue pin       | optional `DEBT:<slug> #<N>` only (space + `#` immediately after slug) — **hard pin**: skips expiry forever until the pin is removed |
| Prefer          | remove the suppression (fix root cause) over adding DEBT                                                                            |

**Not scanned (v1):** `// @ts-nocheck`, file-level biome config, `tools/` / `scripts/kit/` helper ignores.

---

## Modes

| Gate         | Env                                | Default  | Fail when                                                                   |
| ------------ | ---------------------------------- | -------- | --------------------------------------------------------------------------- |
| **Untagged** | `DEBT_UNTAGGED_MODE=warn\|fail`    | **fail** | marker without `DEBT:<slug>`                                                |
| **Expiry**   | `DEBT_EXPIRY_MODE=off\|warn\|fail` | **warn** | `fail` + stale; or an unpinned marker's required Git lookup cannot complete |
| **Grace**    | `DEBT_EXPIRY_MONTHS`               | **6**    | —                                                                           |

### Stale definition (expiry)

A `DEBT:` line is **stale** when **all** hold:

1. The **file** last git-commit date is older than `DEBT_EXPIRY_MONTHS` (file-level inactivity proxy, not marker blame — same as factory).
2. The marker has **no** issue pin of the form `DEBT:<slug> #<N>` (1–6 digits after the slug).

**Pin semantics:** `#N` after the slug is a **permanent expiry exemption** (no open-issue check). Use only for actively tracked remediation. Accidental `#rgb` / mid-reason hashes do **not** pin (pin must follow the slug).

Remediation: remove the debt · add `DEBT:slug #N` pin · or touch the file with a meaningful fix (resets the file-level clock for all markers in that file).

**Landed:** untagged flipped to **fail** after the tree was tagged clean (M-18).
Expiry stays **warn** until stale markers are pinned or removed.

---

## Commands

```bash
bun run debt:check              # default fail/warn
DEBT_UNTAGGED_MODE=warn bun run debt:check
DEBT_EXPIRY_MODE=fail bun run debt:check
bun run test:debt               # CP-DEBT self-test (temp tree)
```

Wired into `validate:full` (untagged fail, expiry warn — stale debt does not block until `DEBT_EXPIRY_MODE=fail`; a required Git lookup failure always blocks).

---

## Light registry (optional)

No per-slug Markdown file is required in the kit. If a slug is reused often, add a row:

| Slug                   | Why it exists                                                                                                  | Drain                                                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fastmcp-zod-boundary` | FastMCP + Zod infer mismatch                                                                                   | when FastMCP types stabilize                                                                                                                                                                              |
| `fastmcp-duck-type`    | FastMCP `addTool` parameter is not assignable without a wide type                                              | when FastMCP types stabilize                                                                                                                                                                              |
| `cog-gate`             | gate script decision procedure; branches are the spec                                                          | [Roxabi/roxabi-boilerplate-cf#287](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/287): split by responsibility, not by moving branches into a helper. Ceiling in `config/kit/debt-ceilings.json` |
| `cog-authz`            | flows authority / plan decision table                                                                          | Roxabi/roxabi-boilerplate-cf#287, same rule                                                                                                                                                               |
| `cog-svc`              | example service or seed decision procedure                                                                     | Roxabi/roxabi-boilerplate-cf#287, same rule                                                                                                                                                               |
| `cog-ui`               | UI composition branches                                                                                        | Roxabi/roxabi-boilerplate-cf#287, same rule                                                                                                                                                               |
| `cog-map`              | boundary mapping (client, auth middleware, email, MCP budget)                                                  | Roxabi/roxabi-boilerplate-cf#287, same rule                                                                                                                                                               |
| `cog-shadcn`           | shadcn chart primitive; do not hand-edit for a score                                                           | vendor bump (not Roxabi/roxabi-boilerplate-cf#287)                                                                                                                                                        |
| `i18n-react-factory`   | Biome flags the per-catalog typed provider and hook factory definition rather than its module-scope call sites | Remove the markers when Biome stops reporting or the contract moves to a prop-threaded provider                                                                                                           |
| `modal-a11y-*`         | Base UI modal patterns                                                                                         | product design pass                                                                                                                                                                                       |

Keep the table short; prefer issue refs on the marker line.

---

## AGENTS.md ADR hygiene (soft)

Operational rules in `AGENTS.md` should be **self-contained** or link a domain page
(`docs/kit/architecture/…`, `docs/kit/testing.md`, …). Bare `ADR-NNNN` as the only pointer is
discouraged (ADRs are provenance, not day-to-day law).

```bash
bun run agents-adr:check   # warn-only by default; AGENTS_ADR_MODE=fail to gate
```

Linked forms such as [ADR-0002](./architecture/adr/0002-session-hmac-interim-vs-better-auth.md) are fine.

---

## Folder size (optional quality gate)

Companion to file length (`scripts/kit/check_file_length.sh`):

```bash
bun run folder-size:check
# QG_FOLDER_MAX (default 40), kit config/kit/folder_exemptions.txt, product config/product/folder_exemptions.txt
```

Included in `quality-gates:check` next to file length.

---

## What this does **not** cover

| Out                                     | Why                 |
| --------------------------------------- | ------------------- |
| Full factory debt registry + audit JSON | kit non-goal        |
| Importlinter / ACL                      | N/A Chemin A        |
| Silent Biome overrides in `biome.json`  | separate policy     |
| Product apps outside this monorepo      | consumers own gates |

---

## Related

| Doc / gate                                               | Role                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`testing.md`](./testing/critical-path.md) · **CP-DEBT** | control-point inventory                                                    |
| Historical plan `010-quality-hygiene-debt.md`            | provenance retained; the historical target is no longer in this repository |
| `scripts/kit/check-debt.ts`                              | untagged + expiry scanner                                                  |
| `scripts/kit/check_folder_size.sh`                       | folder density                                                             |
| kit-factory `docs/kit/debt-tracking.md`                  | upstream inspiration                                                       |
