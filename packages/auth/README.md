# @kit/auth

Authentication primitives and integration surfaces; it does not own product-specific identity policy.

## Entry points

- `@kit/auth`: environment, sessions, keys and organization access helpers.
- `@kit/auth/schema`: authentication database tables.
- `@kit/auth/factory`: Worker authentication factory and email integration.
- `@kit/auth/oidc-provider`: optional OpenID provider composition and administration helpers.
- `@kit/auth/react`: React authentication forms and helpers.
- `@kit/auth/hono`: Hono authentication middleware.
- `@kit/auth/repos/*`: individual repository modules under `src/repos/`.
- `@kit/auth/repos/memory-d1`: explicitly unavailable as a public export.

## Composition

- Kit dependencies: `@kit/core`, `@kit/db`; optional peers `@kit/email`, `@kit/ui`.
- Known consumers: `apps/example-api`, `apps/example-web`, `packages/mcp`, `packages/notifications`.
- Caller rules: [architecture decision](../../docs/kit/architecture/adr/0003-multi-tenant-rbac-modules.md).

## API key scopes

New keys must explicitly store a comma-separated selection of `read`, `write` and `admin` in `scopes`. The scopes are independent: `admin` does not imply `read` or `write`. The migration backfills existing keys with all three scopes. Malformed stored scope strings grant no scopes.

`resolveDualAuth` authenticates keys and returns `scopes: ApiKeyScope[]`; `createRequireAuth` exposes them as `keyScopes` in the request context. Neither enforces route scopes. Each App must install a default-deny policy for API keys, explicitly declare the required scope for each allowed method and route, and enforce it alongside Organization and Role checks. The Example and Starter Apps each implement a central gate; other Apps do not inherit them. `allowsApiKeyScope(identity, requiredScope)` is an optional predicate: it permits sessions and checks exact membership for keys, but does not replace tenant or RBAC authorization.

## Account state

The Product decides who may call `disableAccount` and `enableAccount` from
`@kit/auth/repos/account-state`; both require the acting User and Organization,
and check that actor and target belong to that Organization. Disabling a User
revokes their existing sessions; enabling does not restore them. State is
Deployment-wide for that User, including their memberships in other Organizations.
When the audit set is mounted, pass its audit option to record the change.

When the OpenID provider is enabled, authorize the operation first, then await
`endOidcUserSessions(auth, targetUserId)` **before** calling `disableAccount`.
The latter deletes sessions directly and cannot trigger provider logout hooks.
Apply the same ordering before any other direct session deletion. Do not continue
to direct deletion if the Kit logout call fails.

Each request must use the live `isAccountActive` check when configuring session
and API-key authentication. An Organization-bound key is governed by its
subject (the User who owns the key), not by an Organization-wide status.
Missing Users, disabled Users and state-read failures are refused. Products
must sync and apply the account-state schema migration before deploying.

## OpenID provider (opt-in)

First-party web Apps on different origins use it for single sign-on. It is an
authorization server separate from the hosted MCP shell, which does not become a
general identity provider; an OIDC identity grants no MCP authority.

The pinned Better Auth 1.7.27 uses `redirect: 'manual'` for back-channel
logout delivery on Workers. Delivery remains best effort; see the limitations
below.

Install matching versions of `better-auth` and `@better-auth/oauth-provider`,
both at least 1.7.27, in the Worker. Sync the `oidc_provider` schema set in
addition to the sets required by the Better Auth mount. The normal factory
import does not require the provider peer; import `@kit/auth/oidc-provider` only
in a Worker enabling it.

### OIDC private JWK encryption

The migration stores bytes; it does **not** encrypt private JWKs. Better Auth's JWT
plugin encrypts them with the Better Auth secret before storage. Keep private-key
encryption enabled and protect the secret; losing it makes stored keys unreadable.

Create the provider configuration **for each request**, binding the Worker's
execution context rather than retaining one from another request:

```ts
import { createBetterAuth } from '@kit/auth/factory'
import { createOidcProvider } from '@kit/auth/oidc-provider'

const auth = createBetterAuth({
  database, secret, baseURL, trustedOrigins,
  oidcProvider: createOidcProvider({
    loginPage: '/login',
    consentPage: '/consent',
    claims: async ({ user }) => ({ 'https://example.com/claim': user.id }),
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  }),
})
```

The App owns the login and consent pages and the Better Auth provider client
plugin needed to resume authorization. The issuer is `<auth-origin>/api/auth`,
where `<auth-origin>` is the scheme and host of `BETTER_AUTH_URL` (which may already include `/api/auth`).
Discovery is `{issuer}/.well-known/openid-configuration`; mount the auth
handler on its usual path. The hosted MCP shell retains its own reserved paths
and OAuth server. Do not expose this provider at the root RFC 8414 metadata path,
or accept one server's tokens at the other.

