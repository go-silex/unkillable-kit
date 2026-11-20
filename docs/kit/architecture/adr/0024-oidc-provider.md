---
title: 'ADR-0024 — Opt-in OpenID Provider for first-party Apps'
status: proposed
normative: false
date: 2026-11-20
axial: false
related:
  - docs/kit/architecture/adr/0002-session-hmac-interim-vs-better-auth.md
  - docs/kit/architecture/adr/0008-kit-schema-identity-product-compose.md
  - docs/kit/architecture/adr/0015-mcp-remote-oauth-worker.md
summary: 'Opt-in OpenID Provider for first-party Apps'
---

# ADR-0024 — Opt-in OpenID Provider for first-party Apps

## Status and context

This record is **proposed and non-normative**. It describes the decision targeted by go-silex/unkillable-kit#71, not an accepted policy or a claim of deployment. First-party web Apps on different origins need single sign-on without turning the hosted MCP authorization server into a general identity provider.

## Proposed decision

An App may opt in to an OpenID Provider composed in `createBetterAuth` from Better Auth's OAuth 2.1 provider and JWT plugin. When omitted, existing authentication behavior, routes and tables in use remain unchanged. The JWT plugin operates in OAuth-provider mode: it does not expose a session-JWT `/token` route or emit a `set-auth-jwt` header.

The issuer is `<auth-origin>/api/auth`, where `<auth-origin>` is the scheme and
host of `BETTER_AUTH_URL` (which may already include `/api/auth`). OIDC discovery is served at
`{issuer}/.well-known/openid-configuration`. The hosted MCP shell of
[ADR-0015](./0015-mcp-remote-oauth-worker.md) retains `/authorize`, `/token`,
`/register` and `/.well-known/oauth-*`. The provider does not use the RFC 8414
root metadata path. Both can coexist without changing MCP discovery or
authorization. These separate authorization servers accept only their own tokens:
neither an OIDC token nor an MCP token is a credential for the other server.

Use **RS256** for identity and logout tokens: OpenID Connect Core §15.1 requires
providers to support RS256, while the JWT plugin defaults to EdDSA. Configure
`jwks.keyPairConfig.alg` explicitly. Relying Apps verify signatures against the
issuer's public JWKS without sharing the signing secret. The JWT plugin encrypts
private keys with the Better Auth secret; the migration only stores bytes. See the
[encryption warning](../../../../packages/auth/README.md#oidc-private-jwk-encryption). JWKS and OAuth tables ship as an additive Kit schema module under [ADR-0008](./0008-kit-schema-identity-product-compose.md).

Clients are registered only by server-side administration. V1 supports
confidential web clients with exact redirect URIs and PKCE `S256`; neither
dynamic registration nor client metadata documents are enabled. Only
App-designated first-party clients may skip consent. Scopes are `openid`, `email`
and `profile`. When an authorization request omits `scope`, Better Auth uses the
client's registered scopes, which must contain `openid` for an OpenID request.
`offline_access` and refresh tokens are disabled in v1; revisit session
revocation and logout semantics before enabling either. Inactive Users cannot
complete authorization; existing session guards remain in force.

ID tokens and UserInfo carry `sub` as the User id, `email`, `email_verified` and
`name`. An App-supplied hook may add claims; the Kit does not own Product claims.
RP-initiated and back-channel logout use Workers background delivery bound to
the request execution context. The Kit helper atomically deletes all User
sessions, then invokes Better Auth's back-channel hooks for at most the 25 most
recent sessions. Notifications are best effort and truncated beyond that bound.
Authorize deactivation first and call `endOidcUserSessions` before
`disableAccount` or any other direct session deletion; direct deletion cannot
invoke those hooks. Do not continue to direct deletion if the helper fails.

The access-token session foreign key uses `ON DELETE CASCADE`, deliberately
deviating from upstream Better Auth's `SET NULL`, so deleting a session removes
its associated access-token rows. Self-contained tokens already accepted by an
RP without provider revalidation can remain usable until expiry. RPs must
validate logout tokens, keep their sessions short and periodically revalidate
with the provider using `prompt=none`; logout is not an atomic global revocation
guarantee.

**Workers limitation:** Better Auth 1.7.27 uses `redirect: 'error'` for
back-channel logout delivery, which Workers rejects. Do not rely on this provider
on Workers until the upstream incompatibility is fixed and the Workers logout
integration test passes.

## Exclusions and consequences

Dynamic client registration, third-party consent screens, refresh tokens in v1,
pairwise subjects, front-channel logout, merging the MCP authorization server,
Product client registrations and claims, secrets and deployment are excluded.
The provider adds persistent signing keys, client credentials and logout delivery
obligations. It does not make them ADR-0015 responsibilities or turn an OIDC
identity into MCP authority.
