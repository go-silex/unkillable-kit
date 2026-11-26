# Deploy verify

The Deploy gate moves `deploy/<branch>`; Cloudflare Workers Builds then builds and deploys that
commit with no signal back to GitHub. A failed or stuck build leaves the previous version live while
the gate run stays green. Deploy verify (`.github/workflows/deploy-verify.yml`,
go-silex/unkillable-kit#215) checks from outside that every listed Worker serves the promoted commit
and posts one Slack alert when one does not by the deadline. It is opt-in, per Product and per
source branch. The rest of the CD chain is in [deploy-cloudflare.md](./deploy-cloudflare.md).

## Contract

A verified Worker meets three conditions.

1. **Version tag.** Its deploy runs `wrangler deploy --tag <sha>`, where `<sha>` is the full commit
   SHA its Workers Build deploys, printed by `scripts/kit/cf-builds/require-deploy-sha.sh`.
2. **Binding.** Each Wrangler environment it deploys declares the `version_metadata` binding
   `CF_VERSION_METADATA`. A binding is not inherited: repeat `[env.<name>.version_metadata]` in
   every deployed Wrangler environment.
3. **Health field.** Each health URL listed for it answers a 2xx JSON object whose top-level
   `versionTag` field is `CF_VERSION_METADATA.tag`, or `null` without that binding or tag.

The Example API is the reference: `apps/example-api/wrangler.toml` declares the binding,
`apps/example-api/src/routes/health.ts` returns the field and `scripts/kit/cf-builds/api-deploy.sh`
tags the version.

### Version tag

`require-deploy-sha.sh` prints the SHA to tag and logs `cf-builds: version tag <sha>` to stderr.
It refuses, before migrate or deploy, whenever the tag could name other code:

- in Workers Builds (`WORKERS_CI` set), `WORKERS_CI_COMMIT_SHA` must be 40 lowercase hex
  characters equal to the checkout `HEAD`;
- elsewhere, a break-glass laptop deploy, the worktree must be clean, untracked files included,
  and the tag is `HEAD`;
- a directory that is not a git checkout with a `HEAD` commit is refused.

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

- **After each Deploy gate run.** A gate run triggered by `workflow_run` always runs on the default
  branch, so it does not say which source branch it evaluated. Every gate run whose job ran
  verifies both `deploy/main` and `deploy/staging`; a branch already served passes on the first
  round. A gate run whose jobs were all skipped, such as one for a pull-request CI run, verifies
  nothing. When the gate jobs cannot be read, both branches are verified anyway.
- **By hand.** `workflow_dispatch` verifies one branch. The optional `expected_sha` input pins the
  commit to expect instead of the `deploy/<branch>` tip, for a test or after a break-glass push.
- Runs for one branch are serialized. A running one is never cancelled; a newer queued run
  replaces an older queued one, and each run resolves `deploy/<branch>` when it starts.

## Decision

The workflow resolves `deploy/<branch>`; a missing branch gets a notice, any other read error
fails. It checks out that commit and runs `scripts/kit/deploy-verify.ts` from it.

- Each round requests every target that does not serve the expected SHA yet. A target that
  serves it is not requested again.
- Rounds repeat every 15 seconds. Each request has a 10-second limit, a 64 KiB body limit, no
  redirect and `https` only.
- The deadline is the promotion time plus `timeoutMinutes`. The promotion time comes from the
  repository activity of `deploy/<branch>` when its last event moved it to this SHA. Otherwise,
  and with `expected_sha`, the run start replaces it.
- Every target serves the SHA: the run succeeds.
- `deploy/<branch>` moves on: the run ends as superseded, without an alert. The gate run that moved
  it starts the verification of the new SHA.
- A target still serves another tag, `null`, a non-2xx status, an invalid body or no answer at the
  deadline: the run fails and the alert is posted.

## Slack alert

One alert per branch and SHA. It names the repository, the branch, the expected SHA and what each
target served last, with links to the Deploy verify run and, when there is one, the Deploy gate
run.

- The workflow posts it with the repository secret `SLACK_FLINT_BOT_TOKEN` to the Slack channel
  whose ID is the repository variable `SLACK_CHANNEL_BUGS_ALERT`. There is no default Slack
  channel.
- After a successful post, an artifact named `deploy-verify-alert-<branch>-<sha>` records it for
  90 days. A later run that finds it fails without posting again.
- When the earlier alerts cannot be read, the run posts anyway: a duplicate beats a miss.
- A missing secret or variable, or a Slack error, gives a warning; the failed run remains the
  alert.
- An invalid config fails the run without a Slack alert.

## Trust

- The script, its Bun version and the config come from the already-promoted `deploy/<branch>`,
  never from an untested tip. The workflow YAML itself is the default branch's, as for the gate.
- The workflow holds no Cloudflare credential and no App token. `GITHUB_TOKEN` has `contents: read`
  and `actions: read`, and the checkout keeps no credential: nothing in it can write to `deploy/*`.
- Only the posting step reads the Slack token, and it passes the token to `curl` on stdin.
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
160 seconds. Twenty minutes clears the slowest observed build with margin, and a run never waits
more than 60 minutes.

## Adopt in a Product

1. In each Product deploy script, after the branch guard and before migrate, take the tag with
   `sha="$(bash scripts/kit/cf-builds/require-deploy-sha.sh)"` as its own assignment, then deploy
   with `wrangler deploy --tag "$sha"`.
2. In each deployed Wrangler environment of each verified Worker, declare
   `[env.<name>.version_metadata]` with `binding = "CF_VERSION_METADATA"`.
3. Return `versionTag` from the public health response, as the Example API does.
4. Set the repository secret `SLACK_FLINT_BOT_TOKEN` and the repository variable
   `SLACK_CHANNEL_BUGS_ALERT`.
5. Once every target reports its commit, add `config/product/deploy-verify.json` and let the
   Deploy gate promote it.
6. Check one Deployment by hand: run Deploy verify with `workflow_dispatch` and expect a green run.

## Failure modes

- **`Deploy verify: not served`** — a target still serves another commit at the deadline. Read the
  Workers Build of that commit in the Cloudflare dashboard, fix it, then push a new commit or
  retry the build.
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
- Duplicate keys in the JSON config are not detected; the last one wins.
- A served tag proves the version Cloudflare serves, not the behaviour of that version.

## Proof (CP-DEPLOY-VERIFY)

- `bun run test:deploy-verify` (`scripts/kit/test-deploy-verify.ts`, in `validate:tooling`): the
  config contract, health answers, the polling loop on a fake clock (served, not served by the
  deadline, recovery, superseded, pinned SHA) and the CLI with stubbed `gh` and `curl` (no config,
  no target, invalid config, success, one alert, no second alert, refusals, inert output).
- `bun run test:cf-builds`: `api-deploy.sh` deploys with `--tag` and the tested commit, and
  `require-deploy-sha.sh` refuses a missing, malformed or different CI SHA and a dirty laptop
  worktree.
- The Example API tests: `/health` reports the tag, and `null` without one.
- `bun run actions-pin:check` (in `validate:full`) checks that every action is pinned by SHA.

**Does not** prove GitHub delivering the `workflow_run` event, the repository activity API, the
Slack post, a real Cloudflare deploy or a Product's targets. Each Product proves those at adoption.
