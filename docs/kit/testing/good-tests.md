# Testing

## What a good test looks like

1. **Names the bug** — failure mode in the title (`… without auth returns UNAUTHORIZED`).
2. **Asserts the public contract** — status, `error.code`, cookie flags, a11y/DOM, not private helpers.
3. **Includes the negative path** for T0 (reject, 401, IDOR, bad sig).
4. **Stable** — no real network flake, no order-dependent FS.
5. **Fast enough** for pre-push — integration via `createApp` + memory env OK; full browser only for few paths.
6. **Owned by the right layer** — package unit vs app composition (see ownership).

### Refuse / rewrite

- Happy-path only on a new protected resource.
- “Button renders” as substitute for auth.
- Deleting negative cases to green a floor.
- Product scenarios inside `packages/*`.
- AI spam: `expect(true)` / status 200 without contract.

### God-file hygiene

Prefer splitting large HTTP suites by concern while still hitting `createApp`:

```text
auth.contract.test.ts · notes.idor.test.ts · cors.test.ts · …
```

Avoid pure “mock every repo” theatre unless a bug proves the need.

---
