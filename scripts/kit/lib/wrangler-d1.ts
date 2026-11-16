#!/usr/bin/env bun
/**
 * Wrangler config discovery and D1 `migrations_dir` values of one config (toml, json, jsonc), top
 * level and every `[env.*]`, parsed with Bun's TOML/JSONC parsers — never a same-line grep. A
 * binding without `migrations_dir` uses wrangler's default, `migrations` (relative to the config).
 * Unreadable, unparseable or non-string values throw: callers fail closed.
 *
 * Shared by check-wrangler-migrations-dir.sh (CP-KIT-SCHEMA) and check-migrations-contract.ts
 * (CP-MIGRATION-CONTRACT) so both gates find the same configs and see the same directories.
 * CLI: `bun scripts/kit/lib/wrangler-d1.ts <file>` prints one directory per line;
 *      `bun scripts/kit/lib/wrangler-d1.ts --configs <root>` prints one config path per line.
 *      Exit 1 + message on error.
 */
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** Wrangler config basenames: wrangler.toml|json|jsonc and wrangler.<name>.toml|json|jsonc. */
const WRANGLER_CONFIG = /^wrangler(\.[^/]+)?\.(toml|json|jsonc)$/
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'coverage', '.turbo'])

/** Every wrangler config under `root`, recursively, sorted; dependency and build dirs skipped. */
export function wranglerConfigs(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name)) walk(p)
      } else if (e.isFile() && WRANGLER_CONFIG.test(e.name)) out.push(p)
    }
  }
  walk(root)
  return out.sort()
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

export function d1MigrationDirs(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  let data: unknown
  try {
    data = file.endsWith('.toml') ? Bun.TOML.parse(text) : Bun.JSONC.parse(text)
  } catch (e) {
    throw new Error(
      `unparseable ${file}: ${String(e instanceof Error ? e.message : e).split('\n')[0]}`,
    )
  }
  const dirs: string[] = []
  const pushBindingDir = (b: unknown) => {
    if (!isRecord(b)) return
    const v = b.migrations_dir
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      dirs.push('migrations')
      return
    }
    if (typeof v === 'string') {
      dirs.push(v.trim())
      return
    }
    throw new Error(`non-string migrations_dir in ${file}`)
  }
  const bindings = (block: unknown) => {
    if (!(isRecord(block) && Array.isArray(block.d1_databases))) return
    for (const b of block.d1_databases) pushBindingDir(b)
  }
  bindings(data)
  if (isRecord(data) && isRecord(data.env)) {
    for (const block of Object.values(data.env)) bindings(block)
  }
  return dirs
}

function isSymlinkOrMissing(candidate: string): boolean {
  try {
    return lstatSync(candidate).isSymbolicLink()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

// Resolve each component before applying the next `..`: lexical normalization before
// following a symlink can turn a forbidden path into an apparently safe one.
function resolveMissing(base: string, input: string): string {
  const parts = (isAbsolute(input) ? input : `${base}/${input}`).split('/')
  const resolved: string[] = []
  let links = 0
  while (parts.length > 0) {
    const part = parts.shift()!
    if (!part || part === '.') continue
    if (part === '..') {
      resolved.pop()
      continue
    }
    const candidate = `/${[...resolved, part].join('/')}`
    if (!isSymlinkOrMissing(candidate)) {
      resolved.push(part)
      continue
    }
    if (++links > 40) throw new Error(`too many symlinks resolving ${input}`)
    const target = readlinkSync(candidate)
    if (isAbsolute(target)) resolved.length = 0
    parts.unshift(...target.split('/'))
  }
  return `/${resolved.join('/')}`
}

if (import.meta.main) {
  try {
    if (process.argv[2] === '--resolve') {
      console.log(resolveMissing(process.argv[3] ?? '', process.argv[4] ?? ''))
    } else if (process.argv[2] === '--configs') {
      for (const f of wranglerConfigs(process.argv[3] ?? '.')) console.log(f)
    } else {
      for (const d of d1MigrationDirs(process.argv[2] ?? '')) console.log(d)
    }
  } catch (e) {
    console.error(`check-wrangler-migrations-dir: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}
