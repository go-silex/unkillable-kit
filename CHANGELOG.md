# Changelog

New entries go under `Unreleased`. A release moves them under a `<component>/vX.Y.Z` section; tagged sections are not rewritten. Start a bullet with `**Product action:**` when Products must act because of a migration, an API or behaviour change, or new required configuration.

## Unreleased

### Auth

- `createBetterAuth` (`@kit/auth/factory`) checks its configuration when called, as before, and
  builds the Better Auth instance, its Drizzle database and its plugins on the first use of the
  handle it returns. Request authorization reads the session cookie issuer without building it, so
  a request that does not reach Better Auth no longer constructs it: in the reference composition,
  every route outside `/api/auth/*`. Each call still builds and owns its own instance; nothing is
  shared across requests (go-silex/unkillable-kit#226).
- An error that Better Auth itself throws while building its instance now surfaces on the first
  use of the handle, not from `createBetterAuth`. The Kit's own configuration checks still throw
  from the call.

## unkillable-kit/v0.12.0 — 2026-11-27

### Auth

- `createBetterAuth` (`@kit/auth/factory`) builds on the `better-auth/minimal` initializer with
  the same options, Drizzle adapter, hooks and plugins. It leaves out Kysely, its Better Auth
  adapter and the built-in migration runner, so a Worker with no other importer no longer bundles
  them; the instance cannot run Better Auth migrations, and schema changes stay Drizzle
  migrations (go-silex/unkillable-kit#214).
- `better-auth:check` accepts the factory's Better Auth server import from `better-auth` or
  `better-auth/minimal`; a Wrangler alias that moves either outside the installed package still
  fails it.
- **Product action:** A Product test that mocks `better-auth` to replace the initializer behind
  `createBetterAuth` mocks `better-auth/minimal` instead.

### Validation

- Kit packages and examples import Zod as `import * as z from 'zod'`, so a Worker bundles the
  English locale only, not every Zod locale. Issues and message text are unchanged. A lint rule
  keeps `import { z }` and the default Zod import out of Kit paths; Product paths are not
  checked. A Product's own `import { z } from 'zod'`, and dependencies that import Zod that way
  (`@hono/zod-openapi`, `fastmcp`), still bundle every locale (go-silex/unkillable-kit#214).

### MCP

- `@kit/mcp/hosted` evaluates its shell (OAuth provider, FastMCP Edge server, consent page) on
  the first request to a reserved path of the pinned origin. Product routes reach `fallthrough`
  without evaluating it or building a provider, on every origin and configuration, and the
  shell's answers are unchanged. A bundled Worker still uploads the shell, and the lazily
  evaluated modules tree-shake less: the upload is larger than with an eager shell, by about
  75 KiB raw in a co-located fixture and 145 KiB in the dedicated MCP example
  (go-silex/unkillable-kit#214).

## unkillable-kit/v0.11.1 — 2026-11-27

### UI

- `@kit/ui` ships a command palette with shell-scoped sources, keyboard navigation, and
  cancelable async search. The Example App registers navigation and notes search
  (go-silex/unkillable-kit#201).

## unkillable-kit/v0.11.0 — 2026-11-26

### Deploy

- Deploy verify (`.github/workflows/deploy-verify.yml`) checks after each Deploy gate run that
  evaluated a branch that every Worker listed in `config/product/deploy-verify.json` serves the
  commit of `deploy/<branch>`, and posts a Slack alert when one does not by the deadline, once
  per branch and commit across automatic runs. The deadline is the promotion time plus 20 minutes
  by default, derived from observed Workers Builds durations. Opt-in: without the file, a notice
  and nothing verified. It holds no Cloudflare credential and only reads the repository.
  Runbook: `docs/kit/deploy-verify.md` (go-silex/unkillable-kit#215).
- Outside Workers Builds, `require-deploy-sha.sh` refuses any uncommitted or untracked file, even
  when `WORKERS_CI_COMMIT_SHA` names `HEAD`. Deploy break-glass from a fresh checkout: ignored
  files are not checked.
- The showcase `api-deploy.sh` tags each Worker version with its verified commit
  (`wrangler deploy --tag`) and refuses before migrate when it cannot verify it. The Example API
  declares the `version_metadata` binding and its health response gains `versionTag`, sent with
  `Cache-Control: no-store`.
- **Product action:** To adopt Deploy verify, tag the version in each Product deploy script with
  `sha="$(bash scripts/kit/cf-builds/require-deploy-sha.sh)"` as its own assignment under
  `set -e`, after the branch guard and before migrate, then `wrangler deploy --tag "$sha"`.
- **Product action:** In each Wrangler environment a verified Worker deploys, declare the
  `version_metadata` binding `CF_VERSION_METADATA` (`[version_metadata]` at top level,
  `[env.<name>.version_metadata]` in a named environment; bindings are not inherited), and return
  its `tag` as the top-level `versionTag` field of the public health response, `null` without it.
  Send that response with `Cache-Control: no-store` and keep its URL out of Cloudflare cache
  rules.
- **Product action:** Once every target reports its commit, add
  `config/product/deploy-verify.json`: per source branch (`main`, `staging`), the health URLs to
  check, and optionally `timeoutMinutes`. It applies once promoted to `deploy/<branch>`. Then run
  Deploy verify by hand from the default branch for each configured branch and expect the notice
  `Deploy verify: N target(s) serve <sha> (deploy/<branch>)`, not only a green run.
- **Product action:** For the Slack alert, set the repository secret `SLACK_FLINT_BOT_TOKEN` (a
  bot token with `chat:write` that can post to the Slack channel) and the repository variable
  `SLACK_CHANNEL_BUGS_ALERT` (a Slack channel ID). Without them the run still fails and warns.

## unkillable-kit/v0.10.0 — 2026-11-26

### Auth

- **Product action:** `listApiKeysForOrg` (`@kit/auth/repos/keys`) filters on the exact
  `organizationId` it receives and no longer trims it: an empty value, or one with leading or
  trailing whitespace, throws. A Product that calls it with a value it has not normalized must
  normalize or refuse that value in the route, before its authorization check, and pass the
  checked value unchanged. The Example API already passes the exact organization of the
  authenticated key (go-silex/unkillable-kit#209).

### Flows

- **Product action:** `mintCapabilityGrant` mints for the exact `orgId` it receives and no longer
  trims it: a nonblank value with leading or trailing whitespace is denied with `GRANT_INVALID`
  and gets no grant, and an empty or whitespace-only value is still denied with
  `ORG_ID_REQUIRED`. A Product that mints with a value it has not normalized must normalize or
  refuse it first, then resolve the org module policy facts and mint with that same value
  (go-silex/unkillable-kit#209).

### Root

- Knip no longer reports CSS under App `public/` directories as unused files
  (`ignoreFiles: ['apps/*/public/**/*.css']`). It reads only the `<script>` tags of `index.html`,
  so a stylesheet served unchanged from `public/` and loaded by a `<link>`, for example to keep a
  licence notice that the CSS build strips, failed the Root gate (go-silex/unkillable-kit#203).

### Bun runtime

- **Product action:** The root Bun pin (`package.json#packageManager`) moves from 1.4.4 to 1.4.5,
  a security release that updates lsquic, c-ares, SQLite, llhttp and BoringSSL
  ([release notes](https://bun.com/blog/bun-v1.4.5)). If a Product builds with Cloudflare Workers
  Builds or Pages, set the `BUN_VERSION` build variable to `1.4.5` on each project, production and
  staging, just before the inherit merge reaches the branch that project's `deploy/<branch>` is
  promoted from: production projects before `main`, staging projects before `staging`, in the
  order of the [deploy runbook](docs/kit/deploy-cloudflare.md#4b-bun-and-node-versions). Set
  earlier, a rebuild of the current deploy revision refuses. The build refuses a stale value only
  where its build command starts with `bash scripts/kit/cf-builds/require-bun-version.sh`; keep
  `SKIP_DEPENDENCY_INSTALL=1` where the build command installs. Locally, install Bun 1.4.5 before
  the sync block or `validate:full`, for example with
  `curl -fsSL https://bun.com/install | bash -s bun-v1.4.5`: `lock-ranges:check` fails under any
  other Bun. CI workflows read the version from `package.json` and need no change.
- `create-product` declares `@types/bun` `^1.4.5` in a new MCP App, like the Kit workspaces.
- Bun 1.4.5 still installs versions already in `bun.lock` without re-checking their release age,
  so lock-reproducing installs are unchanged.
- Outside macOS, `bun:sqlite` now embeds SQLite 3.54, which refuses an `ALTER TABLE` that adds,
  renames or drops a column named `rowid`, `oid` or `_rowid_`. Kit migrations name no such column.

### CI

- The Root Better Auth self-test runs its Core runs in parallel, in up to four synthetic Product
  workspaces, one per available CPU. Every scenario keeps its existing assertions, and
  `better-auth:check` is unchanged. On the hosted Kit runner, with Bun 1.4.5, the four
  `test:root-gate-better-auth:*` tasks took 75 s instead of 156 s, and the slowest tooling job
  143 s instead of 177 s. A two-CPU Product runner runs two workspaces
  (go-silex/unkillable-kit#200).

## unkillable-kit/v0.9.1 — 2026-11-26

### CI

- Tooling CI shards balance by measured task duration instead of recipe position, and the Root
  Better Auth self-test runs as four `test:root-gate-better-auth:*` scenario groups. On Product
  runners the slowest shard ran about 285 s of tasks and reached the five-minute job timeout; the
  new plan estimates about 195 s, job setup excluded (go-silex/unkillable-kit#198).

## unkillable-kit/v0.9.0 — 2026-11-25

### Auth

- **Product action:** Kit guards now load a fixed Kit authorization core after routing
  ([ADR-0026](docs/kit/architecture/adr/0026-request-authorization-kit-core.md)). Replace the global
  key and Impersonation gates with the `keyScope` and `impersonation` hooks, register global
  middleware with `authorization.middleware`, mount `betterAuthMount` on Better Auth and give every
  protected route its own guard. Replace `moduleFacts` with `modules: true`. Replace Product facts,
  projections and fingerprints with Product queries after the guards, and read admitted facts from
  `view(c)`. Remove `allEndpoint`. `X-Org-Id` is no longer trimmed. Existing cookies stay valid; no
  D1 migration is needed. See the [migration guide](docs/kit/playbooks/migrate-request-authorization.md)
  (go-silex/unkillable-kit#191).
- **Product action:** Hosted MCP tools call declared App operations in process through the
  `dispatch` capability and designate the Organization from validated input or a server default.
  `facts`, `forOrganization` and `denyFact` are removed; move a `denyFact` barrier into
  `grantAdmission` before upgrading. See [Update hosted MCP tools](docs/kit/playbooks/migrate-request-authorization.md#update-hosted-mcp-tools-if-used)
  (go-silex/unkillable-kit#181).
- Hosted dispatch carries Product headers, such as `Idempotency-Key`, that every matched handler
  declares with `authorization.hosted(app, register, { headers })`; an undeclared name is refused
  before any handler runs, and credential, selection, framing, hop-by-hop and client-address names
  cannot be declared. `query` accepts an array for a repeated key. See [Update hosted MCP tools](docs/kit/playbooks/migrate-request-authorization.md#update-hosted-mcp-tools-if-used)
  (go-silex/unkillable-kit#195).
- `betterAuthMount` refuses only the Kit's machine credentials among Bearer tokens (API keys and
  hosted dispatches), so Better Auth authenticates its own tokens, such as an OIDC access token at
  `/oauth2/userinfo`. The Impersonation fence still refuses any Bearer with an attached delegation
  (go-silex/unkillable-kit#195).
- `requireSession` and `authorization.session(c)` no longer call `keyScope`: a key gets
  `This route requires a session cookie` or `null`. Every other guard calls it, even after
  `session(c)` in the same request; `betterAuthMount` refuses every key
  (go-silex/unkillable-kit#195).
- **Product action:** Update clients and tests that pin refusal statuses. A valid key gets `403`
  (`This route requires a session cookie`) from `requireSession`. `keyScope` judges a `HEAD` request
  on the `GET` registration Hono matches, so a key allowed to read a route may also send `HEAD`. A
  route that reads only `session(c)` gets `null` for a key and answers with its own refusal: the
  Example MCP identity ticket route now returns `401` where the removed global key gate returned
  `403`. For an ordinary member session whose visibility-based write precondition must report a
  stale write before a Module access denial, Product code owns the order: unavailable Module `404`,
  stale write `409`, then insufficient grant `403`. See [Handle admission responses](docs/kit/playbooks/migrate-request-authorization.md#handle-admission-responses)
  and [Preserve a visibility-based write precondition](docs/kit/playbooks/migrate-request-authorization.md#preserve-a-visibility-based-write-precondition)
  (go-silex/unkillable-kit#191, go-silex/unkillable-kit#195).

### Flows

- Flows access predicates accept `authMethod: 'mcp'` and still deny hosted MCP principals run
  creation, approval decisions and cancellation (go-silex/unkillable-kit#195).

### MCP

- **Product action:** `PublicToolErrorCode` gains `UNAVAILABLE`
  (`Authorization is temporarily unavailable.`). `dispatch.fetch()` returns the HTTP response: a
  hosted tool maps a `5xx` to `PublicToolError('UNAVAILABLE')` itself. Code that switches
  exhaustively over the codes or keys a `Record` by them handles it (go-silex/unkillable-kit#191).

### Root

- Root's Better Auth differential compares only the cookies the enrolled issuer sets on sign-in.
  An App may add an unrelated cookie to that response (go-silex/unkillable-kit#188).
- Root's Better Auth check no longer requires built static assets: Wrangler and the local probe use
  an empty scratch directory for a configured `assets.directory`, which must still be a non-empty
  path to a directory, or to nothing yet (go-silex/unkillable-kit#195).
- **Product action:** An App that guards direct writes to `user.disabled` declares
  `kitBetterAuthDisableUser` in its `package.json`: one SQL statement that disables the fixture User
  through the App's own mechanism and leaves its session valid. See [Enroll shipping Better Auth Apps in Root](docs/kit/playbooks/migrate-request-authorization.md#enroll-shipping-better-auth-apps-in-root)
  (go-silex/unkillable-kit#195).

### Import boundaries

- R6 treats `*.test-support.*` modules as test code, so shared test helpers may import
  `@kit/auth/hosted-dispatch` (go-silex/unkillable-kit#195).
- **Product action:** Production code that imports a `*.test-support.*` module, by path or
  through a package export, now fails R6: move that import into test code
  (go-silex/unkillable-kit#195).

### Dependencies

- Refresh the Kit dependency group and Bun lockfile. Update Wrangler to 4.166.0
  with regenerated Worker declarations for every Kit Worker (go-silex/unkillable-kit#187).

### CI

- The inherited PR-title workflow pins `amannn/action-semantic-pull-request` 6.1.3
  (go-silex/unkillable-kit#189).

## unkillable-kit/v0.8.1 — 2026-11-25

### Auth

- Products can preserve a complete Organization- and principal-scoped visibility projection
  and distinguish a stale write precondition (`409`) from a current write denial (`403`) in
  the same request authorization batch. See the [migration guide](docs/kit/playbooks/migrate-request-authorization.md#preserve-a-visibility-based-write-precondition)
  (go-silex/unkillable-kit#182).

## unkillable-kit/v0.8.0 — 2026-11-24

### Auth

- **Product action:** Replace removed auth exports with Kit request authorization and register
  read-only Product facts and Module policy. Unreadable authorization loads now return `503`.
  Enroll each shipping Better Auth App in Root's differential and align the lockfile on one
  resolved `better-auth` version. Verify existing Organization provisioning; do not restore
  missing grants indiscriminately. An unavailable Module now returns `404` even with super-admin
  bypass. Existing cookies stay valid; no D1 migration is needed.
  See the [migration guide](docs/kit/playbooks/migrate-request-authorization.md)
  (go-silex/unkillable-kit#162).

## unkillable-kit/v0.7.0 — 2026-11-24

### UI

- `@kit/ui` exports `DialogPopup`, an unstyled dialog popup. Compose it with
  `Dialog`, `DialogPortal` and a `DialogOverlay` rendered as the Product's own
  veil to bring Product dialog markup while keeping the kit's focus trap,
  focus return and dismissal (go-silex/unkillable-kit#173).

### CI

- Root is the single quality gate for Kit and Product workspaces. Root
  enforces Product App enrollment and omits Kit-owned coverage only on proven
  Product-only pull requests; pushes still prove the whole bar
  (go-silex/unkillable-kit#156).
- **Product action:** In the same Kit upgrade PR, enroll each Product App in
  Root. Keep `apps/*` in the root `workspaces`. Declare non-empty `typecheck`
  and `test:coverage` scripts. Build the Vitest coverage options with
  `makeCoverage` and the App directory name, keep its `json-summary` reporter,
  and set a positive global floor on a metric the run measures. The run needs
  at least one passing test. Give each App a risk tier in
  `config/product/coverage-order.txt`, and add coverage partitions under
  ADR-0023 only where needed (go-silex/unkillable-kit#156).
- **Product action:** In the same PR, remove duplicate typecheck, tests
  (including MCP), `zero-edit` and `deploy-gate:check` from the copied Product
  validation. Move standalone App smoke checks into Root coverage before
  removing their old calls. Keep Product-specific guards. Keep or add the
  deployment builds shown in `docs/kit/templates/product-validate.example.sh`:
  a Vite-only SPA build where the Product has a web App, and a Worker dry-run
  for each deployed environment, including the unnamed configuration when it
  is deployed (go-silex/unkillable-kit#156).
- **Product action:** One Product pilots this release before wider adoption.
  The pilot proves the hosted 300-second Root budget on both its pull request
  run and its push run to the default branch. A pull-request run does not
  prove the push path (go-silex/unkillable-kit#156).
- The Example API D1 round-trip suite measures authenticated route groups in
  separate cases under the default timeout, with the same ceilings and route
  coverage (go-silex/unkillable-kit#174).

## unkillable-kit/v0.6.0 — 2026-11-23

- New Product API starters enable Workers logs and traces with query strings
  redacted. Production onboarding now includes Worker placement near the D1
  primary and verification with D1 spans (go-silex/unkillable-kit#161).
- **Product action:** Refresh the generated Dependabot configuration when
  inheriting this Kit version. Better Auth version updates are grouped separately
  and require human review before landing (go-silex/unkillable-kit#161).

### Merge on green

- Delayed push and reopen jobs preserve authorizations issued after the
  original workflow run was created. Successful revocation checks wake merge
  evaluation again (go-silex/unkillable-kit#158).

### Testing

- The Example and Starter APIs now test D1 round-trip ceilings for authenticated
  routes. Products can use `countD1RoundTrips` from `@kit/db/testing` to set their
  own ceilings (go-silex/unkillable-kit#160).

## unkillable-kit/v0.5.1 — 2026-11-23

### Tooling

- `test:lock-ranges` now checks that `writeExact` writes each paced chunk before
  the next arrives. The full-buffer mutant fails without timing or memory
  thresholds, and the large-blob check compares all materialized bytes
  (go-silex/unkillable-kit#149).

## unkillable-kit/v0.5.0 — 2026-11-23

### Merge on green

- Workflow completions now use at most one runner in the shared repository merge
  queue. The gate still scans all eligible PRs using trusted default-branch code
  and fresh authorization and check evidence (go-silex/unkillable-kit#147).

### OpenID provider

- Use the Web Crypto input type for retained-key verification so the OIDC provider
  typechecks with Cloudflare Worker declarations as well as DOM declarations.

### UI

- Let Apps set the Dialog, AlertDialog, and Sheet backdrop color via `--overlay`
  in light and dark modes without changing the defaults (go-silex/unkillable-kit#138).
- Add `@kit/ui/base.css` for shared styles without Geist, using the system font
  stack unless the App overrides it (go-silex/unkillable-kit#139).

### UI tabs

- Add accessible Tabs to `@kit/ui` and demonstrate them in the Example App
  design-system catalogue (go-silex/unkillable-kit#136).

### Password input

- Add `PasswordInput` to `@kit/ui` with an accessible visibility toggle, and use
  it in the Kit password forms and Example App
  (go-silex/unkillable-kit#137).
- **Product action:** Supply `showPasswordLabel` and `hidePasswordLabel` in the
  copy passed to `ResetPasswordForm` and `ChangePasswordForm`
  (go-silex/unkillable-kit#137).

### Auth

- Let Products render magic-link and password-reset e-mails after locale and
  token-link validation, with Kit templates unchanged by default
  (go-silex/unkillable-kit#135).

### Dependencies

- The inherited `@vitest/coverage-v8` moves to `5.1.1`, and Kit workspaces now
  require `vitest` `^5.1.1` to match it (go-silex/unkillable-kit#130).
- **Product action:** For each Product workspace tested by the inherited V8
  coverage gate, make `bun.lock` resolve its `vitest` to `5.1.1`, the version the
  provider supports. Change its manifest range only if the range excludes `5.1.1`.

## unkillable-kit/v0.4.1 — 2026-11-23

### Observability guide

- Correct the Wrangler `[observability]` inheritance rule: an environment that
  omits the block inherits the whole top-level block, and a declared environment
  block replaces it without merging nested fields. Set `redact_query_string`
  explicitly in every deployed block that carries traces
  (go-silex/unkillable-kit#78).

## unkillable-kit/v0.4.0 — 2026-11-23

### OpenID provider

- Enforce `prompt=login` and `max_age` at authorization code issuance using
  password sign-in evidence (go-silex/unkillable-kit#121).
- **Product action:** The OIDC provider requires `better-auth`,
  `@better-auth/core`, and `@better-auth/oauth-provider` at exactly `1.7.27`,
  enforced at startup when OIDC is enabled. Sync and
  apply the new `oidc_provider` migration to the D1 binding with the canonical
  `session` table before deploying. Keep authorization and continuation traffic
  on one Kit version during cutover. Restart all pending pre-upgrade
  authorizations from the relying party, even without freshness constraints.
  When the App receives `OIDC_RESTART_REQUIRED`, start a new authorization rather
  than retrying with the same signed query.

### CI App token pin

- **Product action:** Kit workflows move `actions/create-github-app-token`
  from 3.3.0 to 3.4.0 (go-silex/unkillable-kit#128), so `kit-upgrade` stops at the CI
  App token-pin preflight. Establish the effective `CI_APP_ID` mode with the
  Kit's [CI App setup](docs/kit/ci-app-setup.md#trust-and-setup), then complete
  the [manual Kit sync](docs/kit/product-consumer-contract.md#pulling-kit-upgrades)
  (“For a new token pin…”).

## unkillable-kit/v0.3.0 — 2026-11-22

### OIDC logout

- Preserve back-channel notification and refresh revocation for legacy D1 BLOB scopes.
  Unsupported stored scopes mark planning coverage unknown without dropping other sessions.
- Chunk deferred refresh revocation writes to stay within D1's bind limit
  (go-silex/unkillable-kit#102). Skip deferred logout effects if the transaction
  adapter's live binding cannot be verified, and report unknown coverage.

### OpenID provider

- Discovery omits the unsupported `create` prompt. Authorization requests using
  it return `invalid_request` instead of going to the login page
  (go-silex/unkillable-kit#86).
- **Product action:** Before upgrading, check each registered OIDC redirect URI.
  If its fixed query string uses `code`, `state`, `iss`, `error`,
  `error_description` or `error_uri`, move those values to non-reserved keys in
  both the client configuration and the registered redirect URI. The provider
  now refuses such redirect URIs, even ones already registered.

### OpenID provider login guidance

- When a signed authorization request carries `prompt=login` or `max_age`, magic-link and social sign-in return HTTP 400 `OIDC_PASSWORD_REQUIRED` instead of starting. Apps should offer password sign-in, so users no longer loop back to the login page (go-silex/unkillable-kit#84).
- Both routes reject an `oauth_query` that is not a string with HTTP 400 `OIDC_INVALID_OAUTH_QUERY`.
- [Document](packages/auth/README.md#login-method-guidance) why these parameters do not guarantee reauthentication. Enforcement is tracked in go-silex/unkillable-kit#121.

### Password reset

- The example App offers a new reset link when Better Auth rejects an expired, used, or unknown token (go-silex/unkillable-kit#85).
- `@kit/api-client` exposes the code of a flat Better Auth error as `HttpError.upstreamCode`. `ApiError.code` still carries only Kit error codes. An App with its own reset page can show the same invalid-link state on HTTP 400 `INVALID_TOKEN`.

## unkillable-kit/v0.2.3 — 2026-11-22

### Product release preparation

- Products can opt in to [release preparation](docs/kit/product-consumer-contract.md#product-release-preparation-opt-in) using their own changelog and push gates, without changing the inherited Kit workflow or changelog.
- Release headings use the source commit's UTC committer date, so running the same proposal on a different day does not change it.
- Product changes come only from Product notes, with no commit count. Inherited Kit history appears only in the separate Kit section.
- With no released heading, preparation starts at `v0.1.0` regardless of tags.
  Otherwise, the newest released heading's exact local tag must point to a Product commit with the inheritance marker, ancestral to the source.
  The tagged Product changelog must parse and have the same newest release heading.
- Product proposals list Kit releases only from strict changelogs and link to the pinned Kit changelog instead for legacy pins.

## unkillable-kit/v0.2.2 — 2026-11-22

### Materialize memory self-test

- The materialization self-test bounds sampled post-GC Buffer memory instead of RSS,
  so allocator retention on CI runners no longer fails it, while Buffer-held full-blob
  buffering is still caught (go-silex/unkillable-kit#116).

## unkillable-kit/v0.2.1 — 2026-11-22

### Release proposal synchronization

- Release preparation waits for GitHub to report the refreshed pull request head before updating its title and body. If it does not sync, rerun the workflow manually without a source SHA.

### Release proposal links

- Release preparation pins relative links and images in the proposal to the source commit, without changing the CHANGELOG.
  Use LF line endings and write links and images with a relative path, an HTTPS URL, or a fragment. Titles, angle destinations, bare URLs, HTML, and escapes outside inline code are rejected.
  Write relative paths from the repository root without dot segments, doubled or trailing slashes, or encoded separators, dots, or percent signs.

### Auth throttle test clock

- Pin the clock in Example API and Auth Package rate-limit tests so crossing a
  fixed-window boundary cannot reset their counters (go-silex/unkillable-kit#105).

## unkillable-kit/v0.2.0 — 2026-11-22

### Kit release preparation

- **Product action:** Before upgrading, set `.dev/stack.yml` `release.component` to your own component if it is `roxabi-boilerplate-cf` or `unkillable-kit`. The Product stack contract rejects both Kit values.
- After green CI and Secret scan on `main`, the Kit opens or refreshes one release-preparation PR. Maintainers review the proposal and publish the tag and GitHub Release manually.
- **Product action:** The upgrade that adds `release-prepare.yml` stops at the CI App token-pin preflight. Verify that it uses the same `actions/create-github-app-token` SHA as `deploy-gate.yml` and `merge-on-green.yml`, then complete the [manual Kit sync](docs/kit/product-consumer-contract.md#pulling-kit-upgrades) (“For a new token pin…”).

### Kit upgrade lock stability

- `kit-upgrade` no longer rewrites `bun.lock`: it stages the merged lock and marker, frozen-installs, runs `lock-ranges:check`, then commits with no re-add. The check accepts a lock an ordinary offline install leaves unchanged, even if `--lockfile-only` would re-serialize it.
- The probe runs on the raw tracked tree with a neutral environment; a canary detects configs that suppress lock writes. Duplicate keys, CR, BOM or comments in `bun.lock` fail.

### OIDC logout planning

- On the D1 adapter, back-channel logout planning loads distinct session and client pairs for notification and only non-revoked refresh tokens for revocation, instead of every token row. The notified relying parties, the 25-session cap and the best-effort behaviour are unchanged.

### Kit upgrade check

- `kit-upgrade --check` prints the pending commit count, first-parent merges and release tags of the locally cached `upstream/main`, plus a `git show` pointer to that tip's CHANGELOG, without fetching or writing.

### API client body content type

- **Product action:** Set `content-type` explicitly when sending JSON as an `ArrayBuffer`, typed array or stream through `apiFetch` / `createApiClient`. The client now adds `content-type: application/json` only to string bodies without a content type. `FormData`, `URLSearchParams` and typed `Blob` bodies keep the content type derived by `fetch`.

### Shared CI install recipe

- Root core, grouped coverage and the maintained Product CI template call Kit-owned `scripts/kit/ci-install.sh` for the frozen Bun install with the selected Node's bundled `node-gyp` shim. Existing Products opt in once after upstream merge by matching that Install step (and pinned Node setup if missing), keeping Product-specific checks.

## unkillable-kit/v0.1.0 — 2026-11-21

Tagged at `8481566`. Product adoption steps: [release notes](https://github.com/go-silex/unkillable-kit/releases/tag/unkillable-kit/v0.1.0).

### Vitest CI workers

- Kit and newly generated Product Apps use all available Vitest workers in CI, without changing local defaults.
- Root lint rejects Kit-owned Vitest configs that omit the shared setting and warns for existing Product Apps.

### Module catalogue reads

- The Example App reads module availability from `platform_modules` only and no longer falls back to the legacy `kit_modules` table. The table, its catalog ids and `@kit/auth/repos/modules` remain; dropping the table will be a separate contract migration (ADR-0003 D7).
- Seed output marks a module `created` against `platform_modules`, instead of reporting every module as created on every run.

### Starter scope gate

- `extract-dry-run` refuses an `apps/starter-api` manifest whose schema sets are not exactly `core` and `audit` (ADR-0022). The unenforced per-App file and line cap is removed.

### ADR consolidation

- ADR-0011 and ADR-0013 are merged into ADR-0009 (D1–D3), ADR-0016 into ADR-0007 D2 and ADR-0024 into the `@kit/auth` README; the merged files are removed. Design note 0019 is removed because ADR-0021 and its design note already carry its routes, DTO and import rule. Product docs linking these files must update those links.

### One Worker site

- `@kit/core` exports `createSiteFetch`, which serves a SPA and its API from one Worker. API paths always reach the API, never the assets or the shell. The shell is served only for navigations, with its own headers and never as a 304. Missing built files keep a 404, and the handler passes through when no `ASSETS` binding exists. The starter API composes it, and the [playbook](docs/kit/playbooks/one-worker-site.md) carries the tested Wrangler `[assets]` recipe.

### Kit schema check

- `kit-schema-sync.sh --check` prints the sync plan, writes nothing, and exits 0 when the same sync would write nothing, 2 when it would write, and 1 on any existing refusal. It cannot be combined with `--dry-run`. The product validate template runs it against the inherited catalog. `--dry-run` keeps exit 0 and now also prints a manifest `sets` change. A real sync is unchanged, except that a `migrations` path that is not a directory is now refused before planning.

### Young dependency exemptions

- Allow reviewed security fixes or operator-approved changes to exempt exact young dependency versions, including necessary transitives, without disabling the release-age gate for the entire resolution. Validate the Kit list offline; Products use a one-shot flag or upstream the exemption.

### CI tooling shards

- Run selected tooling self-tests in three canonical round-robin CI shards, with sequential fail-fast execution per VM and current-run receipt admission in the existing `ci` check. Local tooling remains monolithic and ordered; no coverage policy changes.
- The bar source-of-truth checker accepts CI's canonical shard invocation only together with its tooling receipt join; local hook invocation remains monolithic.

### Root gate task timings

- Emit a JSON timing and status record for each attempted sequential Root gate task, including failures; planning output and receipt schemas remain unchanged.

### Inbox read selection

- `markRead` accepts an optional trusted server-authored, bound SELECT of Notification IDs, evaluated inside the read UPDATE to narrow the existing scope. Omitted selection preserves existing behavior; read-once semantics and newly marked row counts remain unchanged.

### Portable tooling checks

- Resolve Wrangler migration paths without GNU `realpath`, retaining symlink-aware containment even for missing paths. Deploy-ref refusal fixtures no longer depend on Git's diagnostic language; ADR mutation fixtures use portable `sed` syntax.

### Atomic notification admission

- Apps can compose planned notification admission with business writes in the same D1 transaction, then interpret the admission results. Existing execution and best-effort flow producers remain unchanged; external runtime admission is not part of that transaction.

### CI native install transport

- Root core and grouped coverage expose the selected Node's npm-bundled `node-gyp` only to their frozen install; a missing executable or failed install fails the job. The current lock's `trustedDependencies: []` prevents dependency install lifecycles, so this does not exercise native fallback. A prebuilt install, an explicit native source build and an install fallback are separate evidence.

### CI coverage partitions

- CI can run one App's coverage as 2 to 4 native Vitest parts plus one merge, through one reusable `coverage-app.yml` call per declared App ([ADR-0023](docs/kit/architecture/adr/0023-ci-coverage-partitions.md)). This adds capacity; it is not a budget guarantee.
- The merge applies the App's full configured floors to the merged coverage, and parts never authorize. Local `validate:full` still runs every App monolithically and remains the reference.
- The Kit permanently declares `apps/example-api 2`, and CI refuses a partition plan or join without it. Products may declare their own Apps in `config/product/coverage-partitions.txt`.
- Private Products pay the extra Actions minutes and one-day RAW artifact storage of every declaration, the inherited `example-api` one included.
- Fix Root gate self-test receipts to follow all declared App partitions, including Product additions; the runtime join and receipt protocol are unchanged.

### Product bootstrap

- Add `create-product` for fresh dedicated clones: local Product remotes, inheritance, starter Apps and Product CI wiring, with normal-hook commits and validation. Repository creation, first push and deployment remain operator actions.
- Split operator onboarding from the day-0 generator playbook. The fixture-only `--skip-gh-default` path explicitly leaves the GitHub CLI default repository unconfigured.

### Scoped tooling self-tests

- Separate gate-tooling self-tests into `validate:tooling`; keep live tree checks in `validate:full`. Pre-push and CI select the tooling lane for Kit tooling changes, conservatively run it on uncertain selection, and run it on Kit pushes to `main`. Local selection respects actual push destinations and revisions.
- Product clones may skip inherited tooling self-tests after context validation; a tooling zero-edit exception or Product configuration, manifest or shared `bun.lock` change selects them. The CI tooling job always validates selection; its checkout, install and test steps may skip, but the aggregate requires the job to succeed with valid selection. Product validation and secret scanning remain separate.

### Product kit upgrades

- Provide `bun run kit-upgrade` for the documented product-clone merge procedure, with a read-only `--check` mode and a hermetic regression test.

### Minimal starter Apps

- Add minimal API and web starter Apps organized by business module, with shared request policy and a neutral Organization-scoped sample.

### Product agent entry point

- Route agents in product clones to `docs/product/AGENTS.md`.
- Route agents working inside a package or app to its `README.md` when present, in every clone.

### Disabled accounts

- Disabled Users cannot authenticate with sessions or Organization-bound API keys. Disabling revokes existing sessions; enabling requires a new sign-in. Inheriting Products must sync the Kit schema and apply the new migration before deploying: a missing account-state column causes authentication to fail closed.
- Hosted MCP Apps must bind `DB` to the same authentication database as the API. The hosted shell checks live User state for identity, OAuth exchanges and requests; this is required independently of optional grant admission.

### Biome D1 safety

- Keep `noPlaywrightUselessAwait` diagnostics while disabling its automatic fix: Biome 2.6.7 misidentifies D1 `first()` calls as Playwright locators and otherwise removes required awaits. Restore the fix when upstream distinguishes those calls and the real D1 staged-file proof passes.

### Transactional email locale and Product name

- **Consumer-visible API change:** authentication email templates now require an explicit `locale` and `productName`. Migrate template callers to pass both. When supplying `emailPort` to `createBetterAuth`, also supply `emailConfig: { productName, fallbackLocale, resolveRecipientLocale }`; the App resolves each recipient's locale and chooses the fallback.

### TanStack Table v9

- Migrate the Example App notes list and design-system table demo from `@tanstack/react-table` 8.21.3 to 9.3.1 with `useTable`, `FlexRender` and one explicit `listTableFeatures` set (sorting, column and global filtering), without the deprecated `useLegacyTable` bridge. Sorting is table-owned; the search and filter controls keep owning their filter state.
- String columns now sort with TanStack's corrected automatic choice: case-insensitive `text`, or natural `alphanumeric` when sampled values contain digits. Version 8 sampled only rows after the tenth, so lists of ten rows or fewer compared raw strings.
- Remove the Dependabot semver-major hold for `@tanstack/react-table`.

### API key scopes

- Organization-bound API keys require explicit independent `read`, `write`, and `admin` scopes. The Example App narrows the bound principal's existing authority and denies keys on undeclared routes; other Apps must install their own enforcement. The migration backfills existing keys with all three scopes, preserving their scope allowance while the Example App's route declarations apply.

### Bun runtime

- Upgrade the root Bun pin to 1.4.4. Before this change reaches the Kit deploy branch, update `BUN_VERSION` on each showcase Workers Builds and Pages project as described in [the deploy runbook](docs/kit/deploy-cloudflare.md#4b-bun-and-node-versions).

### Schema sync default

- Fresh Product schema sync selects `core,audit`, including `rate_limit_buckets` for the Kit throttle. First `--adopt` without `--modules` also selects `audit`. Existing recorded selections remain unchanged: to opt in, pass `--modules core,audit` plus every other recorded set.

### Wrangler runtime types

- Upgrade the example Workers to Wrangler 4.159.0 and regenerate their committed runtime declarations.

### ADR index generation

- Generate the decision index from ADR summaries and authority metadata; check it for drift during documentation validation.

### Flow run persistence

- Commit run mutations and status/receipt events atomically, with path-specific Organization and snapshot fences. Failed-run closure checks ownership, preserves terminal status and errors during receipt cleanup, retains malformed receipt bytes and propagates the original exception.

### ADR design notes

- Move unimplemented notification destination routes, Slack schema tables and implementation specifications from binding ADRs into non-normative design notes; accepted decisions remain binding.

### API-only stack contract

- An API-only Product replaces the whole `.dev/stack.yml` `frontend` block with the canonical null scalar `frontend: null` and keeps that scalar on upgrade. No frontend App is required. The guard compares values, not filesystem existence; `~`, implicit empty, `Null`, a quoted string, a missing key, and a partial map still fail (Roxabi/roxabi-boilerplate-cf#591).

### Optional native branch ruleset

- Document an operator-applied CI App-only `main` ruleset alongside the retained exact-head merge gate, including rollout, refusal tests, bypass limitations and rollback. No hosted setting changes.

### Independent public root preparation

- Permit an ordinary local first commit to reach both staged secret-scan passes before `HEAD` exists; explicit ranges, commit-only scans and Git errors still fail closed (Roxabi/roxabi-boilerplate-cf#510).
- Document the exact-tree archive into an independent root, normal hooks, private provenance and fresh-clone validation. Local proof is not hosted configuration or public exposure.
- Admit a no-baseline snapshot's marked migration only when its raw bytes match the same path in an actual parentless commit reachable from `HEAD`; shallow history, grafts and replacements cannot supply that evidence. Marker syntax and established-baseline checks remain strict. This admission does not attest a historical deployment (Roxabi/roxabi-boilerplate-cf#591).
- Exercise the candidate's root gate before the reader clone creates `origin/main`, so local preparation covers the first-push context rather than only transport-clone validation.
- Distinguish private and already-public Products: a public consumer may publish a transition only after the Kit exposure checkpoint, without introducing private-only Kit ancestry.
- Carry the Kit's MIT notice with all inherited Kit material in the protected `docs/kit/licenses/MIT.txt`, a byte-identical copy of the root `LICENSE`, and remove the root `package.json` license field so no protected root file declares a Product's terms. A Product's root `LICENSE` stays Product-owned and unprotected: the independent-history join and every later upgrade merge restore its pre-merge presence and bytes before committing, even when they match the Kit's notice, and a change of Product terms is the Product's own reviewed commit. The Kit notices state only the Kit's terms.

### Worktree setup lockfile

- Check committed lockfile normalization offline in the lock-integrity gate, and fail worktree setup if its install changes `bun.lock`.

### Inactive CI App workflows

- Restore successful manual operation when the CI App and authorization policy are absent: skip evaluation, token minting and automated receipt writes. With a complete valid policy but no App, retain read-only evaluation for manual merging.
- Default-ref automation rejects partial or malformed supplied policy, including when the App is disabled. Active setup errors remain failures, and active exact-head receipt checks and token scopes are unchanged.
- Return before loading the adapter on unprivileged `pull_request` events so consumers can inherit from a default branch that predates it; no new adapter export or fallback is required.

### Agent constitution

- Keep the direction and grant/approval invariants concise while retaining their detailed mechanics in the platform direction and flows references inherited by Product repositories.

### Zod Worker entry initialization

- Correct Zod 4.6.7 metadata only: set `sideEffects` to `true` in the nested `v4/package.json` and `v4/classic/package.json` to preserve initialization across static `zod/v4` and dynamic root imports (Roxabi/roxabi-boilerplate-cf#585). The compiler itself is not fixed.
- Bundlers may retain more code and initialize it eagerly. The patch lives under `config/kit/patches/`, already protected by the `config/kit/` zero-edit prefix.
- Remove the patch only when an unpatched newer upstream release passes the entry regression and the real unified product Worker passes under workerd. The regression alone does not prove UI, OAuth or workerd behavior.

### Task link cycles

- Reject any same-kind cycle an incomplete walk used to allow, including a short cycle behind a wide fan-out and a cycle closed through a long chain. Still accept a wide acyclic graph entered at its root, including a shared descendant, and a new link whose walk meets an existing cycle without returning to its source. Organization, kind, reflexive, duplicate and single-parent checks are unchanged (Roxabi/roxabi-boilerplate-cf#583).
- **Breaking:** remove unused `MAX_LINK_TRAVERSAL` from `@kit/tasks`. Link issue codes and request payloads are unchanged. No Kit or Example App reference required a migration.

### Documentation budgets

- Split the testing strategy into navigable sections without rewording its content. The documentation gate ratchets `AGENTS.md`, `README.md` and `docs/kit/**/*.md` at 400 UTF-8 bytes per line and 60,000 bytes per file; existing overages can only shrink. Fenced blocks and link definitions count; there are no exemptions.
- After an improvement, lower the committed baseline with `bun --no-env-file --config=config/kit/bunfig.gates.toml --no-install run scripts/kit/check-doc-hygiene.ts --regenerate-baseline`. New violations and any worsened metric for a still-violating file are refused. A file within both limits is dropped even if a metric grew while making it compliant. `--init-baseline` is only for the initial construction when no baseline exists; it is not routine regeneration.

### Better Auth logging

- Route the Kit factory's Better Auth logger to fixed severity events without forwarding library-controlled messages or arguments, which can include credentials in database errors. Keep the default warning threshold (Roxabi/roxabi-boilerplate-cf#578).
- Prevent Better Call's independent raw-error fallback by converting non-API handler exceptions to a fixed event and empty 500, including exceptions before the router that previously propagated. Returned 5xx responses get a fixed event; diagnostic causes are intentionally lost.
- This covers the factory logger and HTTP handler, not direct API callers, other App or library logs, HTTP bodies or Cloudflare serialization. Product inheritance and deployment are not established by this change.

### Verification credential security

- Hash Better Auth verification identifiers globally and share the hash with Kit-minted welcome/reset tokens; leave magic-link `storeToken` unset to avoid double hashing. Resetting a password revokes all sessions, and origin checks are now enabled in tests (Roxabi/roxabi-boilerplate-cf#395).
- Retain magic-link GET with an accepted login-CSRF residual and revisit triggers; see [ADR-0002 D8](docs/kit/architecture/adr/0002-session-hmac-interim-vs-better-auth.md#d8--verification-credentials-and-magic-link-get).
- No schema migration or deletion: Better Auth 1.7.14 can fall back to current-format plain identifiers until expiry. Older 1.7.6 bare-token magic links are rejected by 1.7.14, independently of this hash change; request a new link. Targeted behavioral tests passed; this does not prove deployment or the full CI gate.

### Auth address buckets

- Normalize IPv6 addresses to a shared /64 rate-limit bucket, including invitation acceptance; retain IPv4 address buckets and map IPv4-mapped IPv6 to the same IPv4 key (Roxabi/roxabi-boilerplate-cf#360).

### Hosted OAuth grant admission

- Add optional, deny-only `grantAdmission` to `@kit/mcp/hosted`, using a provider-verified OAuth grant tuple before tools run and before code or refresh exchanges issue tokens.
- Refuse explicit denials; distinguish unavailable predicates with fail-closed 503 responses that preserve the authorization for a later valid retry instead of revoking it.
- Preserve omitted-option behavior, existing OAuth controls and Product-owned policy storage. The narrowly approved ADR-0015 exception does not claim a second Product consumer or relax future promotion rules.

### Hosted MCP consent presentation

- Add optional static `consentPresentation` to `@kit/mcp/hosted`: Kit-owned English/French security labels and escaped, App-owned service/disclosure text on the existing consent form.
- Capture presentation at Worker construction; preserve default English behavior and all consent, CSRF, identity, scope, PKCE and token-lifetime controls. The option grants no renderer or authorization capability.

### Public preparation

- Consolidate current ADRs and Product onboarding, retiring obsolete proposals and internal journals while preserving the Kit contracts (Roxabi/roxabi-boilerplate-cf#508, Roxabi/roxabi-boilerplate-cf#509).
- License Kit-owned contributions under MIT, copyright UnkillableCompanies; retain scoped third-party notices for shadcn UI, the dependency license checker and generated Worker declarations, and keep npm publication disabled (Roxabi/roxabi-boilerplate-cf#507).
- Clarify that App notification service and Task/Flow producer composition exist; User/email Delivery runtime is implemented while live proof remains outstanding.
- Prepare the approved independent public-first identity `go-silex/unkillable-kit`, protecting its contribution/security policies and retaining legacy identities only for the transition. Product push-denial also recognizes the new parent.
- Add public-safe contribution and issue-reporting guidance, collaborator-only PR policy and private vulnerability disclosure at `team@unkillablecompanies.com`; distinguish written policy from effective GitHub settings and post-publication scanning.
- Document the one-time independent-history consumer transition and subsequent ordinary upgrade, preserving Product content and applied schema identities. Refresh the inheritance marker in the ordinary upgrade recipe.
- Permit an explicitly approved shared merge-App installation as an owner exception, retaining cross-repository key exposure and all exact-head admission checks. No live credentials, merge automation, consumer migration or public target are provisioned by these source changes.

### Reviewed-head authorization

- Implement local exact repository/PR/head grant and withdrawal receipts with authenticated issuer identities, predecessor and edit proof, and require the same selected receipt at evaluation and final SHA-pinned merge. Labels are wakeup hints, not authority. The existing native and manual admission owners remain responsible for review and budget; automatic Dependabot admission binds its evaluated base as well as head (Roxabi/roxabi-boilerplate-cf#506).
- Align environment, workflow ownership and post-cutover guidance with explicit exact-head receipt admission rather than label authority.
- The local adapter fails closed on incomplete or invalid authorization evidence. A read-only production plugin CLI smoke against the source repository refused the missing repository authorization policy; it made no writes. This is not evidence of a live deployment, provisioned target, successful merge or a completed full gate.
- Retain default-ref dispatch and trusted workflow boundaries; older workflow definitions, trusted history edits or deletion, and the non-atomic final read/merge remain residual risks.

### Impersonation

- Add session-bound, Organization-scoped Impersonation with separate default-off read/write permissions per internal Platform Role, configured by `super_admin`.
- Preserve the real Better Auth operator session and audit attribution while applying the represented User's rights. Refuse privileged targets, cross-Organization access, credential/security changes, durable operations and personal data outside the Organization.
- Add permission controls and start actions to the user directory, a persistent return banner, cross-tab synchronization and request-context fencing. Consent, target notifications, custom duration limits and additional reauthentication are not included.
- Commit start/configuration audit atomically and persist business-request attempts before dispatch; stop remains independent of audit availability.
- Keep recovery and explicit return available when introspection is cancelled; reverted query-cache data cannot confirm an identity transition.
- **Breaking:** session payloads now include the verified `sessionId`; `/api/me` includes required `impersonation` and `impersonationPermissions` fields. Sync the additive core migration `0024_impersonation.sql`; see the [consumer contract](docs/kit/product-consumer-contract.md).

### Flow approval lifecycle ports

- Add optional approval-opened and approval-closed ports to `driveFlowRun`, with stable Organization/run/task identity and the winning D1 approval outcome (Roxabi/roxabi-boilerplate-cf#474).
- Run callbacks in dedicated caller-owned Workflow steps with three native retries. Scrub callback failures before owner logging; after exhaustion, log and continue without changing the business decision, deadline or wake budget. Notification loss remains possible; forced termination does not guarantee closure. Producer composition and live lifecycle guards remain App-owned, as described below.

### Notifications

- Add the pure `@kit/notifications` root: validated immutable type registration, User and Organization destination resolution, delivery eligibility, JSON display-parameter validation and an App-copy email layout (Roxabi/roxabi-boilerplate-cf#476).
- Keep `tasks.assigned` and `flows.approval_requested` declarations in the Example App, with email and Slack enabled by default under external rules. Their pure definitions do not dispatch providers or own durable Delivery execution.
- Resolve rules from one captured set of Channel, selector and boolean values per call, and validate and match each Organization destination against one captured selector, so accessor-backed inputs cannot change policy between validation and delivery eligibility.
- Add separate `@kit/notifications/schema` and `/repos` exports, seven constrained tables, the opt-in `notifications` catalog set and additive Example App migration `0023` (Roxabi/roxabi-boilerplate-cf#477).
- Admit Inbox rows and initial Delivery intentions atomically, preserve active-source deduplication, scope Inbox and configuration operations by their exact owner, and commit administration audit with effective mutations.
- Persist monotone admission observations with a fixed 24-hour deadline, conditional terminal receipts, unified fair candidate pagination and bounded Organization-scoped retention. The App derives Workflow identities and never reuses Delivery IDs; storage does not create or restart a Workflow.
- Preserve every decoded cursor key in the shared core helper, including JSON `__proto__` data keys, so Notifications' strict keyset schemas can reject unknown input instead of silently losing it before validation.
- Add the session-only Example App Notifications HTTP interface: global User rules, type catalogue, Organization-scoped Inbox and effective rules, and Deployment/Organization administration metadata (Roxabi/roxabi-boilerplate-cf#478).
- Gate Organization administration with `manage_notifications` at `admin`, preserve logged support reads without an Inbox or write bypass, and commit admin rule audit atomically. Personal rules and read marks remain unaudited; authenticated API keys are refused.
- Render Inbox content from API-owned French/English catalogues at read time, expose configured lock provenance separately from live Module availability, and validate strict request/keyset shapes without widening the 512-character cursor cap. This HTTP slice adds no destination route or Delivery runtime; producer composition is described below.
- Preserve JSON media-type client faults as safe 400 responses, retain schema field errors, and project the complete external-Channel/ASCII identifier grammar and closed Delivery DTO into OpenAPI.
- Route approval Notification links through the authenticated App run view for eligible Organization members without a Platform role; keep the administrative entry restricted and the flows API authoritative.

### Notification producers

- Add server-only App `notify` / `resolve` composition with factual Organization, membership and Module access, complete rule/destination pagination, optional actor exclusion, and independent collective intentions without a collective Inbox (Roxabi/roxabi-boilerplate-cf#479).
- Connect Task assignment events through the existing awaited audit hook, filter each recipient through object visibility, and resolve removal, deletion, completion or a terminal stage. The Task adapter gates resolution and pending Delivery skips on current lifecycle facts inside one D1 batch; a delayed removal or compensation cannot close a later eligible reassignment. Reopening alone emits nothing.
- Connect Flow approval ports to the existing owner. Every opening checks current D1 run, sealed approve task, waiting receipt and terminal decision before and after admission. Decision and cancellation routes attempt exact-source resolution after committed business writes and before wake or termination, including repair on repeats; resolution failure never reverses the business decision.
- Add optional trusted, repository-only SQL predicates that narrow the existing resolution scope and both lifecycle pairs atomically. Task domain stays in the App; the pure root, generic `ResolveInput`, unconditional default resolution and read timestamps remain unchanged.
- Persist stable SHA-256 Delivery identities and their original 24-hour admission deadlines, but do not create a Delivery Workflow, contact providers or reconcile admission. E5 owns those effects; E4-era pending intentions are not an eventual-send guarantee and may never be sent automatically after their original admission window closes.

### Notification email Delivery

- Compose User/email intentions with a separate, stable-ID `NotificationDeliveryWorkflow` after the Inbox transaction commits; admission failures preserve the committed result and do not prevent sibling handoffs (Roxabi/roxabi-boilerplate-cf#480).
- Keep automatic admission inside the original 24-hour window, observe existing owners without restarting them, and reconcile one fair page per Organization. Slack and Organization/email remain uncomposed: they are not sent or falsely finalized because a channel is unavailable.
- Use three native steps, five send retries and a strict private retry envelope with an explicitly constant backoff. Every physical attempt rechecks current access, rules, resolution and verified email; terminal receipts and checkpointed sends are not replayed. Acceptance before checkpoint can still produce a duplicate.
- Render localized App copy, trusted source links and the authenticated rules API link in both email formats; preserve staging policy and classify only typed local or documented structured CF errors. `sent` means transport acceptance, not recipient receipt.
- Add five-minute maintenance and bounded retention, terminalizing pending children before Notification cascade deletion. Preserve native retention defaults without claiming effective account retention or automatic expiry from local tests.

### Tasks and Organization integrity

- Add optional assignee deltas to task mutation events. Task creation and its initial assignees commit atomically; replacement and its baseline read also share one D1 batch, including rollback across insert chunks. Unchanged updates omit the event field and audit metadata excludes assignee ids (Roxabi/roxabi-boilerplate-cf#473).
- **Breaking:** `replaceAssignees` returns `{ added, removed }` or `null` for an unowned task, rather than a boolean. Migrate callers to the [consumer contract](docs/kit/product-consumer-contract.md).
- Promote the Tasks tenancy contract migration after deployed-expand, live-count and disposable-D1 proof. Add database stage-ownership guards without rebuilding tasks; Organization foreign-key rebuilds remain pending and refuse unknown inbound dependencies before touching data (Roxabi/roxabi-boilerplate-cf#348, Roxabi/roxabi-boilerplate-cf#400).

### CI runtime

- Keep local Root complete, ordered and fail-fast, joining current-run Core and Coverage receipts into the CI verdict. The deploy check conservatively proves the CI `always()` conjunction on push while refusing unknown conditions (Roxabi/roxabi-boilerplate-cf#555).
- Amortize Coverage setup across bounded Package groups with a single-pass partition while keeping Apps dedicated, preserving an independent Root invocation and receipt per workspace, and collecting every workspace's report tree before the next cleanup.
- Preserve valid push-safe consumer conditions with separately parenthesized boolean operands in the deploy-gate check.
- Reuse real credential hashes only in synthetic API fixtures; keep default seeds and authentication operations on real crypto, with independent-salt and cross-context reset oracles.
- Keep the Web QueryClient registry separate from the provider renderer so global test setup does not preload the rendering graph; exercise query-cache isolation after a failing teardown.
- Inventory TypeScript inputs without repeating semantic type checking; run Biome global-rule plants with a snapshot of the root config and ignore file through the installed, lockfile-pinned package, retaining the actual-root config contract and full-root lint. Reject ambient binary overrides instead of testing a different executable from lint.
- Use all available CPUs in the five measured multi-file Kit suites only in CI, preserving local run/watch defaults, per-file isolation and sequential coverage execution.
- Default Auth tests to Node and opt the real forms renderer into happy-dom per file; retain explicit renderer cleanup and the existing isolation and coverage floors.

### Dependency maintenance

- Upgrade Biome to 2.6.7 and remove the temporary version hold after real-document formatting proof. Two ordered lists become loose, changing rendered paragraph spacing; future tight lists with adjacent code fences can also be loosened by the staged formatter.
- Product sync: inheritors must normalize Product-owned Markdown and YAML and fix new `noComponentHookFactories` and `useWhile` errors before their full Root gate and deploy. The Kit Root proof does not establish that unchanged Product-owned files pass. Canonical formatting adds substantial source padding and reduces readability in large tables; this is an intentional migration tradeoff, alongside the two documented list-layout changes.
- Raise the shared Zod minimum to 4.6.7, matching the already resolved version.
- Update Happy DOM test environments to 21.0.4 or later to address GHSA-834v-8h66-3h79.

### Documentation gates

- The ADR index gate accepts alignment padding in table cells while retaining reference and status checks.

### Markdown

- The Example App uses `@tanstack/markdown` 1.x. Its `SafeMarkdown` wrapper retains disabled HTML, dropped images and protected outbound links; consumers should verify their own Markdown rendering when upgrading.

### MCP tool refusals

- `toolRefusal(payload)` opts a tool into a domain refusal with MCP `isError: true`, structured content and JSON text. Ordinary results remain successes; unexpected exceptions retain public-error redaction.
- FastMCP's minimum compatible version is `^4.23.8`; the hosted Edge upgrade forwards refusal flags. Register tools through the existing catalogue seam.
- On hosted Edge, thrown tool errors now arrive as MCP results with `isError: true`, rather than JSON-RPC errors. Unsupported `MCP-Protocol-Version` headers on non-initialize requests now receive HTTP 400; initialize negotiates a supported requested protocol version.

### Dependabot automation

- Evaluate Dependabot changes from captured immutable head and base evidence; a withheld, failed or mismatched result cannot publish an automatic authorization receipt.

### Authentication reads

- Better Auth uses native Drizzle joins for session/user and related account/Organization reads. Supplied schema tables receive matching relation metadata; no SQL migration or cookie-format change is needed.
- **Breaking:** `createOrgMiddleware` replaces the `findOrgById` and `findMembership` ports with `findOrgContext(db, orgId, subject)`. Migrate both properties together; keep `getPlatformRole` for the standalone Platform Role guard. See the [consumer migration](docs/kit/product-consumer-contract.md#authentication-reads-and-organization-context-migration).
- Organization context reads status, the subject's Organization membership and Platform Role in one scoped query. Ordinary nonmembers receive 404 regardless of Organization status; suspended members remain forbidden. Super-admin break-glass, bypass audit and Module checks are preserved, without cross-request authorization caching.
- The permanent authentication regression contract for Roxabi/roxabi-boilerplate-cf#532 is described in [testing](docs/kit/testing/auth-seams.md#authentication-regressions). This is not a production latency claim or a resolution of Roxabi/roxabi-boilerplate-cf#398.
