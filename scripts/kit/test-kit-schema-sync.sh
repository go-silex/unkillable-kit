#!/usr/bin/env bash
# Table-driven harness for scripts/kit/kit-schema-sync.sh
#
# Exit 0 only if all cases pass.
set -euo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE 2>/dev/null || true
# Bun colorizes console.log(number) on a TTY (even inside $(...)), and
# FORCE_COLOR still wins over NO_COLOR on Bun 1.4.0. Write a string instead.

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
SCRIPT="${ROOT}/scripts/kit/kit-schema-sync.sh"
KIT_SQL="${ROOT}/apps/example-api/migrations"
CATALOG="${ROOT}/config/kit/kit-schema-modules.json"

if [[ ! -f "${SCRIPT}" ]]; then
  echo "FAIL: missing ${SCRIPT}" >&2
  exit 1
fi

# Catalog projection — same TSV path as the SUT (no eval of JSON.stringify).
CATALOG_IDS=()
CATALOG_FILES=()
CATALOG_SETS=()
CATALOG_SHAS=()
CORE_IDS=()
SOURCE_ROOT=""
CATALOG_TSV="$(
  KIT_SCHEMA_CATALOG="${CATALOG}" bun -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.env.KIT_SCHEMA_CATALOG, "utf8"));
if (typeof data.source_root !== "string") process.exit(1);
console.log("#SOURCE_ROOT\t" + data.source_root);
for (const m of data.modules) {
  console.log([m.id, m.file, m.set, m.kitSha256].join("\t"));
}
'
)" || { echo "FAIL: catalog extract" >&2; exit 1; }
while IFS=$'\t' read -r c1 c2 c3 c4; do
  if [[ "${c1}" == "#SOURCE_ROOT" ]]; then
    SOURCE_ROOT="${c2}"
    continue
  fi
  [[ -n "${c1}" ]] || continue
  CATALOG_IDS+=("${c1}")
  CATALOG_FILES+=("${c2}")
  CATALOG_SETS+=("${c3}")
  CATALOG_SHAS+=("${c4}")
  if [[ "${c3}" == "core" ]]; then
    CORE_IDS+=("${c1}")
  fi
done <<< "${CATALOG_TSV}"$'\n'

PASS=0
FAIL=0

pass() {
  echo "  PASS: $1"
  PASS=$((PASS + 1))
}

fail_case() {
  echo "  FAIL: $1" >&2
  if [[ -n "${2:-}" ]]; then
    echo "    $2" >&2
  fi
  FAIL=$((FAIL + 1))
}

file_sha256() {
  local f="$1"
  local out
  if command -v sha256sum >/dev/null 2>&1; then
    out="$(sha256sum -- "$f")" || return 1
  elif command -v shasum >/dev/null 2>&1; then
    out="$(shasum -a 256 -- "$f")" || return 1
  else
    echo "FAIL: need sha256sum or shasum" >&2
    return 1
  fi
  printf '%s' "${out%% *}" | tr 'A-F' 'a-f'
}

