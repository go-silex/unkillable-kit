# Testing strategy — Chemin A kit

SSoT for **how we test** this monorepo. Complements the [`AGENTS.md`](../../AGENTS.md) constitution, [documentation index](./README.md), [development process](./processes/dev-process.md), [stack standard](./standards/stack.md), axial [ADR-0001](architecture/adr/0001-primary-axis-packages-compose-apps.md) and dual-credential [ADR-0002](architecture/adr/0002-session-hmac-interim-vs-better-auth.md).

---

## Doctrine (one screen)

| Principle                          | Meaning                                                                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Effective tests > vanity %**     | Ask: _if this breaks in prod, which test fails?_                                                                                       |
| **Local is the real gate**         | Tree validation + applicable tooling self-tests **before push**. CI is a **guardrail**, not the place you discover red.                |
| **Tiered floors, not one goal**    | High floors on auth/API; low global floors on ui/web **only if** named contracts stay green.                                           |
| **Ownership follows PRIMARY axis** | Package contracts in `packages/*`; composition in `apps/example-*`; product risks only in `apps/<product>-*`, in product repositories. |
| **No checklist theater**           | PR boxes map to **named suites / CP-IDs**, not “tests added”.                                                                          |
| **Optional tooling has a phase**   | Playwright / mutation: phased or explicitly out of merge — no limbo.                                                                   |

**Anti-slogan:** “We deprioritized coverage for quality” must never mean “we lowered T0 floors” or “we deleted negative cases.”

Root core, grouped coverage and the Product CI template call `scripts/kit/ci-install.sh` after
selecting Node from `.node-version` and Bun from `package.json`. That script exposes npm-bundled
`node-gyp` through a temporary job-local PATH shim only during the frozen Bun install. A missing
executable or failed install fails the job; no global package or lockfile change is involved.
The current lock's `trustedDependencies: []` prevents dependency install lifecycle scripts from
running, so this install does not exercise a native compilation fallback. Prebuilt success does
not prove source compilation. An explicit native source build is a separate proof and does not
establish that an install fallback ran.

The sequential Root gate writes a JSON line per attempted task, alongside its running logs and
task output: `event` is `root-gate:task`, `task` names the task, `durationMs` is monotonic elapsed
milliseconds rounded to three decimals, `status` is `passed` or `failed`, and `exitCode` is the
child exit code (or 1 if unavailable). A failure is recorded before fail-fast stops execution;
read-only plan modes emit no task timings.

Workspace Vitest configs use the shared `ciMaxWorkers` setting: CI uses all available CPUs;
outside CI, Vitest keeps its defaults. Coverage parts and their merge use the same App config.
Root lint checks the dedicated Vitest config or the Vite fallback without loading it. It
reports a missing config in a Vitest workspace, a missing shared setting or `fileParallelism: false`
(which forces one worker). Kit findings fail lint; Product findings warn without failing it.

For an App copied from an older starter, import `ciMaxWorkers` from
`../../packages/config/vitest-workers.mts` and set `test.maxWorkers` to it in the App's config.
Keep any Product-specific worker limit if its suite needs it; the warning is advisory.

---

| What it answers                                        | Section                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| How local gates and CI divide responsibility           | [Ops model — local first, CI guardrail](./testing/ops-model.md)  |
| Which test floors apply by risk tier                   | [Risk tiers (floors + expectations)](./testing/risk-tiers.md)    |
| Who owns tests across the primary axis                 | [Ownership (axial — PRIMARY = packages)](./testing/ownership.md) |
| Which authentication seams and regressions to test     | [Auth test seams (ADR-0002)](./testing/auth-seams.md)            |
| Which critical paths are covered and where gaps remain | [Critical path inventory (CP-*)](./testing/critical-path.md)     |
| What makes an effective test                           | [What a good test looks like](./testing/good-tests.md)           |
| How test layers form the pyramid                       | [Pyramid (kit)](./testing/pyramid.md)                            |
| How coverage is measured                               | [Coverage tooling (reference)](./testing/coverage.md)            |
| What a pull request must demonstrate                   | [PR expectations](./testing/pr-expectations.md)                  |
| When optional tooling applies                          | [Phased tooling](./testing/phased-tooling.md)                    |
| Which testing anti-patterns to avoid                   | [Anti-patterns (ban)](./testing/anti-patterns.md)                |
| Where to find related documentation                    | [Quick links](./testing/quick-links.md)                          |
