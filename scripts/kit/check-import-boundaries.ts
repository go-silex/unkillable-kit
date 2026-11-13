#!/usr/bin/env bun
/**
 * import-boundary — static layer gate for monorepo Chemin A (ADR-0001).
 *
 * Proves (CP-IMPORT):
 *   R1/R2 packages ↛ apps (workspace name or relative)
 *   R3 example-web ↛ example-api src
 *   R4 example-web ↛ cloudflare:workers (and WORKER_BAR_IMPORTS)
 *   R5 non-SPA apps (example-api and apps/* except *-web) ↛ @kit/auth/react
 *       (SPA password forms: example-web and apps/*-web may import)
 *   exemptions require reason; invalid config → exit 2
 *
 * Does NOT prove: runtime/DI purity, non-literal dynamic imports,
 * full tsconfig alias graph, product-owned graphs, R5 routes↛repos.
 *
 * Env: IMPORT_BOUNDARY_ROOT — override monorepo root (self-test harness).
 * Exit: 0 clean · 1 violations · 2 bad exemptions config
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve, sep } from 'node:path'

// Harness override for self-test temp trees (scripts run outside Turbo task graph).
const ROOT = resolve(process.env.IMPORT_BOUNDARY_ROOT ?? join(import.meta.dirname, '../..'))

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cts', '.mts'])
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.wrangler',
  'coverage',
  '.git',
  '.turbo',
  'build',
])

/** Bare specifiers forbidden under apps/example-web (R4). */
const WORKER_BAR_IMPORTS = new Set(['cloudflare:workers', 'cloudflare:email'])

const KIT_EXEMPTIONS_REL = join('config', 'kit', 'import-boundary-exemptions.txt')
const PRODUCT_EXEMPTIONS_REL = join('config', 'product', 'import-boundary-exemptions.txt')

type Zone = 'package' | 'example-web' | 'example-api' | 'other-app' | 'outside'

type WorkspaceEntry = { name: string; absDir: string; zone: Zone }

type ImportHit = {
  file: string
  line: number
  specifier: string
}

type Violation = ImportHit & { rule: string }

function isSourceFile(name: string): boolean {
  if (name.endsWith('.d.ts')) return false
  if (/\.(test|spec)\.(ts|tsx|js|mjs|cts|mts)$/.test(name)) return false
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return SOURCE_EXT.has(name.slice(dot))
}

function walkSources(dir: string, out: string[]): void {
  if (!existsSync(dir)) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent)) continue
    const abs = join(dir, ent)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) walkSources(abs, out)
    else if (st.isFile() && isSourceFile(ent)) out.push(abs)
  }
}

function loadPackageName(pkgJsonPath: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: string }
    return typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : null
  } catch {
    return null
  }
}

function zoneForAppDir(dirName: string): Zone {
  if (dirName === 'example-web') return 'example-web'
  if (dirName === 'example-api') return 'example-api'
  return 'other-app'
}
function pushWorkspaceDirs(
  entries: WorkspaceEntry[],
  parent: string,
  zoneOf: (dirName: string) => Zone,
): void {
  if (!existsSync(parent)) return
  for (const dir of readdirSync(parent)) {
    const absDir = join(parent, dir)
    if (!statSync(absDir).isDirectory()) continue
    const name = loadPackageName(join(absDir, 'package.json'))
    if (name) entries.push({ name, absDir, zone: zoneOf(dir) })
  }
}

function loadWorkspaceMap(root: string): WorkspaceEntry[] {
  const entries: WorkspaceEntry[] = []
  pushWorkspaceDirs(entries, join(root, 'packages'), () => 'package')
  pushWorkspaceDirs(entries, join(root, 'apps'), zoneForAppDir)
  // Longest name first for subpath prefix match.
  entries.sort((a, b) => b.name.length - a.name.length)
  return entries
}

function zoneOfPath(absPath: string, root: string): Zone {
  const rel = relative(root, absPath).split(sep).join('/')
  if (rel.startsWith('packages/') || rel === 'packages') return 'package'
  if (rel.startsWith('apps/example-web/') || rel === 'apps/example-web') return 'example-web'
  if (rel.startsWith('apps/example-api/') || rel === 'apps/example-api') return 'example-api'
  if (rel.startsWith('apps/') || rel === 'apps') return 'other-app'
  return 'outside'
}

/**
 * Strip line and block comments so regex extractors do not treat prose as imports.
 * Does not fully parse strings (template literals with nested quotes remain best-effort).
 */
