#!/usr/bin/env bash
# Fail if docs or hooks re-enumerate either canonical lane recipe.
# Both ordered inventories come from their side-effect-free plans. A line or
# wrapped block mentioning a lane and three of its tasks is a copied inventory.
# Hooks and CI must retain both lane invocations and their tooling selector.
#
# Override: BAR_SSOT_ROOT (fixture trees in the self-test).
set -euo pipefail

ROOT="${BAR_SSOT_ROOT:-$(cd "$(dirname "$0")/../.." && pwd -P)}"

FILES=(
  AGENTS.md
  docs/kit/README.md
  docs/kit/standards/stack.md
  docs/kit/processes/dev-process.md
  docs/kit/testing.md
  lefthook.yml
)

THRESHOLD=3

if [[ ! -d "${ROOT}" ]]; then
  echo "check-bar-ssot: missing root ${ROOT}" >&2
  exit 1
fi

PKG="${ROOT}/package.json"
if [[ ! -f "${PKG}" ]]; then
  echo "check-bar-ssot: missing package.json" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "check-bar-ssot: bun is required to parse package.json" >&2
  exit 1
fi

declare -A LANE_TOKENS
for lane in validate:full validate:tooling; do
  TOKEN_ERR="$(mktemp)"
  TOKEN_OUT=""
  TOKEN_EC=0
  set +e
  TOKEN_OUT="$(
    cd "${ROOT}"
    bun run "${lane}" -- --plan 2>"${TOKEN_ERR}" |
      bun -e 'const plan = JSON.parse(await Bun.stdin.text()); if (!Array.isArray(plan.tasks) || !plan.tasks.length) process.exit(1); for (const task of plan.tasks) console.log(task)'
  )"
  TOKEN_EC=$?
  set -e
  if [[ "${TOKEN_EC}" -ne 0 || -z "${TOKEN_OUT}" ]]; then
    echo "check-bar-ssot: cannot read scripts[\"${lane}\"] plan" >&2
    [[ ! -s "${TOKEN_ERR}" ]] || cat "${TOKEN_ERR}" >&2
    rm -f "${TOKEN_ERR}"
    exit 1
  fi
  rm -f "${TOKEN_ERR}"
  LANE_TOKENS["${lane}"]="${TOKEN_OUT}"
done

marker_count() {
  local text="$1" lane="$2"
  local n=0 m
  local padded=" ${text} "
  local -a tokens
  mapfile -t tokens <<< "${LANE_TOKENS[${lane}]}"
  for m in "${tokens[@]}"; do
    [[ -n "${m}" ]] || continue
    case "${padded}" in
      *[!A-Za-z0-9_:-]"${m}"[!A-Za-z0-9_:-]*) n=$((n + 1)) ;;
    esac
  done
  printf '%s' "${n}"
}

# True if this line continues a middot / comma inventory from the previous.
is_list_continuation() {
  local prev="$1"
  local cur="$2"
  local prev_stripped cur_stripped
  prev_stripped="${prev%"${prev##*[![:space:]]}"}"
  cur_stripped="${cur#"${cur%%[![:space:]]*}"}"
  cur_stripped="${cur_stripped#\#}"
  cur_stripped="${cur_stripped#"${cur_stripped%%[![:space:]]*}"}"
  case "${prev_stripped}" in
    *'·' | *',') return 0 ;;
  esac
  case "${cur_stripped}" in
    '·'* | ','*) return 0 ;;
  esac
  return 1
}


