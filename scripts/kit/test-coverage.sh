#!/usr/bin/env bash
# Run Vitest coverage for all kit packages/apps with thresholds.
# HTML + json-summary → coverage/<name>/
#
# The set of workspaces is DISCOVERED from the root package.json `workspaces`
# globs: every workspace declaring a `test:coverage` script is part of the bar.
# The order tables only fix the RUN ORDER (risk tiers) — they are never the
# source of truth for membership. Any divergence between the discovered set and
# the declared tiers is a hard failure, so no package can silently enter or
# leave the bar without an explicit, reviewed declaration of its risk tier.
#
# Two declaration sites, same rules:
#   - kit tiers: the COVERAGE_* arrays below (kit workspaces only).
#   - product tiers: config/product/coverage-order.txt, one `<tier> <workspace>`
#     per line (`#` comments), tier = high | medium | lower. The file is read
#     in every mode (product repo or kit-mode clone alike, no inheritance marker
#     needed) and lives in the product namespace, so adding a workspace never
#     edits this kit file. Run order = kit high, product high, kit medium,
#     product medium, kit lower, product lower.
# A discovered workspace in neither place, a stale entry, a duplicate (also
# across the two sites), an unknown tier or a malformed line all fail. There is
# deliberately no auto-append: an undeclared workspace never lands in a tier by
# default.
#
# COVERAGE_LIST_ONLY=1 prints the resolved order and exits 0 without running
# Vitest or touching coverage/ (verification seam).
#
# COVERAGE_LIST_KIT=1 prints the kit tiers alone (COVERAGE_HIGH, COVERAGE_MEDIUM,
# COVERAGE_LOWER in that order, one per line) and exits 0 before the extension
# file is read or any workspace is discovered: product entries never appear and
# nothing is reconciled. The coverage-order self-test builds its fixtures from
# it (verification seam).
#
# COVERAGE_ONLY=<workspace> keeps a single already-resolved workspace. The Root
# gate sets it only through --ci-coverage-shard. It cannot execute the full gate.
#
# COVERAGE_CHANGED_BASE=<git-ref> narrows the printed or local run to changed
# apps when every changed path is under apps/<name>/. A package path, a root
# path, an empty diff or an unreadable ref keeps or refuses the full bar; it
# never drops the bar silently. This mode cannot execute the Root gate.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

SELF="scripts/kit/test-coverage.sh"
EXT_FILE="config/product/coverage-order.txt"

# Run order only — membership is discovered, not declared here. Kit workspaces
# only: product workspaces go in $EXT_FILE.
# High bar — backend / security-critical
COVERAGE_HIGH=(
  packages/auth
  packages/core
  apps/starter-api
  apps/example-api
)

# Medium — small pure packages
COVERAGE_MEDIUM=(
  packages/storage
  packages/db
  packages/types
  packages/api-client
  packages/mcp
  packages/email
  packages/i18n
  packages/flows
  packages/tasks
  packages/comments
  packages/notifications
)

# Lower bar — large UI surface still expanding
COVERAGE_LOWER=(
  packages/ui
  apps/starter-web
  apps/example-web
  apps/mcp-example
)

# Kit-only seam: print the three kit tiers above (high, medium, lower; one per
# line) and exit before the extension file is read and before discovery, so the
# output never depends on config/product/coverage-order.txt.
if [[ "${COVERAGE_LIST_KIT:-0}" == "1" ]]; then
  printf '%s\n' "${COVERAGE_HIGH[@]}" "${COVERAGE_MEDIUM[@]}" "${COVERAGE_LOWER[@]}"
  exit 0
fi

# Product tiers from $EXT_FILE (optional).
EXT_HIGH=()
EXT_MEDIUM=()
EXT_LOWER=()
# workspace -> where it is declared, for precise reconcile messages.
declare -A ORIGIN=()
reconcile_failed=0

declare_ws() {
  local ws="$1" origin="$2"
  if [[ -n "${ORIGIN[$ws]:-}" ]]; then
    echo "✗ duplicate entry: $ws is declared in ${ORIGIN[$ws]} and again in $origin" >&2
    echo "  → keep a single declaration (a workspace has exactly one tier)" >&2
    reconcile_failed=1
    return 1
  fi
  ORIGIN[$ws]="$origin"
}

for ws in "${COVERAGE_HIGH[@]}" "${COVERAGE_MEDIUM[@]}" "${COVERAGE_LOWER[@]}"; do
  declare_ws "$ws" "$SELF" || true
