#!/usr/bin/env bash
# Dry-run extractability check for Chemin A kit.
#
# Tree identity: ADR-0009 D5 classifier (scripts/kit/resolve-tree-identity.mjs).
#   kit     — example/mcp apps only; residency + temp compose proof
#   product — product apps under apps/ allowed (complement of kit examples)
#
# Harness-only override (audit): EXTRACT_MODE + EXTRACT_HARNESS_SENTINEL
#   (forbidden on normal lefthook/CI without sentinel — mirror ZERO_EDIT_MODE discipline)
set -euo pipefail

ROOT="${EXTRACT_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
# The kit's empty Bun config for gate steps, resolved from this script's tree before the cd.
GATE_BUNFIG="$(cd "$(dirname "$0")/../.." && pwd)/config/kit/bunfig.gates.toml"
# shellcheck source=lib/kit-apps.sh
source "$(dirname "$0")/lib/kit-apps.sh"
cd "$ROOT"

export ROOT
export EXTRACT_MODE="${EXTRACT_MODE:-}"
export EXTRACT_HARNESS_SENTINEL="${EXTRACT_HARNESS_SENTINEL:-}"

identity_line="$(
  node --input-type=module <<'NODE'
import { resolveTreeIdentity } from './scripts/kit/resolve-tree-identity.mjs'
const { mode, identity, classifiedMode } = resolveTreeIdentity({
  root: process.env.ROOT,
  modeEnv: process.env.EXTRACT_MODE || '',
  harnessSentinel: process.env.EXTRACT_HARNESS_SENTINEL || '',
})
console.log(`mode=${mode} identity=${identity || '(none)'} classified=${classifiedMode}`)
NODE
)" || {
  echo "extract-dry-run: tree identity resolution failed" >&2
  exit 1
}

MODE="$(echo "$identity_line" | sed -n 's/^mode=\([^ ]*\).*/\1/p')"
IDENTITY="$(echo "$identity_line" | sed -n 's/.*identity=\([^ ]*\).*/\1/p')"
CLASSIFIED="$(echo "$identity_line" | sed -n 's/.*classified=\([^ ]*\).*/\1/p')"

search_q() {
  local pat="$1"
  shift
  if command -v rg >/dev/null 2>&1; then
    rg -q "$pat" "$@"
  else
    grep -RIqE --exclude-dir=node_modules --exclude-dir=.git -e "$pat" "$@"
  fi
}

echo "== extract-dry-run: mode=${MODE} identity=${IDENTITY} classified=${CLASSIFIED} =="
echo "== extract-dry-run: tree sanity =="

required=(
  package.json
  turbo.jsonc
  biome.json
  packages/core/package.json
  packages/types/package.json
  packages/auth/package.json
  packages/db/package.json
  packages/storage/package.json
  packages/ui/package.json
  packages/email/package.json
  packages/mcp/package.json
  packages/flows/package.json
  packages/tasks/package.json
  packages/comments/package.json
  packages/notifications/package.json
  packages/api-client/package.json
  packages/i18n/package.json
  apps/example-api/package.json
  apps/example-web/package.json
  apps/mcp-example/package.json
  docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md
  config/kit/zero-edit-zones.json
  scripts/kit/check-zero-edit-zones.sh
)

for f in "${required[@]}"; do
  if [[ ! -e "$f" ]]; then
    echo "MISSING: $f" >&2
    exit 1
  fi
done

# ADR-0011 D3: tools/ is folded. Empty dir is tolerated; any entry fails.
# `find` not `ls` — command substitution of ls -A drops a newline-only name.
if [[ -e tools ]]; then
  if [[ ! -d tools ]]; then
    echo "extract-dry-run: tools must not exist as a non-directory (ADR-0011)" >&2
    exit 1
  fi
  set +e
  leftover="$(find tools -mindepth 1 -print -quit 2>/dev/null)"
  find_ec=$?
  set -e
  if [[ "$find_ec" -ne 0 ]]; then
    echo "extract-dry-run: tools/ scan failed (ADR-0011)" >&2
    exit 1
  fi
  if [[ -n "$leftover" ]]; then
    echo "extract-dry-run: tools/ must stay empty (ADR-0011); found ${leftover}" >&2
    exit 1
  fi
fi

