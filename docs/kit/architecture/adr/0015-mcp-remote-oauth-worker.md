---
title: 'ADR-0015 — Remote MCP uses Streamable HTTP + Worker-issued OAuth tokens'
status: accepted
normative: true
date: 2026-09-16
amended: 2026-11-25
supersedes_notes: >
  The current decision incorporates the 2026-10-24 hosted-shell, consent-policy,
  provider 1.2 and configured-origin decisions, the 2026-11-07 static
  consentPresentation seam with escaped plain text and Kit-owned English/French
  labels, and the 2026-11-09 optional deny-only grantAdmission seam for OAuth
  grants, admitted under an owner-authorized single-consumer exception. Consent
  policy, identity props, minting, scopes and TTLs are unchanged; a refused code
  exchange or refresh now makes the provider revoke that OAuth grant.
  The 2026-11-14 amendment adds a mandatory live User-state check and DB binding.
  2026-11-21: body trimmed to decisions, rationale and limits; implementation
  detail now lives only in the cited code and tests. No decision changed.
  2026-11-25: D8 admits a third owner exception, only for the opt-in tool-input
  Organization selection seam of ADR-0025 D3. No OAuth policy changed.
axial: false
related:
  - docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md
  - docs/kit/architecture/adr/0002-session-hmac-interim-vs-better-auth.md
  - docs/kit/architecture/adr/0003-multi-tenant-rbac-modules.md
  - docs/kit/standards/stack.md
  - docs/kit/testing.md
  - docs/kit/architecture/adr/0025-request-authorization-snapshot.md
summary: 'Hosted Streamable HTTP + Worker-issued MCP OAuth token'
---

# ADR-0015 — Remote MCP uses Streamable HTTP + Worker-issued OAuth tokens

Kit dogfood MCP was stdio-only. Agents (Claude Code, Cursor) could not connect to a hosted URL without a pasted JWT or a laptop stdio proxy. This record adds the **third client class** without collapsing the first two (ADR-0002).

The hosted shell is present under `packages/mcp/src/hosted`; its presence does not establish a deployed public endpoint or a successful OAuth integration proof.

## Context

MCP Authorization (2025-11-25) expects:

1. Unauthenticated resource calls fail closed with a Bearer challenge pointing at RFC 9728 protected-resource metadata.
2. The resource's authorization server is discovered from that metadata (this host, for kit dogfood).
3. The agent becomes a client via **CIMD** (client_id is an HTTPS metadata URL) or, on localhost/dev only, **DCR**.
4. The token stored by the agent is issued by **this** authorization server, bound to this resource.

Better Auth already authenticates humans for the SPA. It is **not** an MCP authorization server. FastMCP `GoogleProvider` / GitHub OAuth login providers authenticate a human to FastMCP; they are the wrong role for the MCP resource AS.

## Decision

### D1 — Three client classes stay distinct

Browser sessions use Better Auth cookies; machine HTTP uses organization-bound
`sk_` keys; remote agents use MCP access tokens issued by the Worker's own
authorization server. OIDC tokens are distinct too: these credentials do not
cross trust boundaries. Human authentication alone does not make Better Auth
or an upstream login provider the MCP resource authorization server.

Do not present a BA cookie or Google access token as MCP Bearer. Do not use `sk_` as MCP OAuth. HMAC sessions stay retired (ADR-0002 D2).

### D2 — Worker-issued token only

> **Amendment (2026-11-09) — deny-only OAuth grant admission.** Adds the optional
> `grantAdmission` seam described below. It can only refuse an existing OAuth
> grant, on an authenticated `/mcp` request, an authorization-code exchange or
> a refresh; it mints nothing and changes no identity props, scope, audience or
> TTL. Omission keeps every other behavior of this decision. D8 records the
> owner authorization and its bounded second-consumer exception.

