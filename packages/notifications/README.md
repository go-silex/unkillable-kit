# @kit/notifications

Notification definitions, resolution and persistence; it does not own application delivery orchestration.

## Entry points

- `@kit/notifications`: definitions, rule validation, resolution and rendering.
- `@kit/notifications/schema`: notification database tables.
- `@kit/notifications/repos`: notification repositories.

## Composition

- Kit dependencies: `@kit/auth`, `@kit/core`, `@kit/db`, `@kit/types`.
- Known consumers: `apps/example-api`.
- Caller rules: [architecture decision](../../docs/kit/architecture/adr/0019-notifications-rules-inbox-and-delivery.md).

### Composing admission with App writes

`@kit/notifications/repos` exports `planAdmitNotifications` and `interpretAdmitResults` for an App that needs its own writes and notification admission in one D1 batch. The planner takes the raw `KitD1Database`, an `AdmissionBatch` and owner identities; it validates them and returns bound statements and parallel `kinds`, without executing them. Use the same database binding for planning and the final batch; treat the bound statements as belonging to that batch, not as reusable SQL to copy or execute separately.

Keep all planned statements contiguous and in their original order. For each User the plan places the Notification insert before its User Delivery inserts, followed by Organization Delivery inserts after all Users. This order preserves the inserts' `changes()` dependency. Do not interleave guards or other writes within the plan.

After a successful batch, pass `interpretAdmitResults` exactly the results for the planned statements, in order, with one `{ results: rows }` entry per kind. Exclude preceding or following App statement results and any guard results; compute the offset according to the batch API's returned results, not merely its input steps. A length mismatch is an error. Returned IDs describe only newly created rows: an active-identity conflict is a successful no-op, whereas a hard constraint or SQL failure aborts the batch.

The App still owns live producer and recipient authorization, including source ACL checks. When authorization can change concurrently, enforce the required live checks in the same batch; planning is not authorization. Only after commit may the App request Workflow admission for newly created Deliveries, under ADR-0020. The existing `admitNotifications` wrapper continues to execute admission on its own; existing best-effort flow callbacks remain unchanged.

## Development

- Where to add: `src/registry.ts` for definitions; `src/resolve.ts` for resolution; `src/repos/` for persistence.
- Test: `bun run --filter @kit/notifications test`
- Typecheck: `bun run --filter @kit/notifications typecheck`
