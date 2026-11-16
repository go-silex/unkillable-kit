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

### Restricting Inbox read marks

`markRead(db, scope, { id?, now }, selection?)` accepts an optional `InboxReadSelection` from `@kit/notifications/repos`: `{ sql, params }`. The three-argument call keeps its existing behavior. The fourth argument is a **trusted server-code seam**, not request data; never accept its SQL from a client or place it in an HTTP body.

`sql` must be one self-contained, read-only SQLite SELECT returning exactly one Notification ID column. It may begin with `WITH` or `WITH RECURSIVE`; it must not depend on an outer alias, inject a top-level CTE, contain a trailing terminator or contain another statement. Use anonymous `?` placeholders and provide D1-bindable `params` in their original positional order. SQL structure and identifiers must come from reviewed server code or a trusted compiler; bind request-derived values instead of interpolating them. Named or numbered parameters and unfilled Drizzle placeholders are not supported.

Kit embeds the selection in its single UPDATE, evaluating it at mutation time rather than materializing IDs first. It intersects the result with the existing Organization, User, readable Module and unread scope and, when supplied, the requested `id`. The selection can only narrow that scope; an empty result marks nothing, and duplicate or NULL IDs do not increase the count. This guarantee assumes a well-formed, trusted selection: the seam is not an SQL sandbox or authorization validator.

Kit sets only `readAt` and returns the number of newly marked rows. Previously read timestamps are preserved, and resolved-but-unread rows remain eligible. Zero can mean already read or outside the effective scope; it is not an authorization verdict. Omission leaves the default behavior unchanged and does not add a live source ACL check. Apps needing such a check must provide their current restriction in the selection.

Malformed selection shapes, including `null`, blank SQL or missing/non-array `params`, fail rather than becoming unrestricted. SQL syntax, result-column arity and bind errors propagate from the database; there is no unrestricted retry. The D1 parameter limit includes both Kit's outer binds and the selection's binds.

## Development

- Where to add: `src/registry.ts` for definitions; `src/resolve.ts` for resolution; `src/repos/` for persistence.
- Test: `bun run --filter @kit/notifications test`
- Typecheck: `bun run --filter @kit/notifications typecheck`
