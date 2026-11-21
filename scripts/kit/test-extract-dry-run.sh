#!/usr/bin/env bash
# CP-EXTRACT — self-test for extract identity (ADR-0009 D5), residency, kit app allowlist,
# tools/ absence, starter schema scope, branded-slot drop, and CP-BAN frame compounds.
set -euo pipefail
# shellcheck source=lib/hermetic-git.sh
source "$(cd "$(dirname "$0")" && pwd -P)/lib/hermetic-git.sh"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RESIDENCY="${ROOT}/scripts/kit/extract-residency.ts"
IDENTITY="${ROOT}/scripts/kit/resolve-tree-identity.mjs"
EXTRACT="${ROOT}/scripts/kit/extract-dry-run.sh"
BAN="${ROOT}/scripts/kit/check-banned-strings.sh"
ZONES_SRC="${ROOT}/config/kit/zero-edit-zones.json"

PASS=0
FAIL=0

assert_exit() {
  local name="$1" expect="$2" cmd="$3"
  local got=0 out
  set +e
  out="$(eval "$cmd" 2>&1)"
  got=$?
  set -e
  if [[ "$got" -ne "$expect" ]]; then
    echo "  FAIL: $name expected exit $expect, got $got" >&2
    echo "    out: $(echo "$out" | tr '\n' ' ')" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  echo "  PASS: $name (exit $got)"
  PASS=$((PASS + 1))
}

assert_exit_match() {
  local name="$1" expect="$2" pat="$3" cmd="$4"
  local got=0 out
  set +e
  out="$(eval "$cmd" 2>&1)"
  got=$?
  set -e
  if [[ "$got" -ne "$expect" ]]; then
    echo "  FAIL: $name expected exit $expect, got $got" >&2
    echo "    out: $(echo "$out" | tr '\n' ' ')" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  if ! echo "$out" | grep -qE "$pat"; then
    echo "  FAIL: $name output missing pattern: $pat" >&2
    echo "    out: $(echo "$out" | tr '\n' ' ')" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  echo "  PASS: $name (exit $got)"
  PASS=$((PASS + 1))
}

assert_output() {
  local name="$1" expect_pat="$2" cmd="$3"
  local got=0 out
  set +e
  out="$(eval "$cmd" 2>&1)"
  got=$?
  set -e
  if [[ "$got" -ne 0 ]]; then
    echo "  FAIL: $name expected exit 0, got $got" >&2
    echo "    out: $(echo "$out" | tr '\n' ' ')" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  if ! echo "$out" | grep -qE "$expect_pat"; then
    echo "  FAIL: $name output missing pattern: $expect_pat" >&2
    echo "    out: $(echo "$out" | tr '\n' ' ')" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  echo "  PASS: $name"
  PASS=$((PASS + 1))
}

seed_extract_gate_stubs() {
  local dir="$1"
  mkdir -p "${dir}/packages"/{core,types,auth,db,storage,ui,email,mcp,flows,tasks,comments,notifications,api-client,i18n}
  mkdir -p "${dir}/apps"/{example-api,example-web,mcp-example}
  mkdir -p "${dir}/docs/kit/architecture/adr" "${dir}/scripts/kit"
  echo '{}' >"${dir}/package.json"
  echo '{}' >"${dir}/turbo.jsonc"
  echo '{}' >"${dir}/biome.json"
  local pkg app
  for pkg in core types auth db storage ui email mcp flows tasks comments notifications api-client i18n; do
    printf '{"name":"@kit/%s"}\n' "$pkg" >"${dir}/packages/${pkg}/package.json"
  done
  for app in example-api example-web mcp-example; do
    echo '{}' >"${dir}/apps/${app}/package.json"
  done
  printf "import '@kit/%s'\n" core auth db storage email flows tasks comments notifications >"${dir}/apps/example-api/imports.ts"
  printf "import '@kit/%s'\n" ui types i18n api-client auth >"${dir}/apps/example-web/imports.ts"
  printf "import '@kit/mcp'\n" >"${dir}/apps/mcp-example/imports.ts"
  cp "${ROOT}/docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md" \
    "${dir}/docs/kit/architecture/adr/"
  cp "${ROOT}/scripts/kit/check-zero-edit-zones.sh" "${dir}/scripts/kit/"
  cp "${ROOT}/scripts/kit/resolve-tree-identity.mjs" "${dir}/scripts/kit/"
}

