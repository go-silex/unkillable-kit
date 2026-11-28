#!/usr/bin/env bash
# Exercise bootstrap's Product-owned script via its CLI boundary, without a Product clone or deployment.
set -euo pipefail
cd "$(dirname "$0")/../.."
root=$PWD
mkdir -p "$root/.tmp"
tmp=$(mktemp -d "$root/.tmp/product-templates.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
export REAL_BUN
REAL_BUN=$(command -v bun)
export TRACE="$tmp/trace"
mkdir "$tmp/bin"
cat > "$tmp/bin/bun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == '--no-env-file -e' ]]; then
  exec "$REAL_BUN" "$@"
fi
if [[ "$*" == *' wrangler deploy '* ]]; then
  outdir="${@: -1}"
  if [[ "$outdir" == "$PWD"/.wrangler-dry-run-*/* &&
    -d "${outdir%/*}" && ! -e "$outdir" ]]; then
    printf '%s %s .fresh/%s\n' "${PWD##*/}" "${*:1:$(($# - 1))}" "${outdir##*/}" >> "$TRACE"
    exit
  fi
fi
printf '%s %s\n' "${PWD##*/}" "$*" >> "$TRACE"
EOF
chmod +x "$tmp/bin/bun"
original_path=$PATH
export PATH="$tmp/bin:$PATH"

for flags in '0 0' '0 1' '1 0' '1 1'; do
  read -r web mcp <<< "$flags"
  fixture="$tmp/product-root"
  rm -rf "$fixture"
  mkdir -p "$fixture/apps/fixture-api" "$fixture/scripts/kit" "$fixture/docs/kit/templates"
  mkdir -p "$fixture/apps/mcp-example/"{src,scripts}
  cp apps/mcp-example/src/{catalogue.ts,index.ts,index.test.ts} "$fixture/apps/mcp-example/src/"
  cp apps/mcp-example/scripts/stdio-smoke.mjs "$fixture/apps/mcp-example/scripts/"
  cp apps/mcp-example/tsconfig.json "$fixture/apps/mcp-example/"
  cp docs/kit/templates/product-{ci.example.yml,validate.example.sh} "$fixture/docs/kit/templates/"
  printf '{}\n' > "$fixture/package.json"
  printf 'name = "fixture-api"\n' > "$fixture/apps/fixture-api/wrangler.toml"
  cat > "$fixture/scripts/kit/kit-schema-sync.sh" <<'EOF'
if [[ -v KIT_SCHEMA_CATALOG ]]; then exit 1; fi
printf '%s schema %s\n' "${PWD##*/}" "$*" >> "$TRACE"
EOF
  if ((web)); then
    mkdir -p "$fixture/apps/fixture-web"
    cat >> "$fixture/apps/fixture-api/wrangler.toml" <<'EOF'
[env."preview/edge".vars]
NAME = "unused"
[env.production]
name = "fixture-prod"
EOF
  fi

  : > "$TRACE"
  (
    cd "$fixture"
    bash "$root/scripts/kit/create-product-templates.sh" fixture "$web" "$mcp"
    if ((mcp && ! web)); then
      app_local=apps/fixture-api/scripts/kit/product-validate.sh
      mkdir -p "$(dirname "$app_local")"
      printf '{}\n' > apps/fixture-api/package.json
      mv scripts/product/validate.sh "$app_local"
      KIT_SCHEMA_CATALOG=not-allowed bash "$app_local"
      exit
    fi
    KIT_SCHEMA_CATALOG=not-allowed bash scripts/product/validate.sh
  )
  {
    printf '%s\n' 'product-root --no-env-file scripts/kit/release-prepare.ts --check-changelog --product'
    printf '%s\n' 'product-root schema --app apps/fixture-api --check'
    if ((web)); then
      printf '%s\n' 'fixture-web x --no-install vite build'
      printf '%s\n' 'fixture-api x --no-install wrangler deploy --dry-run --config wrangler.toml --env=preview/edge --outdir .fresh/env-1'
      printf '%s\n' 'fixture-api x --no-install wrangler deploy --dry-run --config wrangler.toml --env=production --outdir .fresh/env-2'
    else
      printf '%s\n' 'fixture-api x --no-install wrangler deploy --dry-run --config wrangler.toml --outdir .fresh/default'
    fi
  } | diff -u - "$TRACE"
  [[ -z "$(find "$fixture/apps/fixture-api" -maxdepth 1 -name '.wrangler-dry-run-*' -print -quit)" ]]
  grep -Fqx '        run: bash scripts/product/validate.sh' "$fixture/.github/workflows/product-ci.yml"
  if ((mcp)); then
    grep -Fqx 'lower apps/fixture-mcp' "$fixture/config/product/coverage-order.txt"
    test -f "$fixture/apps/fixture-mcp/vitest.config.ts"
  else
    test ! -e "$fixture/apps/fixture-mcp"
  fi
done

# Root uses Vitest directly, not an App's test or coverage script bodies.
export PATH="$original_path"
mkdir -p "$fixture/packages/config"
cp packages/config/{vitest-coverage.mts,vitest-workers.mts,tsconfig.base.json} "$fixture/packages/config/"
# One link per installed package, not a link to their folder: Vitest and Vite keep their caches
# under node_modules, and tasks that run together must not share the checkout's.
link_modules() {
  mkdir "$2"
  ln -s "$1"/* "$1/.bin" "$2/"
}
link_modules "$root/node_modules" "$fixture/node_modules"
app="$fixture/apps/fixture-mcp"
link_modules "$root/apps/mcp-example/node_modules" "$app/node_modules"
(cd "$app" && bunx --no-install vitest run --coverage)

# Break only the actual CLI launch, not the imports exercised by unit tests.
{
  printf 'if (import.meta.main) process.exit(99)\n'
  tail -n +2 "$app/src/index.ts"
} > "$app/src/index.ts.broken"
mv "$app/src/index.ts.broken" "$app/src/index.ts"
if (cd "$app" && bunx --no-install vitest run --coverage) > "$tmp/broken.log" 2>&1; then
  echo 'Expected Root coverage to fail when generated MCP CLI startup is broken' >&2
  exit 1
fi
grep -F 'MCP stdio smoke failed' "$tmp/broken.log" || { cat "$tmp/broken.log" >&2; exit 1; }
