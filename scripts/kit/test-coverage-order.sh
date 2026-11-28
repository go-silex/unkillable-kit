#!/usr/bin/env bash
# CP-COVERAGE-ORDER — self-test for scripts/kit/test-coverage.sh (COVERAGE_LIST_ONLY=1)
#
# The runner discovers the coverage bar from `test:coverage` scripts and only
# takes the RUN ORDER from declared tiers: the kit arrays in the script plus
# the optional product file config/product/coverage-order.txt. Each case builds
# a throwaway tree under $TMPDIR holding a COPY of the script and one stub
# workspace per workspace the case wants discovered, then runs the list-only
# seam. No Vitest, no coverage/ dir, no live-repo state touched.
#
# Kit workspaces come from the script's COVERAGE_LIST_KIT=1 seam (the three kit
# arrays only); the expected tier insertion anchors below must track tier boundaries.
# The live COVERAGE_LIST_ONLY=1 output is NOT used: in a product checkout it also
# holds the workspaces of config/product/coverage-order.txt, which would leak into
# every fixture. The last case re-runs this whole suite from such a checkout.
#
# Exit 0 only if every case passes.
set -euo pipefail
# A pre-push hook exports GIT_DIR at the checkout. git -C does not override it,
# so a fixture commit would move the branch under test. Scrub before any git.
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
SCRIPT="${ROOT}/scripts/kit/test-coverage.sh"
[[ -f "${SCRIPT}" ]] || { echo "FAIL: missing ${SCRIPT}" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

KIT_ORDER="$(cd "${ROOT}" && COVERAGE_LIST_KIT=1 bash "${SCRIPT}")"
[[ -n "${KIT_ORDER}" ]] || { echo "FAIL: kit seam printed nothing" >&2; exit 1; }

PASS=0
FAIL=0
N=0

# make_tree <extra workspace>... — kit workspaces + extras, extension file empty.
make_tree() {
  N=$((N + 1))
  TREE="${TMP}/t${N}"
  mkdir -p "${TREE}/scripts/kit"
  cp "${SCRIPT}" "${TREE}/scripts/kit/test-coverage.sh"
  printf '{ "name": "fixture", "private": true, "workspaces": ["apps/*", "packages/*"] }\n' \
    >"${TREE}/package.json"
  local ws
  while IFS= read -r ws; do
    mkdir -p "${TREE}/${ws}"
    printf '{ "name": "ws", "scripts": { "test:coverage": "vitest run --coverage" } }\n' \
      >"${TREE}/${ws}/package.json"
  done < <(printf '%s\n' "${KIT_ORDER}" ${@+"$@"})
}

write_ext() {
  mkdir -p "${TREE}/config/product"
  cat >"${TREE}/config/product/coverage-order.txt"
}

# run <name> <expected rc> <expected stdout|-> <stderr marker|->
run() {
  local name="$1" want_rc="$2" want_out="$3" marker="$4" rc=0 out err
  out="$(cd "${TREE}" && COVERAGE_LIST_ONLY=1 bash scripts/kit/test-coverage.sh 2>"${TMP}/err")" || rc=$?
  err="$(cat "${TMP}/err")"
  if [[ "${rc}" -ne "${want_rc}" ]]; then
    echo "  FAIL: ${name} — expected exit ${want_rc}, got ${rc}" >&2
    printf '%s\n%s\n' "${out}" "${err}" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  if [[ "${want_out}" != "-" && "${out}" != "${want_out}" ]]; then
    echo "  FAIL: ${name} — unexpected order" >&2
    diff <(printf '%s\n' "${want_out}") <(printf '%s\n' "${out}") >&2 || true
    FAIL=$((FAIL + 1))
    return
  fi
  if [[ "${marker}" != "-" && "${err}" != *"${marker}"* ]]; then
    echo "  FAIL: ${name} — expected stderr to contain '${marker}'" >&2
    echo "${err}" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  echo "  PASS: ${name} (exit ${rc})"
  PASS=$((PASS + 1))
}

# insert_after <anchor> <ws>... — KIT_ORDER with workspaces inserted after anchor.
insert_after() {
  local anchor="$1" line
  shift
  while IFS= read -r line; do
    printf '%s\n' "${line}"
    if [[ "${line}" == "${anchor}" ]]; then
      printf '%s\n' "$@"
    fi
  done <<<"${KIT_ORDER}"
}

echo "== kit-only (no extension file) =="
make_tree
run "bare kit: order is the kit tiers" 0 "${KIT_ORDER}" -

echo "== product tiers =="
make_tree apps/acme-api apps/acme-mcp packages/extra apps/acme-web
write_ext <<'EOF'
# product risk tiers
high apps/acme-api   # trailing comment
high apps/acme-mcp

medium packages/extra
lower apps/acme-web
EOF
want="$(insert_after apps/example-api apps/acme-api apps/acme-mcp)"
want="$(
  while IFS= read -r line; do
    printf '%s\n' "${line}"
    [[ "${line}" == "packages/notifications" ]] && printf '%s\n' packages/extra
    [[ "${line}" == "apps/mcp-example" ]] && printf '%s\n' apps/acme-web
  done <<<"${want}"
)"
run "listed workspaces land at the end of their tier" 0 "${want}" -

