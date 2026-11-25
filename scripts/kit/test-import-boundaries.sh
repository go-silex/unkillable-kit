#!/usr/bin/env bash
# CP-IMPORT — table-driven self-test for scripts/kit/check-import-boundaries.ts
#
# Plants illegal edges in a temp monorepo tree (never under live packages/apps).
# Exit 0 only if all cases pass.
set -euo pipefail

unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR 2>/dev/null || true

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCANNER="${ROOT}/scripts/kit/check-import-boundaries.ts"

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
  local expect_tag="${4:-}"
  local got=0
  local out
  set +e
  out="$(IMPORT_BOUNDARY_ROOT="${root}" bun run "${SCANNER}" 2>&1)"
  got=$?
  set -e
  if [[ "${got}" -ne "${expect}" ]]; then
    echo "  FAIL: ${name} expected exit ${expect}, got ${got}" >&2
    echo "    out: $(echo "${out}" | tr '\n' ' ')" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  if [[ -n "${expect_tag}" ]] && ! echo "${out}" | grep -q "${expect_tag}"; then
    echo "  FAIL: ${name} expected output to contain '${expect_tag}'" >&2
    echo "    out: $(echo "${out}" | tr '\n' ' ')" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  echo "  PASS: ${name} (exit ${got})"
  PASS=$((PASS + 1))
}

# Minimal workspace: one package + example-web + example-api with package.json names.
seed_workspace() {
  local base="$1"
  mkdir -p \
    "${base}/packages/core/src" \
    "${base}/apps/example-web/src" \
    "${base}/apps/example-api/src" \
    "${base}/config/kit"

  cat >"${base}/packages/core/package.json" <<'EOF'
{ "name": "@kit/core", "private": true }
EOF
  cat >"${base}/apps/example-web/package.json" <<'EOF'
{ "name": "@kit/example-web", "private": true }
EOF
  cat >"${base}/apps/example-api/package.json" <<'EOF'
{ "name": "@kit/example-api", "private": true }
EOF

  # Clean baseline sources (no violations)
  echo "export const ok = 1" >"${base}/packages/core/src/index.ts"
  echo "export const web = 1" >"${base}/apps/example-web/src/index.ts"
  echo "export const api = 1" >"${base}/apps/example-api/src/index.ts"

  # Empty exemptions with valid header only
  cat >"${base}/config/kit/import-boundary-exemptions.txt" <<'EOF'
# test exemptions
EOF
}

echo "== CP-IMPORT self-test =="
TMP="$(mktemp -d -t cp-import-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# --- clean tree → 0 ---
CLEAN="${TMP}/clean"
seed_workspace "${CLEAN}"
assert_case "0 clean tree → 0" 0 "${CLEAN}"

# --- R1 workspace packages → apps ---
R1="${TMP}/r1"
seed_workspace "${R1}"
echo "import { api } from '@kit/example-api'" >"${R1}/packages/core/src/bad-r1.ts"
assert_case "1 R1 workspace packages→apps → 1" 1 "${R1}" "R1"

# --- R2 relative packages → apps ---
R2="${TMP}/r2"
seed_workspace "${R2}"
# packages/core/src → ../../../ = monorepo root
echo "import { api } from '../../../apps/example-api/src/index'" >"${R2}/packages/core/src/bad-r2.ts"
assert_case "2 R2 relative packages→apps → 1" 1 "${R2}" "R2"

# --- R3 example-web → example-api (workspace) ---
R3="${TMP}/r3"
seed_workspace "${R3}"
echo "import { api } from '@kit/example-api'" >"${R3}/apps/example-web/src/bad-r3.ts"
assert_case "3 R3 web→api → 1" 1 "${R3}" "R3"

# --- R3 relative web → api ---
R3R="${TMP}/r3rel"
seed_workspace "${R3R}"
echo "import { api } from '../../example-api/src/index'" >"${R3R}/apps/example-web/src/bad-r3-rel.ts"
assert_case "3b R3 relative web→api → 1" 1 "${R3R}" "R3"

