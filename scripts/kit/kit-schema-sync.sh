#!/usr/bin/env bash
# Append missing kit D1 schema modules into a product app migrations/ folder.
# Identity is catalog id + sha256(source bytes). Product filenames stay local.
# Never rewrite applied SQL; never copy kit NNNN onto a product NNNN.
#
# usage: kit-schema-sync.sh --app <apps/foo-api> [--modules core|all|<comma-sets>] [--adopt] [--dry-run]
# Omitted --modules selects core,audit for a new manifest; existing manifests
# retain core ∪ recorded sets. `sets` is written on first sync, explicit selection
# and --adopt, and migrated once from recorded ids and canonical headers when
# absent. Opt out by deleting a set from `sets`. An explicit list that omits a recorded set with new catalog ids
# exits 1 and names those ids. --adopt names unclaimed files of an unselected set.
set -euo pipefail
shopt -s nullglob

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
KIT_SCHEMA_LIB="$(cd "$(dirname "$0")" && pwd -P)/lib"
# shellcheck source=lib/kit-apps.sh
source "${KIT_SCHEMA_LIB}/kit-apps.sh"
CATALOG="${KIT_SCHEMA_CATALOG:-${ROOT}/config/kit/kit-schema-modules.json}"

die() {
  echo "kit-schema-sync: $*" >&2
  exit 1
}

usage() {
  echo "usage: kit-schema-sync.sh --app <apps/foo-api> [--modules core|all|<comma-sets>] [--adopt] [--dry-run]" >&2
}

file_sha256() {
  local f="$1"
  local out
  if command -v sha256sum >/dev/null 2>&1; then
    out="$(sha256sum -- "$f")" || return 1
  elif command -v shasum >/dev/null 2>&1; then
    out="$(shasum -a 256 -- "$f")" || return 1
  else
    die "need sha256sum or shasum -a 256"
  fi
  printf '%s' "${out%% *}" | tr 'A-F' 'a-f'
}

# Hash kit-source bytes: headed files must be exactly 4 comment lines + blank + body.
# One definition shared with check-migrations-contract.ts: scripts/kit/lib/kit-schema-payload.ts.
payload_sha256() {
  bun "${KIT_SCHEMA_LIB}/kit-schema-payload.ts" "$1"
}

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

require_bun() {
  if ! command -v bun >/dev/null 2>&1; then
    die "bun is required to read/write JSON"
  fi
}

