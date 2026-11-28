#!/usr/bin/env bash
# Recurrence guard for Roxabi/roxabi-boilerplate-cf#282: every kit harness that creates a throwaway git
# repo must source scripts/kit/lib/hermetic-git.sh; sourcing it must detach the
# harness from a hook-inherited GIT_DIR; and a commit/push/fetch cycle under
# GIT_TRACE must spawn zero detached maintenance runs.
set -euo pipefail
# This guard creates git repos itself and must stay safe when the helper it
# checks regresses, so it scrubs the hook-inherited repo env on its own.
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
HELPER="${ROOT}/scripts/kit/lib/hermetic-git.sh"
PASS=0
FAIL=0
ok() { echo "PASS: $1"; PASS=$((PASS + 1)); }
ko() { echo "FAIL: $1" >&2; FAIL=$((FAIL + 1)); }

echo "== hermetic-git recurrence guard =="

if [[ -f "$HELPER" ]]; then
  ok "helper exists at scripts/kit/lib/hermetic-git.sh"
else
  ko "missing helper scripts/kit/lib/hermetic-git.sh"
fi

# grep, not rg: rg is not installed on the CI runner.
mapfile -t HARNESSES < <(
  grep -rlE --include='test-*.sh' \
    -e '\bgit\b.*\binit\b' \
    -e '\bgit\b.*\bclone\b' \
    "${ROOT}/scripts/kit" | sort -u
)

if [[ "${#HARNESSES[@]}" -eq 0 ]]; then
  ko "discovery found zero harnesses (grep broken?)"
else
  ok "discovered ${#HARNESSES[@]} harness(es) that create git repos"
fi

for h in "${HARNESSES[@]}"; do
  base="$(basename "$h")"
  if [[ "$base" == "test-hermetic-git.sh" ]]; then
    continue
  fi
  if grep -qE 'scripts/kit/lib/hermetic-git\.sh|lib/hermetic-git\.sh' "$h"; then
    ok "$base sources hermetic-git.sh"
  else
    ko "$base creates a git repo but does not source hermetic-git.sh"
  fi
done

# git exports an absolute GIT_DIR to hooks run from a linked worktree. Unless
# the helper scrubs it, a fixture `git init <tmp>` reinitializes that caller
# instead (core.bare=true in its common config) and the fixture's config /
# commit / push land in the caller's repository.
CALLER="$(mktemp -d -t hermetic-git-caller.XXXXXX)"
trap 'rm -rf "$CALLER"' EXIT
git init -q "${CALLER}/main"
git -C "${CALLER}/main" worktree add -q --orphan -b wt "${CALLER}/wt"
(
  export GIT_DIR
  GIT_DIR="$(git -C "${CALLER}/wt" rev-parse --absolute-git-dir)"
  # shellcheck source=lib/hermetic-git.sh
  source "$HELPER"
  git init -q "${CALLER}/fixture"
  git -C "${CALLER}/fixture" config user.email kit@example.com
) >/dev/null 2>&1 || true
caller_bare="$(git -C "${CALLER}/main" config --local core.bare)"
caller_email="$(git -C "${CALLER}/main" config --local user.email || true)"
fixture="no"
[[ -d "${CALLER}/fixture/.git" ]] && fixture="yes"
if [[ "$caller_bare" == "false" && -z "$caller_email" && "$fixture" == "yes" ]]; then
  ok "helper detaches a linked-worktree GIT_DIR: fixture created, caller untouched"
else
  ko "linked-worktree GIT_DIR leaked into the caller (core.bare=${caller_bare}, user.email=${caller_email:-unset}, fixture=${fixture})"
fi
rm -rf "$CALLER"
trap - EXIT

# Harnesses that run together share one config file. The first sourcing creates it whole and
# private whatever its caller's umask, which it leaves alone, and leaves nothing beside it; a
# later one keeps what it finds.
SHARED="$(mktemp -d -t hermetic-git-shared.XXXXXX)"
STUBS="$(mktemp -d -t hermetic-git-stubs.XXXXXX)"
trap 'rm -rf "$SHARED" "$STUBS"' EXIT
shared_cfg="${SHARED}/kit-hermetic-git-282.config"
shared_whole=$'[maintenance]\n\tauto = false\n[gc]\n\tauto = 0'
# 0222 denies even its owner the write: the helper must not need its caller's umask to write.
caller_umask="$(
  export XDG_RUNTIME_DIR="$SHARED"
  unset GIT_CONFIG_GLOBAL
  umask 0222
  # shellcheck source=lib/hermetic-git.sh
  source "$HELPER"
  umask
)"
if [[ "$caller_umask" == "0222" && "$(ls -A "$SHARED")" == "${shared_cfg##*/}" \
  && "$(cat "$shared_cfg")" == "$shared_whole" \
  && "$(ls -l "$shared_cfg")" == -rw-------* ]]; then
  ok "first sourcing creates the shared config whole and private, caller umask untouched"