type CommentScan = { source: string; out: string; i: number }

function skipLineComment(s: CommentScan): void {
  s.out += ' '
  s.i += 2
  while (s.i < s.source.length && s.source[s.i] !== '\n') {
    s.out += ' '
    s.i++
  }
}

function skipBlockComment(s: CommentScan): void {
  s.out += '  '
  s.i += 2
  while (s.i < s.source.length && !(s.source[s.i] === '*' && s.source[s.i + 1] === '/')) {
    s.out += s.source[s.i] === '\n' ? '\n' : ' '
    s.i++
  }
  if (s.i < s.source.length) {
    s.out += '  '
    s.i += 2
  }
}

function copyQuotedLiteral(s: CommentScan, quote: "'" | '"'): void {
  s.out += quote
  s.i++
  while (s.i < s.source.length) {
    s.out += s.source[s.i]
    if (s.source[s.i] === '\\' && s.i + 1 < s.source.length) {
      s.out += s.source[s.i + 1]
      s.i += 2
      continue
    }
    if (s.source[s.i] === quote) {
      s.i++
      break
    }
    s.i++
  }
}

function stripComments(source: string): string {
  const s: CommentScan = { source, out: '', i: 0 }
  while (s.i < source.length) {
    const c = source[s.i]
    const n = source[s.i + 1]
    if (c === '/' && n === '/') {
      skipLineComment(s)
      continue
    }
    if (c === '/' && n === '*') {
      skipBlockComment(s)
      continue
    }
    if (c === "'" || c === '"') {
      copyQuotedLiteral(s, c)
      continue
    }
    s.out += c
    s.i++
  }
  return s.out
}

/** Drop Vite-style query/hash so `@kit/example-api?raw` still maps to workspace. */
function stripSpecifierSuffix(specifier: string): string {
  const q = specifier.indexOf('?')
  const h = specifier.indexOf('#')
  let end = specifier.length
  if (q >= 0) end = Math.min(end, q)
  if (h >= 0) end = Math.min(end, h)
  return specifier.slice(0, end)
}

/** True if `index` sits inside a single- or double-quoted string on `line`. */
function isInsideQuotes(line: string, index: number): boolean {
  let inS = false
  let inD = false
  let esc = false
  for (let i = 0; i < index; i++) {
    const c = line[i]
    if (esc) {
      esc = false
      continue
    }
    if ((inS || inD) && c === '\\') {
      esc = true
      continue
    }
    if (!inD && c === "'") inS = !inS
    else if (!inS && c === '"') inD = !inD
  }
  return inS || inD
}

