---
title: "Chemin A kit documentation"
description: "Central index for standards, architecture, contracts, processes and runbooks."
---

# Chemin A kit documentation

This index locates the authoritative home for each rule and the operational guidance for using the Kit.

## Authority and navigation

| Home                                                         | Authority                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [This index](./README.md)                                    | Navigation only; it does not create policy                                                  |
| [`AGENTS.md`](../../AGENTS.md)                               | Auto-loaded constitution: mission, precedence, seven invariants and hard rules              |
| [Architecture index](./architecture/index.md)                | ADR authority model and complete list; each ADR frontmatter owns its status and normativity |
| [Standards](#normative-standards-and-contracts)              | Normative when named as a source of truth by the constitution or an accepted ADR            |
| [Processes and runbooks](#processes-operations-and-security) | Required operating procedure within their scope; they do not override constitution or ADRs  |
| [Playbooks](#onboarding-and-playbooks)                       | Ordered onboarding guidance built on the contracts                                          |

## Normative standards and contracts

- [Stack A–L](./standards/stack.md) — runtime, frontend, auth, packages, quality and architecture choices.
- [API contract](./api-contract.md) — the published `example-api` OpenAPI document and how it stays a projection of the routes.
- [Testing strategy](./testing.md) — local gate doctrine, risk tiers and CP inventory.
- [Product consumer contract](./product-consumer-contract.md) — zero-edit upstream, fetch-only remotes and product/kit ownership.
- [`@kit/ui` surface](./ui-kit.md) — owned UI package boundary and component contract.
- [Observability](./observability.md) — logging, redaction, traces and operational visibility.
- [Environment model](./environments.md) — local, staging and production isolation contract.
- [Kit schema sync](./kit-schema-sync.md) — product D1 composition rules aligned with ADR-0008.
- [Debt tracking](./debt-tracking.md) — suppression marker policy and its executable gate.
- [Third-party notices](./third-party-notices.md) — identified third-party material and its terms.
- [Dependabot security](./security-dependabot.md) — version-update and vulnerability-alert policy.

## Architecture and ADRs

- [Architecture and ADR index](./architecture/index.md) — authority model and current decision records.
- [Platform direction](./architecture/platform-direction.md) — developer needs, boundaries and evidence gates.
- [ADR-0001 — package/app primary axis](./architecture/adr/0001-primary-axis-packages-compose-apps.md).
- [ADR-0002 — Better Auth + Bearer `sk_`](./architecture/adr/0002-session-hmac-interim-vs-better-auth.md).
- [ADR-0003 — multi-tenant RBAC and modules](./architecture/adr/0003-multi-tenant-rbac-modules.md).
- [ADR-0004 — Cloudflare Email transport](./architecture/adr/0004-email-transport-cf-default.md).
- [ADR-0005 — governed flows and durable runs](./architecture/adr/0005-flows-platform-agentic-workflows.md).
- [ADR-0007 — tasks and comments kernel](./architecture/adr/0007-tasks-comments-kernel.md).
- [ADR-0008 — kit schema identity](./architecture/adr/0008-kit-schema-identity-product-compose.md).
- [ADR-0009 — namespace polarity and inheritance](./architecture/adr/0009-kit-namespace-polarity-inheritance-marker.md).
- [ADR-0010 — list-page cursor envelope](./architecture/adr/0010-list-page-cursor-envelope.md).
- [ADR-0011 — scripts/config polarity](./architecture/adr/0011-tools-fold-scripts-config-polarity.md).
- [ADR-0012 — kernel persist and request-context](./architecture/adr/0012-kernel-persistence-request-context.md).
- [ADR-0013 — root and GitHub workflow ownership](./architecture/adr/0013-root-github-workflow-ownership.md).
- [ADR-0014 — OpenAPI projected from Hono routes](./architecture/adr/0014-openapi-from-hono-routes.md).
- [ADR-0015 — hosted Streamable HTTP + Worker MCP OAuth](./architecture/adr/0015-mcp-remote-oauth-worker.md).
- [ADR-0016 — tasks owner-org tenancy (proposed)](./architecture/adr/0016-tasks-owner-org-tenancy.md).
- [ADR-0018 — one durable owner per durable execution](./architecture/adr/0018-durable-execution-ownership.md).
- [ADR-0019 — notification rules, Inbox and producer contracts](./architecture/adr/0019-notifications-rules-inbox-and-delivery.md).
- [ADR-0020 — Workflow-owned Delivery and Queue demo boundary](./architecture/adr/0020-notification-delivery-ownership.md).
- [ADR-0021 — Slack installations and notification Channel](./architecture/adr/0021-slack-installations-and-notification-channel.md).

## Processes, operations and security

- [Development process and AI safety](./processes/dev-process.md) — change workflow, secrets, machine gates, independent-agent review and operator supervision.
- [Contributing and publication](../../CONTRIBUTING.md#public-safe-publication) — public permissions and the public-safe publication procedure. Disclosure contact: [SECURITY.md](../../SECURITY.md).
- [Auth abuse response](./auth-abuse-response.md) — rate-limit and audit response procedure.
- [GitHub App `kit-ci` setup](./ci-app-setup.md) — operator setup for merge automation without a PAT.
- [Cloudflare deploy runbook](./deploy-cloudflare.md) — showcase deployment procedure.
- [Cloudflare Email runbook](./email-cf-runbook.md) — binding, allowlist and transport operations.

## Onboarding and playbooks

- [Start a product](./playbooks/start-product.md) — create a zero-edit consumer of the kit.

## Consumer templates

- [Product CI](./templates/product-ci.example.yml) and [validation script](./templates/product-validate.example.sh) — examples for consumer-owned CI.
- [Product Dependabot configuration](./templates/product-dependabot.example.yml) — generated App-only scan at GitHub's fixed path; the [consumer contract](./product-consumer-contract.md#product-dependabot-configuration) defines its content bound and shared-lock limits.
- [Schema manifest](./templates/kit-schema-manifest.example.json) — example for Kit schema composition.
