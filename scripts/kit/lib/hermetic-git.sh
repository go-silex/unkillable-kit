# Hermetic git for kit throwaway harnesses (Roxabi/roxabi-boilerplate-cf#282).
# Source early (after set -euo pipefail). Detaches the harness from the
# caller's repository and disables auto maintenance / gc so detached
# maintenance cannot race TMP EXIT traps.
#
# Why scrub GIT_DIR & co: git exports them to hooks, and from a linked worktree
# GIT_DIR is absolute (.git/worktrees/<name>). A fixture `git init <tmp>` then
# reinitializes the caller as bare instead of creating <tmp>, and the fixture's
# `git -C <tmp>` config / commit / push hit the caller (and its origin).
#
# Why GIT_CONFIG_GLOBAL (not only GIT_CONFIG_COUNT): git 2.55 unsets
# GIT_CONFIG_COUNT and GIT_CONFIG_PARAMETERS when spawning receive-pack /
# upload-pack. A global config file is still read by those children, so a
# bare push/fetch cannot reintroduce detached maintenance. COUNT is still
# set as a belt for the parent process.
#
# Idempotent: re-sourcing does not stack duplicate keys / rewrite the file.
#
# Harnesses that run together share the file. It is written aside, private, and published whole:
# linked into place, where the first one wins, or moved there where hard links are refused. A
# reader finds it whole or not at all.

# shellcheck shell=bash

unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE

_hermetic_dir="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}"
_hermetic_cfg="${_hermetic_dir}/kit-hermetic-git-282.config"

if [ ! -f "$_hermetic_cfg" ]; then
  # A subshell: its umask stays in it, and so does a failure, which the check below reports.
  # errexit is ignored inside the left operand of `||`, hence the explicit exits.
  (
    umask 077
    [ ! -e "$_hermetic_cfg" ] || exit 1
    new="$(mktemp "${_hermetic_cfg}.XXXXXX")" || exit 1
    printf '[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n' >"$new" \
      && { ln "$new" "$_hermetic_cfg" || mv -n "$new" "$_hermetic_cfg"; } 2>/dev/null
    rm -f "$new"
  ) || :
  if [ ! -f "$_hermetic_cfg" ]; then
    echo "hermetic-git: cannot create ${_hermetic_cfg}" >&2
    unset _hermetic_dir _hermetic_cfg
    return 1
  fi
fi

# Preserve a pre-existing GIT_CONFIG_GLOBAL via include (once).
if [ -n "${GIT_CONFIG_GLOBAL:-}" ] && [ "${GIT_CONFIG_GLOBAL}" != "$_hermetic_cfg" ] \
  && [ -f "${GIT_CONFIG_GLOBAL}" ] \
  && ! grep -qF "path = ${GIT_CONFIG_GLOBAL}" "$_hermetic_cfg" 2>/dev/null; then
  printf '\n[include]\n\tpath = %s\n' "$GIT_CONFIG_GLOBAL" >>"$_hermetic_cfg"
fi
export GIT_CONFIG_GLOBAL="$_hermetic_cfg"

_hermetic_git_already=
if [ "${GIT_CONFIG_COUNT:-0}" -gt 0 ]; then
  _i=0
  while [ "$_i" -lt "${GIT_CONFIG_COUNT}" ]; do
    _k="GIT_CONFIG_KEY_${_i}"
    if [ "${!_k-}" = "maintenance.auto" ]; then
      _hermetic_git_already=1
      break
    fi
    _i=$((_i + 1))
  done
fi

if [ -z "$_hermetic_git_already" ]; then
  _n=${GIT_CONFIG_COUNT:-0}
  export "GIT_CONFIG_KEY_${_n}=maintenance.auto"
  export "GIT_CONFIG_VALUE_${_n}=false"
  _n=$((_n + 1))
  export "GIT_CONFIG_KEY_${_n}=gc.auto"
  export "GIT_CONFIG_VALUE_${_n}=0"
  _n=$((_n + 1))
  export GIT_CONFIG_COUNT="${_n}"
fi
unset _hermetic_git_already _i _k _n _hermetic_dir _hermetic_cfg
