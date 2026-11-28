#!/usr/bin/env bun
/**
 * Emit the example-api OpenAPI document from the real Hono app.
 *
 * The app is the SSoT: route schemas are the validators, so the document is a
 * projection, never a parallel hand-written contract.
 *
 *   bun run openapi         # write the snapshot
 *   bun run openapi:check   # fail on drift (CI)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from '../../apps/example-api/src/app'
import { openApiInfo } from '../../apps/example-api/src/lib/openapi'

const OUT = join(import.meta.dir, '../../docs/kit/openapi/example-api.json')

function render(): string {
  const doc = createApp().getOpenAPI31Document(openApiInfo)
  return `${JSON.stringify(doc, null, 2)}\n`
}

const next = render()

if (process.argv.includes('--check')) {
  let current: string
  try {
    current = readFileSync(OUT, 'utf8')
  } catch {
    console.error(`gen-openapi: missing snapshot ${OUT} — run \`bun run openapi\``)
    process.exit(1)
  }
  if (current !== next) {
    console.error('gen-openapi: OpenAPI snapshot is stale — run `bun run openapi` and commit')
    process.exit(1)
  }
  console.log('gen-openapi: OK (snapshot matches the app)')
} else {
  writeFileSync(OUT, next)
  console.log(`gen-openapi: wrote ${OUT}`)
}
