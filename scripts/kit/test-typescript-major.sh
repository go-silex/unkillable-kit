#!/usr/bin/env bash
# CP-TS-MAJOR — table-driven self-test for scripts/kit/check-typescript-major.sh
#
# Plants pin/lock fixtures in a temp monorepo tree (never under live packages/apps).
# Exit 0 only if all cases pass.
set -euo pipefail

unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR 2>/dev/null || true

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCANNER="${ROOT}/scripts/kit/check-typescript-major.sh"

if [[ ! -f "${SCANNER}" ]]; then
  echo "FAIL: missing ${SCANNER}" >&2
  exit 1
fi

PASS=0
FAIL=0

assert_case() {
  local name="$1"
  local expect="$2"
  local tree="$3"
  local expect_tag="${4:-}"
  local got=0
  local out
  set +e
  out="$(TS_MAJOR_ROOT="${tree}" bash "${SCANNER}" 2>&1)"
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
  echo "  PASS: ${name} (exit ${got})"
  PASS=$((PASS + 1))
}

write_root() {
  local file="$1"
  local range="$2"
  mkdir -p "$(dirname "${file}")"
  cat >"${file}" <<EOF
{
  "name": "fixture",
  "private": true,
  "devDependencies": {
    "typescript": "${range}"
  }
}
EOF
}

write_workspace() {
  local file="$1"
  local range="${2:-}"
  mkdir -p "$(dirname "${file}")"
  if [[ -n "$range" ]]; then
    cat >"${file}" <<EOF
{
  "name": "fixture-ws",
  "private": true,
  "devDependencies": {
    "typescript": "${range}"
  }
}
EOF
  else
    cat >"${file}" <<'EOF'
{
  "name": "fixture-ws",
  "private": true,
  "devDependencies": {
    "vitest": "^4.1.10"
  }
}
EOF
  fi
}

# Minimal bun.lock lines the checker greps (not a full valid lockfile)
write_lock_ts7() {
  local base="$1"
  cat >"${base}/bun.lock" <<'EOF'
{
  "lockfileVersion": 1,
  "packages": {
    "typescript": ["typescript@7.0.2", "", {}, "sha512-fixture"]
  }
}
EOF
}

write_lock_ts5() {
  local base="$1"
  # Positive 7.x present + non-allowlisted nested residual @5 (D2 residual ban)
  cat >"${base}/bun.lock" <<'EOF'
{
  "lockfileVersion": 1,
  "packages": {
    "typescript": ["typescript@7.0.2", "", {}, "sha512-fixture"],
    "evil-tool/typescript": ["typescript@5.9.3", "", {}, "sha512-fixture-5"]
  }
}
EOF
}

write_lock_empty() {
  local base="$1"
  cat >"${base}/bun.lock" <<'EOF'
{
  "lockfileVersion": 1,
  "packages": {}
}
EOF
}

write_lock_ts6() {
  local base="$1"
  cat >"${base}/bun.lock" <<'EOF'
{
  "lockfileVersion": 1,
  "packages": {
    "typescript": ["typescript@7.0.2", "", {}, "sha512-fixture"],
    "evil-tool/typescript": ["typescript@6.0.2", "", {}, "sha512-fixture-6"]
  }
}
EOF
}

write_root_no_pin() {
  local file="$1"
  mkdir -p "$(dirname "${file}")"
  cat >"${file}" <<'EOF'
{
  "name": "fixture",
  "private": true,
  "devDependencies": {
    "vitest": "^4.1.10"
  }
}
EOF
}

write_workspace_json() {
  local file="$1"
  mkdir -p "$(dirname "${file}")"
  cat >"${file}"
}

echo "== CP-TS-MAJOR self-test =="
TMP="$(mktemp -d -t cp-ts-major-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# --- 0 golden: root ^7, workspaces inherit (no pin), lock@7 → 0 ---
G0="${TMP}/golden"
write_root "${G0}/package.json" "^7.0.2"
write_workspace "${G0}/packages/core/package.json"
write_lock_ts7 "${G0}"
assert_case "0 golden root ^7 inherit + lock@7 → 0" 0 "${G0}" "0 leftover workspace pin(s) match"

# --- 1 root pin still ^5.9 → 1 ---
B5="${TMP}/pin5"
write_root "${B5}/package.json" "^5.9.0"
write_lock_ts7 "${B5}"
assert_case "1 root pin ^5.9.0 → 1" 1 "${B5}" "exclusive ^7"

# --- 2 root dual-range pin → 1 ---
OR="${TMP}/or-range"
write_root "${OR}/package.json" "^7.0.2 || ^5.9.0"
write_lock_ts7 "${OR}"
assert_case "2 root pin dual-range || → 1" 1 "${OR}" "exclusive ^7"

