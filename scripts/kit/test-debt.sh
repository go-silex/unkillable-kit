#!/usr/bin/env bash
# CP-DEBT — table-driven self-test for scripts/kit/check-debt.ts
#
# Plants suppressions in a temp monorepo tree (never under live packages/apps).
# Covers untagged + expiry (git-seeded stale / pin / warn).
# Exit 0 only if all cases pass.
set -euo pipefail
# shellcheck source=lib/hermetic-git.sh
source "$(cd "$(dirname "$0")" && pwd -P)/lib/hermetic-git.sh"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCANNER="${ROOT}/scripts/kit/check-debt.ts"
BUN_BIN="$(command -v bun)"

if [[ ! -f "${SCANNER}" ]]; then
  echo "FAIL: missing ${SCANNER}" >&2
  exit 1
fi

PASS=0
FAIL=0

assert_case() {
  local name="$1"
  local expect="$2"
  local root="$3"
  local untagged_mode="${4:-fail}"
  local expiry_mode="${5:-off}"
  local expect_tag="${6:-}"
  local months="${7:-6}"
  local forbid_tag="${8:-}"
  local path_override="${9:-}"
  local got=0
  local out
  set +e
  if [[ -n "${path_override}" ]]; then
    out="$(
      DEBT_ROOT="${root}" \
        DEBT_UNTAGGED_MODE="${untagged_mode}" \
        DEBT_EXPIRY_MODE="${expiry_mode}" \
        DEBT_EXPIRY_MONTHS="${months}" \
        PATH="${path_override}" \
        "${BUN_BIN}" run "${SCANNER}" 2>&1
    )"
  else
    out="$(
      DEBT_ROOT="${root}" \
        DEBT_UNTAGGED_MODE="${untagged_mode}" \
        DEBT_EXPIRY_MODE="${expiry_mode}" \
        DEBT_EXPIRY_MONTHS="${months}" \
        "${BUN_BIN}" run "${SCANNER}" 2>&1
    )"
  fi
  got=$?
  set -e
  if [[ "${got}" -ne "${expect}" ]]; then
    echo "  FAIL: ${name} expected exit ${expect}, got ${got}" >&2
    echo "    out: $(echo "${out}" | tr '\n' ' ')" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  if [[ -n "${expect_tag}" ]] && ! grep -q "${expect_tag}" <<<"${out}"; then
    echo "  FAIL: ${name} expected output to contain '${expect_tag}'" >&2
    echo "    out: $(echo "${out}" | tr '\n' ' ')" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  if [[ -n "${forbid_tag}" ]] && grep -q "${forbid_tag}" <<<"${out}"; then
    echo "  FAIL: ${name} expected output not to contain '${forbid_tag}'" >&2
    echo "    out: $(echo "${out}" | tr '\n' ' ')" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  echo "  PASS: ${name} (exit ${got})"
  PASS=$((PASS + 1))
}

seed_clean() {
  local base="$1"
  mkdir -p "${base}/packages/core/src" "${base}/apps/example-api/src"
  cat >"${base}/packages/core/src/ok.ts" <<'EOF'
export const ok = 1
// no suppressions
EOF
  cat >"${base}/apps/example-api/src/ok.ts" <<'EOF'
export const api = 1
EOF
}

seed_untagged() {
  local base="$1"
  seed_clean "${base}"
  cat >"${base}/packages/core/src/bad.ts" <<'EOF'
// biome-ignore lint/suspicious/noExplicitAny: missing debt tag
export const x: any = 1
EOF
}

seed_tagged() {
  local base="$1"
  seed_clean "${base}"
  cat >"${base}/packages/core/src/tagged.ts" <<'EOF'
// biome-ignore lint/suspicious/noExplicitAny: intentional — DEBT:demo-any #1
export const x: any = 1
EOF
}

seed_ts_expect() {
  local base="$1"
  seed_clean "${base}"
  cat >"${base}/packages/core/src/ts.ts" <<'EOF'
// @ts-expect-error legacy — DEBT:legacy-binding
export const y = 1 as never
EOF
}

