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