# --- 3 lock residual typescript@5 → 1 ---
L5="${TMP}/lock5"
write_root "${L5}/package.json" "^7.0.2"
write_lock_ts5 "${L5}"
assert_case "3 lock typescript@5 → 1" 1 "${L5}" "typescript@5/6"

# --- 4 lock missing typescript@7 → 1 ---
L0="${TMP}/lock-empty"
write_root "${L0}/package.json" "^7.0.2"
write_lock_empty "${L0}"
assert_case "4 lock missing typescript@7 → 1" 1 "${L0}" "missing positive typescript@7"

# --- 5 root pin ^6 → 1 ---
B6="${TMP}/pin6"
write_root "${B6}/package.json" "^6.0.2"
write_lock_ts7 "${B6}"
assert_case "5 root pin ^6.0.2 → 1" 1 "${B6}" "exclusive ^7"

# --- 6 root bare 7.0.2 (no caret) → 1 ---
BARE="${TMP}/bare"
write_root "${BARE}/package.json" "7.0.2"
write_lock_ts7 "${BARE}"
assert_case "6 root pin bare 7.0.2 → 1" 1 "${BARE}" "exclusive ^7"

# --- 7 leftover workspace pin ^5.9 → 1 ---
STRAY="${TMP}/stray"
write_root "${STRAY}/package.json" "^7.0.2"
write_workspace "${STRAY}/packages/feedback/package.json" "^5.9.0"
write_lock_ts7 "${STRAY}"
assert_case "7 leftover workspace pin ^5.9.0 → 1" 1 "${STRAY}" "leftover pin"

# --- 8 leftover workspace pin ^7 is ok (matches global) → 0 ---
MATCH="${TMP}/match"
write_root "${MATCH}/package.json" "^7.0.2"
write_workspace "${MATCH}/packages/feedback/package.json" "^7.0.2"
write_lock_ts7 "${MATCH}"
assert_case "8 leftover workspace pin ^7 → 0" 0 "${MATCH}" "1 leftover workspace pin(s) match"

# --- 9 leftover apps/* pin ^5.9 → 1 ---
APP="${TMP}/apps-stray"
write_root "${APP}/package.json" "^7.0.2"
write_workspace "${APP}/apps/example-api/package.json" "^5.9.0"
write_lock_ts7 "${APP}"
assert_case "9 leftover apps pin ^5.9.0 → 1" 1 "${APP}" "leftover pin"

# --- 10 root has no typescript pin → 1 ---
NOPIN="${TMP}/root-nopin"
write_root_no_pin "${NOPIN}/package.json"
write_lock_ts7 "${NOPIN}"
assert_case "10 root has no typescript pin → 1" 1 "${NOPIN}" "has no typescript pin"

# --- 11 leftover dual-range (second key) → 1 ---
DUAL="${TMP}/leftover-dual"
write_root "${DUAL}/package.json" "^7.0.2"
write_workspace_json "${DUAL}/packages/feedback/package.json" <<'EOF'
{
  "name": "fixture-ws",
  "private": true,
  "peerDependencies": {
    "typescript": "^7.0.2"
  },
  "devDependencies": {
    "typescript": "^7.0.2 || ^5.9.0"
  }
}
EOF
write_lock_ts7 "${DUAL}"
assert_case "11 leftover peer^7 + dev dual-range → 1" 1 "${DUAL}" "leftover pin"

# --- 12 lock residual typescript@6 → 1 ---
L6="${TMP}/lock6"
write_root "${L6}/package.json" "^7.0.2"
write_lock_ts6 "${L6}"
assert_case "12 lock typescript@6 → 1" 1 "${L6}" "typescript@5/6"

# --- 13 missing package.json → 1 ---
NOPKG="${TMP}/no-pkg"
mkdir -p "${NOPKG}"
write_lock_ts7 "${NOPKG}"
assert_case "13 missing package.json → 1" 1 "${NOPKG}" "missing package.json"

# --- 14 missing bun.lock file → 1 ---
NOLOCK="${TMP}/no-lock"
write_root "${NOLOCK}/package.json" "^7.0.2"
assert_case "14 bun.lock missing → 1" 1 "${NOLOCK}" "bun.lock missing"

# --- 15 unparseable leftover pin → 1 ---
BAD="${TMP}/unparseable"
write_root "${BAD}/package.json" "^7.0.2"
write_workspace_json "${BAD}/packages/core/package.json" <<'EOF'
{
  "name": "fixture-ws",
  "private": true,
  "devDependencies": {
    "typescript": true
  }
}
EOF
write_lock_ts7 "${BAD}"
assert_case "15 leftover unparseable pin → 1" 1 "${BAD}" "could not parse"

echo "== CP-TS-MAJOR summary: ${PASS} pass, ${FAIL} fail =="
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