run_extract_gate() {
  local tree="$1"
  shift
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GITHUB_REPOSITORY \
    EXTRACT_ROOT="$tree" "$@" bash "$EXTRACT"
}

make_repo() {
  local dir="$1"
  mkdir -p "${dir}/config/kit" "${dir}/config/product"
  cp "${ZONES_SRC}" "${dir}/config/kit/zero-edit-zones.json"
  git --git-dir="${dir}/.git" --work-tree="${dir}" init -q
  git --git-dir="${dir}/.git" --work-tree="${dir}" config user.email "extract-test@example.com"
  git --git-dir="${dir}/.git" --work-tree="${dir}" config user.name "extract-test"
  echo "fixture" >"${dir}/README"
  git --git-dir="${dir}/.git" --work-tree="${dir}" add README config
  LEFTHOOK=0 git --git-dir="${dir}/.git" --work-tree="${dir}" commit -q -m "init"
}

set_origin() {
  local dir="$1" url="$2"
  if git --git-dir="${dir}/.git" --work-tree="${dir}" remote get-url origin >/dev/null 2>&1; then
    git --git-dir="${dir}/.git" --work-tree="${dir}" remote set-url origin "${url}"
  else
    git --git-dir="${dir}/.git" --work-tree="${dir}" remote add origin "${url}"
  fi
}

mark_product() {
  local dir="$1"
  mkdir -p "${dir}/config/product"
  printf '%s\n' '{"version":1,"upstreamCommit":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}' \
    >"${dir}/config/product/inheritance.json"
}

resolve_mode() {
  local dir="$1"
  shift
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GITHUB_REPOSITORY \
    ROOT="${dir}" "$@" node "${IDENTITY}" 2>&1 | sed -n 's/^mode=\([^ ]*\).*/\1/p'
}

echo "== CP-EXTRACT self-test =="
TMP="$(mktemp -d -t cp-extract-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# 1) planted kit table under apps/example-api → residency exit ≠ 0
FIX1="$TMP/residency-fail"
mkdir -p "$FIX1/packages/auth/src" "$FIX1/apps/example-api/src"
cat >"$FIX1/packages/auth/src/schema.ts" <<'EOF'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
export const baOrganization = sqliteTable('organization', { id: text('id').primaryKey() })
EOF
cat >"$FIX1/apps/example-api/src/bad-schema.ts" <<'EOF'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
export const bad = sqliteTable('organization', { id: text('id').primaryKey() })
EOF
assert_exit "residency rejects kit table in apps" 1 "EXTRACT_ROOT='$FIX1' bun run '$RESIDENCY'"

# 2) planted non-allowlisted app → real gate rejects in kit mode
FIX2="$TMP/allowlist-fail"
make_repo "${FIX2}"
set_origin "${FIX2}" "https://github.com/Roxabi/roxabi-boilerplate-cf.git"
seed_extract_gate_stubs "${FIX2}"
mkdir -p "${FIX2}/apps/acme-api"
assert_exit "allowlist rejects acme-api in kit mode" 1 "run_extract_gate '${FIX2}'"

# 3) clean worktree residency passes
assert_exit "residency clean on live tree" 0 "EXTRACT_ROOT='$ROOT' bun run '$RESIDENCY'"

# 4) live tree classifies according to its own polarity marker.
# Kit HEAD/mirrors have no inheritance marker -> kit; product consumers inherit this
# self-test through `validate:full` (ci.yml), so their live tree must resolve product.
if [[ -f "$ROOT/config/product/inheritance.json" ]]; then
  assert_output "live tree classifies product" '^mode=product' "ROOT='$ROOT' node '$IDENTITY'"
