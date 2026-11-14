# `@kit/mcp`

Kit MCP conventions around FastMCP: **ToolCatalogue**, public Zod shapes, agent wire SSOT, and fail-closed execute wrap (input budget + public tool errors).

## Add a tool (product pattern)

```ts
import { createToolCatalogue, toolRefusal, type ToolDef } from '@kit/mcp'
import { FastMCP } from 'fastmcp'
import { z } from 'zod'

const input = z.object({ q: z.string().optional() })
const myTool: ToolDef = {
  name: 'my_tool',
  description: 'Example kit-style tool',
  input,
  effect: 'read', // descriptive only — NOT authorization
  auth: 'none', // descriptive only — NOT authorization
  execute: async (args) => {
    const { q } = input.parse(args)
    if (!q) return toolRefusal({ code: 'QUERY_REQUIRED' })
    return { ok: true, q }
  },
}

const catalogue = createToolCatalogue([myTool] as const)
const server = new FastMCP({ name: 'my-mcp', version: '0.0.1' })
catalogue.registerAll(server) // sole registration path
// smoke expected set: catalogue.names
```

## Effect / auth annotations

`effect` and `auth` on `ToolDef` are **descriptive hints for agents/docs only**.  
`registerAll` does **not** branch on them for authorization. Real auth remains in the handler and API (Bearer `sk_…`).

