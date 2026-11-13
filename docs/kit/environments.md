# Environments & deploy (local · staging · main)

**SSoT** for how **product consumers** map **git branches** → **Wrangler named envs** → **Cloudflare resources**. Kit HEAD is trunk/`main` only.

| Related                                                                    | Role                                                                             |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| This page                                                                  | Protocol — planes, isolation, git × CF, anti-patterns                            |
| [`deploy-cloudflare.md`](./deploy-cloudflare.md)                           | Kit **showcase** CD (Workers Builds / Pages from the CI-gated **`deploy/main`**) |
| [`email-cf-runbook.md`](./email-cf-runbook.md)                             | Email Sending (`cf` / allowlist)                                                 |
| [`product-consumer-contract.md`](./product-consumer-contract.md)           | Product wrangler lives only under `apps/<product>-*`                             |
| [ADR-0002](./architecture/adr/0002-session-hmac-interim-vs-better-auth.md) | Browser session = Better Auth cookies                                            |
| [ADR-0004](./architecture/adr/0004-email-transport-cf-default.md)          | Transport by environment                                                         |

**Status**

| Surface                            | Today                                                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol (this page)               | Normative                                                                                                                                          |
| Kit `apps/example-*/wrangler.toml` | Top-level = **local** · `[env.production]` = showcase · **no** `[env.staging]`                                                                     |
| Kit git                            | **`main` only.** There is no kit `staging` branch. Do not create one on the kit to “match the docs”.                                               |
| Kit CD (`scripts/kit/cf-builds/*`) | Refuses any branch ≠ `deploy/main` (CI-gated) · **always** `--env production`. Copying it onto a product `staging` branch writes **production** D1 |
| Product `apps/<product>-*`         | Owns `[env.staging]` / `[env.production]` (new files, zero-edit)                                                                                   |
| Product git                        | **Trunk.** PRs land on `main`. Optional staging CD is a fast-forward pin `staging` from `main`, not a second landing branch.                       |

Provisioning kit example staging is **B4**. Products do not wait — they add `[env.staging]` in **product** wrangler and **product** CD.

---

## 1. Three planes

| Plane          | `ENVIRONMENT`                       | Wrangler                   | Where it runs                              |
| -------------- | ----------------------------------- | -------------------------- | ------------------------------------------ |
| **local**      | `development` (or `test` in Vitest) | **top-level** (no `--env`) | `wrangler dev` · `.dev.vars` · local D1/R2 |
| **staging**    | `staging`                           | `--env staging`            | Named Worker + **own** D1/R2/secrets/hosts |
| **production** | `production`                        | `--env production`         | Named Worker + **own** D1/R2/secrets/hosts |

Which **git branch** triggers which `--env` is §4 (two models). Do not infer `--env` from the branch name — CD must pass `--env` explicitly.

`ENVIRONMENT` is the runtime switch (`useSecureCookie`, placeholder secrets, CORS fail-closed, email allowlist). It must match the Wrangler env: `[env.staging].vars.ENVIRONMENT = "staging"`.

Never ship `ENVIRONMENT=development` or `EMAIL_TRANSPORT=log` to a Cloudflare Worker.

---

## 2. Isolation (non-negotiable)

Staging is a **second Worker**, not a preview of production.

| Resource                   | Rule                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Worker `name`              | Distinct (`<api>` vs `<api>-staging`)                                                                                                    |
| D1                         | Distinct `database_id` — migrate each env                                                                                                |
| R2                         | Distinct `bucket_name`                                                                                                                   |
| Secrets                    | Distinct `BETTER_AUTH_SECRET`. `wrangler secret put --env staging`                                                                       |
| Public hosts               | Distinct custom domains on the **same registrable zone** as the SPA                                                                      |
| Queues / Workflows / crons | Distinct names; staging **`crons = []`** unless a dry-run is explicit                                                                    |
| Email                      | Staging: `cf` or `resend` + `EMAIL_ALLOW_DOMAINS` + `[TEST STAGING]` ([ADR-0004](./architecture/adr/0004-email-transport-cf-default.md)) |

Same binding **names** in code (`env.DB`, `env.BUCKET`). Different Cloudflare objects behind them.

```text
[env.staging]                 [env.production]
Worker  foo-api-staging       Worker  foo-api
D1      foo-api-staging       D1      foo-api
R2      foo-api-staging       R2      foo-api
host    staging.api.example   host    api.example
```

Sharing production D1/R2 with staging **is** a prod incident. Do **not** copy `[env.production]` UUIDs into `[env.staging]`.

---

## 3. Hosts, cookies, CORS

Better Auth sessions are **host-only cookies** (`HttpOnly` · `Secure` on staging/prod · `SameSite=Lax`).