else
  assert_output "live tree classifies kit" '^mode=kit' "ROOT='$ROOT' node '$IDENTITY'"
fi

# 5) product tree with acme-api classifies product + allowlist skipped
PRODUCT="$TMP/product-pass"
make_repo "${PRODUCT}"
set_origin "${PRODUCT}" "https://github.com/acme/product-consumer.git"
mark_product "${PRODUCT}"
seed_extract_gate_stubs "${PRODUCT}"
mkdir -p "${PRODUCT}/apps/example-api" "${PRODUCT}/apps/acme-api"
mode="$(resolve_mode "${PRODUCT}")"
if [[ "$mode" != "product" ]]; then
  echo "  FAIL: product tree expected mode=product, got mode=${mode}" >&2
  FAIL=$((FAIL + 1))
else
  echo "  PASS: product tree classifies product"
  PASS=$((PASS + 1))
fi
assert_output "product tree notes acme-api in product mode" \
  'NOTE: product app present \(expected on product tree\): apps/acme-api' \
  "out=\$(run_extract_gate '${PRODUCT}' 2>&1 || true); echo \"\$out\" | grep -E 'NOTE: product app present.*apps/acme-api'"

# 6) kit fixture with acme-api fails allowlist
KIT="$TMP/kit-fail"
make_repo "${KIT}"
set_origin "${KIT}" "https://github.com/Roxabi/roxabi-boilerplate-cf.git"
seed_extract_gate_stubs "${KIT}"
mkdir -p "${KIT}/apps/example-api" "${KIT}/apps/acme-api"
mode="$(resolve_mode "${KIT}")"
if [[ "$mode" != "kit" ]]; then
  echo "  FAIL: kit fixture expected mode=kit, got mode=${mode}" >&2
  FAIL=$((FAIL + 1))
else
  echo "  PASS: kit fixture classifies kit"
  PASS=$((PASS + 1))
fi
assert_exit "kit fixture rejects acme-api" 1 "run_extract_gate '${KIT}'"

# 7) product tree + harness force-kit still fails on product apps
SENTINEL="$TMP/harness-sentinel"
touch "${SENTINEL}"
mode="$(resolve_mode "${PRODUCT}" EXTRACT_MODE=kit EXTRACT_HARNESS_SENTINEL="${SENTINEL}")"
if [[ "$mode" != "kit" ]]; then
  echo "  FAIL: harness force-kit expected mode=kit, got mode=${mode}" >&2
  FAIL=$((FAIL + 1))
else
  echo "  PASS: harness force-kit on product tree → kit mode"
  PASS=$((PASS + 1))
fi
assert_exit "product + EXTRACT_MODE=kit + sentinel fails allowlist" 1 \
  "EXTRACT_MODE=kit EXTRACT_HARNESS_SENTINEL='${SENTINEL}' run_extract_gate '${PRODUCT}'"

# 8) EXTRACT_MODE=mono without sentinel → die
assert_exit "EXTRACT_MODE=mono without sentinel rejected" 1 \
  "env -u GITHUB_REPOSITORY ROOT='${KIT}' EXTRACT_MODE=mono node '${IDENTITY}'"

# 9) kit tree + EXTRACT_MODE=mono with sentinel still kit mode (no allowlist bypass)
mode="$(resolve_mode "${KIT}" EXTRACT_MODE=mono EXTRACT_HARNESS_SENTINEL="${SENTINEL}")"
if [[ "$mode" != "kit" ]]; then
  echo "  FAIL: kit + mono sentinel expected effective mode=kit, got ${mode}" >&2
  FAIL=$((FAIL + 1))
else
  echo "  PASS: kit + mono sentinel stays kit (no allowlist bypass)"
  PASS=$((PASS + 1))
fi
assert_exit "kit + mono sentinel still rejects acme-api" 1 \
  "EXTRACT_MODE=mono EXTRACT_HARNESS_SENTINEL='${SENTINEL}' run_extract_gate '${KIT}'"

