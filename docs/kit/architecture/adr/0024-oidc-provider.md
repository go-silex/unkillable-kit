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

The issuer is `<BETTER_AUTH_URL>/api/auth`. OIDC discovery is served at `{issuer}/.well-known/openid-configuration`. This namespace is distinct from the hosted MCP shell of [ADR-0015](./0015-mcp-remote-oauth-worker.md), which retains `/authorize`, `/token`, `/register` and `/.well-known/oauth-*`. The provider does not use the RFC 8414 root metadata path. Both may coexist in one Worker without changing MCP discovery or authorization. They are separate authorization servers: each accepts only its own tokens; neither an OIDC token nor an MCP token is a credential for the other server.

Use **RS256** for signed identity and logout tokens: OpenID Connect Core §15.1 requires providers to support RS256, while the JWT plugin defaults to EdDSA. Configure its `jwks.keyPairConfig.alg` explicitly. Asymmetric signatures let relying Apps verify tokens against the issuer's public JWKS without sharing the signing secret. Signing private keys are encrypted at rest; the JWKS and OAuth-provider tables ship as an additive Kit schema module under [ADR-0008](./0008-kit-schema-identity-product-compose.md).

Clients are registered only by a server-side administrative call. V1 supports confidential web clients with exact redirect URIs and PKCE `S256`; neither dynamic client registration nor client metadata documents are enabled. Consent may be skipped only for an App-designated first-party client. The supported scopes are `openid`, `email` and `profile`; `offline_access` and refresh tokens require explicit per-client enablement and are off in v1. An inactive User cannot complete authorization; existing session guards remain in force.

ID tokens and UserInfo carry `sub` as the User id, `email`, `email_verified` and `name`. An App-supplied claims hook may add App-defined claims; the Kit does not own Product claims. RP-initiated logout and back-channel logout are supported, with Workers background delivery bound to the request execution context. A Kit function ends all sessions of a User through Better Auth so registered clients receive back-channel logout; deleting session rows directly does not notify them.

## Exclusions and consequences

Dynamic client registration, third-party consent screens, refresh tokens in v1, pairwise subjects, front-channel logout, merging the MCP authorization server, Product client registrations and claims, secrets and deployment are outside this decision. Enabling the provider adds persistent signing keys, client credentials and logout delivery obligations; it does not make those responsibilities part of ADR-0015 or turn an OIDC identity into MCP authority.