Use `registerOidcClient(auth, { headers, redirectUris, firstParty, ... })`
from the same entry only in server code after checking administrator permission
and request Origin. The response contains the client secret once; store it
securely on the confidential web client. Setting `firstParty: true` skips
consent; only the App may make that decision. Registration uses exact redirect
URIs, authorization code and PKCE S256. If an authorization request omits
`scope`, Better Auth uses the client's registered scopes; those scopes must
contain `openid` for an OpenID request. Dynamic registration, CIMD, refresh
tokens, `offline_access`, pairwise subjects and front-channel logout are not
supported. Revisit session revocation and logout semantics before enabling
refresh tokens or `offline_access`.

The access-token session foreign key uses `ON DELETE CASCADE`, deliberately
deviating from Better Auth's upstream `SET NULL`: deleting a session removes its
associated access-token rows. This does not revoke self-contained tokens already
accepted by a relying party without provider revalidation.

Revoking an already-invalidated token may return HTTP 400 from Better Auth
1.7.27; the relying party should treat that token as revoked.

`endOidcUserSessions(auth, userId)` atomically deletes the user's sessions and
then invokes Better Auth's back-channel logout hooks for at most the 25 most
recent sessions. Notifications are best effort and truncated beyond that bound.
If logout planning or the session snapshot fails, the result reports
`success: true` and `coverage: 'unknown'`; do not interpret that as complete
notification coverage. Its `truncated` value is a boolean when coverage is
known, and `null` whenever planning fails.
Use it before `disableAccount` or any other direct session deletion: once
sessions are deleted directly, the provider cannot run those hooks for them.
Better Auth's native bulk session revocation paths are not a substitute.

Register a public HTTPS `backchannelLogoutUri` and optional
`postLogoutRedirectUris` for each client. The provider schedules notifications
with the supplied `waitUntil`; delivery is best effort, has a timeout and is
not retried. RP-initiated logout can end a browser session too. Clients must
validate logout tokens, keep RP sessions short and periodically revalidate with
the provider using `prompt=none`. Locally verified access tokens remain usable
according to their expiry; logout is not an atomic global revocation guarantee.

### Login method guidance

When the pending request carries `prompt=login` or `max_age`, Apps should offer
password sign-in and use the Better Auth provider client plugin to send the
signed `oauth_query`. For a verified query with either parameter, the Kit
returns HTTP 400 `OIDC_PASSWORD_REQUIRED` on magic-link send or social sign-in
before sending mail or starting a redirect. This gives Apps a clear error
instead of a login loop; it is not a freshness check.

Better Auth 1.7.27 does not guarantee reauthentication for `prompt=login` or
`max_age`:

- Reissuing a session cookie (for example, on `/update-user` or during
  authorization) can clear `prompt=login` without a new authentication.
- The consent flow can clear both parameters based on session age alone.
- Positive `max_age` is measured from local session creation.
- Google sign-in neither forces upstream reauthentication nor checks Google's
  `auth_time`.

Relying parties that need proof of fresh authentication must not rely on these
parameters from this provider.

## Google sign-in (opt-in)

Pass `google: { clientId, clientSecret, allowedDomains }` to `createBetterAuth`.
Use a Google OAuth **Web application** client and register
`<auth-origin>/api/auth/callback/google` as its redirect URI, where
`<auth-origin>` is the scheme and host of `BETTER_AUTH_URL`. Do not append
`/api/auth` twice if `BETTER_AUTH_URL` already includes it. The App supplies
the client credentials from secret storage and a non-empty list of DNS domains.
Domains are normalized to lowercase and matched exactly. Invalid configuration
throws at construction; omit `google` to leave the provider unconfigured.

Only existing users can sign in: the verified Google ID token must report
`email_verified: true` and an `hd` matching both the email domain and the
allowlist. Google accounts without a hosted-domain claim are refused. Google
accounts link by the same email; first-time implicit linking requires the local
user's email to be verified. Inactive accounts cannot open a session. Provider
tokens are discarded before account persistence and are not logged.

The App owns the sign-in button and must pass its login page as Better Auth's
`errorCallbackURL` when starting sign-in. Also configure the top-level
`createBetterAuth` option `googleErrorURL?: string` with an absolute `https:` or
`http:` URL on a trusted origin for the App login page. This fallback is used when OAuth state is
missing or already consumed and when account lookup fails; it defaults to
`/login` on the first trusted origin. It does not replace `errorCallbackURL`
for normal initial sign-in.

The redirect flow supplies `error` codes: `unable_to_get_user_info` (invalid
token or identity policy), `signup_disabled` (no existing user),
`account_inactive` (disabled or unreadable account), `account_not_linked`
(implicit linking refused), and `google_email_mismatch` (a linked identity's
email changed). Better Auth may also return protocol errors such as
`invalid_code` or `state_not_found`. Direct Google ID-token sign-in and manual
account linking are unsupported; direct routes return HTTP 400 with
`GOOGLE_REDIRECT_ONLY`.

This option supplies no login UI, deployment secrets, or product domain list.

## Development

- Where to add: `src/org-roles.ts` for access roles; `src/react/` for forms; `src/repos/` for persistence.
- Test: `bun run --filter @kit/auth test`
- Typecheck: `bun run --filter @kit/auth typecheck`
