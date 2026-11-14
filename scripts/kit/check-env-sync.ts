#!/usr/bin/env bun
/**
 * env:check — document completeness for **kit example-api only** (Workers + Vite).
 *
 * Proves (kit gate only):
 *   - apps/example-api schema string keys ⊆ apps/example-api/.dev.vars.example
 *     (and reverse drift),
 *   - root .env.example holds known VITE_* placeholders,
 *   - no real-looking secrets in those example files.
 *
 * Does NOT:
 *   - load real .dev.vars / validate production or CF dashboard secrets,
 *   - scan apps/<product>-* env schemas (product owns that inventory),
 *   - claim monorepo-wide env completeness.
 *
 * SSoT: apps/example-api/src/env.schema.ts
 * See docs/kit/testing/critical-path.md — CP-ENV (DX, example-api scoped).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WORKER_BINDINGS, WORKER_STRING_ENV_KEYS } from '../../apps/example-api/src/env.schema'

const ROOT = join(import.meta.dirname, '../..')
const DEV_VARS_EXAMPLE = join(ROOT, 'apps/example-api/.dev.vars.example')
const ROOT_ENV_EXAMPLE = join(ROOT, '.env.example')

/** Root tooling / Vite placeholders (not Worker secrets). */
const ROOT_DOCUMENTED_KEYS = ['VITE_API_URL'] as const

/** Keys allowed only as Cloudflare bindings (never required in .dev.vars). */
const BINDING_SET = new Set<string>(WORKER_BINDINGS)

/**
 * Heuristic: fail if example files look like they contain real secrets.
 * Placeholders and known demo/dev values are allowlisted by shape.
 */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'AWS access key', re: /(?:^|[^A-Z0-9])AKIA[0-9A-Z]{16}(?:[^A-Z0-9]|$)/ },
  { name: 'GitHub PAT', re: /ghp_[A-Za-z0-9]{36,}/ },
  { name: 'Stripe live', re: /sk_live_[A-Za-z0-9]{20,}/ },
  { name: 'OpenAI-ish key', re: /sk-[A-Za-z0-9]{32,}/ },
]

async function parseEnvFileKeys(path: string): Promise<Set<string>> {
  const content = await readFile(path, 'utf-8')
  const keys = new Set<string>()
  for (const raw of content.split('\n')) {
    let line = raw.trim()
    if (line === '' || line.startsWith('# =')) continue
    if (line.startsWith('# ')) line = line.slice(2)
    else if (line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)
    if (match) keys.add(match[1])
  }
  return keys
}

async function fileLooksLikeRealSecrets(path: string): Promise<string[]> {
  const content = await readFile(path, 'utf-8')
  const hits: string[] = []
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(content)) hits.push(`${name} in ${path}`)
  }
  return hits
}
function collectDevKeyErrors(devKeys: Set<string>): string[] {
  const errors: string[] = []
  for (const key of WORKER_STRING_ENV_KEYS) {
    if (!devKeys.has(key)) {
      errors.push(`${key} is in env.schema but missing from apps/example-api/.dev.vars.example`)
    }
  }
  for (const key of devKeys) {
    if (BINDING_SET.has(key)) {
      errors.push(`${key} is a binding — must not appear in .dev.vars.example`)
      continue
    }
    if (!WORKER_STRING_ENV_KEYS.includes(key as (typeof WORKER_STRING_ENV_KEYS)[number])) {
      errors.push(`${key} is in .dev.vars.example but not in env.schema (WORKER_STRING_ENV_KEYS)`)
    }
  }
  return errors
}

function collectRootKeyFindings(rootKeys: Set<string>): { errors: string[]; warns: string[] } {
  const errors: string[] = []
  const warns: string[] = []
  for (const key of ROOT_DOCUMENTED_KEYS) {
    if (!rootKeys.has(key)) errors.push(`${key} missing from root .env.example`)
  }
  for (const key of rootKeys) {
    if (WORKER_STRING_ENV_KEYS.includes(key as (typeof WORKER_STRING_ENV_KEYS)[number])) {
      warns.push(
        `${key} is a Worker secret/var — prefer apps/example-api/.dev.vars.example over root .env.example`,
      )
    }
  }
  return { errors, warns }
}

async function collectSecretErrors(): Promise<string[]> {
  const errors: string[] = []
  for (const path of [DEV_VARS_EXAMPLE, ROOT_ENV_EXAMPLE]) {
    for (const hit of await fileLooksLikeRealSecrets(path)) {
      errors.push(`possible real secret pattern: ${hit}`)
    }
  }
  return errors
}

async function main() {
  console.log('env:check — schema ↔ .dev.vars.example ↔ root .env.example\n')
  console.log(`Worker string keys (SSoT): ${WORKER_STRING_ENV_KEYS.join(', ')}`)
  console.log(`Bindings (not in .dev.vars): ${[...BINDING_SET].join(', ')}\n`)

  const devKeys = await parseEnvFileKeys(DEV_VARS_EXAMPLE)
  const rootKeys = await parseEnvFileKeys(ROOT_ENV_EXAMPLE)
  const rootFindings = collectRootKeyFindings(rootKeys)
  const errors = [
    ...collectDevKeyErrors(devKeys),
    ...rootFindings.errors,
    ...(await collectSecretErrors()),
  ]
  const warns = rootFindings.warns

  for (const w of warns) console.warn(`WARN:  ${w}`)
  for (const e of errors) console.error(`ERROR: ${e}`)

  console.log()
  if (errors.length > 0) {
    console.error(
      'env:check failed. Fix schema / .dev.vars.example drift (see docs/kit/testing/critical-path.md CP-ENV).',
    )
    process.exit(1)
  }
  console.log('env:check OK — example files match schema inventory (DX only).')
  process.exit(0)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