| Do                                                                            | Do not                                                                 |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Custom domains on one registrable zone                                        | `*.workers.dev` / `*.pages.dev` as the session pair                    |
| `workers_dev = false` and `preview_urls = false` on **product** deployed envs | Gradual versions of the **prod** Worker as “staging”                   |
| `BETTER_AUTH_URL` = public API origin of **that** env                         | Reuse prod `BETTER_AUTH_URL` on staging                                |
| `CORS_ORIGINS` = explicit SPA origin(s) of **that** env                       | Add the staging SPA origin to **production** CORS to “make login work” |

Kit showcase `[env.production]` does **not** yet set `workers_dev = false` (dogfood leftover). Products must set the flags; do not copy that omission.

SPA `VITE_API_URL` is baked at **build** time. Staging web build **requires** `VITE_API_URL` = that env’s `BETTER_AUTH_URL`. Defaulting to the prod API (kit `web-build.sh` does this for showcase) on a staging host + `credentials: include` writes **production** if CORS is opened.

---

## 4. Git × Wrangler × CD

```text
feature PR
    │
    ▼
 CD trigger A  ──►  wrangler deploy --env staging      ──►  staging hosts
    │
    │  promote
    ▼
 CD trigger B  ──►  wrangler deploy --env production   ──►  prod hosts
```

| Model                   | PRs land on                                           | Staging CD trigger   | Production CD trigger |
| ----------------------- | ----------------------------------------------------- | -------------------- | --------------------- |
| **staging-train**       | `staging`; `/promote` → `main`                        | git `deploy/staging` | git `deploy/main`     |
| **trunk + staging pin** | `main`; optional `staging` fast-forwarded from `main` | git `deploy/staging` | git `deploy/main`     |

