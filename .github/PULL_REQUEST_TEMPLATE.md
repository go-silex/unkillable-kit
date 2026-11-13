## Summary

<!-- 1–3 sentences: what and why -->

## Related Issue

Closes <owner>/<repo>#<!-- number if any, always qualified: a bare #N is ambiguous -->

## Type of Change

- [ ] `feat` — New feature
- [ ] `fix` — Bug fix
- [ ] `docs` — Documentation
- [ ] `refactor` — Refactor (no behaviour change)
- [ ] `test` — Tests only
- [ ] `chore` — Maintenance
- [ ] `ci` — CI / workflows
- [ ] `perf` — Performance
- [ ] `security` — Security fix / hardening

## Changes

<!-- Bullet list of concrete changes -->

-

## Public text

This description, its commits, and any screenshot are public once the repository is public. Before opening or editing, apply [Public-safe publication](../CONTRIBUTING.md#public-safe-publication) to the exact description file. A vulnerability report goes to [`SECURITY.md`](../SECURITY.md) (`mailto:team@unkillablecompanies.com`), not into this pull request. The box is a reminder, not a publication gate.

- [ ] Description and screenshots omit secret values, raw logs, client data, and vulnerability details

## Security checklist (required)

See [`docs/kit/processes/dev-process.md`](../docs/kit/processes/dev-process.md) § _Sécurité & bon usage de l’IA_.

### Secrets & config

- [ ] No secrets, tokens, or real `.dev.vars` / `.env` values in the diff
- [ ] New env vars documented in `.env.example` / `.dev.vars.example` as **placeholders only**
- [ ] No credentials pasted into PR description or screenshots

### Auth / access (if touched)

- [ ] Guards first on mutating / sensitive routes (`requireSession` / `requireApiKey`)
- [ ] Session cookies: HttpOnly · Secure (prod) · SameSite considered
- [ ] API keys remain **per-user** (no shared team key)
- [ ] `sk_` failures do not leak existence (401)
- [ ] Org membership rules respected (upload = org members only)

### Storage / serve (if touched)

- [ ] No path traversal on R2 / slug paths
- [ ] Zip unpack: zip-slip + size limits (frame)
- [ ] Large uploads use presigned flow (not Worker body for video)

### MCP / agents (if touched)

- [ ] Tools least-privilege; no arbitrary shell/exec
- [ ] Auth via `sk_…` (or documented OAuth path); no shared key
- [ ] Destructive tools require clear auth + audit where applicable

### Errors & privacy

- [ ] Client responses do not leak stack traces / SQL / internal paths
- [ ] Stable error **codes** used where UI/i18n needs them
- [ ] Logs avoid secrets and full API keys

## Quality checklist

See [`docs/kit/testing.md`](../docs/kit/testing.md) (local-first gates, CP-\* paths, ownership).

- [ ] PR title follows [Conventional Commits](https://www.conventionalcommits.org/) — no issue number in the title or scope (qualified refs go in the body)
- [ ] Self-review done on the full diff
- [ ] Tests added/updated for behaviour change — map to **CP-\*** / suite names when auth, IDOR, storage, errors, FE credentials
- [ ] **`bun run validate:full` green locally** before push (primary gate; CI is guardrail only)
- [ ] Docs / `AGENTS.md` / `docs/kit/testing.md` updated if stack or test policy changed
- [ ] Dual-mission: product code stays out of kit packages (`packages/*` has no share-domain strings)

## Critical paths touched (if any)

<!-- From docs/kit/testing.md — tick what this PR affects; name the test file(s) in Test plan -->

- [ ] CP-AUTH-\* (session / keys / dual)
- [ ] CP-IDOR / CP-UNAUTH (new or changed protected resource)
- [ ] CP-ERR / CP-CORS / CP-SECRET
- [ ] CP-R2 / storage paths
- [ ] CP-FE-CRED (api client credentials / 401)
- [ ] CP-MCP / CP-BAN / CP-EXTRACT
- [ ] CP-ENV / CP-LICENSE / CP-I18N
- [ ] CP-UI-CONTRACT
- [ ] None of the above

## Independent targeted review required?

Tick every scope that requires targeted proof and review by an agent independent of implementation. Operator authorization is distinct from technical review. The list follows [`AGENTS.md`](../AGENTS.md) § Hard agent rules.

- [ ] Auth / cookies / API keys
- [ ] ACL / Organization isolation
- [ ] R2 / archive (zip) / serve paths
- [ ] MCP tools
- [ ] D1 migrations
- [ ] Durable execution ownership / hand-built durability: owner changes, a Product ADR pairing, or code that persists, retries, resumes or re-dispatches work ([ADR-0018](../docs/kit/architecture/adr/0018-durable-execution-ownership.md) D1/D2)
- [ ] Deploy
- [ ] None of the above

## Test plan

<!-- Commands actually run + scenarios. Prefer: bun run validate:full -->

-