# Kit apps = the apps/<name>/ protected_prefixes of zero-edit-zones.json, the list every gate reads (Roxabi/roxabi-boilerplate-cf#318).
# extract-dry-run.sh, check-banned-strings.sh and kit-schema-sync.sh share kit_app_names (lib/kit-apps.sh).
kit_apps="$(kit_app_names config/kit/zero-edit-zones.json)" || {
  echo "extract-dry-run: cannot read the kit apps from config/kit/zero-edit-zones.json" >&2
  exit 1
}
mapfile -t KIT_APP_ALLOW <<<"$kit_apps"
# Reserved extract name — not a kit example until the app exists, not a product app.
KIT_APP_DENY=(
  example-web-branded
)

list_app_dirs() {
  if [[ ! -d apps ]]; then
    return 0
  fi
  find apps -mindepth 1 -maxdepth 1 -type d -print
}

is_denied_app() {
  local name="$1" denied
  for denied in "${KIT_APP_DENY[@]}"; do
    if [[ "$name" == "$denied" ]]; then
      return 0
    fi
  done
  return 1
}

is_allowed_app() {
  local name="$1" ok
  for ok in "${KIT_APP_ALLOW[@]}"; do
    if [[ "$name" == "$ok" ]]; then
      return 0
    fi
  done
  return 1
}

if [[ "$MODE" == "kit" ]]; then
  echo "== extract-dry-run: product-app allowlist (kit mode) =="
  while IFS= read -r app_dir; do
    [[ -n "$app_dir" ]] || continue
    app_name="$(basename "$app_dir")"
    if is_denied_app "$app_name" || ! is_allowed_app "$app_name"; then
      echo "UNEXPECTED app (not in kit allowlist): apps/$app_name" >&2
      exit 1
    fi
  done < <(list_app_dirs | sort)
  echo "NOTE: kit tree — no product apps under apps/"
elif [[ "$MODE" == "product" ]]; then
  echo "== extract-dry-run: product apps (product mode) =="
  product_found=0
  while IFS= read -r app_dir; do
    [[ -n "$app_dir" ]] || continue
    app_name="$(basename "$app_dir")"
    if is_denied_app "$app_name"; then
      echo "UNEXPECTED app (reserved kit name, not yet extracted): apps/$app_name" >&2
      exit 1
    fi
    if ! is_allowed_app "$app_name"; then
      product_found=1
      echo "NOTE: product app present (expected on product tree): apps/$app_name"
    fi
  done < <(list_app_dirs | sort)
  if [[ "$product_found" -eq 0 ]]; then
    echo "NOTE: product tree with kit examples only (no product apps yet)"
  fi
else
  echo "extract-dry-run: unresolved tree mode '${MODE}'" >&2
  exit 1
fi

echo "== extract-dry-run: starter scope (ADR-0022) =="
# The starter API is the minimal copy source of create-product.sh: the core and audit schema sets only.
if [[ -d apps/starter-api ]]; then
  starter_sets="$(
    node -e '
const m = JSON.parse(require("node:fs").readFileSync("apps/starter-api/kit-schema-manifest.json", "utf8"))
if (!Array.isArray(m.sets)) process.exit(1)
console.log([...m.sets].sort().join(","))
' 2>/dev/null
  )" || starter_sets="(unreadable manifest)"
  if [[ "$starter_sets" != "audit,core" ]]; then
    echo "extract-dry-run: apps/starter-api must sync only the core and audit schema sets (ADR-0022); found ${starter_sets}" >&2
    exit 1
  fi
fi

echo "== extract-dry-run: banlist (packages + kit apps only) =="
# check-banned-strings.sh targets packages + the kit apps of zero-edit-zones.json (lib/kit-apps.sh)
bash scripts/kit/check-banned-strings.sh