done

if [[ -f "$EXT_FILE" ]]; then
  lineno=0
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    lineno=$((lineno + 1))
    line="${raw%%#*}"
    read -r -a fields <<<"$line" || true
    [[ "${#fields[@]}" -eq 0 ]] && continue
    if [[ "${#fields[@]}" -ne 2 ]]; then
      echo "✗ malformed line $EXT_FILE:$lineno: expected \"<tier> <workspace>\", got \"${raw}\"" >&2
      reconcile_failed=1
      continue
    fi
    tier="${fields[0]}"
    ws="${fields[1]}"
    case "$tier" in
      high | medium | lower) ;;
      *)
        echo "✗ unknown tier \"$tier\" at $EXT_FILE:$lineno (allowed: high, medium, lower)" >&2
        reconcile_failed=1
        continue
        ;;
    esac
    declare_ws "$ws" "$EXT_FILE:$lineno" || continue
    case "$tier" in
      high) EXT_HIGH+=("$ws") ;;
      medium) EXT_MEDIUM+=("$ws") ;;
      lower) EXT_LOWER+=("$ws") ;;
    esac
  done <"$EXT_FILE"
fi

COVERAGE_ORDER=(
  "${COVERAGE_HIGH[@]}" ${EXT_HIGH[@]+"${EXT_HIGH[@]}"}
  "${COVERAGE_MEDIUM[@]}" ${EXT_MEDIUM[@]+"${EXT_MEDIUM[@]}"}
  "${COVERAGE_LOWER[@]}" ${EXT_LOWER[@]+"${EXT_LOWER[@]}"}
)

# Workspaces declaring a `test:coverage` script, one per line.
discover_workspaces() {
  bun -e '
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const root = process.cwd()
const rootPkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
const globs = rootPkg.workspaces ?? []
const found = []
for (const glob of globs) {
  const match = /^(.+)\/\*$/.exec(glob)
  if (!match) {
    console.error(`test-coverage: unsupported workspace glob "${glob}"`)
    process.exit(1)
  }
  const base = match[1]
  const baseDir = path.join(root, base)
  if (!existsSync(baseDir)) continue
  const names = readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  for (const name of names) {
    const pkgPath = path.join(baseDir, name, "package.json")
    if (!existsSync(pkgPath)) continue
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
    if (pkg.scripts?.["test:coverage"]) found.push(`${base}/${name}`)
  }
}
console.log(found.join("\n"))
'
}

discovered_raw="$(discover_workspaces)"
discovered=()
if [[ -n "$discovered_raw" ]]; then
  mapfile -t discovered <<<"$discovered_raw"
fi

if [[ "${#discovered[@]}" -eq 0 ]]; then
  echo "test-coverage: no workspace declares a \"test:coverage\" script — discovery is broken" >&2
  exit 1
fi

# A workspace joined the monorepo but nobody decided its risk tier.
for ws in "${discovered[@]}"; do
  if [[ -z "${ORIGIN[$ws]:-}" ]]; then
    echo "✗ unknown workspace: $ws declares test:coverage but has no risk tier" >&2
    echo "  → add \"<high|medium|lower> $ws\" to $EXT_FILE (kit workspaces: the COVERAGE_* tiers in $SELF)" >&2
    reconcile_failed=1
  fi
done

# A tier entry vanished, was renamed, or lost its test:coverage script.
for ordered in "${COVERAGE_ORDER[@]}"; do
  seen=0
  for ws in "${discovered[@]}"; do
    if [[ "$ordered" == "$ws" ]]; then
      seen=1
      break
    fi
  done
  if [[ "$seen" -eq 0 ]]; then
    echo "✗ stale entry: $ordered is declared in ${ORIGIN[$ordered]} but no longer declares test:coverage" >&2
    echo "  → remove it from ${ORIGIN[$ordered]%%:*} (or restore its test:coverage script)" >&2
    reconcile_failed=1
  fi
done

if [[ "$reconcile_failed" -ne 0 ]]; then
  echo "" >&2
  echo "test-coverage: FAILED (coverage bar membership drifted)" >&2
  exit 1
fi

