#!/usr/bin/env bash
# Workers Builds / Pages: install Bun monorepo from **repo root**.
# Dashboard: Root = empty · Build: `bun run cf:showcase:install`
# Refuses any Bun other than package.json#packageManager (require-bun-version.sh, Roxabi/roxabi-boilerplate-cf#316).
set -euo pipefail

# shellcheck source=require-bun-version.sh
source "$(dirname "$0")/require-bun-version.sh"

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

if ! command -v bun >/dev/null 2>&1; then
  want="$(package_bun_version "$ROOT")"
  curl -fsSL https://bun.sh/install | bash -s "bun-v${want}"
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

require_bun_version "$ROOT"
# --minimum-release-age 0: reproduce the reviewed lock. The pinned Bun does not re-check locked versions;
# the flag guards against a Bun that does, like 1.4.0. docs/kit/security-dependabot.md § Install-time layers.
bun install --frozen-lockfile --minimum-release-age 0