# --- CLI ---
APP_ARG=""
MODULES="core"
MODULES_EXPLICIT=0
ADOPT=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      [[ $# -ge 2 ]] || die "missing value for --app"
      APP_ARG="$2"
      shift 2
      ;;
    --modules)
      [[ $# -ge 2 ]] || die "missing value for --modules"
      MODULES="$2"
      MODULES_EXPLICIT=1
      shift 2
      ;;
    --adopt)
      ADOPT=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown argument: $1"
      ;;
  esac
done

if [[ -z "${APP_ARG}" ]]; then
  usage
  die "--app is required"
fi

require_bun
[[ -f "${CATALOG}" ]] || die "missing catalog ${CATALOG}"

# --- resolve app dir (cwd, then kit root); store --app as given ---
APP_DIR=""
if [[ "${APP_ARG}" == /* ]]; then
  APP_DIR="${APP_ARG}"
elif [[ -d "${APP_ARG}" ]]; then
  APP_DIR="$(cd "${APP_ARG}" && pwd -P)"
elif [[ -d "${ROOT}/${APP_ARG}" ]]; then
  APP_DIR="$(cd "${ROOT}/${APP_ARG}" && pwd -P)"
fi
[[ -n "${APP_DIR}" && -d "${APP_DIR}" ]] || die "app directory not found: ${APP_ARG}"
APP_DIR="$(cd "${APP_DIR}" && pwd -P)"

# A kit app's migrations are the applied SSoT: never sync into one (kit apps: lib/kit-apps.sh, Roxabi/roxabi-boilerplate-cf#318).
kit_apps="$(kit_app_names "${ROOT}/config/kit/zero-edit-zones.json")" ||
  die "cannot read the kit apps from config/kit/zero-edit-zones.json"
while IFS= read -r app; do
  case "${APP_DIR}/" in
    "${ROOT}/apps/${app}/"*)
      die "refuse kit app apps/${app} (applied SSoT)"
      ;;
  esac
done <<<"${kit_apps}"

MIG_DIR="${APP_DIR}/migrations"
MANIFEST="${APP_DIR}/kit-schema-manifest.json"

# --- catalog ---
SOURCE_ROOT=""
MODULE_IDS=()
MODULE_FILES=()
MODULE_SETS=()
MODULE_PINS=()
declare -A VALID_SET=()
declare -A CAT_BASENAME=()
declare -A ID_SET=()
declare -A ID_PIN=()

CATALOG_TSV="$(
  KIT_SCHEMA_CATALOG="${CATALOG}" bun -e '
const fs = require("fs");
const p = process.env.KIT_SCHEMA_CATALOG;
let data;
try { data = JSON.parse(fs.readFileSync(p, "utf8")); }
catch { console.error("kit-schema-sync: invalid catalog JSON"); process.exit(1); }
if (data.version !== 1) { console.error("kit-schema-sync: catalog version must be 1"); process.exit(1); }
if (typeof data.source_root !== "string" || !data.source_root) {
  console.error("kit-schema-sync: catalog source_root required"); process.exit(1);
}
if (data.source_root.includes("..") || data.source_root.startsWith("/") || data.source_root.includes("\t") || data.source_root.includes("\n")) {
  console.error("kit-schema-sync: invalid catalog source_root"); process.exit(1);
}
if (!Array.isArray(data.modules)) {
  console.error("kit-schema-sync: catalog modules must be an array"); process.exit(1);
}
const seen = new Set();
const seenFile = new Set();
console.log("#SOURCE_ROOT\t" + data.source_root);
for (const m of data.modules) {
  if (!m || typeof m.id !== "string" || typeof m.file !== "string" || typeof m.set !== "string" || typeof m.kitSha256 !== "string") {
    console.error("kit-schema-sync: catalog module requires id, file, set, kitSha256"); process.exit(1);
  }
  if (!/^[A-Za-z0-9_]+$/.test(m.id)) {
    console.error("kit-schema-sync: invalid module id: " + m.id); process.exit(1);
  }
  if (!/^[A-Za-z0-9_]+$/.test(m.set)) {
    console.error("kit-schema-sync: invalid module set: " + m.set); process.exit(1);
  }
  if (!/^[0-9]{4}_[A-Za-z0-9_.-]+\.sql$/.test(m.file) || m.file.includes("..")) {
    console.error("kit-schema-sync: invalid catalog file: " + m.file); process.exit(1);
  }
  if (!/^[0-9a-f]{64}$/.test(m.kitSha256)) {
    console.error("kit-schema-sync: invalid kitSha256 for " + m.id); process.exit(1);
  }
  if (seen.has(m.id)) {
    console.error("kit-schema-sync: duplicate module id: " + m.id); process.exit(1);
  }
  if (seenFile.has(m.file)) {
    console.error("kit-schema-sync: duplicate catalog file: " + m.file); process.exit(1);
  }
  seen.add(m.id);
  seenFile.add(m.file);
  console.log([m.id, m.file, m.set, m.kitSha256].join("\t"));
}
'
)" || die "invalid catalog JSON"

while IFS=$'\t' read -r col1 col2 col3 col4; do
  if [[ "${col1}" == "#SOURCE_ROOT" ]]; then
    SOURCE_ROOT="${col2}"
    continue
  fi
  [[ -n "${col1}" ]] || continue
  MODULE_IDS+=("${col1}")
  MODULE_FILES+=("${col2}")
  MODULE_SETS+=("${col3}")
  MODULE_PINS+=("${col4}")
  VALID_SET["${col3}"]=1
  CAT_BASENAME["${col2}"]=1
  ID_SET["${col1}"]="${col3}"
  ID_PIN["${col1}"]="${col4}"
done <<< "${CATALOG_TSV}"$'\n'

[[ -n "${SOURCE_ROOT}" ]] || die "catalog source_root missing"
[[ ${#MODULE_IDS[@]} -gt 0 ]] || die "catalog has no modules"

SOURCE_DIR="${ROOT}/${SOURCE_ROOT}"
[[ -d "${SOURCE_DIR}" ]] || die "missing kit source_root ${SOURCE_ROOT}"

for f in "${SOURCE_DIR}"/*.sql; do
  base="${f##*/}"
  if [[ -z "${CAT_BASENAME[$base]+x}" ]]; then
    die "uncatalogued kit SQL ${SOURCE_ROOT}/${base}"
  fi
done

# --- --modules filter ---
SELECT_ALL=0
declare -A WANT_SET=()
IFS=',' read -ra MODULE_PARTS <<< "${MODULES}"
for raw in "${MODULE_PARTS[@]}"; do
  part="$(trim "${raw}")"
  [[ -n "${part}" ]] || continue
  if [[ "${part}" == "all" ]]; then
    SELECT_ALL=1
  else
    WANT_SET["${part}"]=1
  fi
done
if [[ "${SELECT_ALL}" -eq 0 && ${#WANT_SET[@]} -eq 0 ]]; then
  die "--modules is empty"
fi
for s in "${!WANT_SET[@]}"; do
  if [[ -z "${VALID_SET[$s]+x}" ]]; then
    die "unknown module set: ${s}"
  fi
done

selected() {
  local set="$1"
  if [[ "${SELECT_ALL}" -eq 1 ]]; then
    return 0
  fi
  [[ -n "${WANT_SET[$set]+x}" ]]
}

# --- existing manifest ---
declare -A MANIFEST_SHA=()
declare -A MANIFEST_FILE=()
declare -A PERSISTED_SETS=()
SETS_PRESENT=0
SETS_DIRTY=0
MANIFEST_EXISTS=0
if [[ -f "${MANIFEST}" ]]; then
  MANIFEST_EXISTS=1
  MANIFEST_TSV="$(
    KIT_SCHEMA_MANIFEST="${MANIFEST}" bun -e '
const fs = require("fs");
const p = process.env.KIT_SCHEMA_MANIFEST;
let data;
try { data = JSON.parse(fs.readFileSync(p, "utf8")); }
catch { console.error("kit-schema-sync: invalid manifest JSON"); process.exit(1); }
if (data.version !== 1) { console.error("kit-schema-sync: manifest version must be 1"); process.exit(1); }
const idRe = /^[A-Za-z0-9_]+$/;
const shaRe = /^[0-9a-f]{64}$/;
const fileRe = /^migrations\/[0-9]{4}_[A-Za-z0-9_.-]+\.sql$/;
const mods = data.modules;
if (!mods || typeof mods !== "object" || Array.isArray(mods)) {
  console.error("kit-schema-sync: manifest modules must be an object"); process.exit(1);
}
if (!Object.prototype.hasOwnProperty.call(data, "sets")) {
  console.log("#NOSETS");
} else if (!Array.isArray(data.sets) || data.sets.some((s) => typeof s !== "string" || !idRe.test(s))) {
  console.error("kit-schema-sync: manifest sets must be an array of set ids"); process.exit(1);
} else {
  console.log("#SETS\t" + data.sets.join(","));
}
for (const [id, v] of Object.entries(mods)) {
  if (!idRe.test(id)) {
    console.error("kit-schema-sync: invalid manifest id: " + id); process.exit(1);
  }
  if (!v || typeof v.kitSha256 !== "string" || typeof v.productFile !== "string") {
    console.error("kit-schema-sync: invalid manifest entry: " + id); process.exit(1);
  }
  if (!shaRe.test(v.kitSha256)) {
    console.error("kit-schema-sync: invalid manifest kitSha256: " + id); process.exit(1);
  }
  if (!fileRe.test(v.productFile) || v.productFile.includes("..")) {
    console.error("kit-schema-sync: invalid manifest productFile: " + id); process.exit(1);
  }
  console.log([id, v.kitSha256, v.productFile].join("\t"));
}
'
  )" || die "invalid manifest JSON"
  while IFS=$'\t' read -r mid msha mfile; do
    [[ -n "${mid}" ]] || continue
    if [[ "${mid}" == "#NOSETS" ]]; then
      SETS_PRESENT=0
      continue
    fi
    if [[ "${mid}" == "#SETS" ]]; then
      SETS_PRESENT=1
      if [[ -n "${msha}" ]]; then
        IFS=',' read -ra set_parts <<< "${msha}"
        for raw_set in "${set_parts[@]}"; do
          [[ -n "${raw_set}" ]] || continue
          PERSISTED_SETS["${raw_set}"]=1
        done
      fi
      continue
    fi
    MANIFEST_SHA["${mid}"]="${msha}"
    MANIFEST_FILE["${mid}"]="${mfile}"
  done <<< "${MANIFEST_TSV}"$'\n'
fi
if [[ "${SETS_PRESENT}" -eq 1 && ${#PERSISTED_SETS[@]} -gt 0 ]]; then
  while IFS= read -r raw_set; do
    [[ -n "${raw_set}" ]] || continue
    if [[ -z "${VALID_SET[$raw_set]+x}" ]]; then
      die "manifest sets names unknown set: ${raw_set}"
    fi
  done < <(printf '%s\n' "${!PERSISTED_SETS[@]}" | LC_ALL=C sort)
fi


list_sql_files() {
  local dir="$1"
  local f
  local files=()
  for f in "${dir}"/*.sql; do
    files+=("$f")
  done
  if [[ ${#files[@]} -eq 0 ]]; then
    return 0
  fi
  printf '%s\n' "${files[@]}" | LC_ALL=C sort
}

max_migration_prefix() {
  local dir="$1"
  local max=0 base n f
  for f in "${dir}"/*.sql; do
    base="${f##*/}"
    if [[ "${base}" =~ ^([0-9]{4})_ ]]; then
      n=$((10#${BASH_REMATCH[1]}))
      # Kit band is 0001–0999. Product domain at 1000+ must not occupy kit slots.
      if ((n <= 999 && n > max)); then
        max=$n
      fi
    fi
  done
  printf '%s' "${max}"
}

rel_sql() {
  local abs="$1"
  printf 'migrations/%s' "${abs##*/}"
}

declare -A CLAIMED=()
claim() {
  local rel="$1"
  [[ -n "${rel}" ]] || return 0
  CLAIMED["${rel}"]=1
}

is_claimed() {
  local rel="$1"
  [[ -n "${CLAIMED[$rel]+x}" ]]
}

# Sets MATCH to the path. Return 0 found, 1 not found. Fatals die in this shell.
find_sql_by_sha() {
  local want="$1"
  local f sha rel list
  MATCH=""
  list="$(list_sql_files "${MIG_DIR}")" || die "failed to list ${MIG_DIR}"
  while IFS= read -r f; do
    [[ -n "${f}" ]] || continue
    rel="$(rel_sql "${f}")"
    if is_claimed "${rel}"; then
      continue
    fi
    sha="$(file_sha256 "${f}")" || die "sha256 failed for ${f}"
    if [[ "${sha}" == "${want}" ]]; then
      MATCH="${f}"
      return 0
    fi
  done <<< "${list}"$'\n'
  return 1
}

# Bind any unclaimed -- kit-schema: ${id} file. Payload miss → die (never append).
find_sql_by_header() {
  local id="$1"
  local want="$2"
  local f line1 line2 rel list payload
  MATCH=""
  list="$(list_sql_files "${MIG_DIR}")" || die "failed to list ${MIG_DIR}"
  while IFS= read -r f; do
    [[ -n "${f}" ]] || continue
    rel="$(rel_sql "${f}")"
    if is_claimed "${rel}"; then
      continue
    fi
    {
      IFS= read -r line1 || true
      IFS= read -r line2 || true
    } <"${f}"
    line1="${line1%$'\r'}"
    line2="${line2%$'\r'}"
    if [[ "${line1}" != "-- kit-schema: ${id}" ]]; then
      continue
    fi
    payload="$(payload_sha256 "${f}")" || die "headed ${id} is not a canonical kit header (${rel})"
    if [[ "${line2}" == "-- kit-sha256: ${want}" && "${payload}" == "${want}" ]]; then
      MATCH="${f}"
      return 0
    fi
    die "headed ${id} drifted; not rewriting ${rel}"
  done <<< "${list}"$'\n'
  return 1
}

for mid in "${!MANIFEST_FILE[@]}"; do
  claim "${MANIFEST_FILE[$mid]}"
done

remember_set() {
  local s="$1"
  [[ -n "${s}" ]] || return 0
  if [[ -z "${PERSISTED_SETS[$s]+x}" ]]; then
    SETS_DIRTY=1
  fi
  PERSISTED_SETS["${s}"]=1
}

has_headed_sql() {
  local f line
  [[ -d "${MIG_DIR}" ]] || return 1
  for f in "${MIG_DIR}"/*.sql; do
    [[ -f "${f}" ]] || continue
    IFS= read -r line <"${f}" || true
    line="${line%$'\r'}"
    [[ "${line}" == "-- kit-schema: "* ]] && return 0
  done
  return 1
}

if [[ "${MANIFEST_EXISTS}" -eq 0 ]] && has_headed_sql; then
  die "manifest missing while kit-schema headed files exist; not rebuilding to core"
fi

# sets absent: derive once from recorded catalog ids and canonical headers, then write.
if [[ "${MANIFEST_EXISTS}" -eq 1 && "${SETS_PRESENT}" -eq 0 ]]; then
  SETS_DIRTY=1
  PERSISTED_SETS["core"]=1
  if [[ ${#MANIFEST_SHA[@]} -gt 0 ]]; then
    for mid in "${!MANIFEST_SHA[@]}"; do
      if [[ -n "${ID_SET[$mid]+x}" ]]; then
        PERSISTED_SETS["${ID_SET[$mid]}"]=1
      fi
    done
  fi
  if [[ -d "${MIG_DIR}" ]]; then
    for f in "${MIG_DIR}"/*.sql; do
      [[ -f "${f}" ]] || continue
      IFS= read -r line <"${f}" || true
      line="${line%$'\r'}"
      [[ "${line}" == "-- kit-schema: "* ]] || continue
      hid="${line#-- kit-schema: }"
      [[ "${hid}" =~ ^[A-Za-z0-9_]+$ ]] || die "invalid kit-schema header in ${f##*/}"
      if [[ -z "${ID_SET[$hid]+x}" ]]; then
        continue
      fi
      payload="$(payload_sha256 "${f}")" || die "headed ${hid} is not a canonical kit header (${f##*/})"
      if [[ "${payload}" != "${ID_PIN[$hid]}" ]]; then
        die "headed ${hid} drifted; not rewriting ${f##*/}"
      fi
      PERSISTED_SETS["${ID_SET[$hid]}"]=1
    done
  fi
fi

if [[ "${MODULES_EXPLICIT}" -eq 1 || "${ADOPT}" -eq 1 ]]; then
  if [[ "${SELECT_ALL}" -eq 1 ]]; then
    for s in "${!VALID_SET[@]}"; do
      remember_set "${s}"
    done
  else
    for s in "${!WANT_SET[@]}"; do
      remember_set "${s}"
    done
  fi
fi

if [[ "${MODULES_EXPLICIT}" -eq 0 ]]; then
  if [[ "${MANIFEST_EXISTS}" -eq 0 ]]; then
    [[ -n "${VALID_SET[audit]+x}" ]] || die "catalog has no audit set"
    WANT_SET["audit"]=1
    remember_set "core"
    remember_set "audit"
  fi
  WANT_SET["core"]=1
  if [[ ${#PERSISTED_SETS[@]} -gt 0 ]]; then
    for s in "${!PERSISTED_SETS[@]}"; do
      WANT_SET["${s}"]=1
    done
  fi
fi

if [[ "${MODULES_EXPLICIT}" -eq 1 && "${SELECT_ALL}" -eq 0 ]]; then
  declare -A OPTED_SET=()
  OPTED_SET["core"]=1
  if [[ ${#PERSISTED_SETS[@]} -gt 0 ]]; then
    for s in "${!PERSISTED_SETS[@]}"; do
      OPTED_SET["${s}"]=1
    done
  fi
  omitted_ids=()
  oi=0
  while [[ $oi -lt ${#MODULE_IDS[@]} ]]; do
    oid="${MODULE_IDS[$oi]}"
    oset="${MODULE_SETS[$oi]}"
    oi=$((oi + 1))
    [[ -n "${OPTED_SET[$oset]+x}" ]] || continue
    [[ -n "${WANT_SET[$oset]+x}" ]] && continue
    [[ -z "${MANIFEST_SHA[$oid]+x}" ]] || continue
    omitted_ids+=("${oid}")
  done
  if [[ ${#omitted_ids[@]} -gt 0 ]]; then
    die "opted-in set omitted from --modules; catalog ids not in manifest: ${omitted_ids[*]}"
  fi
fi

PLAN_KIND=()
PLAN_ID=()
PLAN_SHA=()
PLAN_REL=()
PLAN_KIT=()
PLAN_SRC_REL=()
ADOPT_SKIP=()

next_n="$(max_migration_prefix "${MIG_DIR}")"

i=0
while [[ $i -lt ${#MODULE_IDS[@]} ]]; do
  id="${MODULE_IDS[$i]}"
  file="${MODULE_FILES[$i]}"
  set_name="${MODULE_SETS[$i]}"
  pin="${MODULE_PINS[$i]}"
  i=$((i + 1))

  selected "${set_name}" || continue

  kit_file="${ROOT}/${SOURCE_ROOT}/${file}"
  [[ -f "${kit_file}" ]] || die "missing kit source ${SOURCE_ROOT}/${file}"
  kit_sha="$(file_sha256 "${kit_file}")"
  if [[ "${kit_sha}" != "${pin}" ]]; then
    die "catalog pin mismatch ${id}: live ${kit_sha} != ${pin}"
  fi
  src_rel="${SOURCE_ROOT}/${file}"

  if [[ -n "${MANIFEST_SHA[$id]+x}" && "${MANIFEST_SHA[$id]}" == "${kit_sha}" ]]; then
    rec_rel="${MANIFEST_FILE[$id]}"
    rec_path="${APP_DIR}/${rec_rel}"
    [[ -f "${rec_path}" ]] || die "recorded ${id} missing ${rec_rel}"
    rec_payload="$(payload_sha256 "${rec_path}")" || die "recorded ${id} is not a readable payload ${rec_rel}"
    if [[ "${rec_payload}" != "${kit_sha}" ]]; then
      die "recorded ${id} body drifted; not rewriting ${rec_rel}"
    fi
    continue
  fi

  if [[ -z "${MANIFEST_SHA[$id]+x}" ]]; then
    MATCH=""
    if find_sql_by_sha "${kit_sha}"; then
      match="${MATCH}"
      rel="$(rel_sql "${match}")"
      PLAN_KIND+=("record")
      PLAN_ID+=("${id}")
      PLAN_SHA+=("${kit_sha}")
      PLAN_REL+=("${rel}")
      PLAN_KIT+=("")
      PLAN_SRC_REL+=("${src_rel}")
      claim "${rel}"
      continue
    fi
    MATCH=""
    if find_sql_by_header "${id}" "${kit_sha}"; then
      match="${MATCH}"
      rel="$(rel_sql "${match}")"
      PLAN_KIND+=("record")
      PLAN_ID+=("${id}")
      PLAN_SHA+=("${kit_sha}")
      PLAN_REL+=("${rel}")
      PLAN_KIT+=("")
      PLAN_SRC_REL+=("${src_rel}")
      claim "${rel}"
      continue
    fi
    if [[ "${ADOPT}" -eq 1 ]]; then
      echo "kit-schema-sync: skip ${id} (not present)" >&2
      ADOPT_SKIP+=("${id}")
      continue
    fi
    next_n=$((next_n + 1))
    if ((next_n > 999)); then
      die "kit migration band overflow (0001-0999)"
    fi
    nnnn="$(printf '%04d' "${next_n}")"
    rel="migrations/${nnnn}_kit_${id}.sql"
    dest="${MIG_DIR}/${nnnn}_kit_${id}.sql"
    if [[ -e "${dest}" ]]; then
      die "refusing to overwrite existing ${rel}"
    fi
    PLAN_KIND+=("write")
    PLAN_ID+=("${id}")
    PLAN_SHA+=("${kit_sha}")
    PLAN_REL+=("${rel}")
    PLAN_KIT+=("${kit_file}")
    PLAN_SRC_REL+=("${src_rel}")
    claim "${rel}"
    continue
  fi

  die "module ${id} mutated; add a new module id, never edit applied SQL"
done

if [[ "${ADOPT}" -eq 1 || "${MANIFEST_EXISTS}" -eq 0 || "${SETS_PRESENT}" -eq 0 ]]; then
  if [[ -d "${MIG_DIR}" ]]; then
  declare -A UNSEL_SET=()
  unsel_files=()
  for f in "${MIG_DIR}"/*.sql; do
    [[ -f "${f}" ]] || continue
    rel="$(rel_sql "${f}")"
    if is_claimed "${rel}"; then
      continue
    fi
    sha="$(file_sha256 "${f}")" || die "sha256 failed for ${f}"
    matched_set=""
    i=0
    while [[ $i -lt ${#MODULE_IDS[@]} ]]; do
      if [[ "${sha}" == "${MODULE_PINS[$i]}" ]]; then
        matched_set="${MODULE_SETS[$i]}"
        break
      fi
      i=$((i + 1))
    done
    IFS= read -r line <"${f}" || true
    line="${line%$'\r'}"
    if [[ "${line}" == "-- kit-schema: "* ]]; then
      hid="${line#-- kit-schema: }"
      if [[ "${hid}" =~ ^[A-Za-z0-9_]+$ && -n "${ID_SET[$hid]+x}" ]]; then
        payload="$(payload_sha256 "${f}")" || die "headed ${hid} is not a canonical kit header (${rel})"
        if [[ "${payload}" != "${ID_PIN[$hid]}" ]]; then
          die "headed ${hid} drifted; not rewriting ${rel}"
        fi
        matched_set="${ID_SET[$hid]}"
      fi
    fi
    if [[ -n "${matched_set}" ]] && ! selected "${matched_set}"; then
      UNSEL_SET["${matched_set}"]=1
      unsel_files+=("${rel}")
    fi
  done
  if [[ ${#UNSEL_SET[@]} -gt 0 ]]; then
    declare -A HINT_SET=()
    HINT_SET["core"]=1
    for s in "${!WANT_SET[@]}"; do
      HINT_SET["${s}"]=1
    done
    for s in "${!UNSEL_SET[@]}"; do
      HINT_SET["${s}"]=1
    done
    unsel_names="$(printf '%s\n' "${!UNSEL_SET[@]}" | LC_ALL=C sort | paste -sd, -)"
    hint_names="$(printf '%s\n' "${!HINT_SET[@]}" | LC_ALL=C sort | paste -sd, -)"
    die "unclaimed catalog files for unselected set ${unsel_names}: ${unsel_files[*]}; --adopt cannot append a missing id of a partial set; run without --adopt: --modules ${hint_names}"
  fi
  fi
fi


if [[ ${#ADOPT_SKIP[@]} -gt 0 ]]; then
  die "adopt unmatched: ${ADOPT_SKIP[*]}"
fi

write_manifest() {
  local tmp id cid in_catalog rows
  mkdir -p "$(dirname -- "${MANIFEST}")"
  tmp="$(mktemp "${MANIFEST}.XXXXXX")"
  rows="$(mktemp "${MANIFEST}.rows.XXXXXX")"
  for id in "${MODULE_IDS[@]}"; do
    if [[ -n "${MANIFEST_SHA[$id]+x}" ]]; then
      printf '%s\t%s\t%s\n' "${id}" "${MANIFEST_SHA[$id]}" "${MANIFEST_FILE[$id]}"
    fi
  done >"${rows}"
  for id in "${!MANIFEST_SHA[@]}"; do
    in_catalog=0
    for cid in "${MODULE_IDS[@]}"; do
      if [[ "${cid}" == "${id}" ]]; then
        in_catalog=1
        break
      fi
    done
    if [[ "${in_catalog}" -eq 0 ]]; then
      printf '%s\t%s\t%s\n' "${id}" "${MANIFEST_SHA[$id]}" "${MANIFEST_FILE[$id]}" >>"${rows}"
    fi
  done
  sets_csv=""
  if [[ ${#PERSISTED_SETS[@]} -gt 0 ]]; then
    sets_csv="$(printf '%s\n' "${!PERSISTED_SETS[@]}" | sort | paste -sd, -)"
  fi
  if ! KIT_SCHEMA_APP="${APP_ARG}" KIT_SCHEMA_ROWS="${rows}" KIT_SCHEMA_TMP="${tmp}" KIT_SCHEMA_SETS="${sets_csv}" KIT_SCHEMA_MANIFEST="${MANIFEST}" bun -e '
const fs = require("fs");
const manifestPath = process.env.KIT_SCHEMA_MANIFEST || "";
let base = { version: 1, modules: {} };
if (manifestPath && fs.existsSync(manifestPath)) {
  try { base = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
  catch { base = { version: 1, modules: {} }; }
}
if (!base || typeof base !== "object" || Array.isArray(base)) base = { version: 1, modules: {} };
if (typeof base.app !== "string" || !base.app) base.app = process.env.KIT_SCHEMA_APP;
base.version = 1;
const prevModules = base.modules && typeof base.modules === "object" && !Array.isArray(base.modules) ? base.modules : {};
const modules = {};
const rowsRaw = fs.readFileSync(process.env.KIT_SCHEMA_ROWS, "utf8").trim();
if (rowsRaw) {
  for (const line of rowsRaw.split("\n")) {
    const [id, kitSha256, productFile] = line.split("\t");
    const prev = prevModules[id] && typeof prevModules[id] === "object" && !Array.isArray(prevModules[id]) ? prevModules[id] : {};
    modules[id] = Object.assign({}, prev, { kitSha256, productFile });
  }
}
base.modules = modules;
base.sets = process.env.KIT_SCHEMA_SETS ? process.env.KIT_SCHEMA_SETS.split(",") : [];
fs.writeFileSync(process.env.KIT_SCHEMA_TMP, JSON.stringify(base, null, 2) + "\n");
'; then
    rm -f -- "${tmp}" "${rows}"
    die "manifest write failed"
  fi
  mv -f "${tmp}" "${MANIFEST}"
  rm -f -- "${rows}"
}

write_module_file() {
  local dest="$1"
  local id="$2"
  local sha="$3"
  local src_rel="$4"
  local kit_file="$5"
  local tmp
  tmp="${dest}.tmp.$$"
  {
    printf -- '-- kit-schema: %s\n' "${id}"
    printf -- '-- kit-sha256: %s\n' "${sha}"
    printf -- '-- kit-source: %s\n' "${src_rel}"
    printf -- '-- Do not edit this file. Kit changes ship as a new module id.\n'
    printf '\n'
    cat "${kit_file}"
  } >"${tmp}"
  mv -f "${tmp}" "${dest}"
}

if [[ ${#PLAN_KIND[@]} -eq 0 ]]; then
  if [[ "${SETS_DIRTY}" -eq 1 && "${DRY_RUN}" -eq 0 ]]; then
    write_manifest
  fi
  exit 0
fi

changed=0
idx=0
while [[ $idx -lt ${#PLAN_KIND[@]} ]]; do
  kind="${PLAN_KIND[$idx]}"
  id="${PLAN_ID[$idx]}"
  sha="${PLAN_SHA[$idx]}"
  rel="${PLAN_REL[$idx]}"
  kit_file="${PLAN_KIT[$idx]}"
  src_rel="${PLAN_SRC_REL[$idx]}"
  idx=$((idx + 1))

  echo "kit-schema-sync: ${kind} ${rel}"

  if [[ "${kind}" == "write" ]]; then
    if [[ "${DRY_RUN}" -eq 0 ]]; then
      mkdir -p "${MIG_DIR}"
      write_module_file "${MIG_DIR}/${rel#migrations/}" "${id}" "${sha}" "${src_rel}" "${kit_file}"
      MANIFEST_SHA["${id}"]="${sha}"
      MANIFEST_FILE["${id}"]="${rel}"
      changed=1
    fi
    continue
  fi

  if [[ "${DRY_RUN}" -eq 0 ]]; then
    MANIFEST_SHA["${id}"]="${sha}"
    MANIFEST_FILE["${id}"]="${rel}"
    changed=1
  fi
done

if [[ "${DRY_RUN}" -eq 1 ]]; then
  exit 0
fi

if [[ "${changed}" -eq 1 || "${SETS_DIRTY}" -eq 1 ]]; then
  write_manifest
fi

exit 0