> **Amendment (2026-11-14) — live User state.** The hosted shell requires a `DB`
> binding to the same Kit authentication database as the API and checks the
> User's live account state through `@kit/auth` on identity resolution, every
> authenticated MCP request, and every code or refresh exchange. Disabled,
> missing or unreadable state is refused. This is independent of the optional
> `grantAdmission` policy: omitting that predicate no longer omits the
> account-state check. Existing hosted Apps must add the database binding and
> apply the account-state schema migration before upgrading. An in-flight
> operation admitted before a concurrent disable may still complete.

The provider in `@kit/mcp/hosted` is the authorization server. It issues
resource-bound MCP tokens containing human identity only, not organization,
module grants or spend authority. Browser logout does **not** revoke MCP grants.
Refresh tokens, if issued, renew the same revocable grant.

Only `mcp` is granted; plain PKCE, implicit flow and token exchange are off.
Errors redirected to a client wait for identity authentication (RFC 9700
§4.11.2). Implementation and token lifetime options:
`packages/mcp/src/hosted/create-worker.ts`, `packages/mcp/src/hosted/authorize.ts`
and `packages/mcp/README.md`.

The optional `grantAdmission` predicate is deny-only and receives a
provider-verified grant tuple. It cannot mint or alter identity, scope, audience,
TTL or consent, and does not authorize individual tools. It runs on authenticated
requests and code or refresh exchanges, not on authorization or revocation.
Caller hooks with `OAUTH_KV` access are trusted code: KV write access can mint grants.

A refusal on exchange revokes the grant; a refusal on `/mcp` does not.
An undecidable predicate must throw rather than return `false`, so unavailability
blocks without being mistaken for invalid credentials or revoking the grant.
A client whose grant is revoked must authorize again. Implementation and exercised outcomes:
`packages/mcp/src/hosted/create-worker.ts` and
`packages/mcp/src/hosted/grant-admission.test.ts`.

**Non-claims.** Admission is not atomic with issuance. A request or exchange
admitted before a concurrent denial is visible can complete, including a
refresh that re-saves the grant. Later requests and exchanges consult the
predicate again, so a denial keyed on user and grant prevails while it lasts.
For targeted revocation, that denial must last until no code, access token or
refresh token of the grant can still be redeemed, including credentials a
concurrent refresh re-saved. Absence of the grant record alone is not proof of
cleanup. One Product consumer keeps its barrier without a TTL (D8), but the seam
does not require every refusal to have a permanent denial. The caller owns the denial's
storage and consistency; provider revocation is KV-strength, not atomic.

### D3 — Identity port never mints

`McpIdentityPort.resolve` answers “who is the human?” or returns a **redirect Response** to existing Better Auth login. Kit adapter: session-gated one-time **identity ticket** on `example-api` (hashed, TTL seconds). The ticket is not an MCP access token, not a BA cookie, not a Google AT.

The ticket's User is checked again when redeemed; a ticket minted before disablement cannot establish a new hosted identity afterwards.

The identity port resolves identity only; the authorization server mints.
Products may plug another resolver without forking the authorization server.
Implementation: `apps/mcp-example/src/identity-port.ts` and
`packages/mcp/src/hosted/authorize.ts`.

### D4 — CIMD preferred; DCR localhost/dev only

CIMD is preferred. Production-shaped hosts refuse open DCR; localhost/dev may
use it. Implementation: `packages/mcp/src/hosted/host-policy.ts`.

### D5 — Consent is a caller policy, default always-show

> **Amendment (2026-11-07) — presentation only.** Adds optional `consentPresentation` independently of `consent`. Omission preserves the existing English consent-page behavior; it does not change whether consent is required.

> **Amendment (2026-11-09) — consent unchanged by `grantAdmission`.** The D2 admission seam never runs on `/authorize`: it cannot show, skip or force this page, and it changes no consent record, cookie, CSRF check, redirect-class warning or Deny redirect. A user can therefore Allow and the client still receive `invalid_grant` at the code exchange, which revokes that new OAuth grant.