# --- R4 cloudflare:workers from web ---
R4="${TMP}/r4"
seed_workspace "${R4}"
echo "import { env } from 'cloudflare:workers'" >"${R4}/apps/example-web/src/bad-r4.ts"
assert_case "4 R4 cloudflare:workers → 1" 1 "${R4}" "R4"

# --- R5 example-api ↛ @kit/auth/react ---
R5="${TMP}/r5"
seed_workspace "${R5}"
echo "import { ForgotPasswordForm } from '@kit/auth/react'" >"${R5}/apps/example-api/src/bad-auth-react.ts"
assert_case "5 R5 api→auth/react → 1" 1 "${R5}" "R5 apps/example-api"

# --- R5 product Worker API ↛ @kit/auth/react ---
R5P="${TMP}/r5prod"
seed_workspace "${R5P}"
mkdir -p "${R5P}/apps/lgu-api/src"
echo '{ "name": "@gosilex/lgu-api", "private": true }' >"${R5P}/apps/lgu-api/package.json"
echo "import { ForgotPasswordForm } from '@kit/auth/react'" >"${R5P}/apps/lgu-api/src/bad-auth-react.ts"
assert_case "5b R5 product-api→auth/react → 1" 1 "${R5P}" "R5 apps/lgu-api"

# --- SPA product web MAY import @kit/auth/react ---
R5W="${TMP}/r5web"
seed_workspace "${R5W}"
mkdir -p "${R5W}/apps/lgu-web/src"
echo '{ "name": "@gosilex/lgu-web", "private": true }' >"${R5W}/apps/lgu-web/package.json"
echo "import { ForgotPasswordForm } from '@kit/auth/react'" >"${R5W}/apps/lgu-web/src/ok-auth-react.ts"
assert_case "5c product-web→auth/react allowed → 0" 0 "${R5W}"

# --- R5 non-web other-app (mcp / unnamed Worker) stays banned ---
R5M="${TMP}/r5mcp"
seed_workspace "${R5M}"
mkdir -p "${R5M}/apps/mcp-example/src"
echo '{ "name": "@kit/mcp-example", "private": true }' >"${R5M}/apps/mcp-example/package.json"
echo "import { ForgotPasswordForm } from '@kit/auth/react'" >"${R5M}/apps/mcp-example/src/bad-auth-react.ts"
assert_case "5d R5 mcp-example→auth/react → 1" 1 "${R5M}" "R5 apps/mcp-example"

# --- R5 example-web MAY import @kit/auth/react ---
R5E="${TMP}/r5exweb"
seed_workspace "${R5E}"
echo "import { ForgotPasswordForm } from '@kit/auth/react'" >"${R5E}/apps/example-web/src/ok-auth-react.ts"
assert_case "5e example-web→auth/react allowed → 0" 0 "${R5E}"