**CD never builds `staging` or `main` directly** (Roxabi/roxabi-boilerplate-cf#256). The inherited **Deploy gate** (`.github/workflows/deploy-gate.yml` → `scripts/kit/promote-deploy.ts`) fast-forwards `deploy/<branch>` to the newest first-parent commit that descends from it, whose required push runs are all green and whose range has no red Secret scan. Required: kit CI + Secret scan, plus the product workflows declared in `config/product/deploy-gate.json` (mandatory for a product). It never promotes a newer untested push, never goes backwards and never forces. Once the **cutover** is done ([`deploy-cloudflare.md`](./deploy-cloudflare.md) § Cutover), a red commit on `staging` or `main` reaches neither D1 nor the Worker nor the SPA. Inheriting the workflow alone does not switch the dashboards. Break-glass: § Break-glass.

**Who uses which model:** kit HEAD = trunk/`main` only (no kit `staging`). Product consumers default to **trunk + staging pin**: PRs land on `main`; `staging`, if present, is only a fast-forward pin from `main` feeding `deploy/staging`. Kit showcase CD stays `deploy/main` only until B4.

### Builds (product) — two projects, never one Worker’s “non-production”

Cloudflare’s default deploy command is `npx wrangler deploy` (**no** `--env`). Default non-production command is `npx wrangler versions upload` (preview of **that** Worker, **same** D1/R2). Both are forbidden.

| Worker project                | Production branch | Deploy command                                        | Non-production builds |
| ----------------------------- | ----------------- | ----------------------------------------------------- | --------------------- |
| `<api>-staging`               | `deploy/staging`  | `wrangler deploy --env staging`                       | **Off**               |
| `<api>`                       | `deploy/main`     | `wrangler deploy --env production`                    | **Off**               |
| SPA staging (Pages or Worker) | `deploy/staging`  | build with `VITE_API_URL` = staging `BETTER_AUTH_URL` | **Off**               |
| SPA production                | `deploy/main`     | build with `VITE_API_URL` = prod `BETTER_AUTH_URL`    | **Off**               |

A product deploy script guards its branch the same way the kit's does: refuse anything but its `deploy/<branch>` before migrate or deploy.

`scripts/kit/cf-builds/*` cannot deploy staging. Do not copy them onto a `staging` branch.

Builds trigger on **push** of their production branch; only the Deploy gate pushes `deploy/*`, and only green SHAs (lefthook + merge-on-green keep red code off `main`/`staging` as a process; the gate is the enforcement).

Migrate then deploy = two CF APIs, so the running Worker meets the new schema first: a migration that removes schema only as the **contract** step of expand → deploy → contract, marked `-- kit:contract released=<full sha of the deployed release>` and enforced by `migrations-contract:check` ([`deploy-cloudflare.md`](./deploy-cloudflare.md) §5b).

---

## 5. Wrangler layout (fill-in — different ids)

```toml
# Top-level = local `wrangler dev` only. Never CF-deploy this block.
name = "<api>-local"
# [[d1_databases]] / [[r2_buckets]] / [vars] → local ids only

[env.staging]
name = "<api>-staging"
workers_dev = false
preview_urls = false
[env.staging.vars]
ENVIRONMENT = "staging"
BETTER_AUTH_URL = "https://staging.api.example.com"
CORS_ORIGINS = "https://staging.app.example.com"
[[env.staging.routes]]
pattern = "staging.api.example.com"
custom_domain = true
[[env.staging.d1_databases]]
binding = "DB"
database_name = "<api>-staging"
database_id = "REPLACE_STAGING_D1"   # ≠ production id
migrations_dir = "migrations"
[[env.staging.r2_buckets]]
binding = "BUCKET"
bucket_name = "<api>-staging"
[env.staging.triggers]
crons = []

[env.production]
name = "<api>"
workers_dev = false
preview_urls = false
[env.production.vars]
ENVIRONMENT = "production"
BETTER_AUTH_URL = "https://api.example.com"
CORS_ORIGINS = "https://app.example.com"
[[env.production.d1_databases]]
binding = "DB"
database_name = "<api>"
database_id = "REPLACE_PROD_D1"      # ≠ staging id
migrations_dir = "migrations"
```

`REPLACE_*` ids come from `wrangler d1 create` **per plane**. Staging id == production id is a failed review.

```bash
bunx wrangler deploy --env staging      # never omit --env for cloud
bunx wrangler deploy --env production
bunx wrangler d1 migrations apply <staging-db-name> --remote --env staging
bunx wrangler secret put BETTER_AUTH_SECRET --env staging
```

---

## 6. Product (`apps/<product>-*`)

Zero-edit: **do not** patch `apps/example-*/wrangler.toml` or `scripts/kit/cf-builds/*`.

1. New `apps/<product>-api/wrangler.toml` with **both** envs (ids from step 2).
2. `wrangler d1 create <product>-api-staging` · `wrangler r2 bucket create <product>-api-staging` (and a second pair for production).
3. Custom domains on the product zone. Same registrable name for API + SPA **per plane**.
4. **Two** API Worker projects + **two** SPA projects (or Worker-assets), Builds table in §4. **Never** `KIT_SHOWCASE_DEPLOY=1`.
5. Staging SPA build: `VITE_API_URL` required, equal to staging `BETTER_AUTH_URL`.
6. Seed staging with a staging recipe — not a production dump.
7. Account / zone: `config/kit/deploy.cf.local.toml` (gitignored).

Playbook: [`start-product.md`](./playbooks/start-product.md) · contract: [`product-consumer-contract.md`](./product-consumer-contract.md).

---

## 7. Kit showcase (dogfood)

Hosts, Worker names, and CF Builds commands: [`deploy-cloudflare.md`](./deploy-cloudflare.md) only.

The kit examples have no `[env.staging]` or staging D1/R2. Kit CD deploys **`deploy/main` (CI-gated) + `--env production` only**. Do not run `wrangler deploy --env staging` on example-api or example-web, or modify their Wrangler files for a product. Product staging uses product-owned Wrangler files and CD (§6).

Provisioning example staging (B4) requires named staging D1/R2, a second Worker project, and `ENVIRONMENT=staging`, never `development`. The Kit merge process requires secret scan and CI green and fresh native or manual admission with an exact-head receipt before merge-on-green; see [CI App setup](./ci-app-setup.md#reviewed-head-authorization). On GitHub Free private repositories, write access can bypass that process.

---

## 8. Anti-patterns

| Instead                                                        | Use                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| Preview URL / `*.workers.dev` as the SPA↔API pair              | Custom domains, `workers_dev = false`                |
| Versions / `versions upload` of the **prod** Worker as staging | Second Worker project + `[env.staging]` + own D1/R2  |
| Copy `scripts/kit/cf-builds/*` onto git `staging`              | Product deploy command with explicit `--env staging` |
| Copy `[env.production]` UUIDs into `[env.staging]`             | `wrangler d1 create` / `r2 bucket create` per plane  |
| Default `VITE_API_URL` to prod on a staging SPA                | Required build var = staging `BETTER_AUTH_URL`       |
| Open **prod** `CORS_ORIGINS` for the staging SPA               | Staging CORS on the staging Worker only              |
| `ENVIRONMENT=development` on CF                                | Real `BETTER_AUTH_SECRET` (≥32, non-placeholder)     |
| `wrangler deploy` with no `--env`                              | `--env staging` or `--env production`                |
| Copy showcase `ALLOW_PUBLIC_SIGNUP=true`                       | Product default: unset / false                       |

---

## 9. Smoke (staging)

1. Worker `name` contains `-staging` · D1 `database_name` contains `-staging` · ids ≠ production
2. `GET {BETTER_AUTH_URL}/health` → 200 · `ENVIRONMENT` is `staging`
3. SPA `VITE_API_URL` (from the built JS) equals that `BETTER_AUTH_URL`
4. Login from the **staging** SPA origin only — cookie `Secure` + `HttpOnly` · **not** sent to prod API
5. Hard-refresh a deep SPA link
6. Staging email (if on) → allowlisted + `[TEST STAGING]`
7. Staging cron did **not** fire against production D1/R2 (`crons = []` unless dry-run)
