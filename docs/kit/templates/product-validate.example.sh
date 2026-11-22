#!/usr/bin/env bash
# product-validate.example.sh — COPY into the product repo (never run as-is from kit CI).
#
# Preferred copy targets (zero-edit allowed):
#   scripts/product/validate.sh
#   apps/<product>-api/scripts/kit/product-validate.sh
#
# Then replace <product> placeholders with your package names and adjust filters.
# Kit `validate:full` / `scripts/kit/test-coverage.sh` stay kit-only — do not dual-edit them
# to add product packages.
#
# See: docs/kit/product-consumer-contract.md · docs/kit/playbooks/start-product.md#day-0-checklist (item 9)
set -euo pipefail

# Resolve monorepo root from this script location.
# If you copy to scripts/product/validate.sh → two levels up.
# If you copy to apps/<product>-api/scripts/kit/product-validate.sh → three levels up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/../../package.json" ]]; then
  ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
elif [[ -f "${SCRIPT_DIR}/../../../package.json" ]]; then
  ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
else
  echo "product-validate: cannot find monorepo root from ${SCRIPT_DIR}" >&2
  exit 1
fi
cd "$ROOT"

echo "→ product-validate (ROOT=$ROOT)"

# Deploy-gate declaration (Roxabi/roxabi-boilerplate-cf#317): the inherited kit script runs promote-deploy.ts --check for main,
# and for staging when origin/deploy/staging exists (the CI checkout, fetch-depth: 0, carries every
# origin/deploy/* ref). Call it, never re-type it: this file is product-owned and would freeze a copy.
# Early local signal only: this script runs inside Product CI, the workflow under check, so a PR
# that stops Product CI from running never reaches it. Kit `validate:full` runs the same script in
# the required `ci` job; that is the enforcing path.
bun run deploy-gate:check

# Product mode: kit zones clean vs upstream (or inheritance.json in CI).
bun run zero-edit

# Products may opt in to release notes without editing the inherited root CHANGELOG.
bun --no-env-file scripts/kit/release-prepare.ts --check-changelog --product

# Kit schema: exit 2 when the same sync would write (run it without --check and commit), 1 on
# refusal. Uses the inherited catalog, never a KIT_SCHEMA_CATALOG override. Files only: it does
# not prove remote migrations were applied. Drop it only if the Product has no API.
env -u KIT_SCHEMA_CATALOG bash scripts/kit/kit-schema-sync.sh --app apps/<product>-api --check

# --- replace <product> with your app package names ---
bun run --filter "@kit/<product>-api" typecheck
bun run --filter "@kit/<product>-api" test
bun run --filter "@kit/<product>-web" typecheck
bun run --filter "@kit/<product>-web" test
# Optional: wrangler dry-run / turbo build for the product API
# bun run --filter "@kit/<product>-api" build

echo "✓ product-validate OK"