# --- R6 only the hosted shell, auth internals, and tests may import hosted dispatch ---
R6="${TMP}/r6"
seed_workspace "${R6}"
mkdir -p "${R6}/packages/auth/src" "${R6}/packages/mcp/src/hosted" "${R6}/apps/acme-api/src"
echo '{ "name": "@kit/auth" }' >"${R6}/packages/auth/package.json"
echo '{ "name": "@kit/mcp" }' >"${R6}/packages/mcp/package.json"
echo '{ "name": "@acme/api", "private": true }' >"${R6}/apps/acme-api/package.json"
HOSTED_IMPORT="import { createHostedDispatch } from '@kit/auth/hosted-dispatch'"
echo "${HOSTED_IMPORT}" >"${R6}/packages/auth/src/ok.ts"
echo "${HOSTED_IMPORT}" >"${R6}/packages/mcp/src/hosted/ok.ts"
echo "${HOSTED_IMPORT}" >"${R6}/apps/example-api/src/ok.test.ts"
assert_case "R6 shell, auth internals and tests → 0" 0 "${R6}"
echo "${HOSTED_IMPORT}" >"${R6}/packages/core/src/hosted.test-support.ts"
echo "import './hosted.test-support'" >"${R6}/packages/core/src/consumer.test-support.ts"
assert_case "R6 shared test code outside MCP → 0" 0 "${R6}"
echo "import './hosted.test-support'" >"${R6}/packages/core/src/bad-test-support.ts"
assert_case "R6 production relative import of test support → 1" 1 "${R6}" "R6 packages/core/src/bad-test-support.ts"
echo "import '@kit/core/src/hosted.test-support.ts'" >"${R6}/apps/example-api/src/bad-test-support.ts"
assert_case "R6 production workspace import of test support → 1" 1 "${R6}" "R6 apps/example-api/src/bad-test-support.ts"
echo "${HOSTED_IMPORT}" >"${R6}/packages/mcp/src/bad.ts"
assert_case "R6 other MCP code → 1" 1 "${R6}" "R6 packages/mcp/src/bad.ts"
echo "${HOSTED_IMPORT}" >"${R6}/apps/example-web/src/bad.ts"
assert_case "R6 SPA app → 1" 1 "${R6}" "R6 apps/example-web/src/bad.ts"
echo "${HOSTED_IMPORT}" >"${R6}/apps/acme-api/src/bad.ts"
assert_case "R6 product app → 1" 1 "${R6}" "R6 apps/acme-api/src/bad.ts"
mkdir -p "${R6}/config/product"
echo "apps/acme-api/src/bad.ts  # cannot exempt hosted dispatch" >"${R6}/config/product/import-boundary-exemptions.txt"
assert_case "R6 product exemption cannot bypass → 1" 1 "${R6}" "R6 apps/acme-api/src/bad.ts"
for target in request/hosted-dispatch request/hosted-routes snapshot/hosted-principal request/request-authorization snapshot; do
  echo "import '../../auth/src/${target}'" >"${R6}/packages/core/src/bad-relative.ts"
  assert_case "R6 package imports ${target} by relative path → 1" 1 "${R6}" "R6 packages/core/src/bad-relative.ts"
  echo "import '../../../packages/auth/src/${target}.ts'" >"${R6}/apps/acme-api/src/bad-relative.ts"
  assert_case "R6 app imports ${target}.ts by relative path → 1" 1 "${R6}" "R6 apps/acme-api/src/bad-relative.ts"
done
echo "import '../../../auth/src/request/hosted-dispatch'" >"${R6}/packages/mcp/src/hosted/bad-relative.ts"
assert_case "R6 hosted shell must use the package subpath → 1" 1 "${R6}" "R6 packages/mcp/src/hosted/bad-relative.ts"

# --- R1 via export … from (fromRe / re-export) ---
R1E="${TMP}/r1export"
seed_workspace "${R1E}"
echo "export { api } from '@kit/example-api'" >"${R1E}/packages/core/src/bad-export.ts"
assert_case "1b R1 export-from → 1" 1 "${R1E}" "R1"

# --- R4 side-effect import '…' ---
R4S="${TMP}/r4side"
seed_workspace "${R4S}"
echo "import 'cloudflare:workers'" >"${R4S}/apps/example-web/src/bad-r4-side.ts"
assert_case "4b R4 side-effect import → 1" 1 "${R4S}" "R4"

# --- R1 dynamic import() ---
R1D="${TMP}/r1dyn"
seed_workspace "${R1D}"
echo "const m = await import('@kit/example-api')" >"${R1D}/packages/core/src/bad-dyn.ts"
assert_case "1c R1 import() → 1" 1 "${R1D}" "R1"

# --- R1 workspace with Vite query suffix (?raw) ---
R1Q="${TMP}/r1query"
seed_workspace "${R1Q}"
echo "import x from '@kit/example-api?raw'" >"${R1Q}/packages/core/src/bad-query.ts"
assert_case "1d R1 workspace?raw → 1" 1 "${R1Q}" "R1"

# --- comment must NOT trip R1 (comment strip) ---
CMT="${TMP}/comment"
seed_workspace "${CMT}"
echo "// import { api } from '@kit/example-api'" >"${CMT}/packages/core/src/ok-comment.ts"
assert_case "0b comment is not an edge → 0" 0 "${CMT}"

# --- exemption without reason (missing #) → exit 2 ---
E2="${TMP}/e2"
seed_workspace "${E2}"
echo "import { api } from '@kit/example-api'" >"${E2}/packages/core/src/bad.ts"
echo "packages/core/src/bad.ts" >"${E2}/config/kit/import-boundary-exemptions.txt"
assert_case "5 exemption without reason → 2" 2 "${E2}" "CONFIG"

