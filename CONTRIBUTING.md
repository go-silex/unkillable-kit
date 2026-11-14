# Contributing

The public Kit repository is `go-silex/unkillable-kit`. Creating that repository is an operator step; this file does not publish it. These rules govern that repository and every GitHub issue, pull request, and comment write about the Kit.

Kit-owned work is under the [MIT License](docs/kit/licenses/MIT.txt), copyright UnkillableCompanies.

**Security reports go by email to [team@unkillablecompanies.com](mailto:team@unkillablecompanies.com).** Follow [SECURITY.md](SECURITY.md). A vulnerability does not belong in a public issue, pull request, or discussion.

## Permissions

Anyone may fork or clone the public Kit and may push branches on a fork they control.

| Action                                               | Who                                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Open a public issue on the canonical repository      | Anyone, while Issues stay enabled. An outsider stays limited to issues until a maintainer explicitly grants trusted write |
| Open a pull request against the canonical repository | Write, maintain, or admin, after a maintainer sets **Collaborators only**                                                 |
| Push or merge a canonical branch                     | That same write, maintain, or admin grant, or merge automation, subject to protections the repository actually enforces   |

The pull-request limit is a GitHub repository setting, not a rule this file can apply: **Settings → General → Features → Pull requests → Collaborators only**. In an organization repository, a collaborator is a user with the write, maintain, or admin role. There is no pull-request-only collaborator role. Granting write so someone can open a pull request also grants canonical branch push and merge, except where a protection the repository actually enforces withholds them. The pull-request tab stays visible. Issues stay enabled. This file does not turn the setting on, and a missing or later change of that setting leaves GitHub's own default in force. This file does not create branch protection or a ruleset. Write access can still bypass an unenforced process; see [testing.md](docs/kit/testing/ops-model.md#merge-residual-github-free-private) § _Merge residual_.

Merge automation follows a current exact-head authorization receipt. Labels, including `reviewed` and `deps-automerge`, are hints, not authorization. External issue or pull-request authorship does not grant merge authority. Receipts, withdrawal, and the shared-App owner exception stay in [CI App setup](docs/kit/ci-app-setup.md). Do not copy operational inventory into a public write.

The private Kit source stays private. Historical issues are not copied into the public repository. This contract adds no operations repository. Archiving private history is a later operator decision, not an automatic publication step.

## Independent-root preparation

This one-time local procedure exports a clean, reviewed source commit, not its Git history. It does not create a remote repository, push, change visibility or deploy. The first hosted target stays private until its separate exposure checkpoint. Do not fetch the private source into the candidate or add it as a remote.

Run both blocks in the same non-interactive Bash process, from the clean source checkout, with `REVIEWED_SOURCE_SHA` set to the exact independently reviewed commit. The new directory contains only the archived tracked tree when it is staged; `--force` retains source files that are tracked despite ignore rules. Any intended content transformation must instead be approved in the source before export.

```bash
set -euo pipefail
: "${REVIEWED_SOURCE_SHA:?Set the independently reviewed full source SHA}"
[[ "$REVIEWED_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]
for hook_setting in ${!LEFTHOOK@}; do unset "$hook_setting"; done
unset GITHUB_REPOSITORY ZERO_EDIT_MODE ZERO_EDIT_HARNESS_SENTINEL
unset EXTRACT_MODE EXTRACT_HARNESS_SENTINEL ZERO_EDIT_BASE_REF
source_root="$(git rev-parse --show-toplevel)"
test -z "$(git -C "$source_root" status --porcelain)"
source_commit="$(git -C "$source_root" rev-parse --verify "${REVIEWED_SOURCE_SHA}^{commit}")"
test "$(git -C "$source_root" rev-parse HEAD)" = "$source_commit"
source_tree="$(git -C "$source_root" rev-parse "${source_commit}^{tree}")"
candidate="$(mktemp -d "${TMPDIR:-/tmp}/kit-public-root.XXXXXX")"
git -C "$source_root" archive --format=tar "$source_commit" | tar -xf - -C "$candidate"
git -C "$candidate" init -b main
git -C "$candidate" remote add origin https://github.com/go-silex/unkillable-kit.git
if git -C "$candidate" config --get core.hooksPath; then
  echo "Refusing inherited core.hooksPath for this isolated proof" >&2
  exit 1
fi
git -C "$candidate" add --force --all
test "$(git -C "$candidate" write-tree)" = "$source_tree"
(
  cd "$candidate"
  bun install --frozen-lockfile --minimum-release-age 0
  for hook in pre-commit commit-msg; do
    test -x ".git/hooks/$hook"
    grep -Fq "call_lefthook run \"$hook\"" ".git/hooks/$hook"
  done
  git commit -m "chore(kit): initialize independent public source tree"
)
candidate_commit="$(git -C "$candidate" rev-parse HEAD)"
test "$(git -C "$candidate" rev-parse 'HEAD^{tree}')" = "$source_tree"
test "$(git -C "$candidate" rev-list --count --all)" = 1
test "$(git -C "$candidate" for-each-ref --format='%(refname)')" = refs/heads/main
(
  cd "$candidate"
  bun run validate:full
)
test "$(git -C "$candidate" for-each-ref --format='%(refname)')" = refs/heads/main
test ! -e "$candidate/.git/objects/info/alternates"
```

