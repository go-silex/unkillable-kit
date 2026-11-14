# Testing

## Anti-patterns (ban)

| Anti-pattern                                      | Why                                      |
| ------------------------------------------------- | ---------------------------------------- |
| Push red, “CI will catch it”                      | Violates local-first; burns Free minutes |
| `LEFTHOOK=0` / `--no-verify` as habit             | Removes the real gate                    |
| Lower T0 floors “because coverage is radar”       | Erodes security bar                      |
| Treat 10% web floor as “UI security covered”      | Theater                                  |
| Apply “don’t test UI” to `apiFetch` / gates / 401 | Account/session regressions free         |
| Product fixtures in package tests                 | Axial drift                              |
| Optional e2e forever without decision             | False confidence                         |
| Checklist ✅ without CP / test names              | Social theater                           |

---