# Init git repo under DEBT_ROOT with an old commit date (file inactivity proxy).
git_seed_old() {
  local base="$1"
  local marker_line="$2"
  seed_clean "${base}"
  cat >"${base}/packages/core/src/debt.ts" <<EOF
${marker_line}
export const x: any = 1
EOF
  git -C "${base}" init -q
  git -C "${base}" config user.email "cp-debt@test.local"
  git -C "${base}" config user.name "CP-DEBT"
  git -C "${base}" add -A
  # Old commit → older than DEBT_EXPIRY_MONTHS=6
  GIT_AUTHOR_DATE="2020-01-15T12:00:00 +0000" \
    GIT_COMMITTER_DATE="2020-01-15T12:00:00 +0000" \
    git -C "${base}" -c commit.gpgsign=false commit -q -m "old debt"
}

# A tracked repository may still have a DEBT file with no history. This is not a Git failure.
git_seed_untracked() {
  local base="$1"
  seed_clean "${base}"
  git -C "${base}" init -q
  git -C "${base}" config user.email "cp-debt@test.local"
  git -C "${base}" config user.name "CP-DEBT"
  git -C "${base}" add -A
  git -C "${base}" -c commit.gpgsign=false commit -q -m "initial tree"
  cat >"${base}/packages/core/src/debt.ts" <<'EOF'
// biome-ignore lint/suspicious/noExplicitAny: untracked — DEBT:no-git-demo
export const x: any = 1
EOF
}

make_fake_git() {
  local dir="$1"
  local stdout="$2"
  local stderr="$3"
  local status="$4"
  mkdir -p "${dir}"
  {
    echo '#!/bin/sh'
    if [[ -n "${stdout}" ]]; then
      printf 'printf "%%s\\n" %q\n' "${stdout}"
    fi
    if [[ -n "${stderr}" ]]; then
      printf 'printf "%%s\\n" %q >&2\n' "${stderr}"
    fi
    printf 'exit %s\n' "${status}"
  } >"${dir}/git"
  chmod +x "${dir}/git"
}

echo "== CP-DEBT self-test =="
TMP="$(mktemp -d -t cp-debt-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
GIT_128="${TMP}/git-128"
GIT_128_EMPTY="${TMP}/git-128-empty"
GIT_MALFORMED="${TMP}/git-malformed"
GIT_MISSING="${TMP}/git-missing"
make_fake_git "${GIT_128}" "" "fatal: injected Git failure" 128
make_fake_git "${GIT_128_EMPTY}" "" "" 128
make_fake_git "${GIT_MALFORMED}" "not-a-date" "" 0
mkdir -p "${GIT_MISSING}"

# 1. Clean tree → exit 0
C1="${TMP}/clean"
seed_clean "${C1}"
assert_case "clean tree" 0 "${C1}" fail off "clean"

# 2. Untagged + fail mode → exit 1 + UNTAGGED-ish message
C2="${TMP}/untagged"
seed_untagged "${C2}"
assert_case "untagged fail" 1 "${C2}" fail off "untagged"

# 2b. Untagged + default untagged mode (env unset) → fail
C2b="${TMP}/untagged-default"
seed_untagged "${C2b}"
got=0
out="$(
  set +e
  DEBT_ROOT="${C2b}" \
    DEBT_EXPIRY_MODE=off \
    env -u DEBT_UNTAGGED_MODE \
    "${BUN_BIN}" run "${SCANNER}" 2>&1
)" || got=$?
if [[ "${got}" -ne 1 ]]; then
  echo "  FAIL: untagged default expected exit 1, got ${got}" >&2
  echo "    out: $(echo "${out}" | tr '\n' ' ')" >&2
  FAIL=$((FAIL + 1))
