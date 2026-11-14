---
title: 'API contract — example-api OpenAPI'
description: 'How the HTTP contract shared by web, MCP and skills is declared, published and gated.'
---

# API contract — `example-api` OpenAPI

`docs/kit/openapi/example-api.json` is the published contract. It is a **projection of the running app**, never a hand-maintained document.

The document excludes Better Auth's `/api/auth/*` surface. Better Auth owns that handler (`authRoutes.all` in [`routes/auth.ts`](../../apps/example-api/src/routes/auth.ts)); how a session is obtained is in [`stack.md`](./standards/stack.md), not here.

## Why the schemas are the validators

Routes are declared with `@hono/zod-openapi`:

```ts
const createItem = createRoute({
  method: 'post',
  path: '/api/items',
  security: sessionOrKeySecurity,
  description: personalKennelDescription,
  request: { body: { content: { 'application/json': { schema: createItemSchema } }, required: true } },
  responses: { 201: { … }, ...validationErrorResponse, ...authErrorResponses },
})

itemsRoutes.openapi(createItem, handler, invalidRequest('Invalid item'))
```

The same `createItemSchema` validates the request at runtime **and** appears in the document. A description cannot lie about the shape it accepts, because there is no second declaration to drift from. The rejected alternatives both kept one:

| Approach                                        | Why not                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Annotation beside the handler (`describeRoute`) | The annotation is not the validator: a spec claiming `200 {item}` next to a handler returning `{items}` passes every gate |
| Bespoke generator over `app.routes`             | Same lying-metadata problem, plus a kit-owned generator to maintain and no ecosystem tooling                              |

## Regenerate and gate

```bash
bun run openapi          # rewrite the snapshot
bun run openapi:check    # drift = exit 1 (runs in validate:full)
```

The gate exists for the _snapshot file_, not for the contract's truth: the contract is enforced by the type system and the runtime validators. A stale snapshot is a commit hygiene failure, not a contract failure.

## Shared pieces

[`apps/example-api/src/lib/openapi.ts`](../../apps/example-api/src/lib/openapi.ts) owns:

| Export                                                                     | Role                                                                                            |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `apiErrorBodySchema`                                                       | The single error envelope (`ApiError` component) mirroring `toApiErrorBody`                     |
| `authErrorResponses` · `validationErrorResponse` · `notFoundErrorResponse` | Reusable 401/403, 400, 404 entries — spread into `responses`                                    |
| `invalidRequest(message)`                                                  | Per-route validation hook preserving the exact `parseOrThrow` message and `details.fieldErrors` |
| `securitySchemes`                                                          | `session` (Better Auth cookie) and `apiKey` (org-bound `sk_` bearer)                            |
| `sessionOrKeySecurity`                                                     | Dual-credential requirement list (`session` **or** `apiKey`)                                    |
| `sessionOnlySecurity`                                                      | Session-only requirement list                                                                   |

A route that enforces a session declares `sessionOnlySecurity` (`sk_` → 403). Dual-credential routes declare `sessionOrKeySecurity`. An inline `[{ session: [] }]` infers `never[]` and silently collapses `c.req.valid()` to `never` — do not write it.

## `@kit/api-client` stays a generic fetch wrapper

Deliberate, not pending: [`@kit/api-client`](../../packages/api-client/README.md) keeps `fetch` + the kit error envelope + cookie credentials, with no route constants and no generated types. Products own their route paths, and the kit does not ship a second contract surface that could disagree with the spec. A typed client generated from the document is a product-side or later-ADR decision, not a silent dual contract.

The client distinguishes HTTP responses from transport failures: a non-OK response
throws `HttpError` with `status`; a kit error envelope with string code and message
throws its `ApiError` subtype with envelope fields. Non-kit response bodies are not
used as error messages. Network failures are not `HttpError`. See the
[client guide](../../packages/api-client/README.md#http-errors-and-migration) for
401 callback behavior and consumer migration.

## Rules

- Response schemas declare the **exact** fields the handler returns. `.loose()` is prohibited: it documents `additionalProperties: true` instead of the real shape, and its `[x: string]: JSONValue` index signature rejects any optional field the handler types as `| undefined`.
- Contract declarations live in a sibling `routes/<group>.schemas.ts` (schemas + `createRoute` definitions) once a route file would pass the file-length gate; the route file keeps the instance, `app.use` and the handlers. Registration order is part of the published document — preserve it when moving declarations.
- A new kit-owned endpoint is declared with `createRoute`; `parseOrThrow` in a route file is a regression.
- Request bodies that are `.strict()` stay `.strict()`. Widening a request schema to satisfy the document is an authority bug (flows bodies reject `allowedTools` / `grant` by design).
- Repeated query parameters (`?q=a&q=b`) 400: the validator yields an array for a repeated key.
- The document carries zero product domain strings.

## Notifications HTTP composition

The E3 interface follows the exact routes and DTOs in [ADR-0019 D6](./architecture/adr/0019-notifications-rules-inbox-and-delivery.md#d6--http-interface). All 17 endpoints are session-only: missing credentials return 401; an authenticated `sk_` returns 403 before resource authorization. The pure Package and repositories do not authenticate a request.

| Surface                                   | Authorization and projection                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Type catalogue and personal rules         | Global authenticated subject; User rules never lock or produce administration audit                                        |
| Organization Inbox and effective rules    | Actual current membership, active Organization and live Module read grants; no support bypass or source-object ACL re-read |
| Organization rule/Delivery administration | `manage_notifications`, minimum `admin`; explicit logged support reads only, never support writes                          |
| Deployment administration                 | Rules read by `staff` or `super_admin`, writes by `super_admin`; failed Delivery list by `super_admin` only                |

Administration returns Delivery metadata, never content, addresses, display parameters or provider responses. Rule changes and their allowlisted audit commit together through the persistence interface; a no-op does not invent a change. Effective rules preserve the configured value and winning lock/source even when the separate live `available` ceiling is false.

Requests reject unknown or repeated query keys and unknown JSON fields; empty-query and `{}` mutation contracts remain exact. Required JSON mutations return the authored `VALIDATION_ERROR` 400 envelope for missing or unsupported media types, not an internal error. Schema field failures retain `details.fieldErrors`; raw unknown-key and cursor failures stay generic.

Lists retain the shared limit and 512-character cursor cap. Registry/effective lists validate their lexical keysets; persisted lists validate safe dates and bounded ASCII ids before querying their independently scoped rows. The full-string identifier and external-Channel grammars, including rejection of `in_app`, are represented in the generated document. Deployment Delivery metadata is one closed object including `orgId`, not an intersection of incompatible closed objects. Localized copy is not restricted to ASCII.

Inbox content is rendered at read time from API-owned `@kit/i18n` catalogues. Only an exact supported `Accept-Language` value selects that locale; missing, regional, composite or unsupported values use French. Inbox responses declare `Content-Language`, retain `Vary: Accept-Language` and use `Cache-Control: private, no-store`. The root `i18n:check` covers parity within both the API and Web catalogues; the Apps do not have to share the same message keys.

Approval-source links target the authenticated App route `/app/flows/runs/{runId}` and reuse the existing run view in the active Organization. The existing flows API remains authoritative for read and approval access; the `/admin` entry still requires a Platform actor. No Notifications UI or new approval authority is introduced.

Organization destination endpoints remain S2. In the E3 phase, the API did not emit Notifications, create a service factory, start a Delivery owner or send to a provider.