Consent presentation is static data, independent of consent policy. Product
disclosures describe Product policy, not enforcement. Branding assets must be
trusted static images served directly, not user-controlled or redirected.
Presentation cannot override OAuth policy, identity, warnings or security
controls; no renderer, callbacks, CSS, external URLs or form overrides.
Implementation and options: `packages/mcp/src/hosted/presentation.ts`,
`packages/mcp/src/hosted/consent.ts` and `packages/mcp/README.md`.

Consent defaults to always-show. A self-declared CIMD client always sees the
page. Skip is allowed only on a positive product-registration receipt; a missing
or not-yet-visible receipt shows the page. KV eventual consistency can therefore
temporarily show consent after registration. Clients registered only through
bare `createClient` must be re-registered through `createProductClient` for skip.
Demo-loopback skips only for the caller-declared email on a loopback,
non-production host. Its drive-by risk is accepted for that demo account only;
the email is not a package default.

**Non-claim:** single use is best effort at KV strength. KV get→delete is not
atomic and a delete can take 60 seconds or more to appear elsewhere. A holder
of both cookie and page CSRF can replay inside that window, but only for the
same client, redirect URI and PKCE challenge; only the original PKCE-verifier
holder can redeem. This is the provider's authorization-code redemption
strength on KV. Implementation: `packages/mcp/src/hosted/consent.ts`.

### D6 — Hosted tools sit behind the provider

The provider guards stateless hosted tools; unauthenticated or unadmitted
requests execute none. `register` and effect/auth annotations are not
authorization points; grant admission refuses whole grants, not individual
tools. Connect ≠ spend; organization is not on the token (ADR-0003).
Reserved paths cannot fall through to product routes. Cloudflare Access must
exclude every reserved path. Implementation:
`packages/mcp/src/hosted/create-worker.ts` and
`packages/mcp/src/hosted/host-policy.ts`.

### D7 — Hosted whoami polarity

Stdio `whoami` verifies an `sk_` subject through the API; hosted `whoami`
uses MCP token identity. Missing hosted identity must not leak an `sk_`.
Implementation: `apps/mcp-example/src/index.ts` and
`apps/mcp-example/src/create-mcp-worker.ts`.

### D8 — Shell is `@kit/mcp/hosted`

The optional `@kit/mcp/hosted` subpath owns the authorization-server shell;
there is no separate `@kit/mcp-oauth` package. Products compose the shell
rather than copy provider construction. Stdio importers need not load hosted
peers. Identity, tools and product routes remain caller-owned.
Implementation and options: `packages/mcp/src/hosted/create-worker.ts` and
`packages/mcp/README.md`.

The static `consentPresentation` seam has a bounded second-consumer basis:
dogfood's English presentation and one Product consumer's French informative page.
This does not claim two external Products, adoption of the option or deployment.
Product copy stays Product-owned.

The owner authorized a separate exception to the second-consumer condition for
the deny-only `grantAdmission` seam alone. One evidenced Product consumer checks
requests and exchanges to implement its Product-owned barrier.
No second Product with that barrier was found in the inspected trees; this says
nothing about other trees. The barrier and its storage remain Product-owned.
Tests, fixtures and dogfood prove behavior, not consumer provenance.

A further, separate owner exception covers only the `isReservedPath` export.
One Product's planned single-Worker containment needs to refuse reserved paths
before delegation without duplicating classification; this is not a claim of
an implemented consumer or deployment. A caller may refuse early, but must
never implement OAuth or MCP or serve SPA content on a reserved path.

Neither exception waives the second-consumer gate for another seam or policy,
relaxes this ADR's controls, or authorizes publication, Product inheritance or
deployment. Those retain their own authorizations. A new seam or policy still
requires an ADR-0015 amendment and a second consumer.