elif ! grep -q "untagged" <<<"${out}"; then
  echo "  FAIL: untagged default expected output to contain 'untagged'" >&2
  echo "    out: $(echo "${out}" | tr '\n' ' ')" >&2
  FAIL=$((FAIL + 1))
else
  echo "  PASS: untagged default (exit ${got})"
  PASS=$((PASS + 1))
fi

# 3. Untagged + warn mode → exit 0 but still reports
C3="${TMP}/untagged-warn"
seed_untagged "${C3}"
assert_case "untagged warn" 0 "${C3}" warn off "untagged"

# 4. Tagged DEBT → exit 0
C4="${TMP}/tagged"
seed_tagged "${C4}"
assert_case "tagged DEBT" 0 "${C4}" fail off "clean"

# 5. @ts-expect-error with DEBT → exit 0
C5="${TMP}/tse"
seed_ts_expect "${C5}"
assert_case "ts-expect-error tagged" 0 "${C5}" fail off "clean"

# 6. @ts-expect-error untagged + fail
C6="${TMP}/tse-bad"
seed_clean "${C6}"
cat >"${C6}/packages/core/src/bad-ts.ts" <<'EOF'
// @ts-expect-error no tag
export const z = 1 as never
EOF
assert_case "ts-expect-error untagged" 1 "${C6}" fail off "untagged"

# 7. @ts-ignore untagged + fail
C7="${TMP}/tsi-bad"
seed_clean "${C7}"
cat >"${C7}/packages/core/src/bad-tsi.ts" <<'EOF'
// @ts-ignore no tag
export const w = 1 as never
EOF
assert_case "ts-ignore untagged" 1 "${C7}" fail off "untagged"

# 8. Stale DEBT (old git date, no pin) + expiry fail → exit 1 + stale
C8="${TMP}/stale-fail"
git_seed_old "${C8}" '// biome-ignore lint/suspicious/noExplicitAny: old — DEBT:stale-demo'
assert_case "stale expiry fail" 1 "${C8}" fail fail "stale"

# 9. Stale DEBT + expiry warn → exit 0 + stale
C9="${TMP}/stale-warn"
git_seed_old "${C9}" '// biome-ignore lint/suspicious/noExplicitAny: old — DEBT:stale-demo'
assert_case "stale expiry warn" 0 "${C9}" fail warn "stale"

# 10. Stale file + DEBT pin after slug skips Git expiry checks (hard pin).
C10="${TMP}/stale-pin"
git_seed_old "${C10}" '// biome-ignore lint/suspicious/noExplicitAny: old — DEBT:stale-demo #42'
assert_case "stale with pin exempt" 0 "${C10}" fail fail "clean" 6 "" "${GIT_128}"

# 11. Accidental issue-like hash number (a color) in reason (before DEBT) must NOT pin → still stale under fail
C11="${TMP}/false-pin"
git_seed_old "${C11}" '// biome-ignore lint/suspicious/noExplicitAny: color #333 — DEBT:stale-demo' # qualified-refs:ignore — fixture data, not a reference
assert_case "mid-reason hash does not pin" 1 "${C11}" fail fail "stale"

# 12. Untracked file in a repository has no file history → not stale.
C12="${TMP}/untracked"
git_seed_untracked "${C12}"
assert_case "untracked file not stale" 0 "${C12}" fail fail "clean"

# 13. A non-repository is a Git check failure, not a clean no-history result.
G1="${TMP}/no-git"
seed_clean "${G1}"
cat >"${G1}/packages/core/src/debt.ts" <<'EOF'
// biome-ignore lint/suspicious/noExplicitAny: no repository — DEBT:no-git-demo
export const x: any = 1
EOF
assert_case \
  "non-repository Git failure" \
  1 \
  "${G1}" \
  fail \
  fail \
  "Git failure.*packages/core/src/debt.ts" \
  6 \
  "check-debt: clean"

# 14. Expiry off does not invoke Git.
assert_case "expiry off skips Git" 0 "${G1}" fail off "clean"

