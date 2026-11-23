#!/usr/bin/env bash
# product-validate.example.sh — COPY into the product repo (never run as-is from kit CI).
#
# Preferred copy targets (zero-edit allowed):
#   scripts/product/validate.sh
#   apps/<product>-api/scripts/kit/product-validate.sh
#
# Replace <product> with the Product's App prefix. For an API-only Product,
# remove the Vite command. Root already owns typecheck, tests and other shared checks.
#
# See: docs/kit/product-consumer-contract.md · docs/kit/playbooks/start-product.md#day-0-checklist (item 9)
set -euo pipefail

# Resolve monorepo root from this script location.
# If you copy to scripts/product/validate.sh → two levels up.
# If you copy to apps/<product>-api/scripts/kit/product-validate.sh → four levels up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/../../scripts/kit/kit-schema-sync.sh" ]]; then
  ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
elif [[ -f "${SCRIPT_DIR}/../../../../scripts/kit/kit-schema-sync.sh" ]]; then
  ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
else
  echo "product-validate: cannot find monorepo root from ${SCRIPT_DIR}" >&2
  exit 1
fi
cd "$ROOT"

echo "→ product-validate (ROOT=$ROOT)"

# Keep Product-specific guards here; do not rerun zero-edit or deploy-gate:check.
# Products may opt in to release notes without editing the inherited root CHANGELOG.
bun --no-env-file scripts/kit/release-prepare.ts --check-changelog --product

# Kit schema: exit 2 when the same sync would write (run it without --check and commit), 1 on
# refusal. Uses the inherited catalog, never a KIT_SCHEMA_CATALOG override. Files only: it does
# not prove remote migrations were applied. Drop it only if the Product has no API.
env -u KIT_SCHEMA_CATALOG bash scripts/kit/kit-schema-sync.sh --app apps/<product>-api --check

# Bundle the SPA without the starter's `tsc -b` (Root already typechecks it).
(cd "apps/<product>-web" && bun x --no-install vite build)

# Bundle the Worker for each named environment in wrangler.toml. The starter uses
# the unnamed configuration until named environments are added. If the Product
# also deploys the unnamed configuration, add its dry-run explicitly.
(
  cd "apps/<product>-api"
  bun --no-env-file -e '
    const config = Bun.TOML.parse(await Bun.file("wrangler.toml").text())
    const environments = Object.keys(config.env ?? {}).sort()
    const command = [
      "bun", "x", "--no-install", "wrangler", "deploy", "--dry-run", "--config", "wrangler.toml",
    ]
    function build(args) {
      const result = Bun.spawnSync([...command, ...args], {
        stdin: "inherit", stdout: "inherit", stderr: "inherit",
      })
      if (!result.success) process.exit(result.exitCode || 1)
    }
    if (!environments.length) build(["--outdir", "dist"])
    // A Wrangler environment name is an argument, never a path component.
    for (const [index, env] of environments.entries()) {
      build([`--env=${env}`, "--outdir", `dist/env-${index + 1}`])
    }
  '
)

echo "✓ product-validate OK"
