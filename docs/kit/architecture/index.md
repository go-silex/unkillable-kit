---
title: "Architecture and ADR index"
description: "Authority rules and status index for Chemin A kit architecture decisions."
---

# Architecture and ADR index

This index identifies the architectural authority of every decision record. ADR frontmatter is the source of truth: only `status: accepted` with `normative: true` is binding; proposed or non-normative records remain design input.

## Authority model

| Family                                             | Authority                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`AGENTS.md`](../../../AGENTS.md)                  | Auto-loaded constitution: mission, precedence, invariants and hard agent rules        |
| Accepted normative ADR                             | Binding current decision within its stated scope                                      |
| [`platform-direction.md`](./platform-direction.md) | Detailed direction under the constitution; not an implementation backlog              |
| Proposed or non-normative ADR                      | Advisory only; it cannot override the constitution or an accepted normative ADR       |
| Design notes                                       | Non-normative until adopted by an accepted ADR amendment when the code is implemented |

Extracted implementation specifications: [ADR-0019](./design-notes/0019-notifications.md), [ADR-0020](./design-notes/0020-delivery.md), [ADR-0021](./design-notes/0021-slack.md).

## Decision records

Each ADR's YAML frontmatter is the sole home of its status, normativity and axial marker. Reading a
row: a trailing `(<status>)` names the ADR's status, and a row without one is accepted.
`bun run doc:check` checks this file and the ADR frontmatter. The header of
[`check-adr-frontmatter.ts`](../../../scripts/kit/check-adr-frontmatter.ts) describes the rules,
and CP-DOC-HYGIENE in [`testing.md`](../testing.md) says what the check does and does not claim.

| ADR                                                                    | Decision                                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [ADR-0001](./adr/0001-primary-axis-packages-compose-apps.md)           | Platform packages compose deployable apps                                   |
| [ADR-0002](./adr/0002-session-hmac-interim-vs-better-auth.md)          | Better Auth browser sessions + Bearer `sk_` dual path                       |
| [ADR-0003](./adr/0003-multi-tenant-rbac-modules.md)                    | Organization tenancy, platform RBAC and dual-level modules                  |
| [ADR-0004](./adr/0004-email-transport-cf-default.md)                   | Cloudflare Email transport by environment                                   |
| [ADR-0005](./adr/0005-flows-platform-agentic-workflows.md)             | Governed plans and durable runs                                             |
| [ADR-0007](./adr/0007-tasks-comments-kernel.md)                        | Tasks and comments as kit capabilities                                      |
| [ADR-0008](./adr/0008-kit-schema-identity-product-compose.md)          | Kit schema identity by module id + hash                                     |
| [ADR-0009](./adr/0009-kit-namespace-polarity-inheritance-marker.md)    | Kit/product namespace polarity and inheritance marker                       |
| [ADR-0010](./adr/0010-list-page-cursor-envelope.md)                    | Shared list-page cursor envelope                                            |
| [ADR-0011](./adr/0011-tools-fold-scripts-config-polarity.md)           | Fold tools into `scripts/kit` and `config/kit`                              |
| [ADR-0012](./adr/0012-kernel-persistence-request-context.md)           | Applied SQL + `@kit/auth/hono` are the persist/request-context kernel       |
| [ADR-0013](./adr/0013-root-github-workflow-ownership.md)               | Root and GitHub workflow ownership                                          |
| [ADR-0014](./adr/0014-openapi-from-hono-routes.md)                     | OpenAPI projected from the Hono routes                                      |
| [ADR-0015](./adr/0015-mcp-remote-oauth-worker.md)                      | Hosted Streamable HTTP + Worker-issued MCP OAuth token                      |
| [ADR-0016](./adr/0016-tasks-owner-org-tenancy.md)                      | Tasks owner-org tenancy (proposed)                                          |
| [ADR-0018](./adr/0018-durable-execution-ownership.md)                  | One durable owner per durable execution                                     |
| [ADR-0019](./adr/0019-notifications-rules-inbox-and-delivery.md)       | Notifications: rules, Inbox, persistence and producer contracts             |
| [ADR-0020](./adr/0020-notification-delivery-ownership.md)              | Stable-ID Workflow ownership for notification Delivery; Queue demo boundary |
| [ADR-0021](./adr/0021-slack-installations-and-notification-channel.md) | Slack installations, User links and notification Channel                    |

## Reading an ADR

1. Read `status` and `normative` before relying on the decision.
2. Follow `related` references for additional context; the current decision is stated in the ADR itself.
3. Resolve conflicts through the precedence rule in [`AGENTS.md`](../../../AGENTS.md), with ADR-0001 as the axial package/app boundary.
4. Record a new ADR when a stack or cross-cutting architecture decision changes; do not turn working notes into implicit policy.