echo "== kit-mode clone (mirror-like: no config/product/inheritance.json) =="
make_tree packages/feedback
[[ ! -e "${TREE}/config/product/inheritance.json" ]]
write_ext <<'EOF'
medium packages/feedback
EOF
run "extra package added with the extension file alone, kit script byte-identical" 0 \
  "$(insert_after packages/notifications packages/feedback)" -
cmp -s "${SCRIPT}" "${TREE}/scripts/kit/test-coverage.sh" \
  || { echo "  FAIL: fixture script drifted from the kit script" >&2; FAIL=$((FAIL + 1)); }

echo "== reconcile failures =="
make_tree apps/acme-api
run "discovered but unlisted workspace fails and names the file" 1 - \
  "unknown workspace: apps/acme-api"
run "…with the actionable hint" 1 - "config/product/coverage-order.txt"

make_tree
write_ext <<'EOF'
high apps/gone
EOF
run "listed workspace that no longer declares test:coverage is stale" 1 - \
  "stale entry: apps/gone"

make_tree apps/acme-api
write_ext <<'EOF'
high apps/acme-api
lower apps/acme-api
EOF
run "same workspace twice in the extension file" 1 - "duplicate entry: apps/acme-api"

make_tree
write_ext <<'EOF'
high apps/example-api
EOF
run "extension entry duplicating a kit entry" 1 - "duplicate entry: apps/example-api"

make_tree apps/acme-api
write_ext <<'EOF'
urgent apps/acme-api
EOF
run "unknown tier" 1 - 'unknown tier "urgent"'

make_tree apps/acme-api
write_ext <<'EOF'
apps/acme-api
EOF
run "line without a tier is malformed" 1 - "malformed line"

list_with() {
  local name="$1" want_rc="$2" want_out="$3" marker="$4"
  shift 4
  local rc=0 out err
  out="$(cd "${TREE}" && env "$@" bash scripts/kit/test-coverage.sh 2>"${TMP}/err")" || rc=$?
  err="$(cat "${TMP}/err")"
  if [[ "${rc}" -ne "${want_rc}" ]]; then
    echo "  FAIL: ${name} — expected exit ${want_rc}, got ${rc}" >&2
    printf '%s\n%s\n' "${out}" "${err}" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  if [[ "${want_out}" != "-" && "${out}" != "${want_out}" ]]; then
    echo "  FAIL: ${name} — unexpected order" >&2
    diff <(printf '%s\n' "${want_out}") <(printf '%s\n' "${out}") >&2 || true
    FAIL=$((FAIL + 1))
    return
  fi
  if [[ "${marker}" != "-" && "${err}" != *"${marker}"* ]]; then
    echo "  FAIL: ${name} — expected stderr to contain '${marker}'" >&2
    echo "${err}" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  echo "  PASS: ${name} (exit ${rc})"
  PASS=$((PASS + 1))
}

echo "== coverage partitions =="
make_tree apps/acme-api
write_ext <<'EOF'
high apps/acme-api
EOF
printf 'apps/acme-api 3\n' >"${TREE}/config/product/coverage-partitions.txt"
list_with "kit and product partitions" 0 $'apps/example-api 2\napps/acme-api 3' - COVERAGE_LIST_PARTS=1
for declaration in 'apps/acme-api' 'apps/acme-api 1' 'apps/acme-api 5' 'packages/auth 2' 'apps/missing 2' 'apps/example-api 2' 'apps/acme-api 2 extra' $'apps/acme-api 2\napps/acme-api 3'; do
  printf '%s\n' "$declaration" >"${TREE}/config/product/coverage-partitions.txt"
  list_with "invalid partition: ${declaration}" 1 - "test-coverage:" COVERAGE_LIST_ONLY=1
done

gitcfg() {
  GIT_CONFIG_GLOBAL="${TMP}/gitconfig" GIT_CONFIG_NOSYSTEM=1 git -C "${TREE}" "$@"
}

echo "== single workspace and changed-base =="
printf '[user]\n  name = Coverage\n  email = coverage@example.invalid\n' >"${TMP}/gitconfig"
make_tree apps/acme-api apps/acme-web
write_ext <<'EOF'
high apps/acme-api
lower apps/acme-web
EOF
full="$(cd "${TREE}" && COVERAGE_LIST_ONLY=1 bash scripts/kit/test-coverage.sh)"
list_with "COVERAGE_ONLY keeps one resolved workspace" 0 "apps/acme-api" - \
  COVERAGE_LIST_ONLY=1 COVERAGE_ONLY=apps/acme-api
list_with "COVERAGE_ONLY outside the order is refused" 1 - "not in the coverage order" \
  COVERAGE_LIST_ONLY=1 COVERAGE_ONLY=apps/missing
