# Deploy verify

The Deploy gate moves `deploy/<branch>`; Cloudflare Workers Builds then builds and deploys that
commit with no signal back to GitHub. A failed or stuck build leaves the previous version live while
the gate run stays green. Deploy verify (`.github/workflows/deploy-verify.yml`,
go-silex/unkillable-kit#215) checks from outside that every listed Worker serves the promoted commit
and posts one Slack alert when one does not by the deadline. It is opt-in, per Product and per
source branch. The rest of the CD chain is in [deploy-cloudflare.md](./deploy-cloudflare.md).

## Contract

A verified Worker meets four conditions.

1. **Version tag.** Its deploy runs `wrangler deploy --tag <sha>`, where `<sha>` is the full commit
   SHA its Workers Build deploys, printed by `scripts/kit/cf-builds/require-deploy-sha.sh`.
2. **Binding.** Each Wrangler environment it deploys declares the `version_metadata` binding
   `CF_VERSION_METADATA`: `[version_metadata]` for the top-level environment and
   `[env.<name>.version_metadata]` for each named one. A binding is not inherited: repeat it in
   every deployed Wrangler environment.
3. **Health field.** Each health URL listed for it answers a 2xx JSON object whose top-level
   `versionTag` field is `CF_VERSION_METADATA.tag`, or `null` without that binding or tag.
4. **Uncached.** No cache answers for a listed URL: the response sends `Cache-Control: no-store`
   and no Cloudflare cache rule covers it. A cached answer could report a version that no longer
   serves.

The Example API is the reference: `apps/example-api/wrangler.toml` declares the binding,
`apps/example-api/src/routes/health.ts` returns the field with `Cache-Control: no-store` and
`scripts/kit/cf-builds/api-deploy.sh` tags the version.

### Version tag

`require-deploy-sha.sh` prints the SHA to tag and logs `cf-builds: version tag <sha>` to stderr.
It refuses, before migrate or deploy, whenever the tag could name other code:

- in Workers Builds (`WORKERS_CI` set), `WORKERS_CI_COMMIT_SHA` must be 40 lowercase hex
  characters equal to the checkout `HEAD`;
- elsewhere, a break-glass laptop deploy, the tag is `HEAD`, `WORKERS_CI_COMMIT_SHA` must equal it
  when set, and the worktree must be clean, untracked files included whatever
  `status.showUntrackedFiles` says;
- a directory that is not a git checkout with a `HEAD` commit is refused.

Ignored files, such as `.wrangler/` or build output, are not checked: deploy break-glass from a
fresh checkout of `deploy/<branch>`.

Call it as its own assignment under `set -e`. Inside the wrangler arguments, a refusal would go
unnoticed:

```bash
sha="$(bash scripts/kit/cf-builds/require-deploy-sha.sh)"
bunx wrangler deploy --env production --tag "$sha"
```

## Configuration

`config/product/deploy-verify.json` is Product-owned. The workflow reads it from the checkout of
`deploy/<branch>`, so a change applies once the Deploy gate promotes it.

```json
{
  "timeoutMinutes": 20,
  "targets": {
    "main": ["https://api.example.com/health"],
    "staging": ["https://api.staging.example.com/health"]
  }
}
```

- `targets` is required and names at least one source branch, `main` or `staging`.
- Each named branch lists 1 to 10 distinct health URLs.
- A URL is `https`, on a dotted DNS host name, without an IP address, credentials, fragment,
  whitespace or control character, and at most 2048 characters long.
- `timeoutMinutes` is optional: an integer from 1 to 60, 20 by default.
- Any other key, and any other problem, refuses the run with every finding listed.
- A branch absent from `targets` gets a notice and is not verified.

Without the file, the run posts a notice and verifies nothing.

## When it runs

- **After each Deploy gate run that evaluated a branch.** A gate run triggered by `workflow_run`
  always runs on the default branch, so it does not say which source branch it evaluated. Every
  gate run of which one job ran verifies both `deploy/main` and `deploy/staging`; a branch already
  served passes on the first round. The workflow reads the jobs of the gate run attempt that
  triggered it: a non-empty list of skipped jobs, such as for a pull-request CI run, verifies
  nothing. An empty list, a read error or a read past 60 seconds verifies both branches anyway.
  This YAML is the default branch's.
- **By hand.** `workflow_dispatch` verifies one branch with the YAML of the ref it selects: select
  the default branch. The optional `expected_sha` input pins the commit to expect instead of the
  `deploy/<branch>` tip, for a test or after a break-glass push.
- Runs for one branch are serialized. A running one is never cancelled; a newer queued run
  replaces an older queued one, and each run resolves `deploy/<branch>` when it starts. A pinned
  run has its own queue: it never replaces the verification of a promotion.

## Decision

The workflow resolves `deploy/<branch>`; a missing branch gets a notice, any other read error
fails. It checks out that commit and runs `scripts/kit/deploy-verify.ts` from it.

- Each round requests every target. The run succeeds when one round sees every target serve the
  expected SHA; a target that served it and then regressed does not count.
- Rounds repeat 15 seconds after the previous one ends. Each request has a 10-second limit, a
  64 KiB body limit, no redirect, no URL globbing and `https` only.
- The deadline is the promotion time plus `timeoutMinutes`. The promotion time comes from the
  repository activity of `deploy/<branch>` when its last event moved it to this SHA. Otherwise,
  and with `expected_sha`, the start of the verification replaces it.
- The first round always runs, even when the run starts after the deadline. A follow-up round
  starts only before the deadline: the run stops when the next one would start at or after it.
  `timeoutMinutes` bounds that polling window; the job itself stops after 75 minutes.
- `deploy/<branch>` moves on: the run ends as superseded, without an alert. The gate run that moved
  it starts the verification of the new SHA.
- A target still serves another tag, `null`, a non-2xx status, an invalid body or no answer in the
  last round: the run fails and the alert is posted.

## Slack alert

One alert per branch and SHA. It names the repository, the branch, the expected SHA and what each
target served last, in code spans that Slack does not link, with links to the Deploy verify run
and, when there is one, the Deploy gate run.

- The workflow posts it with the repository secret `SLACK_FLINT_BOT_TOKEN` to the Slack channel
  whose ID is the repository variable `SLACK_CHANNEL_BUGS_ALERT`. There is no default Slack
  channel. The bot token needs the `chat:write` scope and the bot must be able to post to that
  Slack channel, as a member for a private one.
- After a successful post, a run started by `workflow_run` uploads an artifact named
  `deploy-verify-alert-<branch>-<sha>`, kept 90 days. A later run that finds it fails without
  posting again.
- A marker counts only when a Deploy verify run started by `workflow_run` uploaded it: that run
  uses the default branch's YAML. A marker from another workflow, from a dispatch on any ref or
  from a pull request, fork included, is logged and ignored.
- A dispatch records no marker. A pinned run reads none either: it always reports, and labels
  its alert as a pinned check.
- When the earlier alerts cannot be read, or the lookup takes more than 60 seconds, the run posts
  anyway: a duplicate beats a miss.
- A missing secret or variable, or a Slack error, gives a warning; the failed run remains the
  alert.
- An invalid config fails the run without a Slack alert.

## Trust

- The script, its Bun version and the config come from the already-promoted `deploy/<branch>`,
  never from an untested tip. Bun is downloaded on each run, never restored from a cache that
  unpromoted code may have written.
- On `workflow_run`, the workflow YAML is the default branch's, as for the gate; a dispatch runs
  the YAML of the selected ref.
- The workflow holds no Cloudflare credential and no App token. `GITHUB_TOKEN` has `contents: read`
  and `actions: read`, and the checkout keeps no credential: nothing in it can write to `deploy/*`.
- Only the posting step reads the Slack token, and it passes the token to `curl` on stdin. That
  step runs after the promoted script in the same job, as the Deploy gate mints its App token
  after `promote-deploy.ts`. The token is kept from untrusted input, not from promoted code:
  whoever can get code promoted can already read repository secrets from a push workflow.
- Health answers, the config and API answers are untrusted. Log lines are made inert as workflow
  commands, annotations carry no value read from them, and the alert text escapes them.
- The dispatch branch input selects a fixed matrix value and is never interpolated into a script;
  `expected_sha` must be 40 lowercase hex characters.

## Default timeout

The 20-minute default comes from the successful Workers Builds of `deploy/*` on four Workers,
from creation to finish, which includes the queue:

| Window                  | Builds | Median | p90  | p95  | p99   | Max    |
| ----------------------- | ------ | ------ | ---- | ---- | ----- | ------ |
| 2026-08-30 → 2026-11-26 | 323    | 52 s   | 85 s | 95 s | 132 s | 1040 s |
| Last 30 days            | 204    | 56 s   | —    | —    | 132 s | 160 s  |

The 1040-second maximum includes 983 seconds of queue; without that build, the maximum is
160 seconds. Twenty minutes clears the slowest observed build with margin; the polling window
never exceeds 60 minutes.

## Adopt in a Product

1. In each Product deploy script, after the branch guard and before migrate, take the tag with
   `sha="$(bash scripts/kit/cf-builds/require-deploy-sha.sh)"` as its own assignment, then deploy
   with `wrangler deploy --tag "$sha"`.
2. In each deployed Wrangler environment of each verified Worker, declare the binding
   `CF_VERSION_METADATA`: `[version_metadata]` at top level, `[env.<name>.version_metadata]` in
   each named environment.
3. Return `versionTag` from the public health response with `Cache-Control: no-store`, as the
   Example API does, and keep every listed URL out of Cloudflare cache rules.
4. Set the repository secret `SLACK_FLINT_BOT_TOKEN`, a bot token with `chat:write` that can post
   to the Slack channel, and the repository variable `SLACK_CHANNEL_BUGS_ALERT`.
5. Once every target reports its commit, add `config/product/deploy-verify.json` and let the
   Deploy gate promote it.
6. Check each configured branch by hand: run Deploy verify with `workflow_dispatch` from the
   default branch. A green run is not enough: expect the notice
   `Deploy verify: N target(s) serve <sha> (deploy/<branch>)` with the promoted SHA.

## Failure modes

- **`Deploy verify: not served`** — a target still serves another commit at the deadline. Read the
  Workers Build of that commit in the Cloudflare dashboard, fix it, then push a new commit or
  retry the build. When that build succeeded, look for a cache or a gradual deployment in front of
  the health URL.
- **`serves no version tag (null)`** — the binding is missing in that Wrangler environment, or the
  deploy did not pass `--tag`.
- **`invalid body`** — the URL is not the health route, or the health response has no
  `versionTag`.
- **`unreachable`** — DNS, TLS, an access rule or a non-2xx status. Requests come from GitHub
  runners, without credentials.
- **`deploy-verify.json` is invalid** — every finding is logged; fix the file on `main` or
  `staging` and let the gate promote it.
- **`Deploy verify missing on deploy/<branch>`** — the config was promoted before the kit upgrade
  that ships the script. Promote that upgrade.
- **`no Slack alert`** — the secret or the variable is missing, or Slack refused the post. The
  warning names the Slack error.

## Limits

- Gradual deployments split traffic between versions; a target may answer either one.
- A rule that challenges GitHub runners, such as bot protection, makes a target unreachable.
- A break-glass push to `deploy/*` is verified at the next gate run, or by hand.
- A break-glass laptop deploy can ship ignored files, such as a stale `.wrangler/` generated
  config, under a clean `HEAD`.
- Duplicate keys in the JSON config are not detected; the last one wins.
- A lost Slack response or a failed marker upload can post the alert again, and so does a gate
  run after a dispatch alerted on the same SHA. Only the first 100 artifacts named after the
  marker are read.
- A served tag proves the version Cloudflare serves, not the behaviour of that version.

## Proof (CP-DEPLOY-VERIFY)

- `bun run test:deploy-verify` (`scripts/kit/test-deploy-verify.ts`, in `validate:tooling`): the
  config contract, health answers, the polling loop on a fake clock (served, served only on a full
  round, not served by the deadline, no follow-up round past it, recovery, superseded, pinned
  SHA), the earlier-alert lookup budget, the alert text and the CLI with stubbed `gh` and `curl`
  (no config, no target, invalid config, success, a bracketed URL, one alert, no second alert,
  markers of other origins, refusals, inert output).
- `bun run test:cf-builds`: `api-deploy.sh` deploys with `--tag` and the tested commit, and
  `require-deploy-sha.sh` refuses a missing, malformed or different CI SHA and a dirty laptop
  worktree, also with the HEAD SHA given or untracked files hidden from `git status`.
- The Example API tests: `/health` reports the tag uncached, and `null` without one.
- `bun run actions-pin:check` (in `validate:full`) checks that every action is pinned by SHA.

**Does not** prove GitHub delivering the `workflow_run` event, the repository activity API, the
Slack post, a real Cloudflare deploy or a Product's targets. Each Product proves those at adoption.