Do not carry that intuition into `@kit/flows`: its registry field `grantClass` **is** authority —
`grantClass: 'mintable'` is what `mintCapabilityGrant` puts in a Capability Grant ceiling. The two
fields are named apart for that reason (Roxabi/roxabi-boilerplate-cf#243).

## Tool results and errors

Return `toolRefusal(payload)` from `execute` for an explicit domain refusal. The tool author is
responsible for supplying a client-safe JSON object; `ToolRefusal` is the exported opaque result
type. `registerAll` sends the same serialized data as MCP `isError: true` in both
`structuredContent` and JSON text. A refusal bypasses the tool's success `output` schema.
Never include secrets or internal exception details in the payload.

Ordinary results, including `{ ok: false }`, are not implicitly classified as refusals: they
remain successes and are validated against `output` when present. Existing `whoami` status
results remain in this ordinary domain channel. Unexpected throws use the fixed public
infrastructure error mapping; do not encode domain refusals as infrastructure codes.

The catalogue validates successful output locally but does not advertise it as an MCP
`outputSchema`: MCP clients may validate structured refusals against an advertised schema even
when `isError` is true. Do not register that success schema as an MCP output schema without
addressing this distinction.

Both stdio and hosted Edge registrations use this same catalogue seam. Apps using FastMCP must
declare `fastmcp` at `^4.23.8` or a compatible newer version; older Edge releases do not forward
the error flag. `effect` and `auth` remain descriptive, never authorization.

## Wire SSOT

Import budgets, env key names, whoami status enum, and public error codes from `@kit/mcp` (`agentWire` / barrel). Do not re-declare stringly constants in apps.

## Hosted shell

`@kit/mcp/hosted` is the optional Worker authorization-server shell ([ADR-0015](../../docs/kit/architecture/adr/0015-mcp-remote-oauth-worker.md) D8). Its only exports are `createHostedMcpWorker`, `createProductClient`, `HostedMcpWorker`, `HostedMcpWorkerOptions`, `ConsentPolicy`, `ConsentPresentation`, `Fallthrough`, `HostedMcpEnv`, `IdentitySource`, and `ACCESS_TOKEN_TTL_SECONDS`. Declare `@cloudflare/workers-oauth-provider` and `fastmcp` in the App that imports this subpath. Root `@kit/mcp` loads neither peer.

```ts
import { createHostedMcpWorker } from '@kit/mcp/hosted'

const hosted = createHostedMcpWorker({
  name: 'product-mcp',
  version: '0.0.1',
  identityPort: (env) => createProductIdentityPort(env),
  apiBaseUrl: (env) => env.API_BASE_URL,
  register(server, { identity }) {
    createProductCatalogue({ identity }).registerAll(server)
  },
  // Optional, deny-only: refuse an existing OAuth grant (ADR-0015 D2).
  // Throw when the answer is unknown; `false` denies, and a token-phase denial revokes.
  async grantAdmission({ userId, grantId }, env) {
    return !(await isProductGrantDenied(env, userId, grantId))
  },
  // Optional: trusted product routes in this same Worker.
  fallthrough(request, env, ctx) {
    return productWorker.fetch(request, env, ctx)
  },
})

// The shell answers `fetch` only; keep the product's `queue`, `scheduled`, … handlers.
// A dedicated Worker with no product handlers exports `hosted` itself.
export default { ...productWorker, fetch: hosted.fetch }
```

The hosted shell requires a `DB` D1 binding pointing at the product's Better Auth database. It calls the shared `isAccountActive` guard on identity resolution, consent submission, every code or refresh exchange, and every authenticated MCP request. Missing or disabled users are denied; database errors fail closed with `503`. This check is mandatory and independent of `grantAdmission`.

`register` runs on every authenticated `/mcp` request because EdgeFastMCP is stateless; with `grantAdmission` set, only after it admits the request. It receives token identity `{ userId, email? }`; tools close over it. Its env, the `identityPort` function env, the `apiBaseUrl(env, request)` env and the `grantAdmission` env have no `OAUTH_PROVIDER`; `apiBaseUrl` reaches `identityPort.resolve` unchanged. The identity port resolves who the user is. The authorization server mints. `userId` must be non-empty and contain no `:` or `/authorize` returns `500`. There is no AsyncLocalStorage and the shell needs no `nodejs_compat`. `register`, `fallthrough`, and catalogue annotations are trusted caller code, not a sandbox or authorization point. Omitting `fallthrough` returns `404`.

`grantAdmission` is an optional extra deny-only policy ([ADR-0015](../../docs/kit/architecture/adr/0015-mcp-remote-oauth-worker.md) D2), evaluated after the mandatory account check. Omitted (absent or `undefined`), no extra policy applies. Any other non-function value makes `createHostedMcpWorker` throw a `TypeError`. Set, the factory keeps the function it was given at creation, and the shell asks it:

- `{ phase: 'request', userId, grantId, clientId }` on every authenticated `/mcp` request, before `register`. The tuple comes from the public `unwrapToken` of the token the provider authenticated (`ctx.auth.token`); its `userId` must equal the token identity and `ctx.auth.userId`, and its client `ctx.auth.clientId`, or the request gets the `false` answer.
- `{ phase: 'token', grantType, userId, grantId, clientId }` on every `authorization_code` or `refresh_token` exchange at `/token`, as the provider's `tokenExchangeCallback`: after the provider's own client, code or refresh-token, PKCE, redirect, expiry, resource and scope checks, and before any OAuth grant or token write. The tuple is the callback's own.

The input never comes from request headers, query, body or client metadata, and it carries no token, props, scope or TTL. The predicate cannot mint or change them; its env still holds `OAUTH_KV`, so it is trusted code like the other hooks.

| Answer                          | `/mcp`                                                                                                                                                | `/token` (code or refresh)                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true`                          | continues unchanged                                                                                                                                   | issues unchanged: same props, scope, audience and TTLs                                                                                                                                                                                                                                                                            |
| `false`                         | `401` with a Kit-generated `invalid_token` Bearer challenge naming `/.well-known/oauth-protected-resource/mcp`, `no-store`, no tools; nothing revoked | `400` `invalid_grant`, no token; the provider revokes that OAuth grant and its tokens                                                                                                                                                                                                                                             |
| throw, rejection or non-boolean | `503` `no-store`, no challenge, no tools                                                                                                              | `503` `temporarily_unavailable`, `no-store`; no OAuth grant or token saved, issued or revoked. Provider writes made before the callback stay (a `private_key_jwt` client's assertion `jti` replay marker), so a retry needs fresh valid client authentication; it can then redeem the same code (while it lives) or refresh token |

`false` is terminal for that OAuth grant: the next refresh or code exchange revokes it, and the client must authorize again, which mints a new OAuth grant judged on its own. A `401` alone revokes nothing. So return `false` only for a decided refusal, and throw when the answer is unknown, for example on a failed store read. Admission is not atomic with issuance: an exchange admitted just before a denial becomes visible can still issue, and every later request and exchange of that OAuth grant is refused while the denial holds. Key a durable denial on `userId` + `grantId`. After a targeted revocation, keep it until no code, access token or refresh token of that OAuth grant can still be redeemed, including credentials a concurrent refresh re-saved: the provider's OAuth grant record being gone is not proof of cleanup. A permanent marker, as Ether OS keeps, is one way to do this, not a requirement for every `false`. Its storage and consistency are the caller's. With the seam set, each `/mcp` request adds one `OAUTH_KV` token read plus the predicate; the shell adds no timeout, retry or cache. Admission does not run on `/authorize`, the consent page or token revocation, changes no consent policy, and is not a tool authorization point. ADR-0015 D8 records why this seam exists with one evidenced Product consumer; nothing here claims that a Product has adopted or deployed it.

The shell owns `/mcp` as a prefix, `/authorize`, `/token` (including revocation), `/register`, and `/.well-known/oauth-*`; they never reach `fallthrough`. `/mcp-admin` is `404`; closed DCR makes `/register` `403` `access_denied`; encoded, trailing-slash, and doubled-slash forms are `404`. Protected-resource metadata lives at `/.well-known/oauth-protected-resource/mcp`, the URL the `401` challenge names; the bare form is `404`. OAuth exists only on the origin `MCP_PUBLIC_URL` configures. On any other origin (cleartext, a preview host, a forged Host) the reserved paths answer `404` and other paths still reach `fallthrough`; a missing or unusable `MCP_PUBLIC_URL` makes the reserved paths `500` instead. Exclude every reserved path from Cloudflare Access.

`consent` defaults to `always`: it renders a non-framable, uncached consent page naming the client name and id, the redirect scheme and host, and one warning for the redirect class (a program on this computer or a custom-scheme app; none for remote https). A CIMD URL `client_id` always shows it. `skip` suppresses it only when a positive product-registration receipt is visible (`createProductClient`). Open DCR and bare `OAuthHelpers.createClient` write none; a missing or not-yet-visible receipt shows the page (KV eventual consistency fail-closed). Temporary consent while a just-written receipt propagates is expected. `skip` on a public product client still does not authenticate the presenting program — only the receipt and PKCE verifier holder. `{ mode: 'demo-loopback', email }` suppresses it only for that email on a loopback non-production host. The stored 10-minute `OAUTH_KV` record binds identity, CSRF, GET-validated authorization request, and granted scope; its HttpOnly SameSite=Lax cookie is `mcp_consent_id; Path=/authorize` on loopback, otherwise `__Host-mcp_consent_id; Secure; Path=/`. The POST ignores its query, compares CSRF in constant time, deletes before completion, and clears the cookie; Deny redirects `access_denied` to the client. Single use is best effort only: KV get→delete is not atomic, but a replay holder can complete only the same client, redirect URI, and PKCE challenge. Hooks keep `OAUTH_KV`, whose write access can mint OAuth grants: they are trusted code.

Bind `OAUTH_KV`. Deployed composes set `ENVIRONMENT=production` or `staging`; otherwise a loopback-looking URL activates development DCR and `demo-loopback` policy. They also set `MCP_PUBLIC_URL` to their public https origin (MCP at `<origin>/mcp`), as `BETTER_AUTH_URL` pins Better Auth: tokens and metadata bind to it, never to a request Host. Unset, only a loopback development host serves OAuth, on its own origin. A value that is neither an https origin nor an http one on a loopback host is a configuration error: like a missing one, it answers `500` on the reserved paths and leaves product routes alone. CIMD requires `global_fetch_strictly_public`, which is its SSRF guard. Access tokens last 8 hours; `refreshTokenTTL` is optional and otherwise keeps the provider default (30 days); it must be `0` (no refresh tokens) or an integer of at least 60 seconds, else `createHostedMcpWorker` throws. Only `mcp` scope is granted; other requested scope returns `invalid_scope` with state. Every error bound for the client's `redirect_uri` waits until the identity port authenticates the user. Plain PKCE, implicit flow, and token exchange are disabled. A redirect URI must be https, http on `localhost`, `127.0.0.0/8` or `[::1]`, or a custom scheme; any other http redirect answers `400` before the identity port or a consent page. Caller code never receives the shell's `OAUTH_PROVIDER`, so a product calling `createProductClient` builds its own helpers with `getOAuthApi`: workers-oauth-provider 1.x requires `resourceMetadata.resource` there (use `<MCP_PUBLIC_URL>/mcp`), and refuses a client none of whose redirect URIs qualifies; a custom scheme qualifies only with `allowPrivateUseRedirectUris: true`.

## Probes

See [testing](../../docs/kit/testing.md#mcp-contract-probes--non-claims) **CP-MCP-REG / SMOKE / REFUSAL / SCHEMA / BUDGET / GRANT-ADMISSION**. Consent policy, fallthrough and OAuth grant admission are tested through the public hosted handler in this package. Dogfood connect is **CP-MCP-HTTP-OAUTH** in `apps/mcp-example` (not `smoke:mcp`).
