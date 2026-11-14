# `@kit/api-client`

Isomorphic HTTP helper for Kit kit apps: `fetch` + kit error envelope + cookie credentials.

## Install (workspace)

```json
"@kit/api-client": "workspace:*"
```

## Usage

```ts
import { createApiClient, ApiError, HttpError, apiErrorToMessage } from '@kit/api-client'
import { parseMe } from '@kit/api-client/me'

const { apiFetch } = createApiClient({
  baseUrl: import.meta.env.VITE_API_URL ?? '',
  credentials: 'include', // default
  onUnauthorized: async (error) => { /* error is HttpError; clear session / redirect */ },
})

try {
  // Without `parse`, JSON is trusted as T at compile time only.
  const me = await apiFetch('/api/me', { parse: parseMe })
} catch (e) {
  if (e instanceof HttpError) {
    // ApiError is an HttpError with kit envelope fields.
    if (e instanceof ApiError) {
      // Field-level VALIDATION_ERROR: apiErrorFieldErrors(e) → details.fieldErrors
    }
    toast.error(apiErrorToMessage(e, {
      fallback: 'Error',
      messages: { UNAUTHORIZED: 'Please sign in' },
    }))
  } else {
    // Network failures and parse-on-read errors are not HTTP response errors.
    throw e
  }
}
```

## HTTP errors and migration

- Every non-OK HTTP response rejects with `HttpError`, exposing its numeric `status`. A kit error envelope with string `error.code` and `error.message` rejects with `ApiError`, a subtype of `HttpError` that additionally exposes `code`, `requestId` and `details`. Other response bodies are not exposed as error messages: the default message is `HTTP <status>`.
- `onUnauthorized` receives an `HttpError` for any 401, including non-kit responses. It may return a promise; the client awaits it and swallows synchronous throws and rejected promises so the request still rejects with the original HTTP error.
- Fetch/network failures remain their original errors, not `HttpError`; parse-on-read failures are `Error('Invalid API response', { cause })`. Do not infer an HTTP status by parsing an arbitrary error message.
- **Migrating consumers:** replace `instanceof ApiError` with `instanceof HttpError` wherever behavior depends only on HTTP status (401 session handling, retries, 403/404 routing, 429). Keep `ApiError` checks for envelope-only fields such as `code`, `requestId` and validation details. Change `onUnauthorized` parameter annotations from `ApiError` to `HttpError`, narrowing to `ApiError` before accessing those fields.
- `apiErrorToMessage` uses a catalog entry or the kit envelope message for `ApiError`; a generic `HttpError` uses its safe status message. Other `Error` messages may be returned as-is: use an application-owned fallback rather than displaying untrusted network or parser errors directly.

## `/api/me` wire contract

`meResponseSchema` / `createOrgResponseSchema` (+ `parseMe`, `MeResponse`, `MeOrg`,
`PlatformRole`) are the hand-written parse-on-read contract for `GET /api/me` and
`POST /api/orgs`, exported from the `@kit/api-client/me` subpath.

They live in this package — not in an app — because both sides of the wire consume
them: the SPA parses every read through `parseMe`, and `example-api` asserts its own
200/201 bodies against the same schemas (`apps/example-api/src/me-spa-contract.test.ts`).
A copy per app would let the contract drift silently; a cross-app deep import would
hide the dependency from the task graph, so editing the schema would not invalidate
the consumer's Turbo cache. Cache and transport concerns (query keys, optimistic
writes) stay in the app.

The same subpath exports `ApiKeyScope`, `MintApiKeyRequest`, `MintApiKeyResponse`,
`ApiKeyMeta` and `ListApiKeysResponse` types for `/api/keys`. Mint requests must
specify at least one scope; `read`, `write` and `admin` are independent. These
types do not validate JSON at runtime.

The subpath is load-bearing, not cosmetic: the barrel's `fetch` transport needs the
DOM `RequestCredentials` surface, which a Worker-typed program
(Workers runtime types from `wrangler types`, no DOM lib) does not have. `@kit/api-client/me` stays
zod-only so the Worker can import the contract without the transport.

## Non-goals

- React Query hooks / toast UI
- Route constants or product paths
- **Types generated from the OpenAPI document** — deliberate, not pending. The kit ships one contract surface (`docs/kit/openapi/example-api.json`, [ADR-0014](../../docs/kit/architecture/adr/0014-openapi-from-hono-routes.md)); a typed client is a product-side or later-ADR decision, never a second contract living here.
- Hardcoded FR/EN strings (i18n stays in the app)
- Cookie parsing (Better Auth owns sessions)

See epic go-silex/silex-boilerplate#18 / child go-silex/silex-boilerplate#81 and `example-web` `src/lib/api.ts` for the app wrapper pattern.