# --- exemption empty reason after # → exit 2 ---
E2B="${TMP}/e2b"
seed_workspace "${E2B}"
echo "import { api } from '@kit/example-api'" >"${E2B}/packages/core/src/bad.ts"
echo "packages/core/src/bad.ts  #" >"${E2B}/config/kit/import-boundary-exemptions.txt"
assert_case "5b exemption empty reason → 2" 2 "${E2B}" "CONFIG"

# --- valid exemption suppresses R1 (paired: same tree without exemption would fail case 1) ---
EX="${TMP}/ex"
seed_workspace "${EX}"
echo "import { api } from '@kit/example-api'" >"${EX}/packages/core/src/bad.ts"
# without exemption → 1
assert_case "6a before exemption → 1" 1 "${EX}" "R1"
echo "packages/core/src/bad.ts  # temporary plant — go-silex/silex-boilerplate#69" >"${EX}/config/kit/import-boundary-exemptions.txt"
assert_case "6b after exemption → 0" 0 "${EX}"

# --- product register: kit path refused ---
PKIT="${TMP}/pkit"
seed_workspace "${PKIT}"
mkdir -p "${PKIT}/config/product"
echo "import { api } from '@kit/example-api'" >"${PKIT}/packages/core/src/bad.ts"
echo "packages/core/src/bad.ts  # product cannot exempt kit" \
  >"${PKIT}/config/product/import-boundary-exemptions.txt"
assert_case "7 product kit-path → 2" 2 "${PKIT}" "not a product-app path"

# --- product register: wildcard refused ---
PWILD="${TMP}/pwild"
seed_workspace "${PWILD}"
mkdir -p "${PWILD}/config/product"
echo "apps/acme-web/**  # no" \
  >"${PWILD}/config/product/import-boundary-exemptions.txt"
assert_case "8 product wildcard → 2" 2 "${PWILD}" "wildcard"

# --- product register: apply on product-api R5 ---
PAPPLY="${TMP}/papply"
seed_workspace "${PAPPLY}"
mkdir -p "${PAPPLY}/apps/acme-api/src" "${PAPPLY}/config/product"
echo '{ "name": "@acme/api", "private": true }' >"${PAPPLY}/apps/acme-api/package.json"
echo "import { x } from '@kit/auth/react'" >"${PAPPLY}/apps/acme-api/src/bad.ts"
assert_case "9a product-api R5 before exemption → 1" 1 "${PAPPLY}" "R5"
echo "apps/acme-api/src/bad.ts  # temporary dual-boot" \
  >"${PAPPLY}/config/product/import-boundary-exemptions.txt"
assert_case "9b product-api R5 after product exemption → 0" 0 "${PAPPLY}"

# --- product register: duplicate of a kit entry refused ---
PDUPK="${TMP}/pdupk"
seed_workspace "${PDUPK}"
mkdir -p "${PDUPK}/config/product"
echo "apps/acme-api/src/bad.ts  # kit-owned plant" >"${PDUPK}/config/kit/import-boundary-exemptions.txt"
echo "apps/acme-api/src/bad.ts  # product copy" \
  >"${PDUPK}/config/product/import-boundary-exemptions.txt"
assert_case "9c product duplicate of kit entry → 2" 2 "${PDUPK}" "bad.ts — duplicate vs kit"

# --- product register: repeated entry refused ---
PDUP="${TMP}/pdup"
seed_workspace "${PDUP}"
mkdir -p "${PDUP}/config/product"
printf '%s\n' "apps/acme-api/src/bad.ts  # first" "apps/acme-api/src/bad.ts  # second" \
  >"${PDUP}/config/product/import-boundary-exemptions.txt"
assert_case "9d product repeated entry → 2" 2 "${PDUP}" "bad.ts — duplicate$"

# --- product file absent is OK ---
PABS="${TMP}/pabs"
seed_workspace "${PABS}"
assert_case "10 product file absent → 0" 0 "${PABS}"

echo ""
echo "CP-IMPORT self-test: ${PASS} passed, ${FAIL} failed"
if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
