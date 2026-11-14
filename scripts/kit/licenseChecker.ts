/**
 * License Checker — Dependency License Compliance (Chemin A kit)
 *
 * Scans all monorepo dependencies (direct and transitive) across workspace packages,
 * checks each license against `.license-policy.json`, and produces a human-readable
 * CLI summary plus a machine-readable JSON report (`reports/licenses.json`).
 *
 * Usage: bun run license:check   (live scan, then --self-test)
 *        bun scripts/kit/licenseChecker.ts              live scan only
 *        bun scripts/kit/licenseChecker.ts --self-test  gate self-test only
 *
 * Compliance hygiene — not a security/malware scan. See docs/kit/testing/critical-path.md CP-LICENSE.
 * Exit codes: 0 clean (UNKNOWN licenses only warn); 1 disallowed SPDX expression or
 * missing node_modules; 2 unusable scan (empty scan, bad policy, `--root` misuse).
 *
 * --self-test proves the gate fails on each planted disallowed shape: a `license`
 * string, its `{ type }` object form, a `licenses` array of objects or of strings,
 * an AND expression, and malformed expressions whose first operand is allowed
 * (lowercase or unknown operator, juxtaposed atoms, stray parenthesis). Each temp
 * tree holds that one package under an MIT-only policy; the scan must exit 1 and
 * report exactly that package as the single violation. It also proves the
 * live-path guards below: an empty scan exits 2, `--root` outside a child exits 2,
 * and QG_LICENSE_ROOT does not move the root.
 * The work tree is never modified. A package whose licence the scan cannot read
 * stays a warning (UNKNOWN) (CP-LICENSE): no package.json field and
 * no LICENSE text it recognises (the patterns are permissive licences only, so a
 * GPL-only LICENSE file is UNKNOWN too).
 *
 * The scan root is the repo root, two levels up. Only a --self-test child takes
 * another one, by argv (`--self-test-child --root <tmp>`); no environment
 * variable can move it. A live scan that finds zero packages exits 2.
 *
 * A missing node_modules is a hard failure (exit 1). There is no
 * directory-absent skip in this checker.
 *
 * Zero external dependencies — uses only Bun built-ins and Node.js fs/path.
 *
 * Ported from kit-boilerplate tools/licenseChecker.ts (Bun-aware walker).
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── Types ───────────────────────────────────────────────────────────────────

interface LicensePolicy {
  /** Resolved allowed licenses — from `allowlist` or `allowedLicenses` (the kit policy uses `allowedLicenses`). */
  allowedLicenses: string[]
  overrides: Record<string, string>
}

/** Raw shape of .license-policy.json on disk — either key accepted. */
interface RawLicensePolicy {
  /** Alternate key accepted alongside `allowedLicenses`; `allowlist` wins when both are present. */
  allowlist?: string[]
  /** Key used by the kit's `.license-policy.json`. */
  allowedLicenses?: string[]
  overrides?: Record<string, string>
}

interface PackageEntry {
  name: string
  version: string
  license: string | null
  status: 'allowed' | 'violation' | 'unknown' | 'override'
  source: 'package.json' | 'LICENSE file' | 'override' | null
}

interface LicenseReport {
  timestamp: string
  summary: {
    totalPackages: number
    licenses: Record<string, number>
    violations: number
    warnings: number
  }
  packages: PackageEntry[]
  violations: PackageEntry[]
  warnings: Array<{ name: string; version: string; reason: string }>
}

// ─── Policy Loading ──────────────────────────────────────────────────────────

function loadPolicy(repoRoot: string): LicensePolicy {
  const policyPath = join(repoRoot, '.license-policy.json')
  if (!existsSync(policyPath)) {
    throw new Error('No .license-policy.json found at repo root')
  }
  const raw = readFileSync(policyPath, 'utf-8')
  const policy = JSON.parse(raw) as RawLicensePolicy
  return {
    allowedLicenses: policy.allowlist ?? policy.allowedLicenses ?? [],
    overrides: policy.overrides ?? {},
  }
}

// ─── Node Modules Scanning ───────────────────────────────────────────────────

