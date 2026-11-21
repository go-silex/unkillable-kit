#!/usr/bin/env bash
# KIT_UPGRADE_BUN and KIT_UPGRADE_HARNESS_SENTINEL are for the hermetic self-test only.
set -euo pipefail
export GIT_OPTIONAL_LOCKS=0
trap 'echo "stop: inspect the error and resume manually as documented in Pulling kit upgrades; do not restart an open merge" >&2' ERR

cd "$(git rev-parse --show-toplevel)"
check=false
if [[ ${1:-} == --check && $# == 1 ]]; then
  check=true
elif [[ $# != 0 ]]; then
  echo 'usage: kit-upgrade.sh [--check]' >&2
  exit 2
fi
if [[ -n ${KIT_UPGRADE_BUN:-} && ( -z ${KIT_UPGRADE_HARNESS_SENTINEL:-} || ! -f ${KIT_UPGRADE_HARNESS_SENTINEL} ) ]]; then
  echo 'stop: KIT_UPGRADE_BUN requires a test harness sentinel' >&2
  exit 1
fi
if [[ $(node scripts/kit/resolve-tree-identity.mjs) != 'mode=product '* ]]; then
  echo 'stop: kit-upgrade requires a product clone' >&2
  exit 1
fi
# The full ref name: a local branch named upstream/main must not shadow the cached Kit tip.
resolve_tip() {
  if ! tip=$(git rev-parse --verify --quiet 'refs/remotes/upstream/main^{commit}'); then
    echo 'stop: refs/remotes/upstream/main is missing; add the upstream remote and fetch it' >&2
    exit 1
  fi
}
if $check; then
  export GIT_NO_LAZY_FETCH=1
  resolve_tip
fi
if ! status=$(git status --porcelain); then
  echo 'stop: cannot read the working tree state (git status failed)' >&2
  exit 1
fi
if [[ -n $status ]] || [[ -f $(git rev-parse --git-path MERGE_HEAD) ]]; then
  echo 'stop: clean the working tree and finish any in-progress merge first' >&2
  exit 1
fi
if ! $check; then
  git fetch upstream
  resolve_tip
fi
package_diff=$(git diff --no-textconv --no-ext-diff -U0 HEAD "$tip" -- package.json)
# Read the whole pipe: grep -q can cause SIGPIPE, while large here-strings can fail on a full TMPDIR.
if printf '%s\n' "$package_diff" | grep '^+.*"packageManager"' >/dev/null; then
  echo "packageManager moves: set BUN_VERSION on each Workers Builds / Pages project just before this reaches its deploy/<branch> source branch (row 'Kit bumps packageManager')" >&2
fi
workflow_diff=$(git diff --no-textconv --no-ext-diff -U0 HEAD "$tip" -- .github/workflows)
if printf '%s\n' "$workflow_diff" | grep '^+.*create-github-app-token@' >/dev/null; then
  echo "stop: this range bumps actions/create-github-app-token; establish the effective CI_APP_ID mode first (row 'Kit bumps actions/create-github-app-token')" >&2
  exit 1
fi
if git merge-base --is-ancestor "$tip" HEAD; then
  echo 'already up to date with upstream/main'
  exit 0
fi
if $check; then
  if [[ $(git rev-parse --is-shallow-repository) == true ]]; then
    echo 'shallow clone: pending range not reported; fetch full history to see it'
  else
    # One block: a failure here must not trip the ERR trap.
    if count=$(git rev-list --count HEAD.."$tip") &&
      subjects=$(git log --first-parent --merges --reverse --format=%s HEAD.."$tip"); then
      printf 'Pending commits: %s\n' "$count"
      echo 'First-parent merge subjects (oldest first):'
      if [[ -n $subjects ]]; then
        printf '%s\n' "$subjects" |
          awk 'NR <= 50 { print } END { if (NR > 50) printf "… %d more\n", NR - 50 }'
      fi
    else
      echo 'pending range not readable from local history'
    fi
  fi
  if [[ $(git ls-tree --name-only "$tip" -- CHANGELOG.md 2>/dev/null) == CHANGELOG.md ]]; then
    printf 'Kit CHANGELOG at the cached tip: git show %s:CHANGELOG.md\n' "$tip"
  fi
  echo 'upgrade pending against the locally cached upstream/main (fetch separately to refresh)'
  exit 0
fi
if ! git merge --no-ff --no-commit "$tip"; then
  echo 'stop: resolve the merge conflict, refresh the inheritance marker to the merged tip, then continue manually as documented in Pulling kit upgrades' >&2
  exit 1
fi
if git cat-file -e HEAD:LICENSE 2>/dev/null; then
  git restore --source=HEAD --staged --worktree -- LICENSE
else
  git rm -q -f --ignore-unmatch -- LICENSE
fi
git diff --no-textconv --no-ext-diff --quiet HEAD -- LICENSE
printf '{\n  "version": 1,\n  "upstreamCommit": "%s"\n}\n' "$tip" > config/product/inheritance.json
bun_cmd=${KIT_UPGRADE_BUN:-bun}
"$bun_cmd" install
git add bun.lock
if ! "$bun_cmd" run lock-ranges:check; then
  echo 'stop: merge remains open; resolve lock-ranges findings by owner and resume as documented in Pulling kit upgrades' >&2
  exit 1
fi
git add bun.lock config/product/inheritance.json
git commit --no-edit
if ! git diff --no-textconv --no-ext-diff --quiet "$tip" -- .github/dependabot.yml; then
  node scripts/kit/configure-product-dependabot.cjs
  git add .github/dependabot.yml
  if ! git diff --cached --quiet -- .github/dependabot.yml; then
    git commit -m 'chore(deps): refresh Product Dependabot scan'
  fi
fi
if ! "$bun_cmd" run zero-edit; then
  echo 'stop: merge is committed; resolve zero-edit findings or intentionally refresh exceptions as documented' >&2
  exit 1
fi