else
  ko "shared config creation (caller umask=${caller_umask}, folder=$(ls -lA "$SHARED" | tr '\n' ' '))"
fi
printf '%s\n' '[kept]' >"$shared_cfg"
(
  export XDG_RUNTIME_DIR="$SHARED"
  unset GIT_CONFIG_GLOBAL
  # shellcheck source=lib/hermetic-git.sh
  source "$HELPER"
)
if [[ "$(cat "$shared_cfg")" == "[kept]" ]]; then
  ok "a later sourcing keeps the shared config it finds"
else
  ko "a later sourcing rewrote the shared config"
fi
# Where hard links are refused, the config still arrives whole, with nothing left beside it.
rm -f "$shared_cfg"
printf '%s\n' '#!/bin/sh' 'exit 1' >"$STUBS/ln"
chmod +x "$STUBS/ln"
if (
  export XDG_RUNTIME_DIR="$SHARED" PATH="$STUBS:$PATH"
  unset GIT_CONFIG_GLOBAL
  # shellcheck source=lib/hermetic-git.sh
  source "$HELPER"
) 2>/dev/null && [[ "$(ls -A "$SHARED")" == "${shared_cfg##*/}" && "$(cat "$shared_cfg")" == "$shared_whole" ]]; then
  ok "a folder that refuses hard links still gets the shared config whole"
else
  ko "shared config without hard links (folder=$(ls -lA "$SHARED" | tr '\n' ' '))"
fi
# A runtime folder that cannot hold the file is an explicit failure, not a silent pass.
rm -f "$shared_cfg"
printf '' >"$SHARED/not-a-folder"
if (
  export XDG_RUNTIME_DIR="$SHARED/not-a-folder"
  unset GIT_CONFIG_GLOBAL
  # shellcheck source=lib/hermetic-git.sh
  source "$HELPER"
) 2>/dev/null; then
  ko "sourcing passed although the shared config could not be created"
else
  ok "sourcing fails when the shared config cannot be created"
fi
rm -rf "$SHARED" "$STUBS"
trap - EXIT

TRACE2="$(mktemp -t hermetic-git-trace2.XXXXXX)"
# Not `( … ) || rc=$?`: errexit is ignored inside the left operand of `||`, so
# a failed step would let the next ones run. Push/fetch name the bare repo by
# path, never a remote name that could resolve to a real origin.
set +e
(
  set -euo pipefail
  # shellcheck source=lib/hermetic-git.sh
  source "$HELPER"
  REPO="$(mktemp -d -t hermetic-git-repo2.XXXXXX)"
  trap 'rm -rf "$REPO" "${REPO}.bare"' EXIT
  export GIT_TRACE=1
  git init -q "$REPO"
  git -C "$REPO" config user.email kit@example.com
  git -C "$REPO" config user.name kit
  git -C "$REPO" commit --allow-empty -q -m init
  git clone -q --bare "$REPO" "${REPO}.bare"
  git -C "$REPO" push -q "${REPO}.bare" HEAD:main
  git -C "$REPO" fetch -q "${REPO}.bare"
) >"$TRACE2" 2>&1
TRACE_RC=$?
set -e

# grep -c prints 0 on no match; an unreadable trace prints nothing and fails
# the string compare instead of counting as zero.
detached="$(grep -c -e 'run --auto --quiet --detach' "$TRACE2" || true)"
if [[ "$TRACE_RC" -eq 0 && "$detached" == "0" ]]; then
  ok "GIT_TRACE shows 0 detached maintenance runs under hermetic-git"
else
  ko "expected 0 detached maintenance (got ${detached:-no count}; setup rc=${TRACE_RC})"
  grep -nE 'maintenance run|unset GIT_CONFIG' "$TRACE2" >&2 || true
fi
rm -f "$TRACE2"

echo "== hermetic-git: ${PASS} passed, ${FAIL} failed =="
[[ "$FAIL" -eq 0 ]]