interface RawPackageInfo {
  name: string
  version: string
  dir: string
  /** License string extracted from package.json at scan time (string field). */
  license?: string
  /** Licenses array extracted from package.json at scan time (deprecated format). */
  licenses?: Array<string | { type?: string }>
}

const IGNORED_ENTRIES = new Set(['.cache', '.bin', '.package-lock.json'])

function collectBunPackages(nodeModulesDir: string): RawPackageInfo[] {
  const bunDir = join(nodeModulesDir, '.bun')
  const results: RawPackageInfo[] = []
  for (const bunEntry of readdirSync(bunDir)) {
    const innerNm = join(bunDir, bunEntry, 'node_modules')
    if (!existsSync(innerNm)) continue
    results.push(...listPackagesInNodeModules(innerNm))
  }
  return results
}

function collectScopedPackages(scopeDir: string): RawPackageInfo[] {
  if (!(existsSync(scopeDir) && lstatSync(scopeDir).isDirectory())) return []
  const results: RawPackageInfo[] = []
  for (const scoped of readdirSync(scopeDir)) {
    const info = readPackageInfo(join(scopeDir, scoped))
    if (info) results.push(info)
  }
  return results
}

function listPackagesInNodeModules(nodeModulesDir: string): RawPackageInfo[] {
  if (!existsSync(nodeModulesDir)) return []
  const results: RawPackageInfo[] = []

  for (const entry of readdirSync(nodeModulesDir)) {
    if (IGNORED_ENTRIES.has(entry)) continue

    if (entry === '.bun') {
      results.push(...collectBunPackages(nodeModulesDir))
      continue
    }

    if (entry.startsWith('@')) {
      results.push(...collectScopedPackages(join(nodeModulesDir, entry)))
      continue
    }

    const info = readPackageInfo(join(nodeModulesDir, entry))
    if (info) results.push(info)
  }
  return results
}

function isWorkspaceSymlink(pkgDir: string): boolean {
  try {
    const stat = lstatSync(pkgDir)
    if (!stat.isSymbolicLink()) return false
    // Bun symlinks point to .bun/ — those are real dependencies, not workspace links
    const target = readlinkSync(pkgDir)
    return !target.includes('.bun/')
  } catch {
    return false
  }
}

/** package.json `license`: an SPDX string, or the deprecated `{ type, url }` object form. */
function licenseString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'type' in value && typeof value.type === 'string') {
    return value.type
  }
  return undefined
}

function readPackageInfo(pkgDir: string): RawPackageInfo | null {
  // Skip workspace symlinks (project code, not third-party)
  if (isWorkspaceSymlink(pkgDir)) return null

  // Resolve symlinks to get the real directory
  let realDir = pkgDir
  try {
    const stat = lstatSync(pkgDir)
    if (stat.isSymbolicLink()) {
      realDir = realpathSync(pkgDir)
      // Security: ensure the resolved path stays within the same node_modules directory
      const nodeModulesDir = resolve(dirname(pkgDir))
      if (!realDir.startsWith(nodeModulesDir + sep) && realDir !== nodeModulesDir) {
        return null
      }
    }
  } catch {
    return null
  }

  const pkgJsonPath = join(realDir, 'package.json')
  if (!existsSync(pkgJsonPath)) return null

  try {
    const raw = readFileSync(pkgJsonPath, 'utf-8')
    const pkg = Object.assign(
      Object.create(null) as Record<string, unknown>,
      JSON.parse(raw) as Record<string, unknown>,
    )
    if (!(pkg.name && pkg.version)) return null
    const info: RawPackageInfo = {
      name: String(pkg.name),
      version: String(pkg.version),
      dir: realDir,
    }
    const license = licenseString(pkg.license)
    if (license !== undefined) info.license = license
    if (Array.isArray(pkg.licenses))
      info.licenses = pkg.licenses as Array<string | { type?: string }>
    return info
  } catch {
    return null
  }
}