# 10) kit tree + EXTRACT_MODE=product with sentinel still kit mode (no allowlist bypass)
mode="$(resolve_mode "${KIT}" EXTRACT_MODE=product EXTRACT_HARNESS_SENTINEL="${SENTINEL}")"
if [[ "$mode" != "kit" ]]; then
  echo "  FAIL: kit + product sentinel expected mode=kit, got ${mode}" >&2
  FAIL=$((FAIL + 1))
else
  echo "  PASS: kit + product sentinel stays kit mode"
  PASS=$((PASS + 1))
fi
assert_exit "kit + product sentinel still rejects acme-api" 1 \
  "EXTRACT_MODE=product EXTRACT_HARNESS_SENTINEL='${SENTINEL}' run_extract_gate '${KIT}'"

# 11) kit fixture + tools/ file → fail-closed (ADR-0009 D2)
FIX_TOOLS="$TMP/tools-fail"
make_repo "${FIX_TOOLS}"
set_origin "${FIX_TOOLS}" "https://github.com/Roxabi/roxabi-boilerplate-cf.git"
seed_extract_gate_stubs "${FIX_TOOLS}"
mkdir -p "${FIX_TOOLS}/tools"
echo '#!/bin/sh' >"${FIX_TOOLS}/tools/checker.sh"
assert_exit_match "tools/ resurrection fails" 1 'tools/ must stay empty' \
  "run_extract_gate '${FIX_TOOLS}'"

# 11b) starter API with an opt-in schema set or no readable manifest → fail-closed (ADR-0022)
FIX_STARTER="$TMP/starter-scope-fail"
make_repo "${FIX_STARTER}"
set_origin "${FIX_STARTER}" "https://github.com/Roxabi/roxabi-boilerplate-cf.git"
seed_extract_gate_stubs "${FIX_STARTER}"
mkdir -p "${FIX_STARTER}/apps/starter-api"
assert_exit_match "starter without manifest fails" 1 'found \(unreadable manifest\)' \
  "run_extract_gate '${FIX_STARTER}'"
echo '{"version":1,"sets":["core","audit","flows"],"modules":{}}' \
  >"${FIX_STARTER}/apps/starter-api/kit-schema-manifest.json"
assert_exit_match "starter with an opt-in set fails" 1 'found \["core","audit","flows"\]' \
  "run_extract_gate '${FIX_STARTER}'"
echo '{"version":1,"sets":["audit,core"],"modules":{}}' \
  >"${FIX_STARTER}/apps/starter-api/kit-schema-manifest.json"
assert_exit_match "starter with one joined set id fails" 1 'found \["audit,core"\]' \
  "run_extract_gate '${FIX_STARTER}'"
echo '{"version":1,"sets":["core","audit"],"modules":{}}' \
  >"${FIX_STARTER}/apps/starter-api/kit-schema-manifest.json"
assert_output "starter with core and audit passes the scope check" 'extract-dry-run: banlist' \
  "out=\$(run_extract_gate '${FIX_STARTER}' 2>&1 || true); ! echo \"\$out\" | grep -q 'must sync only' && echo \"\$out\" | grep -E '== extract-dry-run: banlist'"

# 12) reserved example-web-branded is denied on kit and product trees
FIX_BRANDED="$TMP/branded-fail"
make_repo "${FIX_BRANDED}"
set_origin "${FIX_BRANDED}" "https://github.com/Roxabi/roxabi-boilerplate-cf.git"
seed_extract_gate_stubs "${FIX_BRANDED}"
mkdir -p "${FIX_BRANDED}/apps/example-web-branded"
assert_exit_match "kit rejects example-web-branded" 1 \
  'UNEXPECTED app \(not in kit allowlist\): apps/example-web-branded' \
  "run_extract_gate '${FIX_BRANDED}'"

