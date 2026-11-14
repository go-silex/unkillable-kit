# Testing

## Phased tooling

| Phase               | Add                                                                                           | Gate?                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Now**             | This doc · local `validate:full` (step list = root `package.json`) · existing Vitest + floors | Yes — local + CI guardrail                                                                |
| **B6 / kit polish** | Playwright Chromium: login → session; me/notes smoke; keep design-system smoke                | Prefer local first; CI job only when stable (watch merge-on-green “all checks” semantics) |
| **Later**           | `test:critical` filter alias for CP-\*                                                        | Convenience, not replacement for full pre-push                                            |
| **Later**           | Mutation on `packages/auth`                                                                   | Nightly/manual signal only until &lt;5 min and low noise                                  |

---