sql_count() {
  local dir="$1"
  local files=()
  local old
  old="$(shopt -p nullglob)"
  shopt -s nullglob
  files=("${dir}"/*.sql)
  eval "${old}"
  printf '%s' "${#files[@]}"
}

manifest_count() {
  local f="$1"
  if [[ ! -f "${f}" ]]; then
    printf '0'
    return
  fi
  KIT_SCHEMA_MANIFEST="$f" bun -e '
const m = JSON.parse(require("fs").readFileSync(process.env.KIT_SCHEMA_MANIFEST, "utf8"));
process.stdout.write(String(Object.keys(m.modules || {}).length));
'
}

manifest_field() {
  local f="$1"
  local id="$2"
  local field="$3"
  KIT_SCHEMA_MANIFEST="$f" KIT_SCHEMA_ID="$id" KIT_SCHEMA_FIELD="$field" bun -e '
const m = JSON.parse(require("fs").readFileSync(process.env.KIT_SCHEMA_MANIFEST, "utf8"));
const e = m.modules && m.modules[process.env.KIT_SCHEMA_ID];
if (!e) process.exit(2);
const v = e[process.env.KIT_SCHEMA_FIELD];
if (typeof v !== "string") process.exit(2);
console.log(v);
'
}
# Every output SQL file must be either an explicit seed file or a selected catalog module.
inventory_matches_manifest() {
  KIT_SCHEMA_APP="$1" KIT_SCHEMA_SEED="$2" KIT_SCHEMA_SETS="$3" KIT_SCHEMA_CATALOG="${CATALOG}" \
    KIT_SCHEMA_PAYLOAD_LIB="${ROOT}/scripts/kit/lib/kit-schema-payload.ts" bun -e '
const fs = require("fs");
const path = require("path");
const { kitSchemaPayloadSha256 } = require(process.env.KIT_SCHEMA_PAYLOAD_LIB);
const app = process.env.KIT_SCHEMA_APP;
const manifest = JSON.parse(fs.readFileSync(path.join(app, "kit-schema-manifest.json"), "utf8"));
const sets = new Set(process.env.KIT_SCHEMA_SETS.split(","));
const selected = JSON.parse(fs.readFileSync(process.env.KIT_SCHEMA_CATALOG, "utf8")).modules.filter(m => sets.has(m.set));
const ids = Object.keys(manifest.modules).sort();
if (JSON.stringify(ids) !== JSON.stringify(selected.map(m => m.id).sort())) process.exit(1);
const expected = new Set(fs.readdirSync(process.env.KIT_SCHEMA_SEED).filter(f => f.endsWith(".sql")));
const claimed = new Set();
for (const m of selected) {
  const productFile = manifest.modules[m.id].productFile;
  if (typeof productFile !== "string" || !/^migrations\/[^/]+\.sql$/.test(productFile)) process.exit(1);
  if (claimed.has(productFile)) process.exit(1);
  claimed.add(productFile);
  if (kitSchemaPayloadSha256(path.join(app, productFile)) !== m.kitSha256) process.exit(1);
  expected.add(path.basename(productFile));
}
const actual = fs.readdirSync(path.join(app, "migrations")).filter(f => f.endsWith(".sql")).sort();
if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) process.exit(1);
'
}


copy_sql_range() {
  local dest="$1"
  local start="$2"
  local end="$3"
  local n name
  mkdir -p "${dest}"
  for n in $(seq "${start}" "${end}"); do
    name="$(printf '%04d' "${n}")"
    cp "${KIT_SQL}/${name}"_*.sql "${dest}/"
  done
}

expected_appended() {
  local dest="$1"
  local id="$2"
  local kit_file="$3"
  local src_rel="$4"
  {
    printf -- '-- kit-schema: %s\n' "${id}"
    printf -- '-- kit-sha256: %s\n' "$(file_sha256 "${kit_file}")"
    printf -- '-- kit-source: %s\n' "${src_rel}"
    printf -- '-- Do not edit this file. Kit changes ship as a new module id.\n'
    printf '\n'
    cat "${kit_file}"
  } >"${dest}"
}

run_sync() {
  set +e
  RUN_OUT="$(bash "${SCRIPT}" "$@" 2>&1)"
  RUN_EC=$?
  set -e
}

run_sync_cat() {
  local cat="$1"
  shift
  set +e
  RUN_OUT="$(KIT_SCHEMA_CATALOG="${cat}" bash "${COPY_SCRIPT}" "$@" 2>&1)"
  RUN_EC=$?
  set -e
}

# id|file|set|sha rows. source_root is relative to the kit root (no .., no absolute).
write_min_catalog() {
  local out="$1"
  local source_root="$2"
  shift 2
  KIT_SCHEMA_OUT="${out}" KIT_SCHEMA_SOURCE_ROOT="${source_root}" \
    KIT_SCHEMA_ROWS="$(printf '%s\n' "$@")" bun -e '
const fs = require("fs");
const rows = process.env.KIT_SCHEMA_ROWS.split("\n").filter(Boolean).map((line) => {
  const [id, file, set, kitSha256] = line.split("|");
  return { id, file, set, kitSha256 };
});
const json = { version: 1, source_root: process.env.KIT_SCHEMA_SOURCE_ROOT, modules: rows };
fs.writeFileSync(process.env.KIT_SCHEMA_OUT, JSON.stringify(json, null, 2) + "\n");
'
}

reset_fixture_src() {
  local rel="$1"
  rm -rf "${KIT_COPY}/${rel}"
  mkdir -p "${KIT_COPY}/${rel}"
}

echo "== kit-schema-sync =="
TMP="$(mktemp -d -t kit-schema-sync-XXXXXX)"
KIT_COPY="${TMP}/kit-root"
mkdir -p "${KIT_COPY}/scripts/kit/lib" "${KIT_COPY}/config/kit"
cp "${SCRIPT}" "${KIT_COPY}/scripts/kit/kit-schema-sync.sh"
cp "${ROOT}/scripts/kit/lib/kit-schema-payload.ts" "${ROOT}/scripts/kit/lib/kit-apps.sh" "${KIT_COPY}/scripts/kit/lib/"
cp "${ROOT}/config/kit/zero-edit-zones.json" "${KIT_COPY}/config/kit/"
COPY_SCRIPT="${KIT_COPY}/scripts/kit/kit-schema-sync.sh"
trap 'rm -rf "$TMP"' EXIT

# --- 0: catalog pin vs live SQL + 1:1 listing ---
echo "-- 0 catalog pin --"
ok0=1
detail0=""
if [[ ${#CATALOG_IDS[@]} -eq 0 ]]; then
  ok0=0
  detail0="empty catalog extract"
elif [[ "$(sql_count "${KIT_SQL}")" != "${#CATALOG_IDS[@]}" ]]; then
  ok0=0
  detail0="sql=$(sql_count "${KIT_SQL}") catalog=${#CATALOG_IDS[@]}"
else
  i=0
  while [[ $i -lt ${#CATALOG_IDS[@]} ]]; do
    src="${ROOT}/${SOURCE_ROOT}/${CATALOG_FILES[$i]}"
    if [[ ! -f "${src}" ]]; then
      ok0=0
      detail0="missing ${CATALOG_FILES[$i]}"
      break
    fi
    live="$(file_sha256 "${src}")"
    if [[ "${live}" != "${CATALOG_SHAS[$i]}" ]]; then
      ok0=0
      detail0="${CATALOG_IDS[$i]} live=${live} pin=${CATALOG_SHAS[$i]}"
      break
    fi
    i=$((i + 1))
  done
fi
if [[ "${ok0}" -eq 1 ]] && git -C "${ROOT}" show origin/main:config/kit/kit-schema-modules.json >/dev/null 2>&1; then
  set +e
  pin_drift="$(
    KIT_SCHEMA_CATALOG="${CATALOG}" bun -e '
const fs = require("fs");
const now = JSON.parse(fs.readFileSync(process.env.KIT_SCHEMA_CATALOG, "utf8"));
const prev = JSON.parse(fs.readFileSync("/dev/stdin", "utf8"));
if (!Array.isArray(prev.modules)) process.exit(1);
const nowMap = Object.fromEntries((now.modules || []).map((m) => [m.id, m.kitSha256]));
const drifted = prev.modules
  .filter((m) => m && m.id && m.kitSha256 && nowMap[m.id] && nowMap[m.id] !== m.kitSha256)
  .map((m) => m.id);
if (drifted.length) {
  console.log(drifted.join(","));
  process.exit(2);
}
' < <(git -C "${ROOT}" show origin/main:config/kit/kit-schema-modules.json)
  )"
  pin_ec=$?
  set -e
  if [[ "${pin_ec}" -eq 2 ]]; then
    ok0=0
    detail0="published id hash changed vs origin/main: ${pin_drift}"
  elif [[ "${pin_ec}" -ne 0 ]]; then
    ok0=0
    detail0="pin-drift checker failed (exit ${pin_ec})"
  fi
fi
if [[ "${ok0}" -eq 1 ]]; then
  pass "0 catalog 1:1 + kitSha256 pins match live SQL"
else
  fail_case "0 catalog pin" "${detail0}"
fi

# --- 1: adopt on a full copy records all catalog modules, writes no SQL ---
echo "-- 1 adopt full copy --"
A1="${TMP}/case1"
mkdir -p "${A1}/migrations"
cp "${KIT_SQL}"/*.sql "${A1}/migrations/"
before_1="$(sql_count "${A1}/migrations")"
run_sync --app "${A1}" --modules all --adopt
if [[ "${RUN_EC}" -eq 0 ]]; then
  pass "1 adopt exit 0"
else
  fail_case "1 adopt exit 0" "exit ${RUN_EC}: $(echo "${RUN_OUT}" | tr '\n' ' ')"
fi
if [[ "$(sql_count "${A1}/migrations")" == "${before_1}" && "${before_1}" == "${#CATALOG_IDS[@]}" ]]; then
  pass "1 adopt writes 0 sql (still ${#CATALOG_IDS[@]})"
else
  fail_case "1 adopt writes 0 sql" "count=$(sql_count "${A1}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi
if [[ "$(manifest_count "${A1}/kit-schema-manifest.json")" == "${#CATALOG_IDS[@]}" ]]; then
  pass "1 adopt records ${#CATALOG_IDS[@]} modules"
else
  fail_case "1 adopt records ${#CATALOG_IDS[@]} modules" "count=$(manifest_count "${A1}/kit-schema-manifest.json")"
fi
got_pf="$(manifest_field "${A1}/kit-schema-manifest.json" init productFile || true)"
if [[ "${got_pf}" == "migrations/0001_init.sql" ]]; then
  pass "1 adopt productFile stays 0001_init.sql"
else
  fail_case "1 adopt productFile stays 0001_init.sql" "got=${got_pf}"
fi
# bytes unchanged (record must not rewrite)
if cmp -s "${KIT_SQL}/0001_init.sql" "${A1}/migrations/0001_init.sql"; then
  pass "1 adopt does not rewrite 0001_init.sql"
else
  fail_case "1 adopt does not rewrite 0001_init.sql"
fi

# --- 1b: --modules all --adopt on core-only copy fails and writes 0 kit files ---
echo "-- 1b adopt-all on partial clone --"
A1B="${TMP}/case1b"
copy_sql_range "${A1B}/migrations" 1 8
run_sync --app "${A1B}" --modules all --adopt
if [[ "${RUN_EC}" -ne 0 && "${RUN_OUT}" == *"adopt unmatched"* \
  && "$(sql_count "${A1B}/migrations")" == "8" \
  && ! -e "${A1B}/migrations/0009_kit_organization_roles.sql" \
  && ! -f "${A1B}/kit-schema-manifest.json" ]]; then
  pass "1b adopt-all on 0001-0008 exits 1, writes 0"
else
  fail_case "1b adopt-all on 0001-0008 exits 1, writes 0" \
    "exit=${RUN_EC} sql=$(sql_count "${A1B}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 2: a partial clone adopts existing core migrations and appends missing ones ---
echo "-- 2 core clone 0001-0008 --"
A2="${TMP}/case2"
copy_sql_range "${A2}/migrations" 1 8
cp -a "${A2}/migrations" "${TMP}/case2-seed"
run_sync --app "${A2}" --modules core
if [[ "${RUN_EC}" -eq 0 && "$(manifest_count "${A2}/kit-schema-manifest.json")" == "${#CORE_IDS[@]}" \
  && -f "${A2}/$(manifest_field "${A2}/kit-schema-manifest.json" better_auth_1_7_additive productFile || true)" \
  && -f "${A2}/$(manifest_field "${A2}/kit-schema-manifest.json" api_keys_org_not_null productFile || true)" ]] \
  && inventory_matches_manifest "${A2}" "${TMP}/case2-seed" core; then
  pass "2 core records all catalog core modules"
else
  fail_case "2 core records all catalog core modules" \
    "exit=${RUN_EC} modules=$(manifest_count "${A2}/kit-schema-manifest.json") sql=$(sql_count "${A2}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# Fresh default composes both sets and its SQL applies in local journal order.
A2D="${TMP}/case2-default"
mkdir -p "${A2D}/migrations" "${TMP}/case2d-seed"
run_sync --app "${A2D}"
if [[ "${RUN_EC}" -eq 0 ]] && inventory_matches_manifest "${A2D}" "${TMP}/case2d-seed" core,audit \
  && KIT_SCHEMA_APP="${A2D}" bun -e '
const fs = require("fs");
const { Database } = require("bun:sqlite");
const db = new Database(":memory:");
const dir = process.env.KIT_SCHEMA_APP + "/migrations";
for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) {
  db.exec("BEGIN");
  db.exec(fs.readFileSync(dir + "/" + file, "utf8"));
  db.exec("COMMIT");
}
if (!db.query("SELECT name FROM sqlite_master WHERE type = ? AND name = ?").get("table", "rate_limit_buckets")) process.exit(1);
const m = JSON.parse(fs.readFileSync(process.env.KIT_SCHEMA_APP + "/kit-schema-manifest.json", "utf8"));
if (JSON.stringify([...m.sets].sort()) !== JSON.stringify(["audit", "core"])) process.exit(1);
'; then
  pass "2d fresh default composes core and audit and applies to SQLite"
else
  fail_case "2d fresh default and SQLite" "exit=${RUN_EC} out=${RUN_OUT}"
fi
cp "${A2}/kit-schema-manifest.json" "${TMP}/case2-manifest-before.json"
run_sync --app "${A2}"
if [[ "${RUN_EC}" -eq 0 ]] && cmp -s "${TMP}/case2-manifest-before.json" "${A2}/kit-schema-manifest.json" \
  && inventory_matches_manifest "${A2}" "${TMP}/case2-seed" core; then
  pass "2 core-only recorded selection remains unchanged on default resync"
else
  fail_case "2 core-only selection resync" "exit=${RUN_EC} out=${RUN_OUT}"
fi

# The previous default wrote an empty sets array, not ["core"].
A2OLD="${TMP}/case2-old-default"
cp -a "${A2}" "${A2OLD}"
KIT_SCHEMA_MANIFEST="${A2OLD}/kit-schema-manifest.json" bun -e '
const fs = require("fs"); const p = process.env.KIT_SCHEMA_MANIFEST;
const m = JSON.parse(fs.readFileSync(p, "utf8")); m.sets = [];
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
'
cp "${A2OLD}/kit-schema-manifest.json" "${TMP}/case2-old-before.json"
run_sync --app "${A2OLD}"
if [[ "${RUN_EC}" -eq 0 ]] && cmp -s "${TMP}/case2-old-before.json" "${A2OLD}/kit-schema-manifest.json" \
  && inventory_matches_manifest "${A2OLD}" "${TMP}/case2-seed" core; then
  pass "2 old empty sets remain byte-identical without audit on resync"
else
  fail_case "2 old empty sets resync" "exit=${RUN_EC} out=${RUN_OUT}"
fi

A2LEGACY="${TMP}/case2-legacy"
cp -a "${A2}" "${A2LEGACY}"
KIT_SCHEMA_MANIFEST="${A2LEGACY}/kit-schema-manifest.json" bun -e '
const fs = require("fs"); const p = process.env.KIT_SCHEMA_MANIFEST;
const m = JSON.parse(fs.readFileSync(p, "utf8")); delete m.sets;
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
'
run_sync --app "${A2LEGACY}"
if [[ "${RUN_EC}" -eq 0 ]] && inventory_matches_manifest "${A2LEGACY}" "${TMP}/case2-seed" core \
  && KIT_SCHEMA_MANIFEST="${A2LEGACY}/kit-schema-manifest.json" bun -e '
const m = JSON.parse(require("fs").readFileSync(process.env.KIT_SCHEMA_MANIFEST, "utf8"));
if (JSON.stringify(m.sets) !== JSON.stringify(["core"])) process.exit(1);
'; then
  pass "2 legacy manifest derives core only"
else
  fail_case "2 legacy manifest derives core only" "exit=${RUN_EC} out=${RUN_OUT}"
fi


# Real consumer opt-in: core alone omits notifications, then the explicit set appends it.
A2N="${TMP}/case2-notifications"
copy_sql_range "${A2N}/migrations" 1 8
cp -a "${A2N}/migrations" "${TMP}/case2n-seed"
run_sync --app "${A2N}" --modules core
if [[ "${RUN_EC}" -eq 0 ]] && ! manifest_field "${A2N}/kit-schema-manifest.json" notifications productFile >/dev/null 2>&1 \
  && inventory_matches_manifest "${A2N}" "${TMP}/case2n-seed" core; then
  pass "2n notifications omitted without opt-in"
else
  fail_case "2n notifications omitted without opt-in" "exit=${RUN_EC} out=${RUN_OUT}"
fi
before_notifications="$(sql_count "${A2N}/migrations")"
run_sync --app "${A2N}" --modules core,notifications
notifications_file="$(manifest_field "${A2N}/kit-schema-manifest.json" notifications productFile || true)"
if [[ "${RUN_EC}" -eq 0 && -n "${notifications_file}" && -f "${A2N}/${notifications_file}" \
  && "$(sql_count "${A2N}/migrations")" == "$((before_notifications + 1))" ]] \
  && inventory_matches_manifest "${A2N}" "${TMP}/case2n-seed" core,notifications; then
  expected_appended "${TMP}/expected-notifications.sql" "notifications" "${KIT_SQL}/0023_notifications.sql" "${SOURCE_ROOT}/0023_notifications.sql"
  if cmp -s "${TMP}/expected-notifications.sql" "${A2N}/${notifications_file}"; then
    pass "2n notifications opt-in appends actual migration"
  else
    fail_case "2n notifications payload" "appended SQL differs"
  fi
else
  fail_case "2n notifications opt-in" "exit=${RUN_EC} out=${RUN_OUT}"
fi

# --- 3: isolated tree --modules core,audit appends audit after Better Auth 1.7 ---
echo "-- 3 append audit after Better Auth 1.7 --"
A3="${TMP}/case3"
copy_sql_range "${A3}/migrations" 1 8
run_sync --app "${A3}" --modules core
if [[ "${RUN_EC}" -ne 0 ]]; then
  fail_case "3 seed core" "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi
before_audit="$(sql_count "${A3}/migrations")"
run_sync --app "${A3}" --modules core,audit
want3="${A3}/$(manifest_field "${A3}/kit-schema-manifest.json" rate_limit_audit productFile || true)"
expected_appended "${TMP}/expected-audit.sql" "rate_limit_audit" \
  "${KIT_SQL}/0010_rate_limit_audit.sql" \
  "apps/example-api/migrations/0010_rate_limit_audit.sql"
if [[ "${RUN_EC}" -eq 0 && -f "${want3}" && "$(sql_count "${A3}/migrations")" == "$((before_audit + 1))" ]] \
  && cmp -s "${want3}" "${TMP}/expected-audit.sql"; then
  pass "3 writes audit migration with header and catalog payload"
else
  fail_case "3 writes audit migration with header and catalog payload" \
    "exit=${RUN_EC} sql=$(sql_count "${A3}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi
run_sync --app "${A3}" --modules core,audit
if [[ "${RUN_EC}" -eq 0 && "$(sql_count "${A3}/migrations")" == "$((before_audit + 1))" ]]; then
  pass "3 second run writes 0"
else
  fail_case "3 second run writes 0" \
    "exit=${RUN_EC} sql=$(sql_count "${A3}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 3b: deleting the manifest while headed files exist is fail-closed ---
echo "-- 3b missing manifest with headed files --"
cp "${want3}" "${TMP}/audit-before-header.sql"
rm -f "${A3}/kit-schema-manifest.json"
run_sync --app "${A3}" --modules core,audit
if [[ "${RUN_EC}" -eq 1 && "${RUN_OUT}" == *"manifest missing while kit-schema headed files exist"* \
  && "$(sql_count "${A3}/migrations")" == "$((before_audit + 1))" ]] \
  && cmp -s "${want3}" "${TMP}/audit-before-header.sql" \
  && [[ ! -f "${A3}/kit-schema-manifest.json" ]]; then
  pass "3b missing manifest with headed files exits 1, no rewrite"
else
  fail_case "3b missing manifest with headed files exits 1, no rewrite" \
    "exit=${RUN_EC} sql=$(sql_count "${A3}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 4: product 0009_lgu_domain.sql + core files → rbac writes 0010_kit_organization_roles.sql ---
echo "-- 4 skip occupied 0009 --"
A4="${TMP}/case4"
copy_sql_range "${A4}/migrations" 1 8
printf '%s\n' "-- product domain" "CREATE TABLE IF NOT EXISTS lgu_domain (id TEXT PRIMARY KEY);" \
  >"${A4}/migrations/0009_lgu_domain.sql"
cp -a "${A4}/migrations" "${TMP}/case4-seed"
run_sync --app "${A4}" --modules core,rbac
want4="${A4}/migrations/0010_kit_organization_roles.sql"
if [[ "${RUN_EC}" -eq 0 && -f "${want4}" && ! -f "${A4}/migrations/0009_kit_organization_roles.sql" \
  && -f "${A4}/migrations/0009_lgu_domain.sql" ]] \
  && inventory_matches_manifest "${A4}" "${TMP}/case4-seed" core,rbac; then
  pass "4 writes 0010_kit_organization_roles.sql not 0009"
else
  fail_case "4 writes 0010_kit_organization_roles.sql not 0009" \
    "exit=${RUN_EC} sql=$(sql_count "${A4}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 5: recorded sha mutated → exit 1 ---
echo "-- 5 mutated manifest sha --"
A5="${TMP}/case5"
copy_sql_range "${A5}/migrations" 1 8
run_sync --app "${A5}" --modules core
if [[ "${RUN_EC}" -ne 0 ]]; then
  fail_case "5 seed core" "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi
KIT_SCHEMA_MANIFEST="${A5}/kit-schema-manifest.json" bun -e '
const fs = require("fs");
const p = process.env.KIT_SCHEMA_MANIFEST;
const m = JSON.parse(fs.readFileSync(p, "utf8"));
m.modules.init.kitSha256 = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
'
sql_before5="$(sql_count "${A5}/migrations")"
run_sync --app "${A5}" --modules core
if [[ "${RUN_EC}" -eq 1 && "${RUN_OUT}" == *"module init mutated"* && "$(sql_count "${A5}/migrations")" == "${sql_before5}" ]]; then
  pass "5 mutated sha exits 1, no write"
else
  fail_case "5 mutated sha exits 1, no write" \
    "exit=${RUN_EC} sql=$(sql_count "${A5}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 6: dry-run prints filenames, does not create them ---
echo "-- 6 dry-run --"
A6="${TMP}/case6"
copy_sql_range "${A6}/migrations" 1 8
run_sync --app "${A6}" --modules core,audit --dry-run
if [[ "${RUN_EC}" -eq 0 && "${RUN_OUT}" == *"0009_kit_rate_limit_audit.sql"* \
  && "${RUN_OUT}" == *"0010_kit_better_auth_1_7_additive.sql"* \
  && "${RUN_OUT}" == *"0011_kit_api_keys_org_not_null.sql"* \
  && ! -f "${A6}/migrations/0009_kit_rate_limit_audit.sql" \
  && ! -f "${A6}/migrations/0011_kit_api_keys_org_not_null.sql" \
  && "$(sql_count "${A6}/migrations")" == "8" \
  && ! -f "${A6}/kit-schema-manifest.json" ]]; then
  pass "6 dry-run prints planned files, writes nothing"
else
  fail_case "6 dry-run prints planned files, writes nothing" \
    "exit=${RUN_EC} sql=$(sql_count "${A6}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 7: --modules all on empty migrations writes NNNN_kit_*.sql in catalog order ---
echo "-- 7 empty all --"
A7="${TMP}/case7"
mkdir -p "${A7}/migrations"
run_sync --app "${A7}" --modules all
ok7=1
detail7=""
if [[ "${RUN_EC}" -ne 0 ]]; then
  ok7=0
  detail7="exit ${RUN_EC}: $(echo "${RUN_OUT}" | tr '\n' ' ')"
elif [[ "$(sql_count "${A7}/migrations")" != "${#CATALOG_IDS[@]}" ]]; then
  ok7=0
  detail7="sql count=$(sql_count "${A7}/migrations")"
elif [[ "$(manifest_count "${A7}/kit-schema-manifest.json")" != "${#CATALOG_IDS[@]}" ]]; then
  ok7=0
  detail7="manifest count=$(manifest_count "${A7}/kit-schema-manifest.json")"
else
  n=1
  for id in "${CATALOG_IDS[@]}"; do
    nnnn="$(printf '%04d' "${n}")"
    f="${A7}/migrations/${nnnn}_kit_${id}.sql"
    if [[ ! -f "${f}" ]]; then
      ok7=0
      detail7="missing ${nnnn}_kit_${id}.sql"
      break
    fi
    head1="$(head -n 1 "${f}")"
    if [[ "${head1}" != "-- kit-schema: ${id}" ]]; then
      ok7=0
      detail7="${f} header=${head1}"
      break
    fi
    n=$((n + 1))
  done
  if [[ "${ok7}" -eq 1 ]]; then
    expected_appended "${TMP}/expected-init.sql" "init" \
      "${KIT_SQL}/0001_init.sql" \
      "apps/example-api/migrations/0001_init.sql"
    if ! cmp -s "${A7}/migrations/0001_kit_init.sql" "${TMP}/expected-init.sql"; then
      ok7=0
      detail7="0001_kit_init.sql body mismatch"
    fi
  fi
fi
if [[ "${ok7}" -eq 1 ]]; then
  pass "7 all on empty writes catalog-ordered kit_ files"
else
  fail_case "7 all on empty writes catalog-ordered kit_ files" "${detail7}"
fi

# --- 8: empty --modules ---
echo "-- 8 empty modules --"
A8="${TMP}/case8"
mkdir -p "${A8}/migrations"
run_sync --app "${A8}" --modules ""
if [[ "${RUN_EC}" -eq 1 && "${RUN_OUT}" == *"empty"* ]]; then
  pass "8 empty --modules exits 1"
else
  fail_case "8 empty --modules exits 1" "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 9: unknown set ---
echo "-- 9 unknown set --"
run_sync --app "${A8}" --modules nope
if [[ "${RUN_EC}" -eq 1 && "${RUN_OUT}" == *"unknown module set"* ]]; then
  pass "9 unknown set exits 1"
else
  fail_case "9 unknown set exits 1" "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 10: refuse apps/example-api ---
echo "-- 10 refuse example-api --"
sql_ex="$(sql_count "${KIT_SQL}")"
run_sync --app "${ROOT}/apps/example-api" --modules core
if [[ "${RUN_EC}" -eq 1 && "${RUN_OUT}" == *"refuse kit app apps/example-api (applied SSoT)"* \
  && "$(sql_count "${KIT_SQL}")" == "${sql_ex}" \
  && ! -f "${ROOT}/apps/example-api/kit-schema-manifest.json" ]]; then
  pass "10 refuse --app apps/example-api"
else
  fail_case "10 refuse --app apps/example-api" \
    "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 10b: refuse every kit app of zero-edit-zones.json, relative or not (Roxabi/roxabi-boilerplate-cf#318) ---
echo "-- 10b refuse relative kit apps --"
run_sync --app "apps/example-api" --modules core
if [[ "${RUN_EC}" -eq 1 && "${RUN_OUT}" == *"refuse kit app apps/example-api (applied SSoT)"* \
  && "$(sql_count "${KIT_SQL}")" == "${sql_ex}" ]]; then
  pass "10b refuse --app apps/example-api (relative)"
else
  fail_case "10b refuse --app apps/example-api (relative)" \
    "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi
for kit_app in example-web mcp-example; do
  run_sync --app "apps/${kit_app}" --modules core
  if [[ "${RUN_EC}" -eq 1 && "${RUN_OUT}" == *"refuse kit app apps/${kit_app} (applied SSoT)"* ]]; then
    pass "10b refuse --app apps/${kit_app}"
  else
    fail_case "10b refuse --app apps/${kit_app}" \
      "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
  fi
done

# --- 11b: --modules all,typo still validates the typo ---
echo "-- 11b all+typo --"
run_sync --app "${A8}" --modules all,nope
if [[ "${RUN_EC}" -eq 1 && "${RUN_OUT}" == *"unknown module set"* ]]; then
  pass "11b --modules all,nope exits 1"
else
  fail_case "11b --modules all,nope exits 1" "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 12: product 1000_ does not steal kit 0009 ---
echo "-- 12 kit band ignores 1000_ --"
A12="${TMP}/case12"
copy_sql_range "${A12}/migrations" 1 8
printf '%s\n' "-- product domain" "CREATE TABLE IF NOT EXISTS lgu_domain (id TEXT PRIMARY KEY);" \
  >"${A12}/migrations/1000_lgu_domain.sql"
run_sync --app "${A12}" --modules core,audit
if [[ "${RUN_EC}" -eq 0 && -f "${A12}/migrations/0009_kit_rate_limit_audit.sql" \
  && ! -f "${A12}/migrations/1001_kit_rate_limit_audit.sql" \
  && -f "${A12}/migrations/1000_lgu_domain.sql" ]]; then
  pass "12 1000_domain + audit writes 0009_kit_* not 1001"
else
  fail_case "12 1000_domain + audit writes 0009_kit_* not 1001" \
    "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 11: corrupt clone + --adopt does not rewrite ---
echo "-- 11 adopt mutated clone --"
A11="${TMP}/case11"
copy_sql_range "${A11}/migrations" 1 8
printf '\n-- corrupted\n' >>"${A11}/migrations/0001_init.sql"
run_sync --app "${A11}" --modules core --adopt
if [[ "${RUN_EC}" -ne 0 && "${RUN_OUT}" == *"adopt unmatched"* \
  && ! -f "${A11}/migrations/0009_kit_init.sql" ]] \
  && grep -q "corrupted" "${A11}/migrations/0001_init.sql"; then
  pass "11 adopt on mutated 0001 exits 1, no rewrite"
else
  fail_case "11 adopt on mutated 0001 exits 1, no rewrite" \
    "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 13: catalog pin mismatch via KIT_SCHEMA_CATALOG ---
echo "-- 13 catalog pin mismatch --"
A13="${TMP}/case13"
copy_sql_range "${A13}/migrations" 1 8
BAD_CAT="${TMP}/bad-catalog.json"
KIT_SCHEMA_OUT="${BAD_CAT}" KIT_SCHEMA_CATALOG="${CATALOG}" bun -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync(process.env.KIT_SCHEMA_CATALOG, "utf8"));
m.modules[0].kitSha256 = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
fs.writeFileSync(process.env.KIT_SCHEMA_OUT, JSON.stringify(m, null, 2) + "\n");
'
set +e
RUN_OUT="$(KIT_SCHEMA_CATALOG="${BAD_CAT}" bash "${SCRIPT}" --app "${A13}" --modules core 2>&1)"
RUN_EC=$?
set -e
if [[ "${RUN_EC}" -eq 1 && "${RUN_OUT}" == *"catalog pin mismatch"* \
  && "$(sql_count "${A13}/migrations")" == "8" ]]; then
  pass "13 catalog pin mismatch exits 1, no write"
else
  fail_case "13 catalog pin mismatch exits 1, no write" \
    "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 14: missing manifest + headed file does not rebuild or append ---
echo "-- 14 missing manifest headed --"
A14="${TMP}/case14"
copy_sql_range "${A14}/migrations" 1 8
run_sync --app "${A14}" --modules core
if [[ "${RUN_EC}" -ne 0 ]]; then
  fail_case "14 seed core" "exit=${RUN_EC}"
fi
run_sync --app "${A14}" --modules core,audit
audit14="$(manifest_field "${A14}/kit-schema-manifest.json" rate_limit_audit productFile || true)"
if [[ "${RUN_EC}" -ne 0 || -z "${audit14}" || ! -f "${A14}/${audit14}" ]]; then
  fail_case "14 seed audit" "exit=${RUN_EC} file=${audit14}"
else
  printf '\n-- smuggled\n' >>"${A14}/${audit14}"
fi
cp -a "${A14}/migrations" "${TMP}/case14-before"
rm -f "${A14}/kit-schema-manifest.json"
run_sync --app "${A14}" --modules core,audit
if [[ "${RUN_EC}" -eq 1 && "${RUN_OUT}" == *"manifest missing while kit-schema headed files exist"* ]] \
  && diff -qr "${TMP}/case14-before" "${A14}/migrations" >/dev/null \
  && [[ ! -f "${A14}/kit-schema-manifest.json" ]]; then
  pass "14 missing manifest with headed files exits 1, no append"
else
  fail_case "14 missing manifest with headed files exits 1, no append" \
    "exit=${RUN_EC} sql=$(sql_count "${A14}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 15: recorded body drifted ---
echo "-- 15 recorded body drifted --"
A15="${TMP}/case15"
copy_sql_range "${A15}/migrations" 1 8
run_sync --app "${A15}" --modules core
if [[ "${RUN_EC}" -ne 0 ]]; then
  fail_case "15 seed core" "exit=${RUN_EC}"
fi
printf '\n-- mutated body\n' >>"${A15}/migrations/0001_init.sql"
sql_before15="$(sql_count "${A15}/migrations")"
run_sync --app "${A15}" --modules core
if [[ "${RUN_EC}" -eq 1 && "${RUN_OUT}" == *"body drifted"* \
  && "$(sql_count "${A15}/migrations")" == "${sql_before15}" ]]; then
  pass "15 recorded body drifted exits 1, no write"
else
  fail_case "15 recorded body drifted exits 1, no write" \
    "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 16: recorded file missing ---
echo "-- 16 recorded missing --"
A16="${TMP}/case16"
copy_sql_range "${A16}/migrations" 1 8
run_sync --app "${A16}" --modules core
if [[ "${RUN_EC}" -ne 0 ]]; then
  fail_case "16 seed core" "exit=${RUN_EC}"
fi
rm -f "${A16}/migrations/0001_init.sql"
run_sync --app "${A16}" --modules core
if [[ "${RUN_EC}" -eq 1 && "${RUN_OUT}" == *"recorded init missing"* ]]; then
  pass "16 recorded missing file exits 1"
else
  fail_case "16 recorded missing file exits 1" \
    "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 17: kit band overflow at 0999 ---
echo "-- 17 band overflow --"
A17="${TMP}/case17"
copy_sql_range "${A17}/migrations" 1 8
printf '%s\n' "-- pad" >"${A17}/migrations/0999_pad.sql"
run_sync --app "${A17}" --modules core,audit
if [[ "${RUN_EC}" -eq 1 && "${RUN_OUT}" == *"kit migration band overflow"* \
  && ! -f "${A17}/migrations/1000_kit_rate_limit_audit.sql" ]]; then
  pass "17 0999 pad + audit overflows, no 1000_kit_*"
else
  fail_case "17 0999 pad + audit overflows, no 1000_kit_*" \
    "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# Catalog file names do not contain the set name. Opt-in must come from the
# manifest id → catalog set, not from a filename.
# --- 18: core,flows synced without flows_x; catalog gains flows_x; default appends it ---
echo "-- 18 default re-sync appends new id in opted-in set --"
SRC18=".kit-schema-sync-test-src/c18"
reset_fixture_src "${SRC18}"
printf '%s\n' 'CREATE TABLE kit_optin_core (id TEXT PRIMARY KEY);' >"${KIT_COPY}/${SRC18}/0001_init.sql"
printf '%s\n' 'CREATE TABLE kit_optin_plans (id TEXT PRIMARY KEY);' >"${KIT_COPY}/${SRC18}/0012_plans.sql"
SHA18_INIT="$(file_sha256 "${KIT_COPY}/${SRC18}/0001_init.sql")"
SHA18_PLANS="$(file_sha256 "${KIT_COPY}/${SRC18}/0012_plans.sql")"
CAT18A="${TMP}/cat18a.json"
CAT18B="${TMP}/cat18b.json"
write_min_catalog "${CAT18A}" "${SRC18}" \
  "init|0001_init.sql|core|${SHA18_INIT}" \
  "plans|0012_plans.sql|flows|${SHA18_PLANS}"
A18="${TMP}/case18"
mkdir -p "${A18}/migrations"
run_sync_cat "${CAT18A}" --app "${A18}" --modules core,flows
if [[ "${RUN_EC}" -ne 0 || ! -f "${A18}/migrations/0001_kit_init.sql" \
  || ! -f "${A18}/migrations/0002_kit_plans.sql" \
  || "$(sql_count "${A18}/migrations")" != "2" ]]; then
  fail_case "18 seed core,flows" "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi
SRC18B=".kit-schema-sync-test-src/c18b"
reset_fixture_src "${SRC18B}"
cp "${KIT_COPY}/${SRC18}/0001_init.sql" "${KIT_COPY}/${SRC18}/0012_plans.sql" "${KIT_COPY}/${SRC18B}/"
printf '%s\n' 'CREATE TABLE kit_optin_extra (id TEXT PRIMARY KEY);' >"${KIT_COPY}/${SRC18B}/0099_x.sql"
SHA18_X="$(file_sha256 "${KIT_COPY}/${SRC18B}/0099_x.sql")"
write_min_catalog "${CAT18B}" "${SRC18B}" \
  "init|0001_init.sql|core|${SHA18_INIT}" \
  "plans|0012_plans.sql|flows|${SHA18_PLANS}" \
  "flows_x|0099_x.sql|flows|${SHA18_X}"
sql_before18="$(sql_count "${A18}/migrations")"
run_sync_cat "${CAT18B}" --app "${A18}"
want18="${A18}/migrations/0003_kit_flows_x.sql"
expected_appended "${TMP}/expected-flows-x.sql" "flows_x" \
  "${KIT_COPY}/${SRC18B}/0099_x.sql" \
  "${SRC18B}/0099_x.sql"
if [[ "${RUN_EC}" -eq 0 && -f "${want18}" && ! -f "${A18}/migrations/0004_kit_flows_x.sql" \
  && "$(sql_count "${A18}/migrations")" == "3" && "${sql_before18}" == "2" \
  && "$(manifest_field "${A18}/kit-schema-manifest.json" flows_x productFile)" == "migrations/0003_kit_flows_x.sql" ]] \
  && cmp -s "${want18}" "${TMP}/expected-flows-x.sql"; then
  pass "18 default appends 0003_kit_flows_x.sql"
else
  fail_case "18 default appends 0003_kit_flows_x.sql" \
    "exit=${RUN_EC} count=$(sql_count "${A18}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 18b: same gap, omitted --modules + --adopt must not exit 0 ---
echo "-- 18b adopt default does not skip new opted-in id --"
A18B="${TMP}/case18b"
mkdir -p "${A18B}/migrations"
run_sync_cat "${CAT18A}" --app "${A18B}" --modules core,flows
if [[ "${RUN_EC}" -ne 0 ]]; then
  fail_case "18b seed" "exit=${RUN_EC}"
fi
sql_before18b="$(sql_count "${A18B}/migrations")"
run_sync_cat "${CAT18B}" --app "${A18B}" --adopt
if [[ "${RUN_EC}" -ne 0 && "${RUN_OUT}" == *"adopt unmatched"* && "${RUN_OUT}" == *"flows_x"* \
  && "$(sql_count "${A18B}/migrations")" == "${sql_before18b}" \
  && ! -f "${A18B}/migrations/0003_kit_flows_x.sql" ]]; then
  pass "18b default adopt names flows_x and writes 0"
else
  fail_case "18b default adopt names flows_x and writes 0" \
    "exit=${RUN_EC} count=$(sql_count "${A18B}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 19: core-only manifest, stray flows bytes on disk, catalog has flows — default writes 0 flows ---
echo "-- 19 never opted into flows --"
SRC19=".kit-schema-sync-test-src/c19"
reset_fixture_src "${SRC19}"
cp "${KIT_COPY}/${SRC18}/0001_init.sql" "${KIT_COPY}/${SRC19}/0001_init.sql"
cp "${KIT_COPY}/${SRC18}/0012_plans.sql" "${KIT_COPY}/${SRC19}/0012_plans.sql"
cp "${KIT_COPY}/${SRC18B}/0099_x.sql" "${KIT_COPY}/${SRC19}/0099_x.sql"
CAT19="${TMP}/cat19.json"
write_min_catalog "${CAT19}" "${SRC19}" \
  "init|0001_init.sql|core|${SHA18_INIT}" \
  "plans|0012_plans.sql|flows|${SHA18_PLANS}" \
  "flows_x|0099_x.sql|flows|${SHA18_X}"
A19="${TMP}/case19"
mkdir -p "${A19}/migrations"
run_sync_cat "${CAT19}" --app "${A19}" --modules core
if [[ "${RUN_EC}" -ne 0 || ! -f "${A19}/migrations/0001_kit_init.sql" \
  || -e "${A19}/migrations/0002_kit_plans.sql" \
  || -e "${A19}/migrations/0002_kit_flows_x.sql" \
  || "$(sql_count "${A19}/migrations")" != "1" \
  || "$(manifest_count "${A19}/kit-schema-manifest.json")" != "1" ]]; then
  fail_case "19 explicit core selection" \
    "exit=${RUN_EC} count=$(sql_count "${A19}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi
cp "${KIT_COPY}/${SRC19}/0012_plans.sql" "${A19}/migrations/0009_stray.sql"
sql_before19="$(sql_count "${A19}/migrations")"
run_sync_cat "${CAT19}" --app "${A19}"
if [[ "${RUN_EC}" -eq 0 && "$(sql_count "${A19}/migrations")" == "${sql_before19}" \
  && "$(manifest_count "${A19}/kit-schema-manifest.json")" == "1" \
  && ! -e "${A19}/migrations/0010_kit_flows_x.sql" \
  && ! -e "${A19}/migrations/0010_kit_plans.sql" \
  && -f "${A19}/migrations/0009_stray.sql" ]]; then
  pass "19 core-only manifest gets nothing from flows"
else
  fail_case "19 core-only manifest gets nothing from flows" \
    "exit=${RUN_EC} count=$(sql_count "${A19}/migrations") manifest=$(manifest_count "${A19}/kit-schema-manifest.json") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 20: explicit list that drops an opted-in set with new catalog ids fails closed ---
echo "-- 20 explicit omit of opted-in set --"
SRC20=".kit-schema-sync-test-src/c20"
reset_fixture_src "${SRC20}"
printf '%s\n' 'CREATE TABLE kit_optin_core (id TEXT PRIMARY KEY);' >"${KIT_COPY}/${SRC20}/0001_init.sql"
printf '%s\n' 'CREATE TABLE kit_optin_rate (id TEXT PRIMARY KEY);' >"${KIT_COPY}/${SRC20}/0010_rate.sql"
SHA20_INIT="$(file_sha256 "${KIT_COPY}/${SRC20}/0001_init.sql")"
SHA20_RATE="$(file_sha256 "${KIT_COPY}/${SRC20}/0010_rate.sql")"
CAT20A="${TMP}/cat20a.json"
write_min_catalog "${CAT20A}" "${SRC20}" \
  "init|0001_init.sql|core|${SHA20_INIT}" \
  "rate|0010_rate.sql|audit|${SHA20_RATE}"
A20="${TMP}/case20"
mkdir -p "${A20}/migrations"
run_sync_cat "${CAT20A}" --app "${A20}" --modules core,audit
if [[ "${RUN_EC}" -ne 0 || "$(sql_count "${A20}/migrations")" != "2" ]]; then
  fail_case "20 seed core,audit" "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi
SRC20B=".kit-schema-sync-test-src/c20b"
reset_fixture_src "${SRC20B}"
cp "${KIT_COPY}/${SRC20}/0001_init.sql" "${KIT_COPY}/${SRC20}/0010_rate.sql" "${KIT_COPY}/${SRC20B}/"
printf '%s\n' 'CREATE TABLE kit_optin_audit_x (id TEXT PRIMARY KEY);' >"${KIT_COPY}/${SRC20B}/0098_y.sql"
SHA20_X="$(file_sha256 "${KIT_COPY}/${SRC20B}/0098_y.sql")"
CAT20B="${TMP}/cat20b.json"
write_min_catalog "${CAT20B}" "${SRC20B}" \
  "init|0001_init.sql|core|${SHA20_INIT}" \
  "rate|0010_rate.sql|audit|${SHA20_RATE}" \
  "audit_x|0098_y.sql|audit|${SHA20_X}"
sql_before20="$(sql_count "${A20}/migrations")"
run_sync_cat "${CAT20B}" --app "${A20}" --modules core
if [[ "${RUN_EC}" -ne 0 && "${RUN_OUT}" == *"audit_x"* \
  && "${RUN_OUT}" == *"catalog ids not in manifest"* \
  && "$(sql_count "${A20}/migrations")" == "${sql_before20}" \
  && ! -e "${A20}/migrations/0003_kit_audit_x.sql" ]]; then
  pass "20 explicit --modules core names audit_x and writes 0"
else
  fail_case "20 explicit --modules core names audit_x and writes 0" \
    "exit=${RUN_EC} count=$(sql_count "${A20}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 20b: explicit omit of a fully recorded set is not an error ---
echo "-- 20b explicit omit with no new ids --"
A20B="${TMP}/case20b"
mkdir -p "${A20B}/migrations"
run_sync_cat "${CAT20B}" --app "${A20B}" --modules core,audit
if [[ "${RUN_EC}" -ne 0 ]]; then
  fail_case "20b seed" "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi
sql_before20b="$(sql_count "${A20B}/migrations")"
run_sync_cat "${CAT20B}" --app "${A20B}" --modules core
if [[ "${RUN_EC}" -eq 0 && "$(sql_count "${A20B}/migrations")" == "${sql_before20b}" ]]; then
  pass "20b explicit omit of fully recorded set exits 0"
else
  fail_case "20b explicit omit of fully recorded set exits 0" \
    "exit=${RUN_EC} count=$(sql_count "${A20B}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 20c: explicit list that still names the set appends the new id ---
echo "-- 20c explicit include still appends --"
A20C="${TMP}/case20c"
mkdir -p "${A20C}/migrations"
run_sync_cat "${CAT20A}" --app "${A20C}" --modules core,audit
if [[ "${RUN_EC}" -ne 0 ]]; then
  fail_case "20c seed" "exit=${RUN_EC}"
fi
run_sync_cat "${CAT20B}" --app "${A20C}" --modules core,audit
if [[ "${RUN_EC}" -eq 0 && -f "${A20C}/migrations/0003_kit_audit_x.sql" \
  && "$(sql_count "${A20C}/migrations")" == "3" ]]; then
  pass "20c explicit --modules core,audit appends 0003_kit_audit_x.sql"
else
  fail_case "20c explicit --modules core,audit appends 0003_kit_audit_x.sql" \
    "exit=${RUN_EC} count=$(sql_count "${A20C}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 21: explicit non-core list with a pending core id names it ---
echo "-- 21 explicit flows with pending core --"
A21="${TMP}/case21"
mkdir -p "${A21}/migrations"
run_sync_cat "${CAT18A}" --app "${A21}" --modules flows
if [[ "${RUN_EC}" -eq 1 && "${RUN_OUT}" == *"init"* \
  && "${RUN_OUT}" == *"catalog ids not in manifest"* \
  && "$(sql_count "${A21}/migrations")" == "0" ]]; then
  pass "21 --modules flows names pending core id init"
else
  fail_case "21 --modules flows names pending core id init" \
    "exit=${RUN_EC} count=$(sql_count "${A21}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 22: 0001-0015 clone — printed command exits 0 and appends 0016 ---
echo "-- 22 clone recovery command --"
A22="${TMP}/case22"
mkdir -p "${A22}/migrations"
n=1
while [[ $n -le 15 ]]; do
  name="$(printf '%04d' "${n}")"
  cp "${KIT_SQL}/${name}"_*.sql "${A22}/migrations/"
  n=$((n + 1))
done
flows12="${A22}/migrations/0012_flows_plans_runs.sql"
cp "${flows12}" "${TMP}/flows12-before.sql"
sql_before22="$(sql_count "${A22}/migrations")"
run_sync --app "${A22}" --adopt
hint22="$(printf '%s\n' "${RUN_OUT}" | sed -n 's/.*run without --adopt: --modules //p' | head -n 1)"
if [[ "${RUN_EC}" -eq 0 || -z "${hint22}" || "${hint22}" != *"flows"* \
  || -f "${A22}/kit-schema-manifest.json" \
  || "$(sql_count "${A22}/migrations")" != "${sql_before22}" ]]; then
  fail_case "22 adopt refusal prints a modules list and writes 0" \
    "exit=${RUN_EC} hint=${hint22} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi
run_sync --app "${A22}" --modules "${hint22}"
sets22="$(KIT_SCHEMA_MANIFEST="${A22}/kit-schema-manifest.json" bun -e '
const m = JSON.parse(require("fs").readFileSync(process.env.KIT_SCHEMA_MANIFEST, "utf8"));
process.stdout.write(Array.isArray(m.sets) && m.sets.includes("flows") ? "yes" : "no");
' 2>/dev/null || true)"
if [[ "${RUN_EC}" -eq 0 && -f "${A22}/migrations/0016_kit_flows_run_approvals.sql" \
  && "${sets22}" == "yes" ]] \
  && cmp -s "${flows12}" "${TMP}/flows12-before.sql"; then
  pass "22 printed command exits 0, keeps 0012, appends 0016, records flows"
else
  fail_case "22 printed command exits 0, keeps 0012, appends 0016, records flows" \
    "exit=${RUN_EC} sets=${sets22} hint=${hint22} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 23: retired id survives a rewrite; default exits 0 ---
echo "-- 23 retired id kept --"
A23="${TMP}/case23"
mkdir -p "${A23}/migrations"
run_sync_cat "${CAT18A}" --app "${A23}" --modules core,flows
if [[ "${RUN_EC}" -ne 0 ]]; then
  fail_case "23 seed" "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi
printf '%s\n' '-- retired' >"${A23}/migrations/0098_retired.sql"
KIT_SCHEMA_MANIFEST="${A23}/kit-schema-manifest.json" bun -e '
const fs = require("fs");
const p = process.env.KIT_SCHEMA_MANIFEST;
const m = JSON.parse(fs.readFileSync(p, "utf8"));
m.modules.retired_mod = { kitSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", productFile: "migrations/0098_retired.sql" };
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
'
SRC23="${TMP}/not-used"
SRC23REL="fx/c23"
reset_fixture_src "${SRC23REL}"
cp "${KIT_COPY}/${SRC18}/0001_init.sql" "${KIT_COPY}/${SRC18}/0012_plans.sql" "${KIT_COPY}/${SRC23REL}/"
printf '%s\n' 'CREATE TABLE kit_optin_core_x (id TEXT PRIMARY KEY);' >"${KIT_COPY}/${SRC23REL}/0097_z.sql"
SHA23_X="$(file_sha256 "${KIT_COPY}/${SRC23REL}/0097_z.sql")"
CAT23="${TMP}/cat23.json"
write_min_catalog "${CAT23}" "${SRC23REL}" \
  "init|0001_init.sql|core|${SHA18_INIT}" \
  "plans|0012_plans.sql|flows|${SHA18_PLANS}" \
  "core_x|0097_z.sql|core|${SHA23_X}"
run_sync_cat "${CAT23}" --app "${A23}"
kept23="$(KIT_SCHEMA_MANIFEST="${A23}/kit-schema-manifest.json" bun -e '
const m = JSON.parse(require("fs").readFileSync(process.env.KIT_SCHEMA_MANIFEST, "utf8"));
process.stdout.write(m.modules && m.modules.retired_mod ? "yes" : "no");
')"
if [[ "${RUN_EC}" -eq 0 && -f "${A23}/migrations/0099_kit_core_x.sql" && "${kept23}" == "yes" ]]; then
  pass "23 retired id kept and default exits 0"
else
  fail_case "23 retired id kept and default exits 0" \
    "exit=${RUN_EC} kept=${kept23} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 24: second --modules all appends a new id ---
echo "-- 24 modules all second run --"
A24="${TMP}/case24"
mkdir -p "${A24}/migrations"
run_sync_cat "${CAT20A}" --app "${A24}" --modules all
if [[ "${RUN_EC}" -ne 0 ]]; then
  fail_case "24 seed all" "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi
run_sync_cat "${CAT20B}" --app "${A24}" --modules all
if [[ "${RUN_EC}" -eq 0 && -f "${A24}/migrations/0003_kit_audit_x.sql" \
  && "$(sql_count "${A24}/migrations")" == "3" ]]; then
  pass "24 second --modules all appends audit_x"
else
  fail_case "24 second --modules all appends audit_x" \
    "exit=${RUN_EC} count=$(sql_count "${A24}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 25: removing a set from sets is the opt-out the guard honours ---
echo "-- 25 sets opt-out --"
A25="${TMP}/case25"
mkdir -p "${A25}/migrations"
run_sync_cat "${CAT18A}" --app "${A25}" --modules core,flows
if [[ "${RUN_EC}" -ne 0 ]]; then
  fail_case "25 seed" "exit=${RUN_EC}"
fi
KIT_SCHEMA_MANIFEST="${A25}/kit-schema-manifest.json" bun -e '
const fs = require("fs");
const p = process.env.KIT_SCHEMA_MANIFEST;
const m = JSON.parse(fs.readFileSync(p, "utf8"));
m.sets = (m.sets || []).filter((s) => s !== "flows");
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
'
sql_before25="$(sql_count "${A25}/migrations")"
run_sync_cat "${CAT18B}" --app "${A25}"
if [[ "${RUN_EC}" -ne 0 || -e "${A25}/migrations/0003_kit_flows_x.sql" \
  || "$(sql_count "${A25}/migrations")" != "${sql_before25}" ]]; then
  fail_case "25 default honours sets opt-out" \
    "exit=${RUN_EC} count=$(sql_count "${A25}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi
run_sync_cat "${CAT18B}" --app "${A25}" --modules core
if [[ "${RUN_EC}" -eq 0 && ! -e "${A25}/migrations/0003_kit_flows_x.sql" \
  && "$(sql_count "${A25}/migrations")" == "${sql_before25}" ]]; then
  pass "25 sets opt-out skips new flows id"
else
  fail_case "25 sets opt-out skips new flows id" \
    "exit=${RUN_EC} count=$(sql_count "${A25}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 26: modules must be an object when headed files exist ---
echo "-- 26 modules not an object --"
A26="${TMP}/case26"
mkdir -p "${A26}/migrations"
run_sync_cat "${CAT18A}" --app "${A26}" --modules core
if [[ "${RUN_EC}" -ne 0 ]]; then
  fail_case "26 seed" "exit=${RUN_EC}"
fi
KIT_SCHEMA_MANIFEST="${A26}/kit-schema-manifest.json" bun -e '
const fs = require("fs");
const p = process.env.KIT_SCHEMA_MANIFEST;
const m = JSON.parse(fs.readFileSync(p, "utf8"));
m.modules = [];
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
'
sql_before26="$(sql_count "${A26}/migrations")"
run_sync_cat "${CAT18A}" --app "${A26}"
if [[ "${RUN_EC}" -eq 1 && "${RUN_OUT}" == *"manifest modules must be an object"* \
  && "$(sql_count "${A26}/migrations")" == "${sql_before26}" ]]; then
  pass "26 non-object modules exits 1"
else
  fail_case "26 non-object modules exits 1" \
    "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 27: sets absent is derived once from a canonical header, then appended ---
echo "-- 27 sets migration from header --"
A27="${TMP}/case27"
mkdir -p "${A27}/migrations"
run_sync_cat "${CAT18A}" --app "${A27}" --modules core,flows
if [[ "${RUN_EC}" -ne 0 ]]; then
  fail_case "27 seed" "exit=${RUN_EC}"
fi
KIT_SCHEMA_MANIFEST="${A27}/kit-schema-manifest.json" bun -e '
const fs = require("fs");
const p = process.env.KIT_SCHEMA_MANIFEST;
const m = JSON.parse(fs.readFileSync(p, "utf8"));
delete m.sets;
delete m.modules.plans;
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
'
sql_before27="$(sql_count "${A27}/migrations")"
run_sync_cat "${CAT18B}" --app "${A27}"
sets27="$(KIT_SCHEMA_MANIFEST="${A27}/kit-schema-manifest.json" bun -e '
const m = JSON.parse(require("fs").readFileSync(process.env.KIT_SCHEMA_MANIFEST, "utf8"));
process.stdout.write(Array.isArray(m.sets) && m.sets.includes("flows") ? "yes" : "no");
')"
if [[ "${RUN_EC}" -eq 0 && -f "${A27}/migrations/0003_kit_flows_x.sql" && "${sets27}" == "yes" \
  && "$(sql_count "${A27}/migrations")" == "$((sql_before27 + 1))" ]]; then
  pass "27 header migrates flows into sets and appends flows_x"
else
  fail_case "27 header migrates flows into sets and appends flows_x" \
    "exit=${RUN_EC} sets=${sets27} count=$(sql_count "${A27}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 28: legacy manifest, no sets, unclaimed raw flows file must not exit 0 ---
echo "-- 28 legacy no-sets raw flows --"
A28="${TMP}/case28"
mkdir -p "${A28}/migrations"
copy_sql_range "${A28}/migrations" 1 8
run_sync --app "${A28}" --modules core
if [[ "${RUN_EC}" -ne 0 ]]; then
  fail_case "28 seed core" "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi
cp "${KIT_SQL}/0012_flows_plans_runs.sql" "${A28}/migrations/"
KIT_SCHEMA_MANIFEST="${A28}/kit-schema-manifest.json" bun -e '
const fs = require("fs");
const p = process.env.KIT_SCHEMA_MANIFEST;
const m = JSON.parse(fs.readFileSync(p, "utf8"));
delete m.sets;
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
'
sql_before28="$(sql_count "${A28}/migrations")"
run_sync --app "${A28}"
if [[ "${RUN_EC}" -ne 0 && "${RUN_OUT}" == *"run without --adopt: --modules"* \
  && "${RUN_OUT}" == *"flows"* \
  && "$(sql_count "${A28}/migrations")" == "${sql_before28}" \
  && ! -e "${A28}/migrations/0016_kit_flows_run_approvals.sql" ]]; then
  pass "28 no-sets raw flows file does not exit 0"
else
  fail_case "28 no-sets raw flows file does not exit 0" \
    "exit=${RUN_EC} count=$(sql_count "${A28}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 29: clone synced without --adopt must not exit 0 ---
echo "-- 29 clone without adopt --"
A29="${TMP}/case29"
mkdir -p "${A29}/migrations"
n=1
while [[ $n -le 15 ]]; do
  name="$(printf '%04d' "${n}")"
  cp "${KIT_SQL}/${name}"_*.sql "${A29}/migrations/"
  n=$((n + 1))
done
sql_before29="$(sql_count "${A29}/migrations")"
run_sync --app "${A29}"
if [[ "${RUN_EC}" -ne 0 && ! -f "${A29}/kit-schema-manifest.json" \
  && "$(sql_count "${A29}/migrations")" == "${sql_before29}" \
  && "${RUN_OUT}" == *"flows"* ]]; then
  pass "29 headerless clone without adopt does not exit 0"
else
  fail_case "29 headerless clone without adopt does not exit 0" \
    "exit=${RUN_EC} count=$(sql_count "${A29}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 30: deleted manifest on a raw clone must not rebuild to core ---
echo "-- 30 deleted manifest raw clone --"
A30="${TMP}/case30"
mkdir -p "${A30}/migrations"
n=1
while [[ $n -le 15 ]]; do
  name="$(printf '%04d' "${n}")"
  cp "${KIT_SQL}/${name}"_*.sql "${A30}/migrations/"
  n=$((n + 1))
done
printf '%s\n' '{ "version": 1, "app": "apps/foo-api", "sets": ["core"], "modules": {} }' \
  >"${A30}/kit-schema-manifest.json"
rm -f "${A30}/kit-schema-manifest.json"
sql_before30="$(sql_count "${A30}/migrations")"
run_sync --app "${A30}"
if [[ "${RUN_EC}" -ne 0 && ! -f "${A30}/kit-schema-manifest.json" \
  && "$(sql_count "${A30}/migrations")" == "${sql_before30}" ]]; then
  pass "30 deleted manifest on raw clone does not exit 0"
else
  fail_case "30 deleted manifest on raw clone does not exit 0" \
    "exit=${RUN_EC} count=$(sql_count "${A30}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 31: unknown persisted set name dies ---
echo "-- 31 unknown set name --"
A31="${TMP}/case31"
mkdir -p "${A31}/migrations"
run_sync_cat "${CAT18A}" --app "${A31}" --modules core,flows
if [[ "${RUN_EC}" -ne 0 ]]; then
  fail_case "31 seed" "exit=${RUN_EC}"
fi
KIT_SCHEMA_MANIFEST="${A31}/kit-schema-manifest.json" bun -e '
const fs = require("fs");
const p = process.env.KIT_SCHEMA_MANIFEST;
const m = JSON.parse(fs.readFileSync(p, "utf8"));
m.sets = ["core", "flow"];
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
'
sql_before31="$(sql_count "${A31}/migrations")"
run_sync_cat "${CAT18B}" --app "${A31}"
if [[ "${RUN_EC}" -eq 1 && "${RUN_OUT}" == *"manifest sets names unknown set: flow"* \
  && "$(sql_count "${A31}/migrations")" == "${sql_before31}" \
  && ! -e "${A31}/migrations/0003_kit_flows_x.sql" ]]; then
  pass "31 unknown set name exits 1"
else
  fail_case "31 unknown set name exits 1" \
    "exit=${RUN_EC} count=$(sql_count "${A31}/migrations") out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 32: sets migration from recorded headerless ids ---
echo "-- 32 id migration --"
A32="${TMP}/case32"
mkdir -p "${A32}/migrations"
cp "${KIT_COPY}/${SRC18}/0001_init.sql" "${A32}/migrations/0001_init.sql"
cp "${KIT_COPY}/${SRC18}/0012_plans.sql" "${A32}/migrations/0012_plans.sql"
run_sync_cat "${CAT18A}" --app "${A32}" --modules core,flows
if [[ "${RUN_EC}" -ne 0 || -f "${A32}/migrations/0001_kit_init.sql" ]]; then
  fail_case "32 seed raw" "exit=${RUN_EC} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi
KIT_SCHEMA_MANIFEST="${A32}/kit-schema-manifest.json" bun -e '
const fs = require("fs");
const p = process.env.KIT_SCHEMA_MANIFEST;
const m = JSON.parse(fs.readFileSync(p, "utf8"));
delete m.sets;
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
'
run_sync_cat "${CAT18B}" --app "${A32}"
sets32="$(KIT_SCHEMA_MANIFEST="${A32}/kit-schema-manifest.json" bun -e '
const m = JSON.parse(require("fs").readFileSync(process.env.KIT_SCHEMA_MANIFEST, "utf8"));
process.stdout.write(Array.isArray(m.sets) && m.sets.includes("flows") ? "yes" : "no");
')"
if [[ "${RUN_EC}" -eq 0 && -f "${A32}/migrations/0013_kit_flows_x.sql" && "${sets32}" == "yes" ]]; then
  pass "32 id migration appends flows_x and records flows"
else
  fail_case "32 id migration appends flows_x and records flows" \
    "exit=${RUN_EC} sets=${sets32} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

# --- 33: rewrite keeps unknown keys and the existing app ---
echo "-- 33 manifest merge --"
A33="${TMP}/case33"
mkdir -p "${A33}/migrations"
run_sync_cat "${CAT18A}" --app "${A33}" --modules core
if [[ "${RUN_EC}" -ne 0 ]]; then
  fail_case "33 seed" "exit=${RUN_EC}"
fi
KIT_SCHEMA_MANIFEST="${A33}/kit-schema-manifest.json" bun -e '
const fs = require("fs");
const p = process.env.KIT_SCHEMA_MANIFEST;
const m = JSON.parse(fs.readFileSync(p, "utf8"));
m.$comment = "keep-me";
m.app = "apps/foo-api";
m.modules.init.note = "keep-note";
delete m.sets;
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
'
run_sync_cat "${CAT18A}" --app "${A33}"
kept33="$(KIT_SCHEMA_MANIFEST="${A33}/kit-schema-manifest.json" bun -e '
const m = JSON.parse(require("fs").readFileSync(process.env.KIT_SCHEMA_MANIFEST, "utf8"));
const ok = m.$comment === "keep-me" && m.app === "apps/foo-api" && m.modules.init.note === "keep-note" && Array.isArray(m.sets) && m.sets.includes("core");
process.stdout.write(ok ? "yes" : "no");
')"
if [[ "${RUN_EC}" -eq 0 && "${kept33}" == "yes" ]]; then
  pass "33 rewrite keeps comment, note, and app"
else
  fail_case "33 rewrite keeps comment, note, and app" \
    "exit=${RUN_EC} kept=${kept33} out=$(echo "${RUN_OUT}" | tr '\n' ' ')"
fi

echo "== summary: ${PASS} pass, ${FAIL} fail =="
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
echo "kit-schema-sync: OK"
exit 0