echo "== extract-dry-run: every package imported by an example =="
search_q '@kit/core' apps/example-api || {
  echo "example-api must import @kit/core" >&2
  exit 1
}
search_q '@kit/auth' apps/example-api || {
  echo "example-api must import @kit/auth" >&2
  exit 1
}
search_q '@kit/db' apps/example-api || {
  echo "example-api must import @kit/db" >&2
  exit 1
}
search_q '@kit/storage' apps/example-api || {
  echo "example-api must import @kit/storage" >&2
  exit 1
}
search_q '@kit/email' apps/example-api || {
  echo "example-api must import @kit/email" >&2
  exit 1
}
search_q '@kit/flows' apps/example-api || {
  echo "example-api must import @kit/flows" >&2
  exit 1
}
search_q '@kit/tasks' apps/example-api || {
  echo "example-api must import @kit/tasks" >&2
  exit 1
}
search_q '@kit/comments' apps/example-api || {
  echo "example-api must import @kit/comments" >&2
  exit 1
}
search_q '@kit/notifications' apps/example-api || {
  echo "example-api must import @kit/notifications" >&2
  exit 1
}
search_q '@kit/mcp' apps/mcp-example || {
  echo "mcp-example must import @kit/mcp" >&2
  exit 1
}
search_q '@kit/ui' apps/example-web || {
  echo "example-web must import @kit/ui" >&2
  exit 1
}
search_q '@kit/types' apps/example-web || {
  echo "example-web must import @kit/types" >&2
  exit 1
}
search_q '@kit/i18n' apps/example-web || {
  echo "example-web must import @kit/i18n" >&2
  exit 1
}
search_q '@kit/api-client' apps/example-web || {
  echo "example-web must import @kit/api-client" >&2
  exit 1
}
search_q '@kit/auth' apps/example-web || {
  echo "example-web must import @kit/auth" >&2
  exit 1
}


echo "== extract-dry-run: no orphan workspace packages (optional hard-fail) =="
# Packages under packages/* must be referenced from apps/. A directory without a
# manifest is not a workspace (e.g. packages/config tooling assets) and is skipped.
# Sibling-only hits do not count. EXTRACT_ORPHAN_FAIL=1 enables hard-fail (default on).
ORPHAN_FAIL="${EXTRACT_ORPHAN_FAIL:-1}"
orphan=0
# Use a small Node helper so we avoid set -o pipefail + rg exit-1 traps.
orphan_report="$(
  node --input-type=module <<'NODE'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist' || ent.name === 'coverage') continue
    const p = join(dir, ent.name)
    if (ent.isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx|js|mjs|cjs|json|md)$/.test(ent.name)) acc.push(p)
  }
  return acc
}

const files = walk('apps')
const orphans = []
for (const pkgDir of readdirSync('packages', { withFileTypes: true })) {
  if (!pkgDir.isDirectory()) continue
  const pkgJsonPath = join('packages', pkgDir.name, 'package.json')
  if (!existsSync(pkgJsonPath)) continue
  const name = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).name
  if (!name) continue
  const hit = files.some((f) => {
    try {
      return readFileSync(f, 'utf8').includes(name)
    } catch {
      return false
    }
  })
  if (!hit) orphans.push(`${name} (packages/${pkgDir.name})`)
}
if (orphans.length) {
  for (const o of orphans) console.log(`ORPHAN package (no apps/ importer): ${o}`)
  process.exit(2)
}
process.exit(0)
NODE
)" || orphan_ec=$?
orphan_ec="${orphan_ec:-0}"
if [[ -n "$orphan_report" ]]; then
  echo "$orphan_report" >&2
fi
if [[ "$orphan_ec" -eq 2 ]]; then
  orphan=1
elif [[ "$orphan_ec" -ne 0 ]]; then
  echo "extract-dry-run: orphan check helper failed (exit $orphan_ec)" >&2
  exit 1
fi
if [[ "$orphan" -eq 1 && "$ORPHAN_FAIL" == "1" ]]; then
  echo "extract-dry-run: orphan packages failed (set EXTRACT_ORPHAN_FAIL=0 to warn only)" >&2
  exit 1
fi

# config consumed via tsconfig extends (relative path to packages/config)
search_q 'config/tsconfig.base.json' apps packages || {
  echo "tsconfig must extend packages/config/tsconfig.base.json" >&2
  exit 1
}

# Axial ADR frontmatter
if ! grep -q 'axial: true' docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md; then
  echo "Axial ADR missing axial: true" >&2
  exit 1
fi

# ADR-0002 session interim present (kit contract)
if [[ ! -f docs/kit/architecture/adr/0002-session-hmac-interim-vs-better-auth.md ]]; then
  echo "MISSING: ADR-0002 session HMAC interim" >&2
  exit 1
fi


# --no-env-file + the kit's empty --config: both read EXTRACT_ROOT, which a tree's .env or
# bunfig.toml (preload / define) must not set.
echo "== extract-dry-run: residency (kit tables + org policy) =="
bun --no-env-file --config="$GATE_BUNFIG" scripts/kit/extract-residency.ts

echo "== extract-dry-run: temp compose proof (typecheck + org 200/404) =="
bun --no-env-file --config="$GATE_BUNFIG" scripts/kit/extract-compose-proof.ts

echo "extract-dry-run: OK (mode=${MODE})"