function collectWorkspaceNodeModules(repoRoot: string): string[] {
  try {
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'))
    const workspaceGlobs: string[] = rootPkg.workspaces ?? []
    const workspaceDirs = new Set(workspaceGlobs.map((g: string) => g.replace(/\/\*$/, '')))
    const dirs: string[] = []
    for (const dir of workspaceDirs) {
      const wsRoot = join(repoRoot, dir)
      if (!existsSync(wsRoot)) continue
      for (const ws of readdirSync(wsRoot)) {
        const wsNodeModules = join(wsRoot, ws, 'node_modules')
        if (existsSync(wsNodeModules)) dirs.push(wsNodeModules)
      }
    }
    return dirs
  } catch {
    return []
  }
}

function scanDependencies(repoRoot: string): RawPackageInfo[] {
  const seen = new Set<string>()
  const results: RawPackageInfo[] = []

  const nodeModulesDirs = [join(repoRoot, 'node_modules'), ...collectWorkspaceNodeModules(repoRoot)]

  for (const nmDir of nodeModulesDirs) {
    for (const pkg of listPackagesInNodeModules(nmDir)) {
      const key = `${pkg.name}@${pkg.version}`
      if (seen.has(key)) continue
      seen.add(key)
      results.push(pkg)
    }
  }

  return results
}

// ─── License Detection ──────────────────────────────────────────────────────

const LICENSE_FILE_NAMES = [
  'LICENSE',
  'LICENCE',
  'LICENSE.md',
  'LICENCE.md',
  'LICENSE.txt',
  'LICENCE.txt',
]

const LICENSE_PATTERNS: Array<[RegExp, string]> = [
  [/MIT License/i, 'MIT'],
  [/Permission is hereby granted, free of charge/i, 'MIT'],
  [/MIT No Attribution/i, 'MIT-0'],
  [/Apache License.*Version 2\.0/i, 'Apache-2.0'],
  [/BSD 3-Clause/i, 'BSD-3-Clause'],
  [/BSD 2-Clause/i, 'BSD-2-Clause'],
  [/BSD Zero Clause/i, '0BSD'],
  [/Permission to use, copy, modify, and\/or distribute.*without fee/i, 'ISC'],
  [/ISC License/i, 'ISC'],
  [/The Unlicense/i, 'Unlicense'],
  [/CC0 1\.0 Universal/i, 'CC0-1.0'],
  [/Creative Commons Attribution 4\.0/i, 'CC-BY-4.0'],
  [/Blue Oak Model License.*1\.0\.0/i, 'BlueOak-1.0.0'],
  [/Mozilla Public License.*Version 2\.0/i, 'MPL-2.0'],
  [/Python Software Foundation License/i, 'Python-2.0'],
  [/PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2/i, 'Python-2.0'],
]

function detectLicenseFromFile(pkgDir: string): string | null {
  for (const fileName of LICENSE_FILE_NAMES) {
    const filePath = join(pkgDir, fileName)
    if (!existsSync(filePath)) continue
    try {
      const content = readFileSync(filePath, 'utf-8').slice(0, 2000)
      for (const [pattern, license] of LICENSE_PATTERNS) {
        if (pattern.test(content)) return license
      }
    } catch {}
  }
  return null
}

type LicenseFields = Pick<RawPackageInfo, 'license' | 'licenses'>

/** 2. `license` string field, else 3. first entry of the deprecated `licenses` array, as carried by readPackageInfo. */
function licenseFromFields(fields: LicenseFields): string | null {
  if (typeof fields.license === 'string' && fields.license.trim()) return fields.license.trim()
  const first = (Array.isArray(fields.licenses) ? fields.licenses[0] : undefined) as
    | string
    | { type?: string }
    | null
    | undefined
  const licenseStr = typeof first === 'string' ? first : first?.type
  return licenseStr || null
}

function detectLicense(
  pkg: RawPackageInfo,
  policy: LicensePolicy,
): { license: string | null; source: PackageEntry['source'] } {
  const key = `${pkg.name}@${pkg.version}`

  // 1. Override (highest priority)
  if (key in policy.overrides) {
    return { license: policy.overrides[key], source: 'override' }
  }

  // 2-3. package.json license fields
  const fromPackageJson = licenseFromFields(pkg)
  if (fromPackageJson) return { license: fromPackageJson, source: 'package.json' }

  // 4. LICENSE file
  const fileLicense = detectLicenseFromFile(pkg.dir)
  if (fileLicense) return { license: fileLicense, source: 'LICENSE file' }

  // 5. Unknown
  return { license: null, source: null }
}

