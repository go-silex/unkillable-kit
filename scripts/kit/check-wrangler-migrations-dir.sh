#!/usr/bin/env bash
# Fail if any wrangler config points D1 migrations_dir at packages/*/migrations.
#
# Journal is apps/<api>/migrations (ADR-0008). packages/*/migrations are not the apply path.
# Parse TOML/JSONC with bun (not same-line grep). Unparseable files fail closed.
# Missing packages/ fails (kit CI must see the migrations README tree).
# ROOT override: WRANGLER_MIG_ROOT (fixture trees in the self-test).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="${WRANGLER_MIG_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd -P)}"

if [[ ! -d "${ROOT}" ]]; then
  echo "check-wrangler-migrations-dir: missing root ${ROOT}" >&2
  exit 1
fi

if [[ ! -d "${ROOT}/packages" ]]; then
  echo "check-wrangler-migrations-dir: missing ${ROOT}/packages" >&2
  exit 1
fi
PACKAGES="$(cd "${ROOT}/packages" && pwd -P)"

if ! command -v bun >/dev/null 2>&1; then
  echo "check-wrangler-migrations-dir: bun is required to parse wrangler configs" >&2
  exit 1
fi

# Config discovery is shared with migrations-contract: scripts/kit/lib/wrangler-d1.ts --configs.
CONFIGS="$(bun "${SCRIPT_DIR}/lib/wrangler-d1.ts" --configs "${ROOT}")" || exit 1
FILES=()
FILE_COUNT=0
while IFS= read -r file; do
  if [[ -n "${file}" ]]; then
    FILES[${FILE_COUNT}]="${file}"
    FILE_COUNT=$((FILE_COUNT + 1))
  fi
done <<< "${CONFIGS}"

# Print each migrations_dir string on its own line. Exit non-zero if unparseable.
# One parser for every D1 gate: scripts/kit/lib/wrangler-d1.ts (also used by migrations-contract).
extract_dirs() {
  bun "${SCRIPT_DIR}/lib/wrangler-d1.ts" "$1"
}

FAIL=0
CHECKED=0
ERRF="$(mktemp)"
trap 'rm -f "${ERRF}"' EXIT

for file in "${FILES[@]+"${FILES[@]}"}"; do
  [[ -n "${file:-}" ]] || continue
  config_dir="$(cd "$(dirname -- "${file}")" && pwd -P)"
  case "${config_dir}" in
    "${PACKAGES}"|"${PACKAGES}"/*)
      echo "error: ${file}: wrangler config lives under packages/ (sketch SQL apply path)" >&2
      FAIL=1
      continue
      ;;
  esac
  extract_out=""
  extract_ec=0
  set +e
  extract_out="$(extract_dirs "${file}" 2>"${ERRF}")"
  extract_ec=$?
  set -e
  if [[ "${extract_ec}" -ne 0 ]]; then
    echo "error: ${file}: unparseable wrangler config" >&2
    if [[ -s "${ERRF}" ]]; then
      cat "${ERRF}" >&2
    fi
    FAIL=1
    continue
  fi
  while IFS= read -r raw; do
    [[ -n "${raw}" ]] || continue
    CHECKED=$((CHECKED + 1))
    if ! resolved="$(bun "${SCRIPT_DIR}/lib/wrangler-d1.ts" --resolve "${config_dir}" "${raw}")"; then
      echo "error: ${file}: cannot resolve migrations_dir=${raw}" >&2
      FAIL=1
      continue
    fi
    case "${resolved}" in
      "${PACKAGES}"|"${PACKAGES}"/*)
        echo "error: ${file}: migrations_dir=${raw} resolves to ${resolved}" >&2
        echo "  packages/*/migrations are not the apply path — journal is apps/<api>/migrations (ADR-0008)" >&2
        FAIL=1
        ;;
    esac
  done <<< "${extract_out}"
done

if [[ "${FAIL}" -ne 0 ]]; then
  echo "check-wrangler-migrations-dir: FAIL" >&2
  exit 1
fi

echo "check-wrangler-migrations-dir: OK (${FILE_COUNT} wrangler files, ${CHECKED} migrations_dir)"
exit 0