> **Amendment (2026-11-25) — hosted Organization dispatch** (go-silex/unkillable-kit#181).
> A third owner exception covers only the opt-in
> [ADR-0025 D3](./0025-request-authorization-snapshot.md#d3--credential-selection-and-verification)
> tool-input Organization selection seam. Common MCP clients fix headers per server connection,
> so serving several Organizations over one connection, or keeping tools that already name their
> Organization, requires scoping each call in its arguments. One Product needs this today to keep
> its tool contract; the Kit's tests prove behavior, not a second consumer. The exception adds no
> OAuth grant or consent policy, and changes
> no provider ownership, token claim or scope. The limits of the previous paragraph apply.

A dedicated Worker is optional; trusted `fallthrough` may co-locate the shell.
It is neither a sandbox nor an authorization point and never receives reserved
paths. A co-located compose must preserve the product's other Worker handlers.

Co-location puts the consent page on the product origin. Any script that runs there (an XSS, user-supplied HTML, a third-party script) can fetch the page, read its CSRF and post Allow for the signed-in user, minting an MCP OAuth grant that outlives the browser session. A product origin that serves user content or third-party script uses a dedicated Worker on its own origin.

A deployed Worker serves OAuth only on its configured `MCP_PUBLIC_URL` origin.
Every deployed compose sets `ENVIRONMENT` to production or staging and sets
`MCP_PUBLIC_URL` to its public HTTPS origin; otherwise a loopback-looking host
can activate development policy. Bind `OAUTH_KV` and the authentication `DB`.
CIMD requires `global_fetch_strictly_public` as its SSRF guard.
Configuration and reserved-path behavior: `packages/mcp/src/hosted/host-policy.ts`
and `packages/mcp/src/hosted/create-worker.ts`.

One dogfood app has two transports; do not add a second example app
(ADR-0009 allowlist). The caller seams and deploy inputs remain bounded to
those documented in `packages/mcp/README.md` and the code above.
An executed Worker proof with real consent, PKCE, refresh, targeted refusal and
recovery is required before any end-to-end claim. Independent review remains
required; source observations are not executed tests or hosted smoke results.

### D9 — Stdio smoke ≠ OAuth

The probe implementation is `apps/mcp-example/scripts/stdio-smoke.mjs`.

`bun run smoke:mcp` (`CP-MCP-SMOKE`) stays the stdio JSON-RPC probe and does not claim HTTP or OAuth. Hosted connect is **CP-MCP-HTTP-OAUTH**.

## Anti-patterns

- Token passthrough (Google AT or BA cookie as MCP Bearer)
- FastMCP OAuth-login provider as the MCP resource AS
- Resurrecting HMAC sessions
- Organization, module grants, or spend on the MCP token
- Empty `@kit/mcp-oauth` stub without dogfood
- Cloudflare Access in front of `/mcp` (blocks the handshake)
- Open DCR on a production-shaped host
- Auto-approving every localhost user, or baking `demo@kit.local` into the package
- Copying `OAuthProvider` construction into a product instead of calling `@kit/mcp/hosted`
- Returning `false` from `grantAdmission` when the answer is unknown (it revokes the OAuth grant), or using it to authorize tools
- Overloading `smoke:mcp` to “prove OAuth”
- Pasted JWT / `--header` connect as the hosted path

## Consequences

- Claude Code / Cursor can `claude mcp add --transport http … /mcp` against local `wrangler dev` without a JWT paste.
- Products call `createHostedMcpWorker` and plug `McpIdentityPort`. They do not copy the provider wiring, and they do not copy Google/Workspace secrets into this repo.
- A Product that must refuse a revoked OAuth grant on both requests and token exchanges passes `grantAdmission` instead of copying provider construction.
- Local hosted dogfood is enough to close; a public showcase hostname is not required.

## Refs

- MCP Authorization 2025-11-25
- RFC 8414, RFC 9728, RFC 7591, RFC 7636 (PKCE)
- [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
- Kit issue Roxabi/roxabi-boilerplate-cf#240