// ─── SPDX Expression Evaluator ───────────────────────────────────────────────
// Tokenizes the expression into: atoms (including "A WITH B" as one unit),
// parentheses, and AND/OR operators. Then evaluates with correct precedence:
// AND binds tighter than OR (SPDX spec §4.1).

type SpdxToken = '(' | ')' | 'AND' | 'OR' | string

function tokenizeSpdx(expr: string): SpdxToken[] {
  // Split on whitespace first, then reassemble WITH pairs as single atoms.
  // Note: WITH must appear between two atoms (e.g. "Apache-2.0 WITH LLVM-exception").
  // Grouped forms like "(A) WITH B" are NOT valid SPDX — the paren/length cap in
  // isLicenseAllowed() acts as the safety net for such malformed expressions.
  const raw = expr.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').trim().split(/\s+/).filter(Boolean)

  const tokens: SpdxToken[] = []
  let i = 0
  while (i < raw.length) {
    const t = raw[i]
    if (t === '(' || t === ')' || t === 'AND' || t === 'OR') {
      tokens.push(t as SpdxToken)
      i++
    } else if (raw[i + 1] === 'WITH' && i + 2 < raw.length) {
      // "A WITH B" → single opaque atom
      tokens.push(`${t} WITH ${raw[i + 2]}`)
      i += 3
    } else {
      tokens.push(t)
      i++
    }
  }
  return tokens
}

function isAtomAllowed(atom: string, allowedLicenses: string[]): boolean {
  // Strip trailing '+' (e.g. GPL-2.0+ → GPL-2.0)
  const normalized = atom.endsWith('+') ? atom.slice(0, -1) : atom
  return allowedLicenses.includes(normalized)
}

// Recursive-descent: OR → AND → primary. Fails closed on anything malformed: an operator or ')'
// where a licence belongs, an unclosed '(', or tokens left once the expression ends — otherwise
// "MIT and GPL-3.0-only" or "MIT) AND GPL-3.0-only" would evaluate as their first operand.
function evaluateSpdxExpression(expr: string, allowedLicenses: string[]): boolean {
  const tokens = tokenizeSpdx(expr)
  let pos = 0
  let malformed = false

  function parseOr(): boolean {
    let result = parseAnd()
    while (pos < tokens.length && tokens[pos] === 'OR') {
      pos++
      const right = parseAnd()
      result = result || right
    }
    return result
  }

  function parseAnd(): boolean {
    let result = parsePrimary()
    while (pos < tokens.length && tokens[pos] === 'AND') {
      pos++
      const right = parsePrimary()
      result = result && right
    }
    return result
  }

  function parsePrimary(): boolean {
    const t = tokens[pos]
    if (t === undefined || t === ')' || t === 'AND' || t === 'OR') {
      malformed = true
      return false
    }
    pos++
    if (t === '(') {
      const result = parseOr()
      if (tokens[pos] === ')') pos++
      else malformed = true
      return result
    }
    return isAtomAllowed(t, allowedLicenses)
  }

  const result = parseOr()
  return result && !malformed && pos === tokens.length
}

