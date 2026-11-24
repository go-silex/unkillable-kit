#!/usr/bin/env bun
/**
 * CP-EXTRACT residency — apps must not own kit-generic tables or org policy.
 *
 * Env: EXTRACT_ROOT — monorepo root (self-test harness).
 * Exit: 0 clean · 1 violations
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(process.env.EXTRACT_ROOT ?? join(import.meta.dirname, '../..'))

const SOURCE_EXT = new Set(['.ts', '.tsx'])
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.wrangler',
  'coverage',
  '.git',
  '.turbo',
  'build',
])

const SQLITE_TABLE_RE = /sqliteTable\s*\(\s*['"]([^'"]+)['"]/g

const POLICY_MARKERS = ['findOrgById', 'findMembership', 'AppError.notFound']

function rel(path: string): string {
  return relative(ROOT, path).split(sep).join('/') || '.'
}

function isSourceFile(name: string): boolean {
  if (name.endsWith('.d.ts')) return false
  if (/\.(test|spec)\.(ts|tsx)$/.test(name)) return false
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return SOURCE_EXT.has(name.slice(dot))
}

function walkSources(dir: string, out: string[]): void {
  if (!existsSync(dir)) return
  for (const ent of readdirSync(dir)) {
    if (SKIP_DIRS.has(ent)) continue
    const abs = join(dir, ent)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) walkSources(abs, out)
    else if (isSourceFile(ent)) out.push(abs)
  }
}

function collectKitGenericTables(): Set<string> {
  const names = new Set<string>()
  const pkgDir = join(ROOT, 'packages')
  if (!existsSync(pkgDir)) return names
  const files: string[] = []
  walkSources(pkgDir, files)
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(SQLITE_TABLE_RE)) {
      const table = match[1]
      if (!table.startsWith('demo_')) names.add(table)
    }
  }
  return names
}

function scanAppSqliteViolations(kitTables: Set<string>): string[] {
  const appsDir = join(ROOT, 'apps')
  if (!existsSync(appsDir)) return []
  const files: string[] = []
  walkSources(appsDir, files)
  const violations: string[] = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(SQLITE_TABLE_RE)) {
      const table = match[1]
      if (table.startsWith('demo_')) continue
      if (kitTables.has(table)) {
        violations.push(
          `${rel(file)}: kit-generic sqliteTable('${table}') belongs in packages/, not apps/`,
        )
      }
    }
  }
  return violations
}

function extractFunctionBody(text: string, name: string): string | null {
  const re = new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*(?::[^{]+)?\\{`)
  const m = re.exec(text)
  if (!m) return null
  let i = m.index + m[0].length
  let depth = 1
  while (i < text.length && depth > 0) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    i++
  }
  return text.slice(m.index + m[0].length, i - 1)
}

function isThinOrgContextWrapper(body: string): boolean {
  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  if (!/requireOrgContext\s*\(/.test(stripped)) return false
  return !POLICY_MARKERS.some((m) => stripped.includes(m))
}

function scanOrgPolicyViolations(): string[] {
  const appsDir = join(ROOT, 'apps')
  if (!existsSync(appsDir)) return []
  const files: string[] = []
  walkSources(appsDir, files)
  const violations: string[] = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const localAuthorizationFactory =
      /\bfunction\s+(createOrgMiddleware|createRequestAuthorization)\s*[<(]/.exec(text)?.[1]
    if (localAuthorizationFactory) {
      violations.push(
        `${rel(file)}: apps/ must not define ${localAuthorizationFactory} — compose createRequestAuthorization from @kit/auth/hono`,
      )
    }
    const body = extractFunctionBody(text, 'requireOrgContext')
    if (!body) continue
    if (POLICY_MARKERS.some((m) => body.includes(m)) && !isThinOrgContextWrapper(body)) {
      violations.push(
        `${rel(file)}: requireOrgContext must delegate to @kit/auth/hono, not implement org policy locally`,
      )
    }
  }
  return violations
}

const kitTables = collectKitGenericTables()
const violations = [...scanAppSqliteViolations(kitTables), ...scanOrgPolicyViolations()]

if (violations.length) {
  console.error('extract-residency: FAIL')
  for (const v of violations) console.error(`  ${v}`)
  process.exit(1)
}

console.log(`extract-residency: OK (${kitTables.size} kit-generic tables indexed)`)
process.exit(0)
