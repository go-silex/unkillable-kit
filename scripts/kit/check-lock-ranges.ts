#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
/**
 * check-lock-ranges — workspace ranges vs the versions bun.lock actually resolved.
 * No network. Tree root: this repo. LOCK_RANGES_ROOT overrides it for the
 * self-test. package.json launches the gate with `bun --no-env-file
 * --config=config/kit/bunfig.gates.toml`, so neither a tree `.env` nor a tree
 * `bunfig.toml` (`preload`, `define`) can set the override. That launch is the
 * guarantee: running this file with a bare `bun` gives no such protection.
 * Stability materializes the tracked candidate tree (HEAD, or the staged merge
 * tree) as raw blobs via `ls-tree` + `cat-file --batch` (no checkout filters),
 * then an ordinary offline install in a neutral child env using the same cache
 * as `bun pm cache` (honours tree `.env`). A write-suppression canary follows.
 * Shape checks (CR/BOM/comments, duplicate keys) read the candidate blob, not
 * the working copy. Tracked symlinks must resolve inside the snapshot. Forced
 * `--lockfile-only` is not the oracle. Offline verification may need the local
 * Bun cache. A lock without root workspace `""`, or a blind scan, fails.
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
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assertLockShape, parseJsoncStrict } from './lib/jsonc-strict.ts'
import { gitNoLazyEnv, materializeTree } from './lib/materialize-tree.ts'

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

function candidateTree(root: string): string {
  const env = gitNoLazyEnv()
  const merge = spawnSync('git', ['rev-parse', '--git-path', 'MERGE_HEAD'], { cwd: root, env })
  if (merge.status !== 0) fail('cannot determine merge state')
  if (!existsSync(resolve(root, merge.stdout.toString().trim()))) return 'HEAD'
  const tree = spawnSync('git', ['write-tree'], { cwd: root, env })
  if (tree.status !== 0) fail('cannot verify staged merge tree; resolve conflicts first')
  return tree.stdout.toString().trim()
}

function resolveOperatorCache(root: string): string {
  // Same resolution as a frozen install: honour tree `.env` (no --no-env-file).
  const result = spawnSync(process.execPath, ['pm', 'cache'], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0 || !result.stdout.toString().trim()) {
    throw new Error('cannot resolve Bun package cache; warm the Bun cache and retry')
  }
  return result.stdout.toString().trim()
}

function readCandidateLockBlob(root: string, tree: string): string {
  const result = spawnSync('git', ['cat-file', 'blob', `${tree}:bun.lock`], {
    cwd: root,
    env: gitNoLazyEnv(),
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    const detail = `${result.stderr || result.stdout || ''}`.toString().trim()
    if (/lazy|partial|promisor|filter|not a valid object/i.test(detail)) {
      fail(
        detail
          ? `cannot read candidate bun.lock without fetching (partial clone); ${detail}`
          : 'cannot read candidate bun.lock without fetching (partial clone)',
      )
    }
    fail('missing candidate bun.lock')
  }
  return Buffer.from(result.stdout).toString('utf8')
}

function runOfflineInstall(snapshot: string, cacheDir: string, home: string) {
  return spawnSync(
    process.execPath,
    ['--no-env-file', 'install', '--offline', '--ignore-scripts', '--cache-dir', cacheDir],
    {
      cwd: snapshot,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        TMPDIR: home,
        HOME: home,
        XDG_CONFIG_HOME: home,
      },
    },
  )
}

function probeOfflineInstall(
  snapshot: string,
  cacheDir: string,
  home: string,
  before: Buffer,
): void {
  if (runOfflineInstall(snapshot, cacheDir, home).status !== 0) {
    throw new Error('cannot verify lock stability offline; warm the Bun cache and retry')
  }
  if (!before.equals(readFileSync(join(snapshot, 'bun.lock')))) {
    throw new Error('candidate bun.lock changes on install; regenerate and stage or commit it')
  }
}

const CANARY_SENTINEL = '__lock_ranges_canary__'

/**
 * Write-suppression canary: a bogus `trustedDependencies` entry. Bun rewrites
 * that list from package.json without resolving the name, so a cache that only
 * holds frozen-install tarballs (no `*.npm` manifests) still repairs it.
 */
function assertLockWritesEnabled(
  snapshot: string,
  cacheDir: string,
  home: string,
  original: Buffer,
): void {
  const lockPath = join(snapshot, 'bun.lock')
  const parsed = parseJsoncStrict(original.toString('utf8')) as Record<string, unknown>
  parsed.trustedDependencies = [CANARY_SENTINEL]
  const perturbed = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`)
  writeFileSync(lockPath, perturbed)
  const child = runOfflineInstall(snapshot, cacheDir, home)
  const after = readFileSync(lockPath)
  if (child.status !== 0 || after.equals(perturbed) || after.includes(CANARY_SENTINEL)) {
    throw new Error(
      "the candidate's Bun configuration suppresses lock writes; the stability probe cannot run",
    )
  }
  writeFileSync(lockPath, original)
}

async function checkStability(root: string, tree: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lock-stability-'))
  const snapshot = join(dir, 'tree')
  const home = join(dir, 'home')
  try {
    if (spawnSync('mkdir', ['-p', snapshot, home]).status !== 0) {
      throw new Error('cannot prepare stability workspace')
    }
    const cacheDir = resolveOperatorCache(root)
    await materializeTree(root, tree, snapshot)
    const manifest = JSON.parse(readFileSync(join(snapshot, 'package.json'), 'utf8')) as {
      packageManager?: string
    }
    if (manifest.packageManager !== `bun@${Bun.version}`) {
      throw new Error('cannot verify lock stability without the pinned Bun version')
    }
    // Shape already checked on the candidate blob in main; re-check snapshot bytes.
    const lockText = readFileSync(join(snapshot, 'bun.lock'), 'utf8')
    assertLockShape(lockText)
    const before = Buffer.from(lockText)
    probeOfflineInstall(snapshot, cacheDir, home, before)
    assertLockWritesEnabled(snapshot, cacheDir, home, before)
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    fail(error instanceof Error ? error.message : String(error))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const root = treeRoot()
  const tree = process.env.LOCK_RANGES_ROOT === undefined ? candidateTree(root) : undefined
  // Range scan: staged blob during merge; working lock outside a merge (unchanged).
  const lockText = tree && tree !== 'HEAD' ? readCandidateLockBlob(root, tree) : readLock(root)
  // Shape checks always use the raw candidate blob when stability applies.
  if (tree) assertLockShape(readCandidateLockBlob(root, tree))
  const lock = parseLock(lockText)
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
  if (tree) await checkStability(root, tree)
  console.log(
    `check-lock-ranges: OK (${keys.length} workspace(s), ${tally.checked} range(s) checked, ${tally.skipped} skipped)`,
  )
}

await main()
