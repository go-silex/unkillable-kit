#!/usr/bin/env bash
# Fail if kit workspaces pin zod 3.x, or if bun.lock has non-allowlisted zod@3.
# Allowlist: nested CLI residual only (shadcn).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# Workspace package.json files that must declare zod ^4
PIN_FILES=(
  packages/core/package.json
  packages/flows/package.json
  packages/mcp/package.json
  apps/example-api/package.json
  apps/example-web/package.json
  apps/mcp-example/package.json
)

fail=0

for f in "${PIN_FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "check-zod-major: missing $f" >&2
    fail=1
    continue
  fi
  line="$(grep -E '"zod"' "$f" || true)"
  if [[ -z "$line" ]]; then
    echo "check-zod-major: $f has no zod pin (expected ^4.x)" >&2
    fail=1
    continue
  fi
  if grep -qE '"zod":\s*"\^?3' <<<"$line"; then
    echo "check-zod-major: $f still pins zod 3.x: $line" >&2
    fail=1
  fi
  if ! grep -qE '"zod":\s*"\^4' <<<"$line"; then
    echo "check-zod-major: $f zod pin is not ^4.x: $line" >&2
    fail=1
  fi
done

if [[ ! -f bun.lock ]]; then
  echo "check-zod-major: bun.lock missing" >&2
  exit 1
fi

# Every zod@3. lock key must equal an allowlisted nested key (exact match, not substring).
# bun.lock lines look like:     "shadcn/zod": ["zod@3.25.76", "", {}, "sha…"],
ALLOWLIST=(
  'shadcn/zod'
)

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  # extract nested package key if present: "foo/zod": ["zod@3.…
  key=""
  if [[ "$line" =~ \"([^\"]+)\":[[:space:]]*\[\"zod@3\. ]]; then
    key="${BASH_REMATCH[1]}"
  fi
  allowed=0
  if [[ -n "$key" ]]; then
    for a in "${ALLOWLIST[@]}"; do
      if [[ "$key" == "$a" ]]; then
        allowed=1
        break
      fi
    done
  fi
  if [[ "$allowed" -eq 0 ]]; then
    echo "check-zod-major: non-allowlisted zod@3 in bun.lock:" >&2
    echo "  $line" >&2
    fail=1
  fi
done < <(grep -E 'zod@3\.' bun.lock || true)

if [[ "$fail" -ne 0 ]]; then
  echo "check-zod-major: FAILED" >&2
  exit 1
fi

echo "check-zod-major: OK (workspace pins ^4; residual zod@3 allowlisted: ${ALLOWLIST[*]})"
