# Kit schema sync (product D1)

**Normative:** [ADR-0008](./architecture/adr/0008-kit-schema-identity-product-compose.md).  
**Catalog (kit):** `config/kit/kit-schema-modules.json`.  
**Manifest (product, allowed new file):** `apps/<product>-api/kit-schema-manifest.json`.

Identity = catalog **module `id` + sha256 of kit source bytes** — not the example-api `NNNN_` filename.

## Source bytes

Identity is catalog **module `id` + `kitSha256`**. Sync hashes the files under catalog `source_root` (today the dogfood journal `apps/example-api/migrations/*` — wrangler apply path, not a clone template).
`packages/*/migrations/` contain README only (no `.sql`). Do not copy them into a product and do not point wrangler at them. `@kit/auth` does not export `./migrations/*`. Machine gate: `bun run wrangler-migrations:check` fails if any wrangler `migrations_dir` resolves under `packages/`.

The `tasks` set includes the additive `kit_tasks_stage_org_guard` id, which protects task stage ownership without rebuilding `kit_tasks`. The catalog and local journal include the `0019` contract and subsequent stage guard; they do not prove application to any remote database. Follow the expand/deploy/contract ordering and inspect purge counts before any authorized contract apply. The organization FK rebuild scripts under `apps/example-api/migrations-pending/` are not journaled or catalogued and are not synced. Their headers specify the per-database counts, approvals and promotion steps required before any later release.

The `notifications` set adds the `notifications` id from `0023_notifications.sql`, leaving pending `0021`/`0022` untouched. It is opt-in and does not add a governed Module or disable Inbox. Compose `notificationsDrizzleSchema` from `@kit/notifications/schema`; use `@kit/notifications/repos` for persistence. Include `audit` when composing administration writes, which commit into the existing `audit_events` table. The pure root needs no SQL; each consumer composes producer wiring and an external Delivery runtime separately from schema sync.

The additive `impersonation` id from `0024_impersonation.sql` belongs to `core`. It creates default-off Platform Role permissions and delegations tied to existing Better Auth session records; it grants no authority merely by being installed. Compose the tables through `kitAuthSchema` from `@kit/auth/schema`. Apps using the repositories retain `audit`, including for required start/configuration events and pre-dispatch request attempts.

## Happy path (greenfield)

1. Create `apps/<product>-api` that **imports `@kit/*`** — do not `cp -R apps/example-api`.
2. Sync kit modules. The fresh default includes `core,audit`, required by the [Better Auth mount contract](./product-consumer-contract.md#better-auth-mount):

```bash
bash scripts/kit/kit-schema-sync.sh --app apps/<product>-api
```

3. Product domain SQL starts at **`1000_`**. Leave `0009`–`0999` for later kit appends (`NNNN_kit_*`).

Opt-in sets (only if the product **mounts** those routes). A product that mounts Better Auth keeps `audit` in every list: step 2 installed it.

```bash
bash scripts/kit/kit-schema-sync.sh --app apps/<product>-api --modules core,audit,rbac
bash scripts/kit/kit-schema-sync.sh --app apps/<product>-api --modules all   # every catalogued module — not default
```

With no `--modules`, a fresh Product selects and records `core,audit`; an existing manifest selects `core` ∪ its recorded `sets`, never silently adding `audit` on upgrade. A manifest without `sets` derives them once from recorded ids and canonical headers. To add a set explicitly, name `core` and all recorded sets. A single non-core set exits 1 while any core id is absent. An explicit list that omits a recorded set exits 1 when that set has catalog ids absent from `modules`, and names those ids. Opt out by deleting the set from `sets` (applied module rows stay). A Product that mounts Better Auth cannot opt out of `audit`: its `rate_limit_buckets` table is required by the throttle, without which every non-exempt auth request returns 500. `all` records every catalog set at that run, not future sets.

## Existing clone (already copied example-api)

D1 journal = filename. Do **not** rename applied files. Do **not** rewrite `d1_migrations`.

1. Freeze domain history already at `0009`–`0020` (or whatever you applied).
2. Adopt kit files already present. `--adopt` is fail-closed: selected modules must match kit bytes (or already be recorded). It does **not** append missing modules.

```bash
bash scripts/kit/kit-schema-sync.sh --app apps/<product>-api --adopt
# no manifest yet: core,audit. Unclaimed files that match another catalog set exit 1
# and print `run without --adopt: --modules core,<sets>`. Re-run that command
# without --adopt: adopt cannot append a missing id of a partial set (0012 present,
# 0016 absent). The printed list is the union of sets you passed and sets on disk.
```

Later kit sets append **without** `--adopt`:

```bash
bash scripts/kit/kit-schema-sync.sh --app apps/<product>-api --modules core,audit
```

3. Later kit modules **append** as local `NNNN_kit_*.sql` (e.g. `0021_kit_rate_limit_audit.sql`).
4. **New** product domain SQL at **`1000_`** — never in `0001`–`0999`.

## Last-resort `cp -R apps/example-api`

If you cloned the dogfood app: run `--adopt` **immediately**, then follow the existing-clone rules. This is not day-0.

## Fail-closed (script)

| Event                                                                                                  | Sync                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published module `id` bytes changed (catalog `kitSha256` ≠ live SQL, or recorded product sha ≠ kit)    | **Fail** — kit must add a **new** id, never mutate the old one                                                                                                       |
| `--adopt` selected module not present (sha/header miss)                                                | **Fail** — lists unmatched ids; does not write a partial manifest                                                                                                    |
| `--adopt`, missing manifest, or `sets` absent, and an unclaimed file matches an unselected catalog set | **Fail** — prints `run without --adopt: --modules <union>`. That command records present files and appends missing ids. `--adopt` cannot, because it does not append |
| Manifest missing, or `modules` not an object, while a `-- kit-schema:` file exists                     | **Fail** — does not rebuild a core-only manifest                                                                                                                     |
| Target resolves to `apps/example-*`                                                                    | **Fail** — example-api **is** the applied SSoT                                                                                                                       |
| Dest `NNNN_kit_<id>.sql` already exists                                                                | **Fail**                                                                                                                                                             |
| Kit band `0001`–`0999` exhausted                                                                       | **Fail**                                                                                                                                                             |
| Explicit `--modules` omits a set still listed in `sets` that has catalog ids absent from `modules`     | **Fail** — names those ids; does not write a partial selection                                                                                                       |

Occupied local `NNNN` (including frozen clone domain files): skip that number and append the next free prefix **in 0001–0999**. Product `1000_` files do not occupy kit slots.

Product edits of `apps/example-api/migrations` are forbidden by **zero-edit**, not by this script.

Append-only: never rewrite an applied local file.

## Manifest

Product-owned. JSON keys (see [`templates/kit-schema-manifest.example.json`](./templates/kit-schema-manifest.example.json)): `version`, `app`, `sets`, `modules.<id>.kitSha256`, `modules.<id>.productFile`. `sets` records the fresh default, explicit `--modules`, and `--adopt`. A manifest without `sets` is migrated once from recorded ids and canonical `-- kit-schema:` headers, then written. Deleting a name from `sets` is the opt-out. `kitSha256` is the hex sha256 of **kit source bytes** (not of the headed product copy). Do not dual-edit the catalog by hand in a product.

## Not this doc

- Code glue: import `createBetterAuth` from `@kit/auth/factory` (ADR-0008 **D6**). Do not copy `example-api/src/lib/better-auth.ts` as the factory.
- Do not port `demo` / `flows` / `tasks` SQL unless the product mounts those routes.
