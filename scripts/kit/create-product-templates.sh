#!/usr/bin/env bash
# Materialize product-owned CI and optional stdio MCP from kit contracts.
set -euo pipefail

name="${1:?product name required}"
web="${2:?web flag required}"
mcp="${3:?mcp flag required}"
[[ "$name" =~ ^[a-z][a-z0-9-]{0,38}$ && "$name" != *- ]] || { echo 'Invalid product name' >&2; exit 1; }
[[ "$web" == 0 || "$web" == 1 ]] && [[ "$mcp" == 0 || "$mcp" == 1 ]] || { echo 'Flags must be 0 or 1' >&2; exit 1; }

mkdir -p scripts/product config/product docs/product .github/workflows
# The maintained consumer templates are the CI and validation source of truth.
cp docs/kit/templates/product-ci.example.yml .github/workflows/product-ci.yml
awk -v name="$name" -v web="$web" '
  /apps\/<product>-web/ && web == "0" { next }
  { gsub(/<product>/, name); print }
' docs/kit/templates/product-validate.example.sh > scripts/product/validate.sh
chmod +x scripts/product/validate.sh
printf '{"workflows":[".github/workflows/product-ci.yml"]}\n' > config/product/deploy-gate.json
{
  printf 'high apps/%s-api\n' "$name"
  [[ "$web" == 0 ]] || printf 'lower apps/%s-web\n' "$name"
  [[ "$mcp" == 0 ]] || printf 'lower apps/%s-mcp\n' "$name"
} > config/product/coverage-order.txt
cat > docs/product/AGENTS.md <<'EOF'
# Product agent instructions

Product-owned applications live under `apps/`. Preserve kit-owned zones and the
inheritance pin; follow `docs/kit/product-consumer-contract.md`. Run Root for
workspace quality and `scripts/product/validate.sh` for deployment builds and
Product-specific guards.
EOF

if [[ "$mcp" == 1 ]]; then
  app="apps/$name-mcp"
  mkdir -p "$app/src" "$app/scripts"
  # Compose the same catalogue and stdio entry as the kit example, without
  # importing the example app or bringing along its hosted OAuth worker.
  sed -e "s/mcp-example/$name-mcp/g" -e 's/createExampleCatalogue/createProductCatalogue/g' -e 's/Hosted: Worker MCP token props.//g' apps/mcp-example/src/catalogue.ts > "$app/src/catalogue.ts"
  sed -e "s/kit-mcp-example/$name-mcp/g" -e 's/MCP example/Product MCP/g' -e 's/createExampleCatalogue/createProductCatalogue/g' apps/mcp-example/src/index.ts > "$app/src/index.ts"
  sed "s/mcp-example/$name-mcp/g" apps/mcp-example/src/index.test.ts > "$app/src/index.test.ts"
  # Use a hard bound and no dotenv or Product API configuration, even in the local alias.
  sed -e "s/mcp-example/$name-mcp/g" \
    -e "s/'bun', \['run', entry\]/'bun', ['--no-env-file', 'run', entry]/" \
    -e "/stdio: \['pipe', 'pipe', 'pipe'\],/a\\  timeout: 8000,\\n  killSignal: 'SIGKILL'," \
    -e "/    API_KEY:/c\\    API_KEY: '',\\n    AUTHORIZATION: '',\\n    API_BASE_URL: '',\\n    MCP_ALLOWED_HOSTS: '',\\n    MCP_ALLOW_NONLOCAL_HOSTS: ''," \
    apps/mcp-example/scripts/stdio-smoke.mjs > "$app/scripts/stdio-smoke.mjs"
  cat > "$app/src/stdio.test.ts" <<'EOF'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('serves ping and an unverified identity over stdio JSON-RPC', () => {
  const smoke = fileURLToPath(new URL('../scripts/stdio-smoke.mjs', import.meta.url))
  const child = spawnSync('bun', ['--no-env-file', 'run', smoke], {
    encoding: 'utf8',
    timeout: 12_000,
    killSignal: 'SIGKILL',
  })
  if (child.status !== 0) {
    throw new Error(
      `MCP stdio smoke failed: ${child.error ?? child.signal ?? child.status}\n${child.stderr}`,
    )
  }
  const report = JSON.parse(child.stdout)
  expect(report.ok).toBe(true)
  expect(report.tools).toEqual(['ping', 'whoami'])
  expect(report.ping.isError).not.toBe(true)
  const ping = report.ping.content.find((item: { type: string }) => item.type === 'text')
  expect(JSON.parse(ping.text)).toEqual({ ok: true })
  expect(report.whoami.isError).not.toBe(true)
  expect(report.whoamiParsed).toEqual({
    keyPresent: false,
    verified: false,
    subject: null,
    status: 'missing_key',
  })
}, 15_000)
EOF
  cp apps/mcp-example/tsconfig.json "$app/tsconfig.json"
  cat > "$app/package.json" <<EOF
{
  "name": "@kit/$name-mcp",
  "version": "0.0.1",
  "private": true,
  "license": "MIT",
  "type": "module",
  "scripts": {
    "dev": "bun run src/index.ts",
    "start": "bun run src/index.ts",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "smoke:stdio": "bun --no-env-file run scripts/stdio-smoke.mjs"
  },
  "dependencies": {
    "@kit/mcp": "workspace:*",
    "fastmcp": "^4.26.2",
    "zod": "^4.6.7"
  },
  "devDependencies": {
    "@types/bun": "^1.4.5",
    "@types/node": "^26.6.6",
    "vitest": "^5.1.0"
  }
}
EOF
  cat > "$app/vitest.config.ts" <<EOF
import { defineConfig } from 'vitest/config'
import { makeCoverage } from '../../packages/config/vitest-coverage.mts'
import { ciMaxWorkers } from '../../packages/config/vitest-workers.mts'

export default defineConfig({
  test: {
    maxWorkers: ciMaxWorkers,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: makeCoverage('$name-mcp', {
      statements: 50,
      lines: 50,
      branches: 40,
      functions: 0,
    }),
  },
})
EOF
fi
