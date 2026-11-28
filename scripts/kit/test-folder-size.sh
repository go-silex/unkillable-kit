#!/usr/bin/env bash
# CP-FOLDER-SIZE — product register harness for scripts/kit/check_folder_size.sh
#
# Builds a temp git repo (never plants under the live apps/ or packages/).
# Exit 0 only if all matrix rows pass.
set -euo pipefail
# shellcheck source=lib/hermetic-git.sh
source "$(cd "$(dirname "$0")" && pwd -P)/lib/hermetic-git.sh"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECKER="${ROOT}/scripts/kit/check_folder_size.sh"

if [[ ! -f "${CHECKER}" ]]; then
  echo "FAIL: missing ${CHECKER}" >&2
  exit 1
fi
chmod +x "${CHECKER}" 2>/dev/null || true

PASS=0
FAIL=0

assert_exit() {
  local name="$1"
  local expect="$2"
  local expect_tag="${3:-}"
  shift 3
  local got=0
  local out
  set +e
  out="$("$@" 2>&1)"
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

make_repo() {
  local dir="$1"
  mkdir -p "${dir}/apps" "${dir}/packages"
  git --git-dir="${dir}/.git" --work-tree="${dir}" init -q
  git --git-dir="${dir}/.git" --work-tree="${dir}" config user.email "folder-size@example.com"
  git --git-dir="${dir}/.git" --work-tree="${dir}" config user.name "folder-size"
  echo "x" >"${dir}/README"
  git --git-dir="${dir}/.git" --work-tree="${dir}" add README
  LEFTHOOK=0 git --git-dir="${dir}/.git" --work-tree="${dir}" commit -q -m "init"
}

plant_ts() {
  local dir="$1"
  local n="$2"
  mkdir -p "${dir}"
  local i
  for i in $(seq 1 "${n}"); do
    echo "export const n${i} = ${i}" >"${dir}/f${i}.ts"
  done
}

run_checker() {
  local tree="$1"
  shift
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR \
    -u QG_FOLDER_MAX -u QG_FOLDER_EXEMPTIONS -u QG_FOLDER_ROOTS -u QG_FOLDER_PRODUCT_EXEMPTIONS -u QG_FOLDER_SIZE_DISABLE \
    -C "${tree}" \
    "$@" \
    bash "${CHECKER}"
}

echo "== CP-FOLDER-SIZE matrix =="
TMP="$(mktemp -d -t cp-folder-size-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

ALLOW="${TMP}/allow"
make_repo "${ALLOW}"
mkdir -p "${ALLOW}/config/kit" "${ALLOW}/config/product"
: >"${ALLOW}/config/kit/folder_exemptions.txt"
plant_ts "${ALLOW}/apps/acme-web/src/ui" 45
printf '%s\n' "apps/acme-web/src/ui  # 50 files — ticket test" \
  >"${ALLOW}/config/product/folder_exemptions.txt"
assert_exit "allow 45 files under product cap 50 → 0" 0 "" \
  run_checker "${ALLOW}"

OVER="${TMP}/over"
make_repo "${OVER}"
mkdir -p "${OVER}/config/kit" "${OVER}/config/product"
: >"${OVER}/config/kit/folder_exemptions.txt"
plant_ts "${OVER}/apps/acme-web/src/ui" 12
printf '%s\n' "apps/acme-web/src/ui  # 10 files — ticket test" \
  >"${OVER}/config/product/folder_exemptions.txt"
assert_exit "over declared product cap → 1" 1 "config/product/folder_exemptions.txt" \
  run_checker "${OVER}"

refuse_path() {
  local name="$1"
  local path="$2"
  local tag="$3"
  local expect="${4:-not a product-app path}"
  local dir="${TMP}/${tag}"
  make_repo "${dir}"
  mkdir -p "${dir}/config/kit" "${dir}/config/product"
  : >"${dir}/config/kit/folder_exemptions.txt"
  printf '%s\n' "${path}  # 99 files — should fail" \
    >"${dir}/config/product/folder_exemptions.txt"
  assert_exit "${name}" 1 "${expect}" \
    run_checker "${dir}"
}

refuse_path "refuse packages/..." "packages/ui/src/components/ui" "pkg"
refuse_path "refuse apps/example-web/..." "apps/example-web/src/routes" "exweb"
refuse_path "refuse apps/mcp-example/..." "apps/mcp-example/src" "mcp"
refuse_path "refuse unsuffixed apps/acme/..." "apps/acme/src" "unsuf"
refuse_path "refuse scripts/kit/..." "scripts/kit" "skit"
refuse_path "refuse .. traversal" "apps/acme-web/../../packages/ui/src/components/ui" "dotdot" "non-canonical"
refuse_path "refuse leading ./" "./apps/acme-web/src/ui" "dotslash" "non-canonical"

NOCAP="${TMP}/nocap"
make_repo "${NOCAP}"
mkdir -p "${NOCAP}/config/kit" "${NOCAP}/config/product"
: >"${NOCAP}/config/kit/folder_exemptions.txt"
printf '%s\n' "apps/acme-web/src/ui" \
  >"${NOCAP}/config/product/folder_exemptions.txt"
assert_exit "product line without cap → 1" 1 "missing cap" \
  run_checker "${NOCAP}"

WILD="${TMP}/wild"
make_repo "${WILD}"
mkdir -p "${WILD}/config/kit" "${WILD}/config/product"
: >"${WILD}/config/kit/folder_exemptions.txt"
printf '%s\n' "apps/acme-web/**  # 50 files — no" \
  >"${WILD}/config/product/folder_exemptions.txt"
assert_exit "product wildcard → 1" 1 "wildcard" \
  run_checker "${WILD}"

DUPKIT="${TMP}/dupkit"
make_repo "${DUPKIT}"
mkdir -p "${DUPKIT}/config/kit" "${DUPKIT}/config/product"
printf '%s\n' "apps/acme-web/src/ui  # 50 files — kit" \
  >"${DUPKIT}/config/kit/folder_exemptions.txt"
printf '%s\n' "apps/acme-web/src/ui  # 50 files — product" \
  >"${DUPKIT}/config/product/folder_exemptions.txt"
assert_exit "path in both registers → 1" 1 "duplicate vs kit" \
  run_checker "${DUPKIT}"

DUPIN="${TMP}/dupin"
make_repo "${DUPIN}"
mkdir -p "${DUPIN}/config/kit" "${DUPIN}/config/product"
: >"${DUPIN}/config/kit/folder_exemptions.txt"
printf '%s\n' \
  "apps/acme-web/src/ui  # 50 files — a" \
  "apps/acme-web/src/ui  # 60 files — b" \
  >"${DUPIN}/config/product/folder_exemptions.txt"
assert_exit "duplicate \$1 different comments → 1" 1 "duplicate" \
  run_checker "${DUPIN}"

ABSENT="${TMP}/absent"
make_repo "${ABSENT}"
mkdir -p "${ABSENT}/config/kit" "${ABSENT}/apps/acme-web/src"
: >"${ABSENT}/config/kit/folder_exemptions.txt"
plant_ts "${ABSENT}/apps/acme-web/src" 3
assert_exit "product file absent → 0" 0 "" \
  run_checker "${ABSENT}"

# --- missing scan root is not a pass ---
MISSING="${TMP}/missing-root"
make_repo "${MISSING}"
rm -rf "${MISSING}/packages"
assert_exit "missing packages/ → 1" 1 "not found" \
  run_checker "${MISSING}"
assert_exit "missing packages/ + disable → 0" 0 "" \
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -C "${MISSING}" \
    QG_FOLDER_SIZE_DISABLE=1 \
    bash "${CHECKER}"

echo ""
echo "CP-FOLDER-SIZE matrix: ${PASS} passed, ${FAIL} failed"
if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
