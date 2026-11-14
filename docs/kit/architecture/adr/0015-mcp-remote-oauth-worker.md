---
title: 'ADR-0015 — Remote MCP uses Streamable HTTP + Worker-issued OAuth tokens'
status: accepted
normative: true
date: 2026-09-16
amended: 2026-11-09
supersedes_notes: >
  The current decision incorporates the 2026-10-24 hosted-shell, consent-policy,
  provider 1.2 and configured-origin decisions, the 2026-11-07 static
  consentPresentation seam with escaped plain text and Kit-owned English/French
  labels, and the 2026-11-09 optional deny-only grantAdmission seam for OAuth
  grants, admitted under an owner-authorized single-consumer exception. Consent
  policy, identity props, minting, scopes and TTLs are unchanged; a refused code
  exchange or refresh now makes the provider revoke that OAuth grant.
axial: false
related:
  - docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md
  - docs/kit/architecture/adr/0002-session-hmac-interim-vs-better-auth.md
  - docs/kit/architecture/adr/0003-multi-tenant-rbac-modules.md
  - docs/kit/standards/stack.md
  - docs/kit/testing.md
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

| Class        | Surface                       | Credential                         | Notes                      |
| ------------ | ----------------------------- | ---------------------------------- | -------------------------- |
| Browser SPA  | `example-web` → `example-api` | Better Auth `kit_session` cookie   | ADR-0002 D1                |
| Machine HTTP | `example-api`                 | Bearer `sk_`                       | Organization-bound API key |
| Remote agent | hosted `/mcp`                 | **Worker-issued MCP access token** | this ADR                   |

Do not present a BA cookie or Google access token as MCP Bearer. Do not use `sk_` as MCP OAuth. HMAC sessions stay retired (ADR-0002 D2).

### D2 — Worker-issued token only

> **Amendment (2026-11-09) — deny-only OAuth grant admission.** Adds the optional `grantAdmission` seam described below. It can only refuse an existing OAuth grant, on an authenticated `/mcp` request, an authorization-code exchange or a refresh; it mints nothing and changes no identity props, scope, audience or TTL. Omission keeps every other behavior of this decision. D8 records the owner authorization and its bounded second-consumer exception.

`@kit/mcp/hosted` composes `@cloudflare/workers-oauth-provider` (`OAUTH_KV`) in the caller's App; the provider is the authorization server. `completeAuthorization()` mints the OAuth grant. Token props are **human identity only**: `userId` + optional `email`. Audience = `<MCP_PUBLIC_URL>/mcp` (D8). Access-token lifetime is 8 hours (`ACCESS_TOKEN_TTL_SECONDS`). `refreshTokenTTL` is optional; omitting it keeps the provider default (30 days in `@cloudflare/workers-oauth-provider` 1.2). A set value is `0` (no refresh tokens) or an integer of at least 60 seconds; the shell throws on any other when created. Tokens are revocable (present the token to the token/revocation endpoint; revoke the OAuth grant; wipe `OAUTH_KV`), and a `grantAdmission` refusal at `/token` also revokes the OAuth grant. Browser logout does **not** revoke MCP OAuth grants.

Refresh tokens, if issued, renew the **same** OAuth grant and remain killable.

Only `mcp` is granted. Any other requested scope redirects with `error=invalid_scope` and the request `state`. Every error bound for `redirect_uri` (`invalid_scope`, or a request error the provider ties to a redirect) leaves only after the identity port authenticates the user (RFC 9700 §4.11.2); before that the port's response wins. An error with no redirect target answers `400`. Plain PKCE, implicit flow and token exchange are off. CIMD is on.

**OAuth grant admission.** `HostedMcpWorkerOptions` accepts an optional predicate, typed inline with no new export:

```ts
grantAdmission?: (
  input:
    | { phase: 'request'; userId: string; grantId: string; clientId: string }
    | {
        phase: 'token'
        grantType: 'authorization_code' | 'refresh_token'
        userId: string
        grantId: string
        clientId: string
      },
  env: Env,
) => Promise<boolean>
```

