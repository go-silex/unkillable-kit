---
title: 'ADR-0008 — Kit schema identity is module id + hash, not example-api NNNN'
status: accepted
normative: true
date: 2026-08-19
amended: 2026-10-06
axial: false
related:
  - docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md
  - docs/kit/product-consumer-contract.md
  - docs/kit/playbooks/start-product.md
  - docs/kit/kit-schema-sync.md
---

# ADR-0008 — Kit schema identity is module id + hash, not example-api NNNN

Extends [ADR-0001](./0001-primary-axis-packages-compose-apps.md): apps compose `@kit/*`; they do not clone `example-api` as a product.

Operator how-to: [`docs/kit/kit-schema-sync.md`](../../kit-schema-sync.md).

## Problem

`apps/example-api` is three things at once:

| Role                | What it is                                  | What products inferred                   |
| ------------------- | ------------------------------------------- | ---------------------------------------- |
| **Dogfood app**     | Kit prove-out (routes, seed, UI)            | “Copy this tree to start”                |
| **Applied D1 SSoT** | Live SQL in `apps/example-api/migrations/*` | “Those `NNNN_` numbers are kit versions” |
| **Clone template**  | Accidental scaffold                         | Hand-copy 0001–0008, then domain at 0009 |

That inference is false. **D1’s journal is the filename.** Wrangler records `0009_….sql`; you cannot reuse a number, cannot rename applied history, cannot “fix” a collision by editing `d1_migrations` in prod.

For example, a product might copy migrations 0001–0008, use 0009 onward for its domain, and later need a kit migration numbered 0009. Copying that kit file into the same journal would collide with the existing local migration number.

Code clone has the same shape: `example-api/src/lib/better-auth.ts` (`createBetterAuth`, `first_login` hook, email-port) is **app glue**, not a package. Products that copied it port the file on every kit merge.

## Decision

### D1 — Compose, do not clone

Happy path: new `apps/<product>-api` that **imports `@kit/*`**. `cp -R apps/example-api` is last resort, not day-0.

| Do                                                | Do not                                                 |
| ------------------------------------------------- | ------------------------------------------------------ |
| New product API app + import packages             | Clone `example-api` as the product                     |
| Sync kit SQL via `scripts/kit/kit-schema-sync.sh` | Hand-copy `example-api/migrations` then domain at 0009 |
| Last-resort clone: `--adopt` immediately          | Keep dual-editing the copy forever                     |

Last-resort **must** `--adopt` then never add **new** domain SQL in `0001`–`0999`. Frozen history stays; new domain starts at `1000_`.

### D2 — Schema identity = module `id` + sha256

Identity is **not** the example-api filename.

| Fact                                        | Where                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| Module `id` + source path + `kitSha256` pin | Catalog `config/kit/kit-schema-modules.json` (kit)                               |
| sha256 of **kit source bytes**              | Catalog pin; verified at sync against live catalogued file                       |
| Local filename in the product app           | Manifest `apps/<product>-api/kit-schema-manifest.json` (product-owned, new file) |

Product local names are free (`0021_kit_rate_limit_audit.sql`). The journal may differ from the kit’s `0010_rate_limit_audit.sql`; the **hash** must match the kit source.

Manifest JSON keys (sync script): `modules.<id>.kitSha256`, `modules.<id>.productFile`.

### D3 — Catalog identity and applied SQL

| Tree                                 | Status in this ADR                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `config/kit/kit-schema-modules.json` | **Identity SSoT** — module `id` + `kitSha256`                                                        |
| `apps/example-api/migrations/*`      | **Dogfood wrangler journal** — sync hashes these bytes today; not a product scaffold                 |
| `packages/*/migrations/*`            | **Sketches only** — not the product apply path. Gate: `scripts/kit/check-wrangler-migrations-dir.sh` |

`@kit/auth` does **not** export `./migrations/*`. The product apply path is `kit-schema-sync` (catalog) into `apps/<product>-api/migrations`.

### D4 — Sync is append-only

The catalog defines the `core` set, including `0014_better_auth_1_7_additive` and `0015_api_keys_org_not_null`. Omitted `--modules` selects `core` plus the product manifest `sets` array. Explicit `--modules` and `--adopt` record selected sets; when `sets` is absent it is migrated once from recorded ids and canonical headers. An explicit list omitting a recorded set fails if catalog ids in that set are missing from `modules`, naming those ids. Delete the set from `sets` to opt out. `--adopt` fails closed when an unclaimed file matches an unselected set.

```text
scripts/kit/kit-schema-sync.sh --app apps/<product>-api [--modules core|all|<sets>]
```

| Default | omitted `--modules` = `core` ∪ manifest `sets` (greenfield, no manifest → `core` only) |
| Opt-in sets | `rbac` · `audit` · `demo` · `flows` · `tasks` · `notifications` — first opt-in is `--modules core,<set>`; the catalog is SSoT for ids/files. `audit` is required wherever the Better Auth throttle runs: `rate_limit_buckets` ships in it, and a `core`-only database returns 500 on every non-exempt Better Auth request |
| `all` | Every catalogued module at that run, recorded into `sets` — **not** the default; do not use it for sets the product does not mount |
| Write | Append a **new** local file + manifest row |
| Never | Rewrite an applied file · reuse a local `NNNN` · edit `d1_migrations` |
| Hash change | If a **published** module `id` changes bytes → **fail**. Add a **new** `id` (new source file). Do not mutate the old id |

