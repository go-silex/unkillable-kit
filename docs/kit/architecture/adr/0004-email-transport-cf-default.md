---
title: 'ADR-0004 — Email transport: CF Email Sending default (prod), Mailpit/log local'
status: accepted
normative: true
date: 2026-07-30
axial: false
related:
  - packages/email
  - GitHub epic CF Email
summary: 'Cloudflare Email transport by environment'
---

# ADR-0004 — Email transport by environment

## Context

Transactional email is required for Better Auth flows (password reset, org invites) and future product notifs. Kit already has:

- Edge-safe `sendLog` + demo templates (`@kit/email`)
- Node-only SMTP → Mailpit (`@kit/email/server`)

AGENTS freeze listed Resend and/or **Cloudflare Email** for prod. Chemin A is Workers-first → prefer **CF Email Sending** binding (no API key in Worker).

## Decision

### D1 — Transport matrix

| Env         | Transport                                                          | Notes                                                           |
| ----------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| **local**   | `log` (Worker) and/or SMTP → **Mailpit** (Node scripts / optional) | Never real customer inbox                                       |
| **staging** | **CF Email** or opted-in Resend (real send)                        | Recipient allowlist, From-domain pin and staging subject prefix |
| **prod**    | **Cloudflare Email Sending** via Worker binding                    | Default · optional allowlist pin                                |

Resend remains an **escape hatch** (`EMAIL_TRANSPORT=resend`) if a product cannot use CF Email — not the kit default.

### D2 — Kit API shape

```text
EMAIL_TRANSPORT=log | smtp | cf | resend   # app env
EMAIL_FROM=...
EMAIL_ALLOW_DOMAINS=a.com,b.com            # recipient allowlist
EMAIL_FROM_DOMAIN=example.com              # optional From pin (staging default)
```

- **`cf`**: `env.EMAIL.send({ to, from, subject, html, text })` — binding name configurable (default `EMAIL`)
- **`log`**: structured console JSON (edge-safe; **must redact** reset/invite tokens in body)
- **`smtp`**: Node-only Mailpit path (`@kit/email/server`) — never import from Worker bundle
- **`resend`**: optional HTTP from Worker when product opts in

### D3 — Domain & deliverability (ops)

- Domain onboarded: `wrangler email sending enable <domain>` (or dashboard)
- SPF / DKIM / DMARC documented in kit runbook (ops checklist)
- From-address must use onboarded domain
- Transactional only (no marketing bulk)

### D4 — Security

- Never log full magic-link / reset URLs in prod/staging (`log` transport redacts tokens)
- Secrets: CF binding needs no API key; Resend key = CF secret if used
- Fail closed if `EMAIL_TRANSPORT=cf` and binding missing outside test
- Token hrefs are scheme/host-allowlisted before render (`assertSafeTokenHref`); HTML-escape is not enough. `allowedOrigins` is required; a request-derived BA `baseURL` is not seeded into the allowlist

### D6 — Staging recipient allowlist and From-domain pin

Staging sends **real** mail (client + internal QA), but must not spray arbitrary addresses from DB dumps.

| Rule                  | Staging (`cf`\|`resend`)                                             | Production                                                 |
| --------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| `EMAIL_ALLOW_DOMAINS` | **Required** non-empty · exact match on recipient domain             | Optional; when set, enforced                               |
| `EMAIL_FROM`          | Must match `EMAIL_FROM_DOMAIN`; defaults to `example.com` when unset | Product onboarded domain; optional `EMAIL_FROM_DOMAIN` pin |
| Unknown `to` domain   | Fail closed at send — **no** provider call                           | Send (unless allowlist set)                                |
| Subject               | Forced prefix **`[TEST STAGING]`** (idempotent)                      | Unchanged                                                  |

Intent: ops allowlists each client test domain and the team domain, pins the staging From identity, and makes subjects distinguishable from production.

### D5 — Axial

- Templates: shared builders in `@kit/email` (locale-aware later); **no product domain copy** in package defaults beyond kit demo strings
- Apps choose from-address and which flows call the port
- No empty `@kit/email-cf` package — extend `@kit/email`

## Consequences

- B3 reset/invites can use real transport on CF once domain ready
- Local dogfood stays Mailpit/log
- Inbound Email Routing **out of scope** for this ADR

## Implementation state

`@kit/email` implements the Cloudflare, Resend and log ports and staging policy; SMTP is a Node-only subpath. The example API resolves its email port lazily at send time. Staging and production require an explicit real transport; log is forbidden there. Source availability does not prove a domain is onboarded or that mail was sent.

## Anti-patterns

- Shipping Worker with `ENVIRONMENT=development` + real CF sends by accident without intent
- Logging password-reset tokens in clear
- Importing Node SMTP into Worker bundle
- Empty package theater for CF only

## Related

- [ADR-0002](./0002-session-hmac-interim-vs-better-auth.md) — BA session (reset/invites consumers)
- `packages/email` · `docker-compose.yml` Mailpit
- Cloudflare Email Service docs / skill `cloudflare-email-service`