Only an absent or `undefined` option means omitted; any other value that is not a function makes `createHostedMcpWorker` throw a `TypeError` at construction. The factory snapshots the function at construction; replacing the option afterwards changes nothing. Its `env` is the request's env without `OAUTH_PROVIDER`, like every caller seam. That env still holds `OAUTH_KV`, so the predicate is trusted code (D5); the seam itself only returns a decision. The input is the provider-verified OAuth grant tuple and nothing else: no token, props, scope, resource, TTL, request or OAuth helper, and no value read from request headers, query, body or client metadata. The seam offers no way to mint, change props, scope or TTLs, or rewrite the request.

- **Token phase.** Only when `grantAdmission` is set does the shell give the provider a `tokenExchangeCallback`. Provider 1.2.4 calls it for `authorization_code` and `refresh_token` after its own checks (client identification; code or refresh-token hash and client binding; PKCE and redirect URI for a code; expiry for a refresh; resource and scope) and before it saves the OAuth grant or writes a token. The provider's own refusals come first and are unchanged: a replayed code revokes its OAuth grant natively, and a record bound to another resource is refused. The tuple is the callback's own `userId`, `grantId` and `clientId`. On `true` the shell returns nothing, so the provider issues the props, scope, audience and TTLs it would issue without the seam. Token exchange stays disabled, so no other grant type reaches the predicate.
- **Request phase.** On `/mcp`, after the provider authenticates the bearer token and the existing identity check passes, the shell unwraps the provider-authenticated token (`ctx.auth.token`) with the public `unwrapToken` helper. The tuple is that summary's `userId`, `grantId` and client. The summary must exist, its `userId` must equal both the normalized token identity (`ctx.props`) and `ctx.auth.userId`, and its client must equal `ctx.auth.clientId`; otherwise the request is refused as for `false`, and an unwrap that throws answers as unavailable. Admission runs before `register`. Without `grantAdmission` the shell unwraps nothing.

