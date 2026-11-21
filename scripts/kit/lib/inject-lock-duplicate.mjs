#!/usr/bin/env node
/** Inject a duplicate decoded key into a JSON lock for self-tests. */
import { readFileSync, writeFileSync } from 'node:fs'

const [lockPath, mode] = process.argv.slice(2)
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))

if (mode === 'nested') {
  const a = lock.workspaces['apps/a']
  const inner = JSON.stringify(a.dependencies)
  const body = `{
  "lockfileVersion": ${lock.lockfileVersion || 1},
  "workspaces": {
    "": ${JSON.stringify(lock.workspaces[''])},
    "apps/a": {
      "name": "a",
      "dependencies": ${inner},
      "dependenc\\u0069es": ${inner}
    },
    "apps/b": ${JSON.stringify(lock.workspaces['apps/b'])},
    "apps/c": ${JSON.stringify(lock.workspaces['apps/c'])}
  },
  "trustedDependencies": [],
  "packages": ${JSON.stringify(lock.packages, null, 2)}
}
`
  writeFileSync(lockPath, body)
  process.exit(0)
}

const pkgs = lock.packages
const kit = JSON.stringify(pkgs['kit-pin'])
const dupKey = mode === 'escaped' ? '"k\\u0069t-pin"' : '"kit-pin"'
const lines = [
  '{',
  `  "lockfileVersion": ${lock.lockfileVersion || 1},`,
  `  "workspaces": ${JSON.stringify(lock.workspaces, null, 2).replace(/\n/g, '\n  ')},`,
  '  "trustedDependencies": [],',
  '  "packages": {',
  `    "kit-pin": ${kit},`,
  `    ${dupKey}: ${kit},`,
]
for (const [k, v] of Object.entries(pkgs)) {
  if (k === 'kit-pin') continue
  lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
}
lines.push('  },', '}', '')
writeFileSync(lockPath, lines.join('\n'))