Set ↔ current applied files (catalog remains SSoT):

| Set             | example-api today                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `core`          | The ids labelled `core` in the catalog, not a migration number range                                                          |
| `rbac`          | `0009_organization_roles_grants.sql`                                                                                          |
| `audit`         | `0010_rate_limit_audit.sql`                                                                                                   |
| `demo`          | `0011_demo_items.sql`                                                                                                         |
| `flows`         | `0012_flows_plans_runs.sql`, `0016_flows_run_approvals.sql`, `0017_flow_run_events.sql`                                       |
| `tasks`         | `0013_tasks_comments.sql`, `0018_tasks_assignees_org.sql`, `0019_tasks_org_fk_contract.sql`, `0020_tasks_stage_org_guard.sql` |
| `notifications` | `0023_notifications.sql`                                                                                                      |

### D5 — Product SQL numbering

| Kind                      | Band                                   | Rule                                                                                                                          |
| ------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Greenfield** after sync | Kit local `0001`–`0999` (`NNNN_kit_*`) | Product domain starts at **`1000_`** (gap)                                                                                    |
| **Existing clone**        | Domain already below `1000_`           | **Freeze** that history. `--adopt` core. Later kit modules **append** with available local numbers. New domain at **`1000_`** |
| Last-resort `cp`          | Applied 0001–0008 (or more)            | `--adopt` immediately; no new domain SQL below `1000_`                                                                        |

### D6 — Code glue is importable (`@kit/auth`)

**Shipped 2026-08-20.** Products **import**; they do not port `example-api/src/lib/better-auth.ts`.

| Piece                                                                           | Where                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createBetterAuth({ database, secret, baseURL, emailPort?, emailConfig?, … })`  | `@kit/auth/factory` (not the root barrel — SPA/MCP stay free of `better-auth`); when supplying `emailPort`, also supply `emailConfig: { productName, fallbackLocale, resolveRecipientLocale }`                                                      |
| Drizzle BA tables                                                               | `@kit/auth/schema` — `drizzle-orm` is an **optional peer** of `@kit/auth`. The product API that imports `./schema`, `./factory`, or `./repos/*` must declare it (`example-api` already does). Root barrel and `./react` stay drizzle-free.          |
| Env helpers (`getBetterAuthSecret`, `betterAuthBaseURL`, cors, signup, cookies) | `@kit/auth` — **required** with the factory (min-32 + placeholder denylist also runs inside `createBetterAuth`)                                                                                                                                     |
| Magic-link + reset send via EmailPort                                           | Optional `emailPort` on `@kit/auth/factory` (`sendMagicLinkMail` / `sendResetPasswordMail`), with required `emailConfig: { productName, fallbackLocale, resolveRecipientLocale }` when the port is supplied. Omit the port to skip those plugins.   |
| `first_login` hook                                                              | `@kit/auth` `onFirstSession` / `createFirstSessionAfterHook` — product supplies the audit insert (`tryFirstLogin`). Its `audit_events` table ships in the `audit` set, which a product that mounts Better Auth always syncs (Opt-in sets row above) |
| Welcome / invite mail                                                           | already `@kit/email` `build*EmailText` + app `resolveEmailPort`                                                                                                                                                                                     |

`example-api/src/lib/better-auth.ts` is a thin **Env adapter** (dogfood): maps Worker env → factory opts + lazy `emailPort` + `onFirstSession`. It is the mapping example, not a second factory. Do not `cp` it as the BA implementation.

`emailPort.send` runs only when BA sends mail. Do **not** call `resolveEmailPort(env)` at factory construction — that 500s every request (including `/health`) when staging/prod lacks `EMAIL_TRANSPORT`. Wrap: `emailPort: { send: (input) => resolveEmailPort(env).send(input) }, emailConfig: { productName, fallbackLocale, resolveRecipientLocale }`.

SQL identity is still D1–D5 (this ADR). D6 does **not** move applied SQL into `packages/*/migrations`.

## Consequences

- Second product compose (ADR-0001 test) does not fork D1 numbers.
- Kit can add 0009+ in example-api; products already on 0009-domain still append via sync.
- Manifest is an allowed product file (zero-edit free). Products **must not** edit `apps/example-api/migrations`.
- A set that was never recorded in manifest `sets` is not a “stay current” obligation. A set that is recorded is: new catalog ids of that set are part of default sync. To leave a set, delete it from `sets` (applied module rows stay; new ids of that set are not applied).

## Anti-patterns

| Anti                                                                                                               | Why                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Copy kit `0009_*.sql` into a product that already has `0009_*.sql`                                                 | D1 journal collision                                                                                                          |
| Rewrite `d1_migrations` in prod (or any applied DB)                                                                | History is the database                                                                                                       |
| Rename applied migration files to “make room”                                                                      | Same — journal = filename                                                                                                     |
| `--modules all` / port `demo_items` · flows · tasks “to stay current” when the product does not mount those routes | Records those sets in `sets` (dead schema + merge noise). Leaving one later is a `sets` edit, not a narrower `--modules` list |
| Dual-edit kit `better-auth.ts` (or kit migrations) in the product                                                  | Forever-conflicts; import `@kit/auth/factory`                                                                                 |
| Treat `packages/*/migrations` as applied SSoT                                                                      | Sketches; hashes would drift from example-api                                                                                 |

## Non-goals

- Implementing product domain SQL in the kit
- Moving applied SSoT into `packages/*/migrations` (later ADR)
- Editing any product tree from the kit