list_with "COVERAGE_ONLY must be a workspace path" 1 - "not a workspace path" \
  COVERAGE_LIST_ONLY=1 COVERAGE_ONLY=../package.json
list_with "COVERAGE_ONLY and changed-base are exclusive" 1 - "mutually exclusive" \
  COVERAGE_LIST_ONLY=1 COVERAGE_ONLY=apps/acme-api COVERAGE_CHANGED_BASE=HEAD
gitcfg init -q
gitcfg add --all
gitcfg commit -q -m base
base="$(gitcfg rev-parse HEAD)"
list_with "empty diff keeps the full bar" 0 "${full}" - \
  COVERAGE_LIST_ONLY=1 COVERAGE_CHANGED_BASE="${base}"
mkdir -p "${TREE}/apps/acme-web/src" "${TREE}/apps/acme-api/src"
echo web >"${TREE}/apps/acme-web/src/touched.txt"
echo api >"${TREE}/apps/acme-api/src/touched.txt"
echo api-again >"${TREE}/apps/acme-api/src/again.txt"
gitcfg add --all
gitcfg commit -q -m apps
list_with "changed apps stay in tier order and are not duplicated" 0 $'apps/acme-api\napps/acme-web' - \
  COVERAGE_LIST_ONLY=1 COVERAGE_CHANGED_BASE="${base}"
pkg="$(awk '/^packages\// { print; exit }' <<<"${KIT_ORDER}")"
mkdir -p "${TREE}/${pkg}/src"
echo pkg >"${TREE}/${pkg}/src/touched.txt"
gitcfg add --all
gitcfg commit -q -m package
list_with "a package change keeps the full bar" 0 "${full}" - \
  COVERAGE_LIST_ONLY=1 COVERAGE_CHANGED_BASE="${base}"
echo note >"${TREE}/README.md"
gitcfg add --all
gitcfg commit -q -m root
list_with "a root change keeps the full bar" 0 "${full}" - \
  COVERAGE_LIST_ONLY=1 COVERAGE_CHANGED_BASE="${base}"
make_tree apps/acme-api
write_ext <<'EOF'
high apps/acme-api
EOF
gitcfg init -q
gitcfg add --all
gitcfg commit -q -m base
base="$(gitcfg rev-parse HEAD)"
mkdir -p "${TREE}/apps/not-covered/src"
echo stray >"${TREE}/apps/not-covered/src/touched.txt"
gitcfg add --all
gitcfg commit -q -m stray
list_with "a changed app outside the bar is refused" 1 - "refusing to skip the bar" \
  COVERAGE_LIST_ONLY=1 COVERAGE_CHANGED_BASE="${base}"
mkdir -p "${TREE}/apps/acme-api/src"
echo known >"${TREE}/apps/acme-api/src/touched.txt"
gitcfg add --all
gitcfg commit -q -m mixed
list_with "a known app does not hide an app outside the bar" 1 - "refusing to skip the bar" \
  COVERAGE_LIST_ONLY=1 COVERAGE_CHANGED_BASE="${base}"
list_with "an unreadable base is refused" 1 - "cannot read changes" \
  COVERAGE_LIST_ONLY=1 COVERAGE_CHANGED_BASE=not-a-ref
# Run this same suite from a product-shaped checkout: the kit scripts plus a
# product workspace listed in config/product/coverage-order.txt. The child runs
# every case above and below but does not recurse into another consumer case.
if [[ "${1:-}" != "--consumer-fixture" ]]; then
  echo "== self-test isolation from an existing consumer extension =="
  make_tree apps/acme-api
  write_ext <<'EOF'
medium apps/acme-api
EOF
  cp "${BASH_SOURCE[0]}" "${TREE}/scripts/kit/test-coverage-order.sh"
  live="$(cd "${TREE}" && COVERAGE_LIST_ONLY=1 bash scripts/kit/test-coverage.sh)"
  kit="$(cd "${TREE}" && COVERAGE_LIST_KIT=1 bash scripts/kit/test-coverage.sh)"
  child_rc=0
  child_out="$(cd "${TREE}" && bash scripts/kit/test-coverage-order.sh --consumer-fixture 2>&1)" || child_rc=$?
  if [[ "${live}" != *apps/acme-api* || "${kit}" == *apps/acme-api* ]]; then
    echo "  FAIL: consumer fixture is not product-shaped (live list must hold the product workspace, kit list must not)" >&2
    FAIL=$((FAIL + 1))
  elif [[ "${child_rc}" -ne 0 || "${child_out}" != *", 0 failed"* ]]; then
    echo "  FAIL: suite is not green from a checkout with a consumer extension — exit ${child_rc}" >&2
    printf '%s\n' "${child_out}" >&2
    FAIL=$((FAIL + 1))
  else
    echo "  PASS: full suite green from a checkout with a consumer extension, kit list free of product entries"
    PASS=$((PASS + 1))
  fi
fi

echo ""
echo "coverage-order self-test: ${PASS} passed, ${FAIL} failed"
[[ "${FAIL}" -eq 0 ]]