FIX_BRANDED_P="$TMP/branded-product-fail"
make_repo "${FIX_BRANDED_P}"
set_origin "${FIX_BRANDED_P}" "https://github.com/acme/product-consumer.git"
mark_product "${FIX_BRANDED_P}"
seed_extract_gate_stubs "${FIX_BRANDED_P}"
mkdir -p "${FIX_BRANDED_P}/apps/example-web-branded"
assert_exit_match "product rejects example-web-branded" 1 \
  'UNEXPECTED app \(reserved kit name, not yet extracted\): apps/example-web-branded' \
  "run_extract_gate '${FIX_BRANDED_P}'"

# 12b) hidden app dirs are still unexpected on kit trees
FIX_HIDDEN="$TMP/hidden-app-fail"
make_repo "${FIX_HIDDEN}"
set_origin "${FIX_HIDDEN}" "https://github.com/Roxabi/roxabi-boilerplate-cf.git"
seed_extract_gate_stubs "${FIX_HIDDEN}"
mkdir -p "${FIX_HIDDEN}/apps/.share-api"
assert_exit_match "kit rejects hidden app dir" 1 \
  'UNEXPECTED app \(not in kit allowlist\): apps/.share-api' \
  "run_extract_gate '${FIX_HIDDEN}'"

# 13) CP-BAN plants — each new frame compound fails in isolation (source + *.test.ts)
for token in private_acl SLUG_EXISTS share-mcp; do
  FIX_BAN="$TMP/ban-${token}"
  mkdir -p "${FIX_BAN}/packages/core" "${FIX_BAN}/apps" "${FIX_BAN}/config/kit"
  cp "${ZONES_SRC}" "${FIX_BAN}/config/kit/zero-edit-zones.json"
  printf 'export const leak = "%s"\n' "$token" >"${FIX_BAN}/packages/core/leak.ts"
  assert_exit_match "banlist rejects ${token}" 1 "BANLIST HIT: pattern /${token}/" \
    "ZERO_EDIT_ROOT='${FIX_BAN}' bash '${BAN}'"
  FIX_BAN_T="$TMP/ban-${token}-test"
  mkdir -p "${FIX_BAN_T}/packages/core" "${FIX_BAN_T}/apps" "${FIX_BAN_T}/config/kit"
  cp "${ZONES_SRC}" "${FIX_BAN_T}/config/kit/zero-edit-zones.json"
  printf 'export const leak = "%s"\n' "$token" >"${FIX_BAN_T}/packages/core/leak.test.ts"
  assert_exit_match "banlist rejects ${token} in *.test.ts" 1 "BANLIST HIT: pattern /${token}/" \
    "ZERO_EDIT_ROOT='${FIX_BAN_T}' bash '${BAN}'"
done

# 14) Roxabi/roxabi-boilerplate-cf#318: the banlist scans every kit app zero-edit-zones.json lists, not a list of its own.
FIX_BAN_APP="$TMP/ban-kit-app"
mkdir -p "${FIX_BAN_APP}/packages" "${FIX_BAN_APP}/apps/example-cron" "${FIX_BAN_APP}/config/kit"
bun -e '
  const [src, dst] = process.argv.slice(1); const z = JSON.parse(await Bun.file(src).text());
  z.protected_prefixes.push("apps/example-cron/"); await Bun.write(dst, JSON.stringify(z, null, 2));
' "${ZONES_SRC}" "${FIX_BAN_APP}/config/kit/zero-edit-zones.json"
printf 'export const leak = "%s"\n' share-mcp >"${FIX_BAN_APP}/apps/example-cron/leak.ts"
assert_exit_match "banlist scans a kit app added to zero-edit-zones.json" 1 \
  "BANLIST HIT: pattern /share-mcp/ under apps/example-cron" \
  "ZERO_EDIT_ROOT='${FIX_BAN_APP}' bash '${BAN}'"
FIX_BAN_NOZONES="$TMP/ban-no-zones"
mkdir -p "${FIX_BAN_NOZONES}/packages"
assert_exit_match "banlist refuses without zero-edit-zones.json" 1 \
  "check-banned-strings: cannot read the kit apps" \
  "ZERO_EDIT_ROOT='${FIX_BAN_NOZONES}' bash '${BAN}'"


echo ""
echo "CP-EXTRACT self-test: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