narrow_changed() {
  local base="$1" files file ws ordered already=""
  local -a picked=() narrowed=()
  if ! files="$(git diff --name-only "${base}...HEAD")"; then
    echo "test-coverage: cannot read changes from ${base}" >&2
    exit 1
  fi
  [[ -n "${files}" ]] || return 0
  while IFS= read -r file; do
    [[ -n "${file}" ]] || continue
    if [[ "${file}" =~ ^(apps|packages)/([^/]+)/ ]]; then
      ws="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
      if [[ "${BASH_REMATCH[1]}" == "packages" ]]; then
        return 0
      fi
      picked+=("${ws}")
    else
      return 0
    fi
  done <<<"${files}"
  for ws in "${picked[@]}"; do
    local known=0
    for ordered in "${COVERAGE_ORDER[@]}"; do
      if [[ "${ordered}" == "${ws}" ]]; then
        known=1
        break
      fi
    done
    if [[ "${known}" -eq 0 ]]; then
      echo "test-coverage: changed files match no coverage workspace; refusing to skip the bar" >&2
      exit 1
    fi
  done
  for ordered in "${COVERAGE_ORDER[@]}"; do
    for ws in "${picked[@]}"; do
      if [[ "${ordered}" == "${ws}" && "${already}" != *"|${ordered}|"* ]]; then
        narrowed+=("${ordered}")
        already="${already}|${ordered}|"
        break
      fi
    done
  done
  if [[ "${#narrowed[@]}" -eq 0 ]]; then
    echo "test-coverage: changed files match no coverage workspace; refusing to skip the bar" >&2
    exit 1
  fi
  COVERAGE_ORDER=("${narrowed[@]}")
}

if [[ -n "${COVERAGE_ONLY:-}" && -n "${COVERAGE_CHANGED_BASE:-}" ]]; then
  echo "test-coverage: COVERAGE_ONLY and COVERAGE_CHANGED_BASE are mutually exclusive" >&2
  exit 1
fi
if [[ -n "${COVERAGE_CHANGED_BASE:-}" ]]; then
  narrow_changed "${COVERAGE_CHANGED_BASE}"
fi
if [[ -n "${COVERAGE_ONLY:-}" ]]; then
  if [[ ! "${COVERAGE_ONLY}" =~ ^(apps|packages)/[A-Za-z0-9._-]+$ ]]; then
    echo "test-coverage: COVERAGE_ONLY ${COVERAGE_ONLY} is not a workspace path" >&2
    exit 1
  fi
  only_seen=0
  for ordered in "${COVERAGE_ORDER[@]}"; do
    if [[ "${ordered}" == "${COVERAGE_ONLY}" ]]; then
      only_seen=1
    fi
  done
  if [[ "${only_seen}" -eq 0 ]]; then
    echo "test-coverage: COVERAGE_ONLY ${COVERAGE_ONLY} is not in the coverage order" >&2
    exit 1
  fi
  COVERAGE_ORDER=("${COVERAGE_ONLY}")
fi
if [[ "${COVERAGE_LIST_ONLY:-0}" == "1" ]]; then
  printf '%s\n' "${COVERAGE_ORDER[@]}"
  exit 0
fi

echo "→ Cleaning coverage/"
rm -rf coverage
mkdir -p coverage

fail=0

run_pkg() {
  local dir="$1"
  local name
  local log
  local pkg_failed=0
  name="$(basename "$dir")"
  log="$(mktemp)"
  echo ""
  echo "════════════════════════════════════════"
  echo " coverage: $name ($dir)"
  echo "════════════════════════════════════════"
  if ! (cd "$dir" && bunx vitest run --coverage 2>&1 | tee "$log"); then
    pkg_failed=1
  fi
  if grep -Fq "Excluding it from coverage." "$log"; then
    echo "✗ $name silently excluded a file from coverage" >&2
    pkg_failed=1
  fi
  rm -f "$log"
  if [[ "$pkg_failed" -eq 0 ]]; then
    echo "✓ $name"
  else
    echo "✗ $name FAILED" >&2
    fail=1
  fi
}

for ws in "${COVERAGE_ORDER[@]}"; do
  run_pkg "$ws"
done

echo ""
bun scripts/kit/print-coverage-summary.mjs || true

if [[ "$fail" -ne 0 ]]; then
  echo ""
  echo "test-coverage: FAILED (see thresholds / failing suites above)" >&2
  exit 1
fi

echo ""
echo "test-coverage: OK"
echo "HTML reports: coverage/<package>/index.html"
echo "Open e.g.:  coverage/example-api/index.html"