function isLicenseAllowed(license: string | null, allowedLicenses: string[]): boolean {
  if (!license) return false

  // Direct match (fast path — also handles simple atoms with no operators)
  if (allowedLicenses.includes(license)) return true

  // Guard against pathologically large or deeply nested expressions from untrusted
  // package.json data (e.g. 50 000 nested parens → stack overflow in the evaluator).
  // Real SPDX expressions are short; 512 chars and 20 open-parens are well above any
  // legitimate expression seen in the wild.
  const openParenCount = (license.match(/\(/g) ?? []).length
  if (license.length > 512 || openParenCount > 20) {
    process.stderr.write(
      `license-check: expression too complex to evaluate safely, treating as disallowed: ${license.slice(0, 60)}...\n`,
    )
    return false
  }

  // Evaluate as SPDX expression with correct precedence and grouping
  return evaluateSpdxExpression(license, allowedLicenses)
}

// ─── Compliance Check ────────────────────────────────────────────────────────

function checkCompliance(packages: RawPackageInfo[], policy: LicensePolicy): LicenseReport {
  const entries: PackageEntry[] = []
  const violations: PackageEntry[] = []
  const warnings: LicenseReport['warnings'] = []
  const licenseCounts: Record<string, number> = {}

  for (const pkg of packages) {
    const { license, source } = detectLicense(pkg, policy)

    let status: PackageEntry['status']
    if (source === 'override') {
      status = 'override'
    } else if (license === null) {
      status = 'unknown'
      warnings.push({
        name: pkg.name,
        version: pkg.version,
        reason: 'No license field or LICENSE file found',
      })
    } else if (isLicenseAllowed(license, policy.allowedLicenses)) {
      status = 'allowed'
    } else {
      status = 'violation'
    }

    const entry: PackageEntry = {
      name: pkg.name,
      version: pkg.version,
      license,
      status,
      source,
    }

    entries.push(entry)
    if (status === 'violation') violations.push(entry)
    if (license) {
      licenseCounts[license] = (licenseCounts[license] ?? 0) + 1
    }
  }

  // Detect stale overrides that don't match any scanned package
  const scannedKeys = new Set(packages.map((p) => `${p.name}@${p.version}`))
  for (const overrideKey of Object.keys(policy.overrides)) {
    if (!scannedKeys.has(overrideKey)) {
      warnings.push({
        name: overrideKey.replace(/@[^@]+$/, ''),
        version: overrideKey.replace(/^.*@/, ''),
        reason: `Override "${overrideKey}" does not match any installed package`,
      })
    }
  }

  return {
    timestamp: new Date().toISOString(),
    summary: {
      totalPackages: entries.length,
      licenses: licenseCounts,
      violations: violations.length,
      warnings: warnings.length,
    },
    packages: entries,
    violations,
    warnings,
  }
}

// ─── Report Generation ──────────────────────────────────────────────────────

function writeReport(report: LicenseReport, repoRoot: string): string {
  const reportsDir = join(repoRoot, 'reports')
  if (!existsSync(reportsDir)) {
    mkdirSync(reportsDir, { recursive: true })
  }
  const reportPath = join(reportsDir, 'licenses.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  return reportPath
}

// ─── CLI Output ──────────────────────────────────────────────────────────────

function formatLicenseDistribution(licenses: Record<string, number>): string {
  const sorted = Object.entries(licenses).sort((a, b) => b[1] - a[1])
  if (sorted.length === 0) return ''
  const maxNameLen = Math.max(...sorted.map(([name]) => name.length))
  const lines = ['Licenses found:']
  for (const [name, count] of sorted) {
    lines.push(`  ${name.padEnd(maxNameLen + 2)}${count}`)
  }
  lines.push('')
  return lines.join('\n')
}

function formatViolations(violations: PackageEntry[]): string {
  if (violations.length === 0) return ''
  const s = violations.length > 1 ? 's' : ''
  const lines = [`\u274c ${violations.length} violation${s}:`]
  for (const v of violations) {
    lines.push(`  ${v.name}@${v.version}    ${v.license}`)
  }
  lines.push('')
  return lines.join('\n')
}

function formatWarnings(warnings: LicenseReport['warnings']): string {
  if (warnings.length === 0) return ''
  const s = warnings.length > 1 ? 's' : ''
  const lines = [`\u26a0  ${warnings.length} package${s} with unknown license (see report)`]
  for (const w of warnings) {
    lines.push(`  ${w.name}@${w.version}    UNKNOWN`)
  }
  lines.push('')
  return lines.join('\n')
}

function printSummary(report: LicenseReport, reportPath: string): void {
  console.log(`\nLicense Check — ${report.summary.totalPackages} packages scanned\n`)
  const dist = formatLicenseDistribution(report.summary.licenses)
  if (dist) console.log(dist)
  const viol = formatViolations(report.violations)
  if (viol) console.log(viol)
  const warn = formatWarnings(report.warnings)
  if (warn) console.log(warn)
  if (report.violations.length === 0) {
    console.log('\u2705 No violations found')
  }
  console.log(`\nReport written to ${reportPath}`)
}

// ─── Main ────────────────────────────────────────────────────────────────────

/** The repo root, or the temp tree a `--self-test` child is handed by argv — never from the environment. */
function resolveRepoRoot(argv: readonly string[]): string {
  const at = argv.indexOf('--root')
  if (at === -1) return resolve(import.meta.dirname ?? '.', '../..')
  const root = argv[at + 1]
  if (!(argv.includes('--self-test-child') && root)) {
    throw new Error('--root is only accepted by a --self-test child')
  }
  return resolve(root)
}

/**
 * One disallowed shape per tree, so a regression in one detection path cannot hide behind another.
 * `license` is what the report must name as the single violation.
 */
const SELF_TEST_CASES: ReadonlyArray<{
  shape: string
  fields: Record<string, unknown>
  license: string
}> = [
  { shape: 'license string', fields: { license: 'GPL-3.0-only' }, license: 'GPL-3.0-only' },
  {
    shape: 'license object',
    fields: { license: { type: 'GPL-3.0-only' } },
    license: 'GPL-3.0-only',
  },
  {
    shape: 'licenses array of objects',
    fields: { licenses: [{ type: 'GPL-3.0-only' }] },
    license: 'GPL-3.0-only',
  },
  {
    shape: 'licenses array of strings',
    fields: { licenses: ['GPL-3.0-only'] },
    license: 'GPL-3.0-only',
  },
  {
    shape: 'AND expression',
    fields: { license: '(MIT) AND GPL-3.0-only' },
    license: '(MIT) AND GPL-3.0-only',
  },
  ...[
    'MIT and GPL-3.0-only',
    'MIT GPL-3.0-only',
    'MIT / GPL-3.0-only',
    'MIT) AND GPL-3.0-only',
  ].map((license) => ({
    shape: `malformed expression "${license}"`,
    fields: { license },
    license,
  })),
]

/** The parts of a `--json` report the self-test judges, as JSON: package count and `name@version license` per violation. */
function reportShape(report: unknown): string {
  if (!(report && typeof report === 'object' && 'summary' in report && 'violations' in report)) {
    return JSON.stringify(report)
  }
  const { summary, violations } = report
  const totalPackages =
    summary && typeof summary === 'object' && 'totalPackages' in summary
      ? summary.totalPackages
      : undefined
  const named = Array.isArray(violations)
    ? violations.map((v: unknown) =>
        v && typeof v === 'object' && 'name' in v && 'version' in v && 'license' in v
          ? `${String(v.name)}@${String(v.version)} ${String(v.license)}`
          : v,
      )
    : violations
  return JSON.stringify({ totalPackages, violations: named })
}

/** A temp tree under an MIT-only policy: `evil-gpl@1.0.0` with `fields`, or an empty node_modules for `null`. */
function plantTree(fields: Record<string, unknown> | null): string {
  const tmp = mkdtempSync(join(tmpdir(), 'license-checker-self-test-'))
  mkdirSync(join(tmp, 'node_modules'))
  if (fields) {
    const pkgDir = join(tmp, 'node_modules', 'evil-gpl')
    mkdirSync(pkgDir)
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'evil-gpl', version: '1.0.0', ...fields }),
    )
  }
  writeFileSync(join(tmp, '.license-policy.json'), JSON.stringify({ allowedLicenses: ['MIT'] }))
  return tmp
}

