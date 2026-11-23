# @kit/db

D1 database helpers and a SQLite test adapter; it does not own application schema composition.

## Entry points

- `@kit/db`: D1 client and database utilities.
- `@kit/db/testing`: SQLite-backed D1 test adapter and D1 round-trip counter.

## Composition

- Kit dependencies: none.
- Known consumers: `packages/auth`, `packages/comments`, `packages/flows`, `packages/notifications`, `packages/tasks`, `apps/example-api`.
- Caller rules: [architecture decision](../../docs/kit/architecture/adr/0012-kernel-persistence-request-context.md).

## Measuring HTTP requests

Use `countD1RoundTrips` with a real or local D1 binding. After arranging the
fixtures and obtaining credentials on the original binding, wrap it for just
the request under test:

```ts
import { countD1RoundTrips } from '@kit/db/testing'

const measured = countD1RoundTrips(env.DB)
const response = await app.request('/api/profile', { headers }, { ...env, DB: measured.db })
expect(response.status).toBe(200)
measured.assertAtMost('GET /api/profile', 7) // Replace 7 with this fixture's measured count.
```

`measured.count` gives the observed count. One counter measures calls made
through its wrapped binding, including statements made through D1 Sessions;
it does not measure other bindings or asynchronous work after the assertion.
Use a fresh counter per request rather than including migration, fixture,
sign-in or verification queries in the ceiling.

See the [ceiling policy](../../docs/kit/testing.md#d1-round-trip-ceilings).

## Development

- Where to add: `src/index.ts` for D1 helpers; `src/test/sqlite-d1.ts` for the test adapter.
- Test: `bun run --filter @kit/db test`
- Typecheck: `bun run --filter @kit/db typecheck`
