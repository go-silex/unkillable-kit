#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
/**
 * check-lock-ranges — workspace ranges vs the versions bun.lock actually resolved.
 * No network. Tree root: this repo. LOCK_RANGES_ROOT overrides it for the
 * self-test. package.json launches the gate with `bun --no-env-file
 * --config=config/kit/bunfig.gates.toml`, so neither a tree `.env` nor a tree
 * `bunfig.toml` (`preload`, `define`) can set the override. That launch is the
 * guarantee: running this file with a bare `bun` gives no such protection.
 * Lock normalization checks committed HEAD inputs only; unstaged and untracked
 * files are deliberately outside its scope. Offline verification requires the
 * local Bun cache when resolution cannot be completed from the lock alone.
 * A lock without the root workspace `""`, or a scan that checks no range, fails.
 *
 * Scope: every `workspaces` entry in bun.lock, root `""` included. For each of
 * `dependencies`, `devDependencies` and `optionalDependencies`, the resolved
 * version must satisfy the effective spec. The effective spec is the string
 * `overrides[dep]` at the lock root when that key is present, otherwise the
 * spec declared on the workspace. bun.lock records overrides next to
 * `workspaces` (this repo: `"overrides": { "vite": "^8.3.0" }`).
 *
 * Resolution lookup, in order:
 *   1. `packages["<workspace name>/<dep>"]` — nested, wins over hoisted.
 *      Real key: `@kit/mcp-example/@cloudflare/workers-types`.
 *   2. `packages["<dep>"]` — hoisted.
 *      Real key: `@tanstack/react-hotkeys` → `["@tanstack/react-hotkeys@0.12.0", …]`.
 * The version is the semver in the first array element (`name@version`).
 * A `workspace:` dep is stored as `name@workspace:<path>` (e.g.
 * `@kit/auth@workspace:packages/auth`) and is skipped via its spec, not via
 * that entry. An `npm:` alias (`npm:pkg@^1`) is skipped: the lock records the
 * target package's version under the alias key, and this gate does not rewrite
 * the alias onto that target's range.
 *
 * NOT checked: `peerDependencies` / `optionalPeers`, and the ranges a package
 * declares for its own dependencies (the `dependencies` object inside a
 * `packages[]` info record). Those are peer and transitive constraints, not
 * the workspace manifest range an inherit merge can desync.
 *
 * Skipped (counted, not checked): `workspace:`, `catalog:`, `file:`, `link:`,
 * `tarball:`, `npm:` aliases, `git:` / `git+` / `github:`, `http:` / `https:` /
 * `ssh:` URLs, npm's prefix-less forms — git shorthand `owner/repo[#ref]` and
 * paths (`./`, `../`, `~/`, `/`) — `*`, `x` / `X`, and dist-tags with no digit
 * (`latest`, `next`, …). A range with no packages entry is a finding (lock out
 * of sync). A spec that is neither a skip nor a semver range fails closed:
 * Bun.semver.satisfies returns true for non-ranges, which would hide the defect.
 * Its repair is a spec rewrite, which `bun update` cannot do.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

const PROTOCOL =
  /^(?:workspace:|catalog:|file:|link:|npm:|git:|git\+|github:|https?:|ssh:|tarball:)/
/** npm's prefix-less forms: a semver range never contains `/`. */
const GIT_SHORTHAND = /^[\w.-]+\/[\w.-]+(?:#.+)?$/
const PATH_SPEC = /^(?:\.{1,2}\/|~\/|\/)/

const VERSION_CORE =
  'v?(?:0|[1-9]\\d*|[xX*])(?:\\.(?:0|[1-9]\\d*|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?'
const COMPARATOR = new RegExp(`^(?:[~^]|>=|<=|>|<|=)?\\s*${VERSION_CORE}$`)
const HYPHEN = new RegExp(`^${VERSION_CORE}\\s+-\\s+${VERSION_CORE}$`)
const REGISTRY_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

type LockWorkspace = {
  name?: unknown
  dependencies?: unknown
  devDependencies?: unknown
  optionalDependencies?: unknown
}

type LockFile = {
  workspaces: Record<string, unknown>
  packages: Record<string, unknown>
  overrides: Record<string, unknown>
}

type Finding = {
  workspace: string
  section: string
  dep: string
  spec: string
  override: boolean
  resolved: string
  detail: string
  /** The spec's form is wrong, not its resolution: `bun update` cannot repair it. */
  shape?: true
}

type Tally = { checked: number; skipped: number; findings: Finding[] }

function fail(message: string): never {
  console.error(`check-lock-ranges: FAIL ${message}`)
  process.exit(1)
}

function objectMap(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function readLock(root: string): string {
  const path = join(root, 'bun.lock')
  if (!existsSync(path)) fail('missing bun.lock')
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    fail(`unreadable bun.lock: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseLock(text: string): LockFile {
  let parsed: unknown
  try {
    parsed = Bun.JSONC.parse(text)
  } catch (error) {
    fail(`unparseable bun.lock: ${error instanceof Error ? error.message : String(error)}`)
  }
  const root = objectMap(parsed)
  const workspaces = root ? objectMap(root.workspaces) : undefined
  const packages = root ? objectMap(root.packages) : undefined
  if (!(root && workspaces && packages))
    fail('unparseable bun.lock: missing workspaces or packages')
  if (!Object.hasOwn(workspaces, '')) fail('unparseable bun.lock: no root workspace ""')
  if (root.overrides !== undefined && !objectMap(root.overrides)) {
    fail('unparseable bun.lock: overrides is not an object')
  }
  return {
    workspaces,
    packages,
    overrides: objectMap(root.overrides) ?? {},
  }
}

/** Protocol, wildcard, or dist-tag. Null means the spec must be a range. */
function skipReason(spec: string): string | null {
  const trimmed = spec.trim()
  if (trimmed === '*' || trimmed === 'x' || trimmed === 'X') return 'wildcard'
  if (PROTOCOL.test(trimmed)) return 'protocol'
  if (GIT_SHORTHAND.test(trimmed)) return 'git shorthand'
  if (PATH_SPEC.test(trimmed)) return 'path'
  if (!/\d/.test(trimmed)) return 'tag'
  return null
}

/** Shape only; `Bun.semver.satisfies` reads the spec as written, so `>= 1.0.0` is joined here. */
function isRange(spec: string): boolean {
  const parts = spec.trim().split(/\s*\|\|\s*/)
  if (parts.length === 0 || parts.some((part) => part === '')) return false
  return parts.every((part) => {
    const piece = part.trim().replace(/(>=|<=|>|<|=|~|\^)\s+/g, '$1')
    if (HYPHEN.test(piece)) return true
    const comparators = piece.split(/\s+/).filter((token) => token.length > 0)
    return comparators.length > 0 && comparators.every((token) => COMPARATOR.test(token))
  })
}

/** `name@version` or `@scope/name@version`. The second `@` splits a scoped id. */
function splitPkgId(pkgId: string): { name: string; resolution: string } | null {
  const at = pkgId.startsWith('@') ? pkgId.indexOf('@', pkgId.indexOf('/') + 1) : pkgId.indexOf('@')
  if (at <= 0) return null
  return { name: pkgId.slice(0, at), resolution: pkgId.slice(at + 1) }
}

/**
 * The registry version an entry resolved for `dep`, or the finding's `resolved` / `detail`.
 * The entry must name `dep` itself: a range spec (`npm:` aliases are skipped earlier) never
 * installs another package, so a matching version under another name is no proof.
 */
function registryVersion(
  entry: unknown,
  dep: string,
): { version: string } | { resolved: string; detail: string } {
  const pkgId = Array.isArray(entry) && typeof entry[0] === 'string' ? entry[0] : null
  const split = pkgId === null ? null : splitPkgId(pkgId)
  if (!(pkgId && split)) {
    return { resolved: '<unreadable>', detail: 'resolution is not a registry version' }
  }
  if (split.name !== dep) {
    return { resolved: pkgId, detail: `lock entry is package ${split.name}, not ${dep}` }
  }
  if (!REGISTRY_VERSION.test(split.resolution)) {
    return { resolved: '<not a registry version>', detail: 'resolution is not a registry version' }
  }
  return { version: split.resolution }
}

/** `bun update <dep>` rewrites the workspace manifest too (`^2.0.0` → `^2.1.3`), so the repair names it. */
function format(finding: Finding): string {
  const via = finding.override ? ' (override)' : ''
  const manifest = finding.workspace === '.' ? 'package.json' : `${finding.workspace}/package.json`
  const where = finding.override ? 'the root package.json overrides' : manifest
  const fix = finding.shape
    ? `write a semver range, or a form this gate skips (scripts/kit/check-lock-ranges.ts header), in ${where}, ` +
      "then run `bun install` and stage bun.lock; `bun update` cannot change a spec's form"
    : finding.override
      ? 'fix the override or the lock'
      : `run \`bun update ${finding.dep}\` from ${finding.workspace}, then stage bun.lock and ${manifest}` +
        ' (it rewrites both); a kit workspace in a product takes the kit lock instead' +
        ' (docs/kit/product-consumer-contract.md § Pulling kit upgrades)'
  return (
    `${finding.workspace} ${finding.section}: ${finding.dep} ` +
    `spec ${JSON.stringify(finding.spec)}${via} resolved ${finding.resolved}; ` +
    `${finding.detail}; repair: ${fix}`
  )
}

function checkDep(
  tally: Tally,
  packages: Record<string, unknown>,
  workspace: string,
  workspaceName: string | undefined,
  section: string,
  dep: string,
  declared: unknown,
  override: unknown,
): void {
  const fromOverride = override !== undefined
  const spec = fromOverride ? override : declared
  const base = { workspace, section, dep, override: fromOverride }
  if (typeof spec !== 'string') {
    tally.findings.push({
      ...base,
      spec: '',
      resolved: '<none>',
      detail: fromOverride ? 'override is not a string' : 'spec is not a string',
      shape: true,
    })
    tally.checked += 1
    return
  }
  if (skipReason(spec)) {
    tally.skipped += 1
    return
  }
  if (!isRange(spec)) {
    tally.findings.push({
      ...base,
      spec,
      resolved: '<none>',
      detail: 'spec is not a checkable range',
      shape: true,
    })
    tally.checked += 1
    return
  }
  tally.checked += 1
  const nested = workspaceName ? packages[`${workspaceName}/${dep}`] : undefined
  const entry = nested !== undefined ? nested : packages[dep]
  if (entry === undefined) {
    tally.findings.push({ ...base, spec, resolved: '<none>', detail: 'lock out of sync' })
    return
  }
  const resolution = registryVersion(entry, dep)
  if (!('version' in resolution)) {
    tally.findings.push({ ...base, spec, ...resolution })
    return
  }
  const { version } = resolution
  if (!Bun.semver.satisfies(version, spec.trim())) {
    tally.findings.push({
      ...base,
      spec,
      resolved: version,
      detail: 'does not satisfy the range',
    })
  }
}

function checkSection(
  tally: Tally,
  packages: Record<string, unknown>,
  overrides: Record<string, unknown>,
  workspace: string,
  workspaceName: string | undefined,
  section: (typeof SECTIONS)[number],
  declared: unknown,
): void {
  const deps = objectMap(declared)
  if (!deps) {
    tally.findings.push({
      workspace,
      section,
      dep: section,
      spec: '',
      override: false,
      resolved: '<none>',
      detail: 'dependency map is not an object',
    })
    tally.checked += 1
    return
  }
  for (const dep of Object.keys(deps).sort()) {
    checkDep(tally, packages, workspace, workspaceName, section, dep, deps[dep], overrides[dep])
  }
}

function checkWorkspace(
  tally: Tally,
  packages: Record<string, unknown>,
  overrides: Record<string, unknown>,
  key: string,
  workspace: unknown,
): void {
  const path = key === '' ? '.' : key
  const entry = objectMap(workspace) as LockWorkspace | undefined
  if (!entry) {
    tally.findings.push({
      workspace: path,
      section: 'workspaces',
      dep: path,
      spec: '',
      override: false,
      resolved: '<none>',
      detail: 'workspace entry is not an object',
    })
    tally.checked += 1
    return
  }
  const workspaceName = typeof entry.name === 'string' ? entry.name : undefined
  for (const section of SECTIONS) {
    if (entry[section] === undefined) continue
    checkSection(tally, packages, overrides, path, workspaceName, section, entry[section])
  }
}

function treeRoot(): string {
  const override = process.env.LOCK_RANGES_ROOT
  if (override === undefined) return realpathSync(join(import.meta.dirname, '../..'))
  try {
    return realpathSync(resolve(override))
  } catch {
    fail(`missing root ${override}`)
  }
}

function checkCommittedNormalization(root: string): void {
  const list = spawnSync('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD'], { cwd: root })
  if (list.status !== 0) fail('cannot list committed lock inputs')
  const paths = list.stdout
    .toString()
    .split('\0')
    .filter(
      (path) =>
        path === 'bun.lock' ||
        path === 'bunfig.toml' ||
        basename(path) === 'package.json' ||
        path.startsWith('config/kit/patches/'),
    )
  if (!(paths.includes('bun.lock') && paths.includes('package.json')))
    fail('committed lock inputs are missing')
  const dir = mkdtempSync(join(tmpdir(), 'lock-normalization-'))
  try {
    const archive = spawnSync('git', ['archive', 'HEAD', '--', ...paths], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    })
    if (archive.status !== 0) throw new Error('cannot archive committed lock inputs')
    const extract = spawnSync('tar', ['-xf', '-', '-C', dir], { input: archive.stdout })
    if (extract.status !== 0) throw new Error('cannot extract committed lock inputs')
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (manifest.packageManager !== `bun@${Bun.version}`)
      throw new Error('cannot verify lock normalization without the pinned Bun version')
    const before = readFileSync(join(dir, 'bun.lock'))
    const install = spawnSync(
      process.execPath,
      ['install', '--lockfile-only', '--offline', '--ignore-scripts', '--minimum-release-age', '0'],
      { cwd: dir },
    )
    if (install.status !== 0)
      throw new Error('cannot verify lock normalization offline; warm the Bun cache and retry')
    if (!before.equals(readFileSync(join(dir, 'bun.lock'))))
      throw new Error('committed bun.lock changes on install; regenerate and commit it')
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    fail(error instanceof Error ? error.message : String(error))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function main(): void {
  const root = treeRoot()
  const lock = parseLock(readLock(root))
  const tally: Tally = { checked: 0, skipped: 0, findings: [] }
  const keys = Object.keys(lock.workspaces).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  for (const key of keys) {
    checkWorkspace(tally, lock.packages, lock.overrides, key, lock.workspaces[key])
  }
  if (tally.checked === 0) fail('no range checked — the scan is blind')
  if (tally.findings.length > 0) {
    for (const finding of tally.findings) console.error(format(finding))
    console.error(`check-lock-ranges: FAIL (${tally.findings.length} finding(s))`)
    process.exit(1)
  }
  if (process.env.LOCK_RANGES_ROOT === undefined) checkCommittedNormalization(root)
  console.log(
    `check-lock-ranges: OK (${keys.length} workspace(s), ${tally.checked} range(s) checked, ${tally.skipped} skipped)`,
  )
}

main()
