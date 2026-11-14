# Start a product from this kit

**Audience:** engineer spinning a greenfield product that takes this monorepo as git `upstream`.

## Architecture default — compose, do not clone

Kit SQL identity is **module id + hash**, not `example-api` `NNNN_` filenames. Normative: [ADR-0008](../architecture/adr/0008-kit-schema-identity-product-compose.md) · how-to: [`docs/kit/kit-schema-sync.md`](../kit-schema-sync.md).

| Do                                                                                                                                                                                                                  | Do not                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| New `apps/<product>-api` importing `@kit/*`                                                                                                                                                                         | `cp -R apps/example-api` as happy path                                                                                                        |
| `bash scripts/kit/kit-schema-sync.sh --app apps/<product>-api` after creating the app (fresh default: `core,audit`)                                                                                                 | Hand-copy `example-api/migrations` and then put domain SQL at 0009                                                                            |
| Product SQL from `1000_`                                                                                                                                                                                            | Reuse kit 0009–0999 for domain                                                                                                                |
| Import `createBetterAuth` from `@kit/auth/factory` + tables from `@kit/auth/schema` + env helpers from `@kit/auth`, mounted per the [Better Auth mount contract](../product-consumer-contract.md#better-auth-mount) | Copy `example-api/src/lib/better-auth.ts` as the BA factory / `better-auth-schema.ts` · skip `corsAllowlist` and pass `trustedOrigins: ['*']` |
| Existing clone: freeze history, `--adopt` (no manifest yet → core,audit; other applied sets must be named or the command exits 1); later runs omit `--modules`                                                      | Rename applied files                                                                                                                          |

**Last resort:** if you already cloned `example-api`, run `--adopt` **immediately**, then never add new domain SQL in `0001`–`0999` (frozen history stays; new domain at `1000_`).

```bash
bash scripts/kit/kit-schema-sync.sh --app apps/<product>-api --adopt
```

## Which parent to clone

Clone the **immediate** parent. This file does not name which clone is HEAD vs mirror. Classify this tree with `node scripts/kit/resolve-tree-identity.mjs` (origin + `config/product/inheritance.json` / `kit_origin_allowlist`). Which URL to clone is operator topology. Remotes and deny-upstream: [`product-consumer-contract.md`](../product-consumer-contract.md).

For a mirrored kit, clone and pin the mirror rather than the original kit HEAD. The operator determines the parent URL.

| Repo     | `inheritance.json` | Why                                                                                                                |
| -------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Kit HEAD | **absent**         | kit mode                                                                                                           |
| Mirror   | **absent**         | allowlisted kit mode. A marker here is a hard error. Mirror `upstream` = HEAD and **may** push for kit contribute. |
| Product  | **required**       | product mode. `upstream` = immediate parent, push URL `no_push`.                                                   |

A product has one parent and does not add a remote to its grandparent. Kit HEAD ships `config/kit/deny-upstream-remotes.json` with `Roxabi/roxabi-boilerplate-cf`. The hook normalizes remote URLs to `owner/repo` and matches that identity exactly (HTTPS, `ssh://`, or scp-style `[user@]host:owner/repo`, with or without `.git`). Products inherit the file and do not name the grandparent. A mirror must not edit it: the edit would conflict on every HEAD sync. The product's immediate parent is already blocked by the remote name `upstream`. Pinning a HEAD SHA while the tree inherited the mirror (or the reverse) is a failed start. Mirror synchronization is an operator concern, not a product gate ([ADR-0009](../architecture/adr/0009-kit-namespace-polarity-inheritance-marker.md) D4/D8).

## Day-0 checklist

**Product bootstrap uses an independent repository, not the GitHub Fork button.** This is a Product topology rule, not a restriction on copying or forking the public MIT-licensed Kit; contribution permissions are in [CONTRIBUTING](../../../CONTRIBUTING.md). Polarity gates are separate: `deny-upstream` is a no-op only when `config/product/inheritance.json` is absent; `zero-edit` is product-mode whenever that marker exists and origin is **not** in `kit_origin_allowlist`. A fork named `org/<product>` plus the marker works, but remains coupled to the GitHub fork network. A fork that keeps a Kit slug without a marker fails closed (`cannot classify`). Start a Product from an empty repository so its visibility, deletion and PR destination remain independent of the Kit.

1. Create an **empty** private product repo `org/<product>`. Do not GitHub-fork this kit.
2. Inherit history from the **immediate parent** (table above), without keeping that parent as `origin`:

   ```bash
   git clone <immediate-parent-url> <product>
   cd <product>
   git remote rename origin upstream
   git remote add origin <product-repo-url>
   git remote set-url --push upstream no_push
   git push -u origin main
   gh repo set-default <org>/<product>
   ```

   `gh repo set-default` is required: with both remotes and no default, `gh` ranks `upstream`
   ahead of `origin`, and every `issue-triage` command then writes to the parent repo
   ([roxabi-plugins#614](https://github.com/Roxabi/roxabi-plugins/issues/614)).
   Then pin the inherited tip. Do **not** create or push a landing branch named `staging`:

   ```bash
   mkdir -p config/product
   printf '{\n  "version": 1,\n  "upstreamCommit": "%s"\n}\n' "$(git rev-parse upstream/main)" > config/product/inheritance.json
   git add config/product/inheritance.json
   git commit -m "chore(product): pin kit inheritance"
   ```

   The kit parent has no `staging` branch. Commit the marker on day-0 so `zero-edit` classifies product mode. Fill `name`, `backend.path`, `release.component`, and either `frontend.path` or a whole-block `frontend: null` (API-only; no frontend App) in the same commit or the next one — `stack-contract:check` refuses the upstream values. The guard compares those values; it does not check that a path exists on disk. Keep `frontend: null` on upgrade.
3. `bun install` · ensure lefthook hooks.
4. Copy env examples → gitignored local files only (`.dev.vars`, etc.).
   Public sign-up is **off** unless you set `ALLOW_PUBLIC_SIGNUP=true` (then SPA `/sign-up` appears). Leave unset for invite/admin-only.
   `CORS_ORIGINS` is required outside `development|test` (never `*` / `null`; localhost default is local-only).
5. **CI App for merge-on-green:** configure the recommended target-only GitHub App, or an explicitly approved [shared-App owner exception](../ci-app-setup.md#shared-app-owner-exception), with repository-level `CI_APP_PRIVATE_KEY`, `CI_APP_ID` and all four numeric-identity `HEAD_AUTH_*` variables per [CI App setup](../ci-app-setup.md#trust-and-setup). On GitHub Free private, org-level Actions values do not reach private repos. If the App is verified inactive, use separately authorized manual merges; a missing key or unreadable configuration is not inactive mode.
   An App-only `main` ruleset blocks that manual path; follow its [bounded disable and restore procedure](../ci-app-setup.md#manual-landing-with-an-app-only-ruleset).
   Run `issue-triage init` on the product repo, after `gh repo set-default <org>/<product>` (step 2): `gh` ranks a remote named `upstream` ahead of `origin`, and without the default, init writes to the parent repo while printing `writes: 0`. It keeps the inherited contract (`contract: keep-existing`, byte-identical, so `zero-edit` stays green) and creates the seven triage labels (`size:*`, `P0-critical`…`P3-low`) from [`docs/agents/issue-tracker.md`](../../agents/issue-tracker.md) § Labels. Run `--dry-run` first and require two things: `repo: <org>/<product>`, and `relabel issues: 0` — a non-zero count means init will rewrite existing issue labels (`size:m` → `size:F-lite`, `priority:*` → `P*-*`, and it removes `ready-for-agent`), so stop if that family belongs to the product. Colours apply only to labels init creates; the `--force` block in § Labels fixes existing ones. `issue-triage` refuses a label the repo does not carry, and `dev-review` reads the review tier only from `size:`. The contract file itself is inherited unchanged (kit surface: `tool_mandated_paths` + `protected_files`); product additions go to `docs/product/issue-tracker.md`. `/feature init` leaves it untouched too. Repo resolution is tracked upstream: [roxabi-plugins#614](https://github.com/Roxabi/roxabi-plugins/issues/614).
6. Choose the Product's terms in the root `LICENSE` ([Zones](../product-consumer-contract.md#zones)), then add product apps only under `apps/<product>-*`.
   Stage each Product App `package.json`, then run `node scripts/kit/configure-product-dependabot.cjs` and `bun run zero-edit`; commit the generated `.github/dependabot.yml` with the setup. The [bounded Product scan](../product-consumer-contract.md#product-dependabot-configuration) is the only content-based customization at this protected path. Kit manifests and inherited workflow pins update upstream first; App-only scanning does not prove isolation of Bun workspace mutations or shared-lock support. Review the whole `bun.lock` and use the documented manual route if the robot cannot produce a conforming diff. Keep Dependabot alerts enabled; Bun has no native security-update PRs.
7. When `apps/<product>-api` exists: `bash scripts/kit/kit-schema-sync.sh --app apps/<product>-api`. Fresh Products get `core,audit`; the throttle needs `audit`. Existing manifests retain their recorded selection. Named opt-in: [Core vs opt-in](#core-vs-opt-in). Last-resort clones: `--adopt` immediately (fail-closed if copied bytes drifted, or if an applied file matches an unselected set). Do not hand-copy `apps/example-api/migrations`. Product domain SQL starts at `1000_`.
8. Auth: `createBetterAuth` from `@kit/auth/factory` (per-request factory, magic-link + reset EmailPort, optional `onFirstSession`). Mount it per the [Better Auth mount contract](../product-consumer-contract.md#better-auth-mount); step 7 already synced its schema sets. Env helpers (`getBetterAuthSecret`, `assertBetterAuthConfigured`, `allowPublicSignup`) from `@kit/auth`. Tables: `@kit/auth/schema`. SPA forgot/reset/change-password forms from `@kit/auth/react` (app owns routes, chrome, catalogs). See `example-api/src/lib/better-auth.ts` only as a **thin Env adapter**, not the factory. Never import `@kit/auth/react` from a Worker.
9. Keep `bun run validate:full` green (kit bar). Wire product-validate when product apps exist ([`docs/kit/templates/`](../templates/)).
10. Cloudflare: copy `config/kit/deploy.cf.example.toml` → `config/kit/deploy.cf.local.toml` (gitignored), fill **account id** + zone/hosts. Planes / `[env.staging]` / `[env.production]` / cookies: [`docs/kit/environments.md`](../environments.md). Showcase CD commands (kit HEAD only): [`docs/kit/deploy-cloudflare.md`](../deploy-cloudflare.md). Account is never assumed by the kit. Connect the product's Workers Builds / Pages with production branch **`deploy/main`** (and `deploy/staging` for the staging projects), never `main`/`staging`: the inherited Deploy gate moves them only after CI is green. Commit `config/product/deploy-gate.json` listing your product workflows, then follow the cutover order ([deploy-cloudflare.md](../deploy-cloudflare.md) § Cutover, [environments.md](../environments.md) §4).
11. UI locales: `apps/<product>-web` `createI18n({ defaultLocale, catalogs })`. **Catalog keys are the locale policy.** One locale → `LocaleSwitcher` is hidden (no FR/EN chrome). Kit `example-web` dogs FR+EN; do not patch it.

## Project foundations and first issue

1. Decide the authentication surfaces (session cookie or `sk_`), and choose organization modules and roles if the product is multi-tenant ([ADR-0003](../architecture/adr/0003-multi-tenant-rbac-modules.md)).
2. Compose `@kit/ui` in `apps/<product>-web`; product CSS token overrides are allowed. Inventory environment variables for the product apps, not only `example-api`.
3. Capture the product brief in `docs/product/*`, then open the tracker and GitHub issues.
   The product agent entry point is `docs/product/AGENTS.md`; the kit `AGENTS.md` routes agents to it when present.
4. Implement under `apps/<product>-*` and product workflows as needed. If the API exists, run `bash scripts/kit/kit-schema-sync.sh --app apps/<product>-api` to sync its recorded sets. The product-owned manifest is not checked by kit `validate:full`. If Better Auth is mounted but `audit` is absent, run once with `--modules` naming `core`, `audit`, and every recorded set; see the [mount contract](../product-consumer-contract.md#better-auth-mount).
5. Run `bun run validate:full` and product validation when product apps exist ([templates](../templates/)). Open the PR against product `main`, not a `staging` landing branch.

Land shared kit fixes on a kit clone; products receive them by fetching and merging their immediate `upstream`.

## Stack map

After inherit, fill these keys in [`.dev/stack.yml`](../../../.dev/stack.yml) so they differ from the inherited file, or replace the whole `frontend` block with `frontend: null` when the product has no frontend App ([Roxabi/roxabi-boilerplate-cf#591](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/591)). The file is product-owned ([Roxabi/roxabi-boilerplate-cf#260](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/260)); no zero-edit exception. `check-stack-contract` is what replaces byte-equality. Keep `frontend: null` on upgrade. The guard compares values, not filesystem existence.

- `name`
- `backend.path` — `apps/<product>-api`
- `frontend` — `frontend.path` as `apps/<product>-web`, or replace the whole block with `frontend: null` when the product has no frontend App
- `release.component`

On `git merge upstream/main`, keep those scalars, including an API-only `frontend: null`, and any `worktree.copy` additions; take kit keys for everything else. Never take the kit frontend map back over `frontend: null`. Never keep the product file wholesale. The guard compares values, not filesystem existence.

`landing.mode` is inherited (`merge-on-green`). Override it to `native` only when the product is on native branch protection. `check-stack-contract` rejects any `landing.required_checks` (`merge-on-green.yml` owns the list) and any `bun.*version` key.

`release.model` is inherited `trunk`. `/feature` bases on `main`. `/promote` with no ref named `staging` is `trunk_mode`: it does not apply; a release is an annotated tag, not a promote. A staging **environment** is optional and is not a PR base: fast-forward a pin named `staging` from `main`, and the Deploy gate (`SOURCE_BRANCH=staging`) moves `deploy/staging`. That pin must be a ref named `staging` — `promote-deploy.ts` sets `target = deploy/${source}`, so `deploy/staging` is not fed from `main` directly. omp-build `/promote` preflight treats any `refs/heads/staging` or `origin/staging` under trunk as `trunk_promote_pr` (opens a staging→main PR, never tags). It cannot tell that pin from a landing branch. Gap, not fixed here: [roxabi-plugins](https://github.com/Roxabi/roxabi-plugins) `plugins/omp-build/skills/promote/preflight.sh`. Do not create the pin unless you want that behaviour.

## Core vs opt-in

Day-0 default is `core,audit`: the Better Auth throttle needs `rate_limit_buckets`, which ships in `audit`, and without it every non-exempt Better Auth request returns 500. A Product not mounting Better Auth may explicitly select `--modules core`. Adding any other set is an explicit operator decision. A later run with `--modules` omitted retains recorded sets and appends their new catalog ids; it does not silently add `audit` to existing selections.

| Default Day-0                                                                                                     | Opt-in (named)                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth (`@kit/auth` / `createBetterAuth`), default schema sync (`core,audit`), UI primitives, zero-edit marker, env | tasks (`@kit/tasks`), comments (`@kit/comments`), flows (`@kit/flows`), notifications (`@kit/notifications`), MCP product tools (`@kit/mcp`) |

Every command below names `audit`. Keep it when mounting Better Auth or composing Notifications administration writes; omit it only when neither requires the audit tables.

| Module            | Package                                                 | ADR / anchor                                                                   | Compose                                                                                                                                                                                     | Lives in                                                                       |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| tasks             | `@kit/tasks`                                            | [ADR-0007](../architecture/adr/0007-tasks-comments-kernel.md)                  | `bash scripts/kit/kit-schema-sync.sh --app apps/<product>-api --modules core,audit,tasks`                                                                                                   | `apps/<product>-api`                                                           |
| comments          | `@kit/comments`                                         | [ADR-0007](../architecture/adr/0007-tasks-comments-kernel.md)                  | no catalog set `comments`; D1 is set `tasks` (id `tasks_comments`) — same `--modules core,audit,tasks` as above                                                                             | `apps/<product>-api`                                                           |
| flows             | `@kit/flows`                                            | [ADR-0005](../architecture/adr/0005-flows-platform-agentic-workflows.md)       | `bash scripts/kit/kit-schema-sync.sh --app apps/<product>-api --modules core,audit,flows`                                                                                                   | `apps/<product>-api`                                                           |
| notifications     | `@kit/notifications/schema`, `@kit/notifications/repos` | [ADR-0019](../architecture/adr/0019-notifications-rules-inbox-and-delivery.md) | `bash scripts/kit/kit-schema-sync.sh --app apps/<product>-api --modules core,audit,notifications`; compose `notificationsDrizzleSchema`; administration writes also require the `audit` set | `apps/<product>-api`; a schema set, not a governed Module                      |
| MCP product tools | `@kit/mcp`                                              | [`packages/mcp`](../../../packages/mcp/README.md)                              | no SQL set; import `createToolCatalogue` from `@kit/mcp`                                                                                                                                    | the Worker that serves MCP                                                     |
| Remote MCP AS     | `@kit/mcp/hosted`                                       | [ADR-0015](../architecture/adr/0015-mcp-remote-oauth-worker.md)                | `createHostedMcpWorker`; declare the optional peers                                                                                                                                         | dedicated `apps/<product>-mcp` **or** the product Worker through `fallthrough` |

### Remote MCP OAuth (compose, do not fork)

Hosted Streamable HTTP + the Worker authorization server are kit protocol ([ADR-0015](../architecture/adr/0015-mcp-remote-oauth-worker.md)). Compose:

1. Call `createHostedMcpWorker` from `@kit/mcp/hosted`. Do **not** copy `OAuthProvider` construction or fork a second authorization server. A separate `apps/<product>-mcp` Worker is optional.
2. Plug `McpIdentityPort` (kit dogfood = Better Auth identity ticket). Its function form and `apiBaseUrl(env, request)` receive no `OAUTH_PROVIDER`; the port resolves identity, never mints. Register tools per authenticated `/mcp` request with `register(server, { identity })`.
3. Use optional `fallthrough` only for trusted product routes in the same Worker. It is not a sandbox or authorization point; it receives an env without `OAUTH_PROVIDER` and unchanged `ctx`. Omit it for `404`. The shell answers `fetch` only: export `{ ...productWorker, fetch: hosted.fetch }` so the product's `queue` and `scheduled` handlers survive. Co-location puts the consent page on the product origin, where any script running there (XSS, user content, third-party script) can approve consent for the signed-in user; an origin that serves user content or third-party script uses the dedicated Worker instead.
4. Keep `/mcp` (including its prefix), `/authorize`, `/token`, `/register`, and `/.well-known/oauth-*` out of `fallthrough`; their encoded, trailing-slash, and doubled-slash forms are also reserved. Exclude all of them from Cloudflare Access.
5. Bind `OAUTH_KV`; deployed composes set `ENVIRONMENT=production` or `staging` and `MCP_PUBLIC_URL` to their public https origin (MCP at `<origin>/mcp`); CIMD needs `global_fetch_strictly_public` as its SSRF guard. Unset `ENVIRONMENT` plus a loopback-looking URL activates development DCR and `demo-loopback` policy; unset `MCP_PUBLIC_URL` serves OAuth only on a loopback development host.

Do not put Workspace client ids in kit secrets. FastMCP `GoogleProvider` is not the MCP resource AS.

`@kit/tasks` and `@kit/comments` are **incubating** and usable by products (ADR-0007 D6 / package.json). Their schemas and repositories are delivered, and Example App dogfoods them through `example-api` and `example-web`; migration files exist, but their application to any particular database is deployment-specific. Promotion remains separate: it requires a stable schema, a green example, and a first real product compose. ADR presence ≠ promotion.

Catalog sets without a package boundary are SQL only: `audit` is in the fresh default, while `rbac` and `demo` require explicit selection. `audit` is required for a Product that mounts Better Auth. Sync several at once with a comma list including `core` and every recorded set; `--modules all` takes every set that exists at that run and records them.

## Contract

- Zero-edit + remotes: [`docs/kit/product-consumer-contract.md`](../product-consumer-contract.md)
- Org map / which URL is kit parent: **operator SSoT** (outside this repo)
- CF account / zone for deploy: **local** `deploy.cf.local.toml` (not kit defaults)

## Never

- Bootstrap a Product through the GitHub **Fork** button (fork network, not polarity); this does not forbid public contribution forks
- Skip `config/product/inheritance.json` on day-0
- Pin a HEAD SHA when `upstream` is the mirror (or the reverse)
- Add a remote from a product to kit HEAD. The product talks only to its immediate parent.
- Edit kit-owned paths for product config
- `git push upstream` from a product clone
- Commit secrets
- Point wrangler `migrations_dir` at `packages/*/migrations` (not the apply path; journal is `apps/<api>/migrations`)