| Predicate result                                           | `/mcp` request                                                                                                                                                                                                                                                                                                               | Code exchange or refresh                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true`                                                     | continues unchanged to `register`                                                                                                                                                                                                                                                                                            | issued with the props, scope, audience and TTLs it would have without the seam                                                                                                                                                                                                                                                                                                                                                                 |
| `false`                                                    | `401` with a Kit-generated `invalid_token` Bearer challenge in the provider's format (`resource_metadata` naming `/.well-known/oauth-protected-resource/mcp`, `scope="mcp"`) and `Cache-Control: no-store`, zero tools; nothing revoked. Its body and other headers are not the provider's (no JSON error body, no `Pragma`) | `400` `invalid_grant`, no token: the shell throws `OAuthError('invalid_grant')`, and the provider revokes that OAuth grant and its tokens before answering                                                                                                                                                                                                                                                                                     |
| throw (an `OAuthError` included), rejection or non-boolean | `503`, `Cache-Control: no-store`, no Bearer challenge, zero tools                                                                                                                                                                                                                                                            | `503` `temporarily_unavailable`, `Cache-Control: no-store`: the shell throws `OAuthError('temporarily_unavailable', { statusCode: 503 })`; no OAuth grant or token is saved, issued or revoked. Provider writes made before the callback stay, such as a `private_key_jwt` client's assertion `jti` replay marker, so a retry needs fresh valid client authentication; it can then redeem the same code (within its lifetime) or refresh token |

`false` is terminal for that OAuth grant. Its next code exchange or refresh revokes it through the provider's own `invalid_grant` path; a failed revocation is logged and still answers `invalid_grant`. The client must then authorize again, which mints a new OAuth grant that the predicate judges on its own. A predicate that cannot decide throws rather than return `false`: unavailable keeps the OAuth grant and never passes for invalid credentials. `true` widens nothing: the provider's checks and D6 still refuse what they refuse.

**Non-claims.** Admission is not atomic with issuance. A request or exchange admitted before a concurrent denial is visible can complete, including a refresh that re-saves the OAuth grant; each later request and exchange of that OAuth grant consults the predicate again, so a denial keyed on `userId` and `grantId` prevails while it lasts. For a targeted revocation, that denial must last until no code, access token or refresh token of that OAuth grant can still be redeemed, including credentials a concurrent refresh re-saved; the absence of the provider's OAuth grant record alone is not proof of cleanup. Ether OS keeps its barrier without a TTL (D8), which is one way to meet this; the seam does not require every `false` to be backed by a permanent denial. The denial's storage and consistency belong to the caller, and the provider's revocation is KV-strength (list, then delete). Admission never runs on `/authorize`, consent, minting or token revocation (RFC 7009), and it is not a tool authorization point (D6): it refuses whole OAuth grants only. The shell adds no timeout, retry or cache; with the seam set, each `/mcp` request adds one `OAUTH_KV` token read and the predicate.

### D3 — Identity port never mints

`McpIdentityPort.resolve` answers “who is the human?” or returns a **redirect Response** to existing Better Auth login. Kit adapter: session-gated one-time **identity ticket** on `example-api` (hashed, TTL seconds). The ticket is not an MCP access token, not a BA cookie, not a Google AT.

`identityPort` may be a port or a per-request `(env) => port`; that function and `apiBaseUrl(env, request)` receive an env without `OAUTH_PROVIDER`. `apiBaseUrl` passes verbatim to `identityPort.resolve`. The identity port resolves identity only; the authorization server mints. `userId` must be non-empty and contain no `:` (provider OAuth grant keys use `grant:<userId>:…`), otherwise `/authorize` returns `500`. Products may later plug another resolver (e.g. Google). They do not fork the authorization server in this repository.

### D4 — CIMD preferred; DCR localhost/dev only

`clientIdMetadataDocumentEnabled: true`. `clientRegistrationEndpoint` is advertised only when the host is not production-shaped (`ENVIRONMENT=production|staging` or a non-loopback host). Production-shaped dogfood refuses open DCR; CIMD still works.

### D5 — Consent is a caller policy, default always-show

> **Amendment (2026-11-07) — presentation only.** Adds optional `consentPresentation` independently of `consent`. Omission preserves the existing English consent-page behavior; it does not change whether consent is required.

> **Amendment (2026-11-09) — consent unchanged by `grantAdmission`.** The D2 admission seam never runs on `/authorize`: it cannot show, skip or force this page, and it changes no consent record, cookie, CSRF check, redirect-class warning or Deny redirect. A user can therefore Allow and the client still receive `invalid_grant` at the code exchange, which revokes that new OAuth grant.

`HostedMcpWorkerOptions` accepts `consentPresentation?: ConsentPresentation`. The type is exported only from `@kit/mcp/hosted`:

```ts
export type ConsentPresentation = {
  readonly locale?: 'en' | 'fr'
  readonly serviceName?: string
  readonly disclosures?: readonly { readonly label: string; readonly text: string }[]
}
```

The factory snapshots this static caller data once at construction, including disclosure entries, so subsequent caller mutation cannot change the pages. Presentation is not persisted in consent records, OAuth grants or tokens. An omitted locale means `en`; `fr` selects Kit-owned protocol/security labels. There is no request-language negotiation, switcher, new i18n framework or dependency. General error localization is outside this seam.

The service name and every disclosure label/text are escaped plain text, never Markdown or HTML. The option accepts no renderer, callbacks, links, CSS, form attributes or security-label overrides. Kit retains the authenticated identity, client ID and actual redirect facts, redirect-class warnings, fixed `/authorize` action, CSRF, Allow/Deny controls and response headers.

UI content carries no authority: disclosures cannot change identity, scopes, PKCE, CSRF, consent policy, TTLs or minting. Duration or revocation prose must describe the caller's actual policy; it does not configure or enforce it. This amendment adds no revocation hooks.
The shell does not auto-approve. `consent` defaults to `always`: it shows a page naming the client's `client_name`, its `client_id`, the `redirect_uri` scheme and host, and one warning for the redirect class: a program on this computer (dotted `127.0.0.0/8`, `[::1]`, IPv4-mapped `127.0.0.0/8`, `localhost`, `*.localhost`) or a custom-scheme app. A remote https redirect gets none; an http redirect off the provider's loopback hosts never reaches the page. The page sends `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Cache-Control: no-store`, and `Referrer-Policy: no-referrer`.

Provider 1.2 refuses cleartext HTTP redirects other than `localhost`, dotted `127.0.0.0/8` and `[::1]`, returning a local `400` before identity or consent. The shell enables `allowPrivateUseRedirectUris` for custom-scheme native apps.

A URL `client_id` (CIMD, self-declared) always gets the page, in every mode. `skip` omits it only when a positive product-registration receipt is visible for that client. Products obtain the receipt through `createProductClient` (public `OAuthHelpers.createClient` plus a package-owned `OAUTH_KV` key). Open DCR and bare `createClient` write no receipt. A missing or not-yet-visible receipt shows the page: absence never means product-registered, including under Cloudflare KV eventual consistency and cached negative lookups. Temporary consent while a just-written receipt propagates is expected. Existing clients registered only with bare `createClient` must be re-registered through the helper before `skip` applies. `{ mode: 'demo-loopback', email }` omits the page only for that email on a loopback, non-production host, for any client registered there; that drive-by risk is accepted for the demo account only. Dogfood passes `{ mode: 'demo-loopback', email: 'demo@kit.local' }`; that email is not a package default. In every mode the identity port resolves identity only; the authorization server mints.

The consent record lives in `OAUTH_KV` for 10 minutes and is found only through an HttpOnly, SameSite=Lax cookie. Loopback uses `mcp_consent_id; Path=/authorize`; elsewhere only `__Host-mcp_consent_id; Secure; Path=/` is read. The record holds identity, CSRF, the GET-validated authorization request, and granted scope. Its POST ignores its own query, compares CSRF in constant time, deletes the record before completion, and clears the cookie (`Max-Age=0`): consent stays bound to the client, redirect URI, and PKCE challenge that the user saw. Deny redirects `error=access_denied` to that client. `OAUTH_KV` write access can mint OAuth grants, so caller hooks that hold it are trusted code.

**Non-claim:** single use is best effort at KV strength. KV get→delete is not atomic and a delete can take 60 seconds or more to appear elsewhere. A holder of both cookie and page CSRF can replay inside that window, but only for the same client, redirect URI, and PKCE challenge; only the original PKCE-verifier holder can redeem. This is the provider's own authorization-code redemption strength on KV. `/authorize` accepts GET and POST only; another method is `405`.

### D6 — Hosted tools sit behind the provider

`EdgeFastMCP` (`fastmcp/edge`) serves tools at `/mcp` as the provider `apiHandler`. The dogfood catalogue is `ping` / `whoami` only. `register` runs for every authenticated `/mcp` request because EdgeFastMCP is stateless, and with `grantAdmission` set only after the request is admitted (D2); it receives token identity `{ userId, email? }` and an env without `OAUTH_PROVIDER`, and tools close over that identity. It uses no AsyncLocalStorage and the shell needs no `nodejs_compat`. `register` and `effect` / `auth` annotations are never authorization points; `grantAdmission` refuses whole OAuth grants and never authorizes a tool. Connect ≠ spend; organization is not on the token (ADR-0003).

Unauthenticated `/mcp` executes **zero** tools and looks like MCP OAuth (`401` + `WWW-Authenticate` `resource_metadata` naming `/.well-known/oauth-protected-resource/mcp`). A request that `grantAdmission` refuses gets a Kit-generated `401` challenge with the same `resource_metadata` and `error="invalid_token"`, and one it cannot decide gets `503`; neither executes a tool. Unknown MCP methods fail closed. Reserved paths never reach `fallthrough`: `/mcp` as a prefix (`/mcp-admin` is `404`), `/authorize`, `/token` (including revocation), `/register` (closed DCR is `403` `access_denied` and shadows a product signup route), and `/.well-known/oauth-*`. Their percent-encoded, trailing-slash, and doubled-slash forms are `404`. On an origin other than the configured one, reserved paths answer `404` and other paths still reach `fallthrough`; a missing or unusable `MCP_PUBLIC_URL` (D8) makes the reserved paths `500`. Cloudflare Access must exclude every reserved path.

### D7 — Hosted whoami polarity

| Path        | Identity              | `verified` means     |
| ----------- | --------------------- | -------------------- |
| stdio       | `sk_` → `GET /api/me` | subject parse OK     |
| hosted HTTP | MCP token props       | MCP identity present |

Missing hosted identity → domain status `missing_identity`, never a leaked `sk_`.

### D8 — Shell is `@kit/mcp/hosted`

> **Amendment (2026-11-07) — bounded consent presentation.** Adds only the static `consentPresentation` seam and its `ConsentPresentation` type (D5). For this narrow amendment, the second-consumer condition is supported by the two evidenced presentation cases below, not by claiming two external Products or prior adoption of the new option.

> **External rationale — source observations, not Kit defaults or deployment proof.** The existing [dogfood compose](../../../../apps/mcp-example/src/create-mcp-worker.ts) uses the default English presentation whenever its independent `demo-loopback` policy shows the page. The external Product Ether OS has a [French informative consent page](https://github.com/go-silex/extern-client-etherOs/blob/99bde5a03771bd38c7d1c54ef55d9d453e8ce923/apps/ether-mcp/src/consent-page.ts#L175-L193) explaining role-bound reads/writes, transfer of results to the AI provider, durations and revocation. These two existing presentation cases motivate this data-only seam. Product copy stays Product-owned. This is not a claim that Ether OS already imports the option or that new code is deployed; publication, inheritance and deployment require their own authorizations.

> **Amendment (2026-11-09) — deny-only `grantAdmission` under a bounded owner exception.** Adds only the optional `grantAdmission` seam (D2) and no export. On 2026-11-09 the owner explicitly authorized this one exception to the second-consumer condition. One Product consumer is evidenced, Ether OS (below). No second Product with the same request-and-exchange barrier was found in the inspected trees; that search says nothing about other trees. Kit tests, fixtures and the dogfood App are proof of behavior, never a consumer. The exception covers this seam alone. It waives the condition for no other seam or policy, relaxes no control of this ADR (consent policy and page, the same-origin rule below, reserved paths, identity props, scopes, TTLs), and authorizes no publication, Product inheritance or deployment, which keep their own authorizations.

> **External rationale — source observations, not Kit defaults or deployment proof.** Ether OS refuses both the requests and the token exchanges of an OAuth grant it has revoked, inside its own provider construction: a [per-request check](https://github.com/go-silex/extern-client-etherOs/blob/2bc7b17d2ee5f1da06c482871a73f827b5c4dc95/apps/ether-mcp/src/create-mcp-worker.ts#L62-L95) and a [pre-issuance `tokenExchangeCallback`](https://github.com/go-silex/extern-client-etherOs/blob/2bc7b17d2ee5f1da06c482871a73f827b5c4dc95/apps/ether-mcp/src/create-mcp-worker.ts#L118-L122). Its [decision D-108](https://github.com/go-silex/extern-client-etherOs/blob/8a30d413e6cb2848e13fa96248a27b57489ac47b/docs/product/decisions.md#L1023-L1028) requires that refusal once the barrier is visible, even after a concurrent refresh has re-saved the OAuth grant, and requires a failed barrier read to block without passing for invalid credentials. The shell gives `register` no OAuth grant id and the provider no `tokenExchangeCallback`, so that Product cannot compose the shell with its barrier without this seam. The barrier's marker and storage stay Product-owned. This is not a claim that Ether OS already imports the option or that new code is deployed.

> **Amendment (2026-11-09) — public reserved-path classifier under a separate bounded owner exception.** The owner explicitly authorized an exception to the second-consumer condition for the `isReservedPath` export alone. Ether OS's planned single-Worker integration needs to refuse all hosted OAuth and MCP paths before delegation during an operational containment event, without duplicating Kit's path classification. This is a requirement for a planned integration, not a claim of an implemented consumer or deployment. No second consumer is claimed; Kit tests, fixtures and dogfood are behavioral evidence, not consumer provenance. This exception is separate from the `grantAdmission` exception, waives no gate for future seams or policies, relaxes none of this ADR's same-origin, identity, consent or grant controls, and authorizes no publication, Product inheritance or deployment.

No `@kit/mcp-oauth` package. The authorization-server shell is the optional subpath `@kit/mcp/hosted` (`createHostedMcpWorker`). The dogfood and two product composes each held a copy before promotion (ADR-0001 three-strikes). Callers use `createHostedMcpWorker({ name, version?, register(server, { identity, env }), identityPort, apiBaseUrl(env, request), consent?, consentPresentation?, refreshTokenTTL?, grantAdmission?(input, env), fallthrough? })`; they do not copy `OAuthProvider` construction. The only subpath exports are `createHostedMcpWorker`, `createProductClient`, `HostedMcpWorker`, `HostedMcpWorkerOptions`, `ConsentPolicy`, `ConsentPresentation`, `Fallthrough`, `HostedMcpEnv`, `IdentitySource`, `ACCESS_TOKEN_TTL_SECONDS`, and `isReservedPath`.

The subpath peers are optional (`@cloudflare/workers-oauth-provider`, `fastmcp`). A stdio-only importer of root `@kit/mcp` loads neither peer; a hosted importer declares them. A separate `apps/<product>-mcp` Worker is optional: use a dedicated Worker or front the product Worker through trusted `fallthrough`. `fallthrough` is not a sandbox or authorization point; it receives unchanged `ctx` and an env without `OAUTH_PROVIDER`, and omission is `404`. It never receives reserved paths. The shell is a `fetch`-only handler: a co-located compose exports `{ ...productWorker, fetch: hosted.fetch }` so the product's `queue`, `scheduled` and other handlers survive.

`isReservedPath(pathname: string): boolean` is the shell's existing pure classifier, not a new caller seam or deploy input. Pass `new URL(request.url).pathname`: it decodes once, treats malformed encoding as reserved, collapses runs of slashes and strips trailing slashes, then matches the `/mcp` prefix, exact `/authorize`, `/token` and `/register`, or the `/.well-known/oauth-` prefix. A caller may refuse a reserved path before `hosted.fetch`; it must never implement OAuth or MCP or serve SPA content on that path. Such an early refusal can precede and replace the shell's off-origin or configuration error response. Otherwise delegation and the hosted shell remain unchanged; the same-origin rule and all identity, consent and grant controls continue to apply.

Co-location puts the consent page on the product origin. Any script that runs there (an XSS, user-supplied HTML, a third-party script) can fetch the page, read its CSRF and post Allow for the signed-in user, minting an MCP OAuth grant that outlives the browser session. A product origin that serves user content or third-party script uses a dedicated Worker on its own origin.

Identity resolution, the tool catalogue, and product routes stay with the caller. The factory mints nothing from the plan body, the client, or the agent. The provider caches its helper on env; the shell supplies a per-request env copy. A deployed Worker serves OAuth on its `MCP_PUBLIC_URL` origin only. Without that setting, only a loopback development host serves OAuth on its own origin. One dogfood app, two transports. Do not add a second example app (ADR-0009 allowlist).

Every deployed compose sets `ENVIRONMENT` to `production` or `staging`; an unset value plus a loopback-looking URL activates development policy (DCR open and `demo-loopback` active). Every deployed compose also sets `MCP_PUBLIC_URL` to its public https origin, with MCP at `<origin>/mcp`. Unset, only a loopback development host serves OAuth, on its own origin. A value that is neither an https origin nor an http one on a loopback host is a configuration error: like a missing one, it answers `500` on the reserved paths and leaves product routes alone. Bind `OAUTH_KV`. CIMD also requires `global_fetch_strictly_public`: without it an HTTPS `client_id` fails with `500`, and the flag is the SSRF guard.

Framework guard: the caller seams are exactly `identityPort`, `apiBaseUrl`, `register`, `consent`, `consentPresentation`, `refreshTokenTTL`, `grantAdmission`, and `fallthrough`, and the deploy inputs are `ENVIRONMENT`, `MCP_PUBLIC_URL`, `OAUTH_KV`, and the `global_fetch_strictly_public` flag. `consentPresentation` is limited to D5's static data, not a renderer or authority hook. `grantAdmission` is limited to D2's deny-only predicate, not a token, props, scope, TTL or minting hook. A new seam or policy still requires an ADR-0015 amendment and a second consumer; neither the presentation-case evidence nor either separately scoped 2026-11-09 owner exception waives that gate for future changes.

Targeted proof must cover omitted-English compatibility, French informative presentation, hostile-text escaping and construction-time snapshot isolation while preserving the existing consent and OAuth controls. For `grantAdmission` it must cover omission compatibility; unchanged provider PKCE and bearer checks when the predicate allows; a refused request that registers and executes nothing; separate code and refresh refusals that issue no token and revoke only the targeted OAuth grant; unavailable answers that issue and revoke no OAuth grant or token, leave the code redeemable and recover on a later retry with valid client authentication; a non-boolean result treated as unavailable; the construction-time snapshot; and the provider-verified tuple, never request headers, with an env lacking `OAUTH_PROVIDER`. An executed Worker proof with real consent, PKCE, refresh, targeted refusal and recovery is required before any end-to-end claim. Independent review remains required; source observations are not executed tests or hosted smoke results.

### D9 — Stdio smoke ≠ OAuth

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