# 15. Missing Git on PATH is a hard Git failure even when expiry is warn-only.
G2="${TMP}/missing-git"
git_seed_old "${G2}" '// biome-ignore lint/suspicious/noExplicitAny: old — DEBT:missing-git'
assert_case \
  "missing Git executable" \
  1 \
  "${G2}" \
  fail \
  warn \
  "Git failure for packages/core/src/debt.ts: .*git" \
  6 \
  "check-debt: clean" \
  "${GIT_MISSING}"

# 16. Git status failures retain the first stderr line; no stderr gets a useful status fallback.
G3="${TMP}/git-128"
git_seed_old "${G3}" '// biome-ignore lint/suspicious/noExplicitAny: old — DEBT:git-128'
assert_case \
  "Git status failure stderr" \
  1 \
  "${G3}" \
  fail \
  fail \
  "Git failure.*packages/core/src/debt.ts.*fatal: injected Git failure" \
  6 \
  "check-debt: clean" \
  "${GIT_128}"
assert_case \
  "Git status failure fallback" \
  1 \
  "${G3}" \
  fail \
  fail \
  "Git failure.*packages/core/src/debt.ts.*status 128" \
  6 \
  "check-debt: clean" \
  "${GIT_128_EMPTY}"

# 17. A successful Git command with malformed output is a hard failure.
G4="${TMP}/git-malformed"
git_seed_old "${G4}" '// biome-ignore lint/suspicious/noExplicitAny: old — DEBT:git-malformed'
assert_case \
  "malformed Git date" \
  1 \
  "${G4}" \
  fail \
  fail \
  "Git failure.*packages/core/src/debt.ts.*invalid date" \
  6 \
  "check-debt: clean" \
  "${GIT_MALFORMED}"

# 18. No eligible DEBT marker does not perform a global Git preflight.
G5="${TMP}/no-eligible-debt"
seed_clean "${G5}"
assert_case "no eligible debt skips Git" 0 "${G5}" fail fail "clean" 6 "" "${GIT_128}"
# Ceiling ratchet for the cog-* family (config/kit/debt-ceilings.json).
# Missing file + a cog marker is not an open channel.
seed_ceiling() {
  local base="$1"
  local max="$2"
  shift 2
  seed_clean "${base}"
  mkdir -p "${base}/config/kit"
  printf '{ "version": 1, "families": [ { "prefix": "cog-", "max": %s } ] }\n' "${max}" >"${base}/config/kit/debt-ceilings.json"
  local i=0
  for slug in "$@"; do
    i=$((i + 1))
    cat >"${base}/packages/core/src/cog-${i}.ts" <<EOF
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: spec — DEBT:${slug}
export const cog${i} = ${i}
EOF
  done
}

# 13. Equal to ceiling → green
C13="${TMP}/ceil-equal"
seed_ceiling "${C13}" 1 cog-gate
assert_case "ceiling equal" 0 "${C13}" fail off "ceiling cog- 1"

# 14. One marker over the ceiling → red, names the new site
C14="${TMP}/ceil-over"
seed_ceiling "${C14}" 1 cog-gate cog-ui
assert_case "ceiling +1" 1 "${C14}" fail off "cog-ui"

# 15. One marker under the ceiling → red until the ceiling is lowered
C15="${TMP}/ceil-under"
seed_ceiling "${C15}" 2 cog-gate
assert_case "ceiling -1" 1 "${C15}" fail off "lower the ceiling to 1"

# 16. cog marker with no ceiling file → red (not an open channel)
C16="${TMP}/ceil-missing"
seed_clean "${C16}"
# Build the DEBT slug via concat so this script itself is not a countable marker.
_debt_slug='cog'-'gate'
cat >"${C16}/packages/core/src/cog.ts" <<EOF
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: spec — DEBT:${_debt_slug}
export const cog = 1
EOF
assert_case "ceiling file missing" 1 "${C16}" fail off "debt-ceilings.json"

echo ""
echo "CP-DEBT: ${PASS} passed, ${FAIL} failed"
if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