/** This file run as a `--json` child with `args`, plus `env` over the current environment. */
function runChild(args: readonly string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--json', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

/**
 * Scan `tmp`, a planted tree holding only `evil-gpl@1.0.0`, as a self-test child.
 * Returns why the scan did not report exactly that package as the single violation, or null.
 */
function selfTestFailure(tmp: string, license: string): string | null {
  const child = runChild(['--self-test-child', '--root', tmp])
  if (child.status !== 1) {
    if (child.stderr) process.stderr.write(child.stderr)
    return `expected exit 1, got ${child.status}`
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(child.stdout)
  } catch {
    return 'exit 1 without a JSON report (the scan never ran)'
  }
  const want = JSON.stringify({ totalPackages: 1, violations: [`evil-gpl@1.0.0 ${license}`] })
  const got = reportShape(parsed)
  return got === want ? null : `expected ${want}, got ${got}`
}

function exitIs(child: { status: number | null }, code: number): string | null {
  return child.status === code ? null : `expected exit ${code}, got ${child.status}`
}

/** A live scan (repo root) with QG_LICENSE_ROOT pointing at the planted tree must not scan that tree. */
function envRootFailure(tmp: string): string | null {
  const child = runChild([], { QG_LICENSE_ROOT: tmp })
  let parsed: unknown
  try {
    parsed = JSON.parse(child.stdout)
  } catch {
    return `no JSON report (exit ${child.status})`
  }
  return reportShape(parsed).includes('evil-gpl@') ? 'QG_LICENSE_ROOT moved the scan root' : null
}

/** The live-path guards: each check gets its own temp tree (planted or empty). */
const GUARD_CASES: ReadonlyArray<{
  guard: string
  planted: boolean
  check: (tmp: string) => string | null
}> = [
  {
    guard: 'an empty scan exits 2',
    planted: false,
    check: (tmp) => exitIs(runChild(['--self-test-child', '--root', tmp]), 2),
  },
  {
    guard: '--root outside a child exits 2',
    planted: true,
    check: (tmp) => exitIs(runChild(['--root', tmp]), 2),
  },
  { guard: 'no environment variable moves the root', planted: true, check: envRootFailure },
]

function withTree<T>(fields: Record<string, unknown> | null, run: (tmp: string) => T): T {
  const tmp = plantTree(fields)
  try {
    return run(tmp)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function selfTest(): never {
  const failures: string[] = []
  for (const { shape, fields, license } of SELF_TEST_CASES) {
    const failure = withTree(fields, (tmp) => selfTestFailure(tmp, license))
    if (failure) failures.push(`(${shape}): ${failure}`)
  }
  for (const { guard, planted, check } of GUARD_CASES) {
    const failure = withTree(planted ? { license: 'GPL-3.0-only' } : null, check)
    if (failure) failures.push(`(${guard}): ${failure}`)
  }
  for (const failure of failures)
    process.stderr.write(`ERROR: licenseChecker --self-test ${failure}\n`)
  process.exit(failures.length ? 1 : 0)
}

function main(): void {
  if (process.argv.includes('--self-test')) {
    selfTest()
  }
  const jsonMode = process.argv.includes('--json')

  try {
    const repoRoot = resolveRepoRoot(process.argv)

    // 1. Validate node_modules exists
    if (!existsSync(join(repoRoot, 'node_modules'))) {
      if (!jsonMode) console.error('Error: Run `bun install` first')
      process.exit(1)
    }

    // 2. Load policy
    const policy = loadPolicy(repoRoot)

    // 3-5. Scan dependencies and check compliance
    const packages = scanDependencies(repoRoot)
    // An empty scan proves nothing: a wrong root or an emptied node_modules would pass.
    if (packages.length === 0) throw new Error(`no package found under ${repoRoot}/node_modules`)
    const report = checkCompliance(packages, policy)

    if (jsonMode) {
      // Machine-readable output: emit JSON, suppress human output
      process.stdout.write(JSON.stringify(report))
    } else {
      // 6. Generate report
      const reportPath = writeReport(report, repoRoot)

      // 7. Print CLI output
      printSummary(report, reportPath)
    }

    // 8. Exit with appropriate code
    process.exit(report.summary.violations > 0 ? 1 : 0)
  } catch (error) {
    if (!jsonMode) console.error(`Error: ${error instanceof Error ? error.message : error}`)
    process.exit(2)
  }
}

// Only run when executed directly, not when imported for testing
if (import.meta.main) {
  main()
}
