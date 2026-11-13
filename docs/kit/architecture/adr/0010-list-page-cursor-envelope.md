---
title: 'ADR-0010 — List page cursor envelope'
status: accepted
normative: true
date: 2026-08-21
axial: false
related:
  - docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md
  - docs/kit/ui-kit.md
---

# ADR-0010 — List page cursor envelope

Kit catalogue endpoints share one cursor page contract so consumers do not freeze divergent offset, dump-all, or resource-key envelopes.

## Context

List transport, keyset mechanics, SQL ownership, and UI presentation are separate concerns. A reusable contract must remain Worker-safe and generic without hiding endpoint authorization or query semantics inside a package.

## Decision

### D1 — Contract and ownership

| Concern          | Decision                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| Wire response    | `{ items, nextCursor, requestId }`; `nextCursor: null` marks the last page                                 |
| Shared page type | `ListPage<T> = { items: T[]; nextCursor: string \| null }`; `requestId` remains route/middleware-owned     |
| Cursor           | Opaque by convention, not an authorization or security boundary                                            |
| Shared helpers   | Query/page types in `@kit/types`; cursor, limit, and page extraction mechanics in `@kit/core`              |
| Package boundary | No `@kit/pagination`                                                                                       |
| Repository       | Owns authorization scope, stable `ORDER BY`, matching keyset `WHERE`, and `limit + 1` fetch                |
| Encoding         | Base64url JSON through Worker Web APIs (`TextEncoder`, `TextDecoder`, `btoa`, `atob`), never Node `Buffer` |

Generic decoding validates encoding, JSON, and the generic record shape only. Each endpoint must then validate its exact key names, value types, and constraints before constructing repository predicates. Invalid cursors fail with a generic validation error that does not disclose the decoded keyset.

Temporal cursor fields are finite epoch-millisecond numbers. Response DTOs may expose another representation, but cursor creation and SQL comparison use epoch milliseconds.

### D2 — Data-shape rule

| Data shape                                | Default                                                             |
| ----------------------------------------- | ------------------------------------------------------------------- |
| Unbounded catalogue                       | Cursor page envelope with `items`                                   |
| Small lookup or documented demo-size data | Known-small dump or hard cap; optional search                       |
| Aggregate or insights                     | Aggregate on the server; do not page raw rows for browser reduction |

A demo-size dump must be documented as an exception. If it can grow into a catalogue, it adopts the cursor page envelope.

### D3 — Accepted trade-offs

- Clients may mint a well-formed cursor to seek within an authorized result set.
- Search `q` is not bound into the cursor; reusing a valid cursor with another `q` is an accepted seek.
- Concurrent writes may cause skipped or duplicated rows between page requests.
- Exact totals are absent by default because they require separate counting work and may scan D1 data.

Authorization and tenant scope apply independently on every request; cursor contents never grant access.

## Consequences

- New kit catalogue endpoints expose a stable `{ items, nextCursor, requestId }` wire shape.
- Endpoint repositories retain full ownership of SQL ordering and keyset predicates.
- UI code may use infinite queries or another app-owned presentation without changing the API contract.
- Consumers needing snapshot-stable traversal, bound filters, or totals must define and price those stronger semantics explicitly.

## Implementation state

`@kit/types` exports `ListPage` and list query types; `@kit/core` provides cursor and page helpers. Endpoint-specific authorization, validation and SQL predicates remain the responsibility of each composing app; the shared helpers do not prove every endpoint has migrated.

## Non-goals

- Encrypted or authenticated cursors
- Offset pagination as the kit default
- Snapshot isolation across page requests
- A shared UI pagination component
