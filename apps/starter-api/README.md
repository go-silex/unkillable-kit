# @kit/starter-api

Minimal Hono Worker: Better Auth password sessions, Organization-scoped members and first-login audit. Only the `core,audit` schema sets are installed. No example App dependency or optional capability is mounted. `src/platform` wires shared policy; `src/modules/members` owns the neutral member listing.

## Local development

Copy `.dev.vars.example` to `.dev.vars` and set a local secret. Public signup is enabled only by that local file; it is off by default. Run `bun run --filter @kit/starter-api db:migrate`, then `bun run --filter @kit/starter-api dev` (port 8787). Run `bun run --filter @kit/starter-api test` for SQLite-backed HTTP tests. Remote deployment requires a real D1 database, strong secret, production URL and explicit trusted CORS origins. This starter has no email transport, so password recovery is not configured.

`GET /api/me` returns the current profile and memberships; `GET /api/orgs/:orgId/members` requires a session or organization-bound key and current membership. Better Auth's Organization routes are disabled: provision Organizations and memberships through your Product's authorized administration flow.

API keys require the `read` scope for both endpoints; scopes are independent grants. All other routes deny API keys unless their exact method and path are declared in `src/platform/key-scopes.ts`. Sessions keep their existing access rules. The scopes migration preserves legacy keys with `read,write,admin`; newly created keys must receive explicit scopes.

## Copy / rename map

| Starter value                            | Product replacement                             |
| ---------------------------------------- | ----------------------------------------------- |
| `apps/starter-api`                       | `apps/<product>-api` (including manifest `app`) |
| `@kit/starter-api`                       | Product workspace package name                  |
| `starter-api`                            | Product Worker name in `wrangler.toml`          |
| `starter-api-local`, `local-starter-api` | Product D1 name and database ID                 |
| `@kit/starter-api` README title          | Product API title                               |

After copying to a Product path, keep the existing journal and run `bash scripts/kit/kit-schema-sync.sh --app apps/<product>-api --modules core,audit` to append future Kit changes. The sync tool intentionally refuses Kit-owned starter paths. Domain migrations begin at `1000_`; never edit applied Kit migrations.
