#!/usr/bin/env bash
# KIT_UPGRADE_BUN and KIT_UPGRADE_HARNESS_SENTINEL are for the hermetic self-test only.
set -euo pipefail
export GIT_OPTIONAL_LOCKS=0
trap 'echo "stop: inspect the error and resume manually as documented in Pulling kit upgrades; do not restart an open merge" >&2' ERR

cd "$(git rev-parse --show-toplevel)"
unset LOCK_RANGES_ROOT
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
# Exact ref only: rev-parse also tries refs/heads/<name>, so a local branch could stand in for the Kit tip.
resolve_tip() {
  if ! ref=$(git show-ref --verify --hash refs/remotes/upstream/main 2>/dev/null); then
    echo 'stop: refs/remotes/upstream/main is missing; add the upstream remote and fetch it' >&2
    exit 1
  fi
  if ! tip=$(git rev-parse --verify --quiet "$ref^{commit}"); then
    echo 'stop: refs/remotes/upstream/main does not point to a commit' >&2
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
# Each diff in an `if`: a failure (e.g. a tip object a partial clone lacks offline) stops
# with git's own error instead of the ERR trap, after any earlier notice is printed.
preflight_stop() {
  echo "stop: cannot compare $1 with the cached upstream/main (git diff failed; see the error above)" >&2
  exit 1
}
package_diff=$(git diff --no-textconv --no-ext-diff -U0 HEAD "$tip" -- package.json) || preflight_stop package.json
# Read the whole pipe: grep -q can cause SIGPIPE, while large here-strings can fail on a full TMPDIR.
if printf '%s\n' "$package_diff" | grep '^+.*"packageManager"' >/dev/null; then
  echo "packageManager moves: set BUN_VERSION on each Workers Builds / Pages project just before this reaches its deploy/<branch> source branch (row 'Kit bumps packageManager')" >&2
fi
workflow_diff=$(git diff --no-textconv --no-ext-diff -U0 HEAD "$tip" -- .github/workflows) || preflight_stop .github/workflows
added_token_pins=$(printf '%s\n' "$workflow_diff" | awk '/^\+[^+].*create-github-app-token@/')
if [[ -n "$added_token_pins" ]]; then
  token_pattern="create-github-app-token@([[:xdigit:]]{40})([[:space:]\"']|$)"
  existing_token_pins='' rc=0
  existing_token_pins=$(git grep -E "$token_pattern" HEAD -- .github/workflows) || rc=$?
  if (( rc > 1 )); then preflight_stop .github/workflows; fi
  while IFS= read -r added_pin; do
    if [[ "$added_pin" =~ $token_pattern ]]; then
      existing_pattern="create-github-app-token@${BASH_REMATCH[1]}([[:space:]\"']|$)"
      if [[ "$existing_token_pins" =~ $existing_pattern ]]; then continue; fi
    fi
    echo "stop: this range bumps actions/create-github-app-token; establish the effective CI_APP_ID mode first (row 'Kit bumps actions/create-github-app-token')" >&2
    exit 1
  done <<<"$added_token_pins"
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
    # Only the cached Kit tree can name the Kit tag namespace. Parse its block
    # mapping, not the Product's stack or a `component` key in another block.
    if component=$(git show --no-textconv "$tip:.dev/stack.yml" 2>/dev/null | awk '
      /^[[:space:]]*(#|$)/ { next }
      /^[^[:space:]]/ { release = /^release:[[:space:]]*(#.*)?$/; next }
      release && /^  component:[[:space:]]*/ {
        count++
        sub(/^  component:[[:space:]]*/, "")
        sub(/[[:space:]]+#.*/, "")
        sub(/[[:space:]]+$/, "")
        if (/^"[a-zA-Z0-9][a-zA-Z0-9._-]*"$/ || /^\047[a-zA-Z0-9][a-zA-Z0-9._-]*\047$/)
          $0 = substr($0, 2, length($0) - 2)
        if (/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/) value = $0
      }
      END { if (count != 1 || value == "") exit 1; print value }
    '); then
      if releases=$(git for-each-ref --merged="$tip" --no-merged=HEAD \
        --sort=refname --sort=creatordate --format='%(refname:lstrip=2)' "refs/tags/$component/v*" 2>/dev/null); then
        releases=${releases//$'\n'/, }
        printf 'Kit releases in range (oldest first): %s\n' "${releases:-(none)}"
      else
        echo 'Kit release tags not readable from local history'
      fi
    else
      echo 'Kit release tags not reported: cannot read release.component at the cached tip'
    fi
  fi
  # A regular file only: a directory or symlink named CHANGELOG.md would make the pointer misleading.
  changelog_entry=$'^100(644|755) blob [0-9a-f]+\tCHANGELOG\\.md$'
  if [[ $(git ls-tree "$tip" -- CHANGELOG.md 2>/dev/null) =~ $changelog_entry ]]; then
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
git add bun.lock config/product/inheritance.json
if ! "$bun_cmd" install --frozen-lockfile --minimum-release-age 0; then
  echo 'stop: merge remains open; frozen install of the merged lock failed (see the error above); repair the lock and resume as documented in Pulling kit upgrades' >&2
  exit 1
fi
if ! "$bun_cmd" run lock-ranges:check; then
  echo 'stop: merge remains open; resolve lock-ranges findings by owner and resume as documented in Pulling kit upgrades' >&2
  exit 1
fi
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
