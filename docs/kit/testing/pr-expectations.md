# Testing

## PR expectations

Use [`.github/PULL_REQUEST_TEMPLATE.md`](../../../.github/PULL_REQUEST_TEMPLATE.md).

| Touched area                                          | Expected                                                                                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth / keys / cookies                                 | Update seam tests; targeted proof + review by an agent independent of implementation                                                                                   |
| Durable execution (Workflows, Queues, DO alarm, Cron) | Targeted proof + review by an agent independent of implementation against [ADR-0018](../architecture/adr/0018-durable-execution-ownership.md) D1/D2; no gate checks it |
| New protected resource                                | **CP-IDOR** + **CP-UNAUTH** cases for that resource                                                                                                                    |
| `packages/*` public API                               | Package unit + example still composes it                                                                                                                               |
| UI primitives trap                                    | Contract test in `packages/ui` (or justify)                                                                                                                            |
| FE api client                                         | **CP-FE-CRED** stays green                                                                                                                                             |
| Product domain                                        | Must not land in packages (banlist)                                                                                                                                    |

**Test plan section** should list commands actually run, e.g.:

```bash
bun run validate:full
# and/or focused:
bun run --filter @kit/example-api test
```

---
