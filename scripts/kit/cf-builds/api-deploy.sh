#!/usr/bin/env bash
# Kit **showcase** only — deploys apps/example-api [env.production] (boilerplate-api).
# Dashboard: Root = repo root · Deploy: `bun run cf:showcase:deploy-api`
# Build var required: KIT_SHOWCASE_DEPLOY=1
# Production branch only (deploy/main — CI-gated, Roxabi/roxabi-boilerplate-cf#256).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

if [[ "${KIT_SHOWCASE_DEPLOY:-}" != "1" ]]; then
  echo "error: refusing deploy — set KIT_SHOWCASE_DEPLOY=1 (kit showcase only)." >&2
  echo "  Products: use apps/<product>-* wrangler + your own CF Builds / product-deploy.yml." >&2
  echo "  See docs/kit/deploy-cloudflare.md § product / fork." >&2
  exit 1
fi

# shellcheck source=require-deploy-branch.sh
source "$(dirname "$0")/require-deploy-branch.sh"
require_deploy_branch "$ROOT" deploy

# go-silex/unkillable-kit#215: the version is tagged with the commit it ships, verified, for Deploy
# verify; an unverifiable SHA refuses here, before install, migrate or deploy.
# shellcheck source=require-deploy-sha.sh
source "$(dirname "$0")/require-deploy-sha.sh"
DEPLOY_SHA="$(require_deploy_sha "$ROOT")"

# shellcheck source=require-bun-version.sh
source "$(dirname "$0")/require-bun-version.sh"
cd "$ROOT"
if [[ -d node_modules ]]; then
  require_bun_version "$ROOT" # the image pre-installed with its own Bun (Roxabi/roxabi-boilerplate-cf#316)
else
  bash scripts/kit/cf-builds/install-monorepo.sh
fi

cd "$ROOT/apps/example-api"
DB=boilerplate-api

# Recovery point (Roxabi/roxabi-boilerplate-cf#258): migrate then deploy is not one transaction (runbook §5b). Before applying
# anything, record the D1 Time Travel bookmark and what is about to run — no bookmark, no migrate.
# stdout only: wrangler's warnings and hints go to stderr, straight to the build log.
if ! listing="$(bunx wrangler d1 migrations list "$DB" --remote --env production)"; then
  echo "error: cannot list pending D1 migrations — not migrating without a recovery point." >&2
  exit 1
fi
# Pending = the table rows under "Migrations to be applied:" (colours stripped, header skipped).
pending="$(awk '
  { gsub(/\033\[[0-9;]*m/, "") }
  /Migrations to be applied:/ { rows = 1; next }
  rows && index($0, "│") {
    cell = $0
    gsub(/│/, "", cell)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", cell)
    if (cell != "" && tolower(cell) != "name") { printf "%s%s", sep, cell; sep = " " }
  }' <<<"$listing")"
if [[ -n "$pending" ]]; then
  if ! info="$(bunx wrangler d1 time-travel info "$DB" --env production --json)"; then
    echo "error: cannot read the D1 Time Travel bookmark — not migrating without a recovery point." >&2
    exit 1
  fi
  bookmark="$(sed -n 's/.*"bookmark"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' <<<"$info" | sed -n 1p)"
  if [[ -z "$bookmark" ]]; then
    printf '%s\n' "$info" >&2
    echo "error: no bookmark in the Time Travel answer — not migrating without a recovery point." >&2
    exit 1
  fi
  cat <<EOF
== D1 recovery point (Roxabi/roxabi-boilerplate-cf#258) — before migrating ${DB} (production) ==
bookmark: ${bookmark}
pending:  ${pending}
runbook:  docs/kit/deploy-cloudflare.md § 5b "Recover a migration" — freeze, triage and roll the Worker back first
restore:  (runbook step 4 only, human in a TTY) cd apps/example-api && bunx wrangler d1 time-travel restore ${DB} --env production --bookmark=${bookmark}
EOF
elif [[ "$listing" != *"No migrations to apply"* ]]; then
  printf '%s\n' "$listing" >&2
  echo "error: unrecognised 'wrangler d1 migrations list' output — not migrating blind." >&2
  exit 1
fi

# Migrate then deploy. Not one distributed transaction (see runbook).
bunx wrangler d1 migrations apply "$DB" --remote --env production
bunx wrangler deploy --env production --tag "$DEPLOY_SHA"
