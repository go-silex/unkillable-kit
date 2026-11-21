# One Worker for a SPA and its API

A Product can serve its web build and its API from one Worker, on one origin. Separate API and SPA projects remain supported ([environments](../environments.md) § 6). Work in Product-owned Apps copied from the starters; Kit-owned Apps stay untouched.

## Compose

`apps/starter-api/src/index.ts` composes `createSiteFetch` from `@kit/core` over the Hono App:

```ts
import { createSiteFetch } from '@kit/core'

export default {
  fetch: createSiteFetch<Env & { ASSETS?: Fetcher }, ExecutionContext>({
    api: (request, env, ctx) => app.fetch(request, env, ctx),
    assets: (env) => env.ASSETS,
  }),
}
```

The handler classifies the path as Static Assets does (decoded once, repeated slashes collapsed), then decides in this order:

| Request                                                                    | Answer                                                                                    |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| No `ASSETS` binding                                                        | The API, for every path: API-only Workers and local `wrangler dev` are unchanged          |
| `/api`, `/api/*`, `/health` (any case), or an undecodable path             | The API, never the assets or the shell, whatever the `Accept` or `Sec-Fetch-Mode` headers |
| Another method than `GET`/`HEAD`                                           | JSON 405 with `Allow: GET, HEAD` and `x-request-id`                                       |
| A file of the build                                                        | The file                                                                                  |
| A miss under `/assets/`                                                    | The 404, never the shell                                                                  |
| Another miss: no extension in the last segment, or HTML accepted (`q` > 0) | The shell (`/`)                                                                           |
| Any other miss                                                             | The 404                                                                                   |

- What an API path answers is the API's: JSON errors from the Hono App, Better Auth's own responses under its base path. Routing is not authorization: the API keeps its own checks.
- HTML responses from the binding get `cache-control: no-cache`, `x-content-type-options`, `x-frame-options` and `referrer-policy`. `shellHeaders` adds Product policy, such as a CSP, and wins on conflict.
- Navigations are fetched without conditional headers: a 304 would carry the binding's cache policy instead of the shell's.
- A miss on a dotted path answers `Vary: Accept`, since `Accept` chose between the shell and the 404.
- `isApiPath` and `assetPrefix` override the defaults.

## Wrangler recipe

Add the block to each named environment of the Product API configuration, with `directory` relative to that file:

```toml
[env.production.assets]
directory = "../<product>-web/dist"
binding = "ASSETS"
not_found_handling = "none"
run_worker_first = ["/*", "!/assets/*"]
```

- `not_found_handling = "none"`: outside `/assets/*`, a miss runs the Worker, which tells a missing file from a navigation. With `"single-page-application"`, a missing built file returns `index.html` with status 200, and without `run_worker_first` browser navigations skip the Worker, `/api/*` and OAuth paths included.
- `run_worker_first` runs the Worker before matching files too: without it, `/` (served from `index.html`) and other root files bypass the handler, so they miss its headers and `shellHeaders` such as a CSP.
- `!/assets/*` is a cost choice: Vite's content-hashed files skip the Worker invocation, and a request under it, missing file or other method, is answered by Static Assets alone. Keep that prefix for built files only.

`apps/starter-api/src/site-recipe.test.ts` runs this block through Wrangler's local Static Assets routing with the real starter Worker.

Build the web App before each Worker deploy of that plane. The build output is public: no secrets or private files.

## Same origin

The SPA calls relative `/api/...` URLs; no `VITE_API_URL` is needed. Set both `BETTER_AUTH_URL` and `CORS_ORIGINS` to the public origin of the plane: `originGuard` checks the `Origin` of every mutation against `CORS_ORIGINS`, same-origin requests included, so the Worker's own origin must be listed. The session cookie stays first-party.

## Hosted MCP

With `@kit/mcp/hosted`, pass the handler as `fallthrough` to `createHostedMcpWorker` and export the hosted Worker. Reserved MCP and OAuth paths are answered by the hosted shell and never reach the handler; see [ADR-0015](../architecture/adr/0015-mcp-remote-oauth-worker.md).

## Local development

- API only: `wrangler dev` without an assets block, as in the starter README.
- Hot reload: run the web App's Vite server; it proxies `/api` to the API on port 8787.
- Single origin: build the web App, add the assets block to a local environment, run `wrangler dev --env <name>` and open the Worker origin.

## Not covered

Cache policy for built files beyond Static Assets defaults, CSP content, SSR, and access control for private files.
