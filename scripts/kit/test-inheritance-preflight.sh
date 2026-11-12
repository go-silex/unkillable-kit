#!/usr/bin/env bash
# Exercise the early preflight without Bun or installed dependencies.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GIT_DIR="$(git -C "$ROOT" rev-parse --absolute-git-dir)"
SHA="$(git -C "$ROOT" rev-parse HEAD)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/work/config/product"
ln -s "$(command -v node)" "$fixture/bin/node"
ln -s "$(command -v git)" "$fixture/bin/git"

run_preflight() {
  (cd "$fixture/work" && PATH="$fixture/bin" GIT_DIR="$GIT_DIR" GIT_WORK_TREE="$fixture/work" \
    /bin/bash "$ROOT/scripts/kit/inheritance-preflight.sh")
}
refuse() {
  if run_preflight >/dev/null 2>&1; then
    echo "preflight unexpectedly accepted $1" >&2
    exit 1
  fi
}

run_preflight
printf '{"upstreamCommit":" %s "}\n' "$SHA" > "$fixture/work/config/product/inheritance.json"
run_preflight
printf '{"upstreamCommit":"%040d"}\n' 0 > "$fixture/work/config/product/inheritance.json"
refuse 'an unknown commit'
printf '{}\n' > "$fixture/work/config/product/inheritance.json"
refuse 'a missing upstreamCommit'
printf '{broken\n' > "$fixture/work/config/product/inheritance.json"
refuse 'invalid JSON'
echo 'inheritance preflight fixtures passed'