# A hook must execute the unflagged full bar. CI may instead invoke the
# substantive join; plan and individual groups are not complete verdicts.
line_invokes_validate_full() {
  local stripped="$1" role="$2"
  [[ "${stripped}" == \#* ]] && return 1
  if [[ "${stripped}" == -* ]]; then
    stripped="${stripped#-}"
    stripped="${stripped#"${stripped%%[![:space:]]*}"}"
  fi
  [[ "${stripped}" == \#* ]] && return 1
  local full='^(run:[[:space:]]*)?bun[[:space:]]+run[[:space:]]+validate:full[[:space:]]*(#.*)?$'
  local join='^(run:[[:space:]]*)?bun[[:space:]]+run[[:space:]]+validate:full[[:space:]]+--[[:space:]]+--ci-join[[:space:]]+[^[:space:]]+[[:space:]]+--producers-result[[:space:]]+[^[:space:]]+[[:space:]]*(#.*)?$'
  [[ "${stripped}" =~ ${full} ]] || { [[ "${role}" == ci ]] && [[ "${stripped}" =~ ${join} ]]; }
}

line_invokes_tooling() {
  local stripped="$1"
  [[ "${stripped}" == \#* ]] && return 1
  if [[ "${stripped}" == -* ]]; then
    stripped="${stripped#-}"
    stripped="${stripped#"${stripped%%[![:space:]]*}"}"
  fi
  [[ "${stripped}" =~ ^(run:[[:space:]]*)?bun[[:space:]]+run[[:space:]]+validate:tooling[[:space:]]*(#.*)?$ ]]
}

line_invokes_selector() {
  local stripped="$1"
  if [[ "${stripped}" == -* ]]; then
    stripped="${stripped#-}"
    stripped="${stripped#"${stripped%%[![:space:]]*}"}"
  fi
  [[ "${stripped}" == \#* ]] && return 1
  [[ "${stripped}" =~ ^(run:[[:space:]]*)?bun[[:space:]]+scripts/kit/select-tooling\.ts([[:space:]]|$) ]]
}

FAIL=0

for rel in "${FILES[@]}"; do
  path="${ROOT}/${rel}"
  if [[ ! -f "${path}" ]]; then
    echo "check-bar-ssot: missing ${rel}" >&2
    FAIL=1
    continue
  fi

  block=""
  block_ln=0
  block_n=0
  ln=0
  flush_block() {
    local text="$1"
    local at="$2"
    local lines="$3"
    local bn lane
    [[ "${lines}" -gt 1 ]] || return 0
    for lane in validate:full validate:tooling; do
      bn="$(marker_count "${text}" "${lane}")"
      if [[ "${bn}" -ge "${THRESHOLD}" && "${text}" == *"${lane}"* ]]; then
        echo "error: ${rel}:${at}: wrapped ${lane} step list belongs in package.json" >&2
        echo "  ${text}" >&2
        FAIL=1
      fi
    done
  }
  while IFS= read -r line || [[ -n "${line}" ]]; do
    ln=$((ln + 1))
    line="${line%$'\r'}"
    for lane in validate:full validate:tooling; do
      n="$(marker_count "${line}" "${lane}")"
      if [[ "${n}" -ge "${THRESHOLD}" && "${line}" == *"${lane}"* ]]; then
        echo "error: ${rel}:${ln}: ${lane} step list belongs in package.json" >&2
        echo "  ${line}" >&2
        FAIL=1
      fi
    done
    if [[ -n "${block}" ]] && is_list_continuation "${block}" "${line}"; then
      block="${block} ${line}"
      block_n=$((block_n + 1))
    else
      flush_block "${block}" "${block_ln}" "${block_n}"
      block="${line}"
      block_ln="${ln}"
      block_n=1
    fi
  done <"${path}"
  flush_block "${block}" "${block_ln}" "${block_n}"
done

LEFTHOOK="${ROOT}/lefthook.yml"
if [[ -f "${LEFTHOOK}" ]]; then
  pre_push="$(awk '
    /^pre-push:[[:space:]]*$/ {grab=1; print; next}
    grab && /^[A-Za-z0-9_-]+:/ {exit}
    grab {print}
  ' "${LEFTHOOK}")"
  found=0 tooling_found=0 selector_found=0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    stripped="${line#"${line%%[![:space:]]*}"}"
    line_invokes_validate_full "${stripped}" hook && found=1
    line_invokes_tooling "${stripped}" && tooling_found=1
    line_invokes_selector "${stripped}" && selector_found=1
  done <<< "${pre_push}"
  if [[ "${found}" -eq 0 || "${tooling_found}" -eq 0 || "${selector_found}" -eq 0 ]]; then
    echo "error: lefthook.yml: pre-push must invoke both lanes and tooling selector" >&2
    FAIL=1
  fi
fi

CI="${ROOT}/.github/workflows/ci.yml"
if [[ -f "${CI}" ]]; then
  found=0 tooling_found=0 selector_found=0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    stripped="${line#"${line%%[![:space:]]*}"}"
    line_invokes_validate_full "${stripped}" ci && found=1
    line_invokes_tooling "${stripped}" && tooling_found=1
    line_invokes_selector "${stripped}" && selector_found=1
  done <"${CI}"
  if [[ "${found}" -eq 0 || "${tooling_found}" -eq 0 || "${selector_found}" -eq 0 ]]; then
    echo "error: .github/workflows/ci.yml: must invoke both lanes and tooling selector" >&2
    FAIL=1
  fi
fi

if [[ "${FAIL}" -ne 0 ]]; then
  echo "check-bar-ssot: FAIL (SSoT is package.json lane recipes)" >&2
  exit 1
fi

echo "check-bar-ssot: OK"
exit 0
