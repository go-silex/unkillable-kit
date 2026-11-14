# @kit/starter-web

A minimal Vite SPA composing Kit Packages, with email sign-in and an authenticated shell. This App is a starting point, not a dependency on the Example Apps. The API enforces authorization; the shell is not a security boundary.

## Local development

Run `@kit/starter-api` on port 8787, with its database and authentication configured as described in its README. Then run `bun run --filter @kit/starter-web dev`. Vite proxies `/api` to `http://127.0.0.1:8787`; deploy the SPA and API on the same origin or configure a suitable reverse proxy. Browser requests use session cookies. Do not put credentials in source.

- Test: `bun run --filter @kit/starter-web test`
- Typecheck: `bun run --filter @kit/starter-web typecheck`
- Build: `bun run --filter @kit/starter-web build`

## API contract

The App uses `POST /api/auth/sign-in/email` with `{ email, password }`, `POST /api/auth/sign-out`, and authenticated `GET /api/me`. The identity response must satisfy `@kit/api-client/me`'s `parseMe` contract. Authentication failures return 401; other failures remain visible and do not masquerade as sign-out. Cookie, origin and CSRF configuration must match the API deployment.

## Rename map

When adapting this App, rename the workspace package `@kit/starter-web` in `package.json` and its references in commands and workspace configuration; rename the `Starter Web` document title in `index.html` and the shell heading in `src/app.tsx`. The coverage report name `starter-web` in `vitest.config.ts` can be renamed with the App. There is no Worker name in this App. If the API App is renamed, update the `@kit/starter-api` reference above and retain the API contract and proxy alignment.