/** Extract static import/export/require string literals (line best-effort). */
function extractImports(content: string, file: string): ImportHit[] {
  const hits: ImportHit[] = []
  // Comment-stripped so "// import from '@kit/…'" is not an edge; newlines preserved for line nos.
  const scan = stripComments(content)
  // from '…' / from "…" (import and export … from)
  const fromRe = /\bfrom\s+['"]([^'"]+)['"]/g
  // side-effect import '…'
  const sideRe = /\bimport\s+['"]([^'"]+)['"]/g
  // require('…') / import('…')
  const callRe = /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g

  const lines = scan.split('\n')
  const pushOnLine = (line: string, lineNo: number, re: RegExp) => {
    re.lastIndex = 0
    while (true) {
      const m = re.exec(line)
      if (m === null) break
      if (isInsideQuotes(line, m.index)) continue
      hits.push({ file, line: lineNo, specifier: m[1] })
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNo = i + 1
    pushOnLine(line, lineNo, fromRe)
    pushOnLine(line, lineNo, sideRe)
    pushOnLine(line, lineNo, callRe)
  }
  return hits
}

type ResolveResult =
  | { kind: 'workspace'; entry: WorkspaceEntry; absPath: string }
  | { kind: 'relative'; absPath: string }
  | { kind: 'bare'; specifier: string }
  | { kind: 'unresolved' }

function resolveSpecifier(
  specifier: string,
  importerAbs: string,
  workspace: WorkspaceEntry[],
): ResolveResult {
  // Relative only (./ ../). Absolute FS paths (/…) are not kit import style — bare/unresolved.
  if (specifier.startsWith('.')) {
    const absPath = normalize(resolve(dirname(importerAbs), specifier))
    return { kind: 'relative', absPath }
  }

  const bare = stripSpecifierSuffix(specifier)

  for (const entry of workspace) {
    if (bare === entry.name || bare.startsWith(`${entry.name}/`)) {
      const rest = bare === entry.name ? '' : bare.slice(entry.name.length + 1)
      const absPath = rest ? join(entry.absDir, rest) : entry.absDir
      return { kind: 'workspace', entry, absPath }
    }
  }

  return { kind: 'bare', specifier: bare }
}

type ExemptionsLoad = { ok: true; paths: Set<string> } | { ok: false; errors: string[] }

function productPathCanonical(p: string): boolean {
  if (p.startsWith('/') || p.startsWith('./')) return false
  return p.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function productAppOk(p: string): boolean {
  if (!productPathCanonical(p)) return false
  const m = /^apps\/([^/]+)-(api|web|mcp)\//.exec(p)
  if (!m) return false
  const name = m[1]
  const suffix = m[2]
  if (!name || name === 'example') return false
  if (`${name}-${suffix}` === 'mcp-example') return false
  return true
}
function productExemptionError(
  rel: string,
  lineNo: number,
  norm: string,
  opts: { kitPaths: Set<string> },
  paths: Set<string>,
): string | null {
  if (/[*?[]/.test(norm)) return `${rel}:${lineNo}: ${norm} — wildcard product exemption`
  if (!productPathCanonical(norm)) return `${rel}:${lineNo}: ${norm} — non-canonical`
  if (!productAppOk(norm)) return `${rel}:${lineNo}: ${norm} — not a product-app path`
  if (opts.kitPaths.has(norm)) return `${rel}:${lineNo}: ${norm} — duplicate vs kit`
  if (paths.has(norm)) return `${rel}:${lineNo}: ${norm} — duplicate`
  return null
}

function parseExemptionLine(
  rel: string,
  lineNo: number,
  trimmed: string,
  opts: { product: boolean; kitPaths: Set<string> },
  paths: Set<string>,
): string | null {
  const hash = trimmed.indexOf('#')
  if (hash < 0) return `${rel}:${lineNo}: missing reason after #`
  const filePart = trimmed.slice(0, hash).trim()
  const reason = trimmed.slice(hash + 1).trim()
  if (!filePart) return `${rel}:${lineNo}: empty path before #`
  if (!reason) return `${rel}:${lineNo}: empty reason after #`
  const norm = filePart.split(sep).join('/')
  if (opts.product) {
    const err = productExemptionError(rel, lineNo, norm, opts, paths)
    if (err) return err
  }
  paths.add(norm)
  return null
}

function parseExemptionFile(
  root: string,
  rel: string,
  opts: { product: boolean; kitPaths: Set<string> },
): ExemptionsLoad {
  const path = join(root, rel)
  if (!existsSync(path)) {
    return { ok: true, paths: new Set() }
  }
  const paths = new Set<string>()
  const errors: string[] = []
  const lines = readFileSync(path, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const err = parseExemptionLine(rel, i + 1, trimmed, opts, paths)
    if (err) errors.push(err)
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, paths }
}

function loadExemptions(root: string): ExemptionsLoad {
  const kit = parseExemptionFile(root, KIT_EXEMPTIONS_REL, {
    product: false,
    kitPaths: new Set(),
  })
  if (!kit.ok) return kit
  const product = parseExemptionFile(root, PRODUCT_EXEMPTIONS_REL, {
    product: true,
    kitPaths: kit.paths,
  })
  if (!product.ok) return product
  return { ok: true, paths: new Set([...kit.paths, ...product.paths]) }
}

function relPosix(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/')
}

function targetUnderApps(absPath: string, root: string, workspace: WorkspaceEntry[]): boolean {
  const z = zoneOfPath(absPath, root)
  if (z === 'example-web' || z === 'example-api' || z === 'other-app') return true
  // Workspace entry rooted under apps/
  for (const e of workspace) {
    if (e.zone === 'package') continue
    const rootSlash = e.absDir.endsWith(sep) ? e.absDir : e.absDir + sep
    if (absPath === e.absDir || absPath.startsWith(rootSlash)) return true
  }
  return false
}

function targetUnderExampleApi(
  absPath: string,
  root: string,
  workspace: WorkspaceEntry[],
): boolean {
  if (zoneOfPath(absPath, root) === 'example-api') return true
  for (const e of workspace) {
    if (e.zone !== 'example-api') continue
    const rootSlash = e.absDir.endsWith(sep) ? e.absDir : e.absDir + sep
    if (absPath === e.absDir || absPath.startsWith(rootSlash)) return true
  }
  return false
}
function authReactViolation(
  hit: ImportHit,
  importerZone: Zone,
  specBare: string,
): Violation | null {
  // hit.file is already posix-relative from scanRoot. Allowlist SPA web so
  // unnamed Workers / mcp-example stay fail-closed (not a *-api denylist).
  const isProductSpa = /^apps\/[^/]+-web\//.test(hit.file)
  if (importerZone !== 'example-api' && importerZone !== 'other-app') return null
  if (isProductSpa) return null
  if (specBare !== '@kit/auth/react' && !specBare.startsWith('@kit/auth/react/')) return null
  return { ...hit, rule: 'R5' }
}

function resolvedAbsTarget(resolved: ResolveResult): string | null {
  if (resolved.kind === 'workspace' || resolved.kind === 'relative') return resolved.absPath
  return null
}

function classify(
  hit: ImportHit,
  importerZone: Zone,
  resolved: ResolveResult,
  root: string,
  workspace: WorkspaceEntry[],
): Violation | null {
  const specBare = stripSpecifierSuffix(hit.specifier)
  if (importerZone === 'example-web' && WORKER_BAR_IMPORTS.has(specBare)) {
    return { ...hit, rule: 'R4' }
  }
  const auth = authReactViolation(hit, importerZone, specBare)
  if (auth) return auth
  if (resolved.kind === 'bare' || resolved.kind === 'unresolved') return null
  const absTarget = resolvedAbsTarget(resolved)
  if (!absTarget) return null
  if (importerZone === 'package' && targetUnderApps(absTarget, root, workspace)) {
    return { ...hit, rule: resolved.kind === 'relative' ? 'R2' : 'R1' }
  }
  if (importerZone === 'example-web' && targetUnderExampleApi(absTarget, root, workspace)) {
    return { ...hit, rule: 'R3' }
  }
  return null
}

export function scanRoot(root: string = ROOT): {
  violations: Violation[]
  exemptionErrors: string[]
  filesScanned: number
} {
  const workspace = loadWorkspaceMap(root)
  const exemptions = loadExemptions(root)
  if (!exemptions.ok) {
    return { violations: [], exemptionErrors: exemptions.errors, filesScanned: 0 }
  }

  const files: string[] = []
  walkSources(join(root, 'packages'), files)
  walkSources(join(root, 'apps'), files)

  const violations: Violation[] = []

  for (const abs of files) {
    const rel = relPosix(root, abs)
    if (exemptions.paths.has(rel)) continue

    const importerZone = zoneOfPath(abs, root)
    if (importerZone === 'outside') continue

    let content: string
    try {
      content = readFileSync(abs, 'utf8')
    } catch {
      continue
    }

    for (const hit of extractImports(content, rel)) {
      const resolved = resolveSpecifier(hit.specifier, abs, workspace)
      const v = classify(hit, importerZone, resolved, root, workspace)
      if (v) violations.push(v)
    }
  }

  return { violations, exemptionErrors: [], filesScanned: files.length }
}

function main(): void {
  const started = performance.now()
  console.log(`import-boundary — root=${ROOT}`)

  const { violations, exemptionErrors, filesScanned } = scanRoot(ROOT)

  if (exemptionErrors.length > 0) {
    for (const e of exemptionErrors) console.error(`CONFIG: ${e}`)
    console.error(
      '\nimport-boundary: invalid exemptions (exit 2). Each active line needs: path  # reason — #issue',
    )
    console.error(`Fix: edit ${KIT_EXEMPTIONS_REL} or ${PRODUCT_EXEMPTIONS_REL}`)
    process.exit(2)
  }

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.rule} ${v.file}:${v.line} → ${v.specifier}`)
    }
    console.error(`\nimport-boundary: ${violations.length} violation(s) in ${filesScanned} file(s)`)
    console.error(
      `Fix: remove edge | ${KIT_EXEMPTIONS_REL} or ${PRODUCT_EXEMPTIONS_REL}  # reason — #issue`,
    )
    process.exit(1)
  }

  const ms = Math.round(performance.now() - started)
  console.log(`import-boundary OK — ${filesScanned} files, 0 violations (${ms}ms)`)
  if (ms > 3000) {
    console.warn(`WARN: import-boundary p95 budget 3s exceeded (${ms}ms)`)
  }
  process.exit(0)
}

if (import.meta.main) {
  main()
}
