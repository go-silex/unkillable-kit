# Testing

## Risk tiers (floors + expectations)

Floors are enforced by Vitest (`packages/config/vitest-coverage.mts` + per-package `vitest.config.ts`). Runner: `scripts/kit/test-coverage.sh`.

| Tier   | Scope                                                                                    | Floor (stmts/lines, approx.)                                                                                              | Policy                                                                                                                                                                           |
| ------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T0** | `@kit/auth`, `@kit/example-api` (guards, dual auth, paths), FE **auth client** contracts | **auth 80%** · **example-api** machine floors **78/80/65/75** (stmts/lines/branches/funcs) · pin named web contract files | **Auth: never lower without ADR.** example-api: Vitest 4 v8 remapping exception (Roxabi/roxabi-boilerplate-cf#21) — see inventory before/after; do not lower further without ADR |
| **T1** | `core`, `storage`, `db`, `types`, `@kit/api-client`, `mcp`                               | **core ~68/69/66** (stmts/lines/branches) · others **70–75%** typical                                                     | Raise when surface grows; core floors recalibrated under Vitest 4 remapping (Roxabi/roxabi-boilerplate-cf#21)                                                                    |
| **T2** | `@kit/ui`, `example-web` (page chrome)                                                   | **ui ~17/17/16/23** · **web 10/10/20/12**                                                                                 | Low % OK **iff** contract suites green; do not chase Button coverage; Vitest 4 remapping (Roxabi/roxabi-boilerplate-cf#21)                                                       |
| **T3** | `email` thin, mcp-example smoke                                                          | soft / special (e.g. funcs 0% mcp-example)                                                                                | Document, don’t pretend product security                                                                                                                                         |

The starter API is in the high coverage tier, with floors of 70/70/55/70 (statements/lines/branches/functions); the starter web is in the lower tier at 50/50/40/50. Starter HTTP tests exercise authentication and Organization isolation; web smoke tests cover sign-in and the authenticated shell. The Vitest configurations enforce these floors.

**Vitest 4 remapping (Roxabi/roxabi-boilerplate-cf#21):** Same sources/tests produce lower stmt/branch % under Vitest 4.1.x v8 than 3.2.x. Floors were recalibrated just under measured values. **% is a ratchet, not the story.** The story is **critical paths** below.

---
