#!/usr/bin/env bash
# Sourced by api-deploy.sh (go-silex/unkillable-kit#215). Prints the commit a deploy ships, verified,
# for `wrangler deploy --tag`: Deploy verify (.github/workflows/deploy-verify.yml) compares the tag a
# Worker serves in its health `versionTag` field with the SHA of deploy/<branch>. A tag that does not
# name the deployed code would make that check lie, so anything unverifiable refuses before migrate
# or deploy.
# Usage: require_deploy_sha <ROOT>   prints the 40-hex SHA on stdout, or refuses
#   Workers Builds (WORKERS_CI=1): WORKERS_CI_COMMIT_SHA must be a full lowercase SHA equal to the
#     checkout HEAD.
#   Elsewhere (a break-glass laptop deploy): WORKERS_CI_COMMIT_SHA, when set, must equal HEAD, and
#     the worktree must hold no uncommitted change, untracked files included whatever
#     status.showUntrackedFiles says, since other bytes would ship under that name. Ignored files
#     (.wrangler/, build output) are not checked: deploy from a fresh checkout.
# Run, not sourced, it prints the SHA of the repository it lives in: a product deploy script runs
# `sha="$(bash scripts/kit/cf-builds/require-deploy-sha.sh)"` as its own assignment under `set -e`
# (inline in the wrangler arguments, a refusal would go unnoticed), then `wrangler deploy --tag "$sha"`.
require_deploy_sha() {
  local root="$1" ci_sha="${WORKERS_CI_COMMIT_SHA:-}" head
  if ! head="$(git -C "${root}" rev-parse --verify --quiet 'HEAD^{commit}' 2>/dev/null)"; then
    echo "error: refusing — ${root} is not a git checkout with a HEAD commit; the version tag cannot be verified." >&2
    exit 1
  fi
  if [[ -n "${WORKERS_CI:-}" && -z "${ci_sha}" ]]; then
    echo "error: refusing — Workers Builds set no WORKERS_CI_COMMIT_SHA; the version tag cannot be verified." >&2
    exit 1
  fi
  if [[ -n "${ci_sha}" ]]; then
    if [[ ! "${ci_sha}" =~ ^[0-9a-f]{40}$ ]]; then
      echo "error: refusing — WORKERS_CI_COMMIT_SHA '${ci_sha}' is not a full lowercase commit SHA." >&2
      exit 1
    fi
    if [[ "${ci_sha}" != "${head}" ]]; then
      echo "error: refusing — WORKERS_CI_COMMIT_SHA ${ci_sha} is not the checkout HEAD ${head}." >&2
      exit 1
    fi
  fi
  if [[ -z "${WORKERS_CI:-}" && -n "$(git -C "${root}" status --porcelain --untracked-files=all 2>/dev/null || echo unreadable)" ]]; then
    echo "error: refusing — the worktree has uncommitted changes (or git status failed): HEAD ${head} would not name the deployed code." >&2
    echo "  Deploy from a clean checkout of deploy/<branch>. docs/kit/deploy-verify.md § Version tag." >&2
    exit 1
  fi
  echo "cf-builds: version tag ${head}" >&2
  printf '%s\n' "${head}"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  require_deploy_sha "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
fi