Use the runtime admitted by the repository's Bun version check. Locked installation runs the normal hook installation path; the initial commit must pass the maintained staged secret scans and commit checks. Fix a failing hook in the source and export again: neither an empty sentinel commit nor a hook bypass is an acceptable bootstrap.

Keep the source commit/tree, included-file manifest, candidate commit/tree and intended public refs in a private receipt outside both repositories. The content trees must match; the new root commit SHA will differ from the source commit. Do not turn the receipt into a tracked journal or public operational inventory.

`bun run validate:full` above exercises the first-push context: the candidate still has no remote-tracking ref. Run it before the reader clone. Do not plant `origin/main` to satisfy the migration gate.

Exercise a fresh clone using only the candidate as transport, then set its actual origin to the intended identity:

```bash
fresh="$(mktemp -d "${TMPDIR:-/tmp}/kit-public-reader.XXXXXX")/kit"
git clone --no-local "$candidate" "$fresh"
git -C "$fresh" remote set-url origin https://github.com/go-silex/unkillable-kit.git
test "$(git -C "$fresh" rev-parse HEAD)" = "$candidate_commit"
test "$(git -C "$fresh" rev-parse 'HEAD^{tree}')" = "$source_tree"
test "$(git -C "$fresh" rev-list --count --all)" = 1
test ! -e "$fresh/.git/objects/info/alternates"
(
  cd "$fresh"
  bun install --frozen-lockfile --minimum-release-age 0
  node scripts/kit/resolve-tree-identity.mjs
  bun run validate:full
)
```

Exercise the [Product onboarding](docs/kit/playbooks/start-product.md) in a separate throwaway fresh clone. Use the candidate as transport, then set its sole `origin` to the intended Kit identity as in the reader clone above. From that clone's root, run `bash scripts/kit/create-product.sh sample --origin example/sample-product --accept-parent-origin --commit --skip-gh-default`. The fictitious Product repository is not created or pushed, and the `gh` default is **not configured**; this fixture does not prove the authenticated default-repository path. Run the Product's own checks, not only the Kit gate. Exercise origin-only full-history consumption and the refusal of unknown identity, invalid marker, shallow ancestry and protected edits. The existing [continuity fixtures](docs/kit/testing/ops-model.md#commands) cover synthetic legacy transitions; they do not replace the real reader journey.

This local transport proof attests neither hosted settings nor public availability. Audit the candidate content and every intended ref, obtain independent review, and refresh affected evidence after any source or candidate change. Remote bootstrap, credentials and final visibility require their own authorized operations; anonymous clone and the same reader journey must verify the final public tip.

## Public-safe publication

Write the final public-safe payload. A private draft, a prompt, or a form field is not a holding area for material that must stay unpublished.

A public-safe payload:

- states the defect or change in Kit terms
- includes only a minimal sanitized reproduction
- omits raw logs, client data, and secret values
- may include an App or User identifier; those identifiers are not automatically secrets

Initial vulnerability reports go only to the email in [SECURITY.md](SECURITY.md). A later public mention follows that file.

### Final-payload review

Before creating or editing an issue, a comment, or a pull-request description, review every final outgoing title, body and comment part. The submitting human or agent checks semantic confidentiality and rewrites anything that is not public-safe. This is not an extra human sign-off on every issue.

Keep the final text in a local file while reviewing it. Include only a minimal sanitized reproduction, and remove secret values, client information, raw logs and private operational inventory. Security-report details stay in the private disclosure channel.

A trusted secret scanner may provide an additional, best-effort check of those final drafts. Disable provider verification and automatic updates, inspect results privately, and never paste a scanner match into GitHub. A finding stops publication. An unavailable scan or a clean exit is not permission to skip the semantic review.

The selected protection is documentary and best-effort, not a mandatory automatic publisher gate. TruffleHog and Gitleaks can silently skip content they classify as a file format; a clean scan does not prove that every outgoing byte was checked or that the text is public-safe. Attachments, linked content and credential-free confidential prose require the same semantic review.

No new publication command, scanner dependency, native adapter or plugin gate is provided. Existing issue, pull-request and comment writers remain unchanged. Direct `gh` and browser writes are not intercepted. Forms and checklists are reminders; GitHub secret scanning detects supported secrets after publication, not before it.

## Issues and pull requests

Issue creation, triage fields, and relations go through the writer in [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md). This file does not add a second writer. A public reporter may still open an issue; the form reminder does not replace the writer's final-payload review when an agent writes.

Use the bug or feature form for an ordinary report. Leave blank issues enabled. Do not file a security report through either form.

Qualified issue and pull-request references follow [AGENTS.md](AGENTS.md).

## Development

Read [AGENTS.md](AGENTS.md) before changing Kit-owned paths. The development and review procedure is [dev-process.md](docs/kit/processes/dev-process.md). The root gate is the `validate:full` script in the root `package.json`; [testing.md](docs/kit/testing.md) owns the testing doctrine. Do not copy the gate's step list into a pull request or an issue.
