#!/usr/bin/env bun
/**
 * CP-MIGRATION-CONTRACT (Roxabi/roxabi-boilerplate-cf#257) — expand → deploy → contract, enforced on D1 migrations.
 *
 * Cloudflare applies `migrations apply --remote` before `wrangler deploy`, so the Worker still
 * serving traffic runs the previous release against the new schema. A migration that removes what
 * that release reads breaks production in the window. Such a migration must be the *contract* step
 * of a later release and say so:
 *
 *   -- kit:contract released=<full sha of the deployed release that stopped using the object>
 *
 * Destructive is measured, not guessed from text: each migration chain is applied in order to an
 * in-memory SQLite database, each file in one transaction as D1 applies it (node:sqlite, which
 * stops at the first failing statement). A file is destructive when a table, view, column, column
 * definition (type, NOT NULL, default, primary key), UNIQUE / PRIMARY KEY index or table storage
 * (rootpage — a rebuild) that existed before it is gone or different after it. Objects a file
 * creates and drops itself never count. A file that SQLite cannot apply fails closed.
 *
 * `released=` must be a full commit sha that does not contain the migration file and is an ancestor
 * of **every** Deploy gate branch (`origin/deploy/*`, Roxabi/roxabi-boilerplate-cf#256) — before a repository's cutover, of the
 * branches Cloudflare builds (`origin/main`, and `origin/staging` when it exists). A file already on
 * every one of them is applied and not re-judged. With none of those refs, the check still fails
 * closed unless the marked file's raw worktree bytes are the blob at that path in a commit reachable
 * from HEAD whose raw header has no `parent` line (Roxabi/roxabi-boilerplate-cf#591). That is this
 * repository's initial snapshot, not a contract against a prior deploy. A shallow repository does
 * not qualify: its commit objects keep parent headers, and revision walking hides those parents.
 * Graft and replace overrides do not qualify. The exception does not prove a sha this repository
 * does not contain. Applied migrations are pinned with path + sha256
 * in config/kit/migrations-contract-grandfathered.txt (kit) and config/product/migrations-contract-
 * grandfathered.txt (product app paths only). Kit apps are the `apps/<name>/` entries of
 * protected_prefixes in config/kit/zero-edit-zones.json — a product app named example-* is a
 * product app. A product copy of a catalog kit module (kit-schema-sync header, payload = catalog
 * kitSha256) is judged at its kit source; in a product, a kit app's contract keeps its marker
 * check, but its released= was judged in the kit.
 *
 * Scope: every D1 migrations_dir of every wrangler config under apps/ (scripts/kit/lib/wrangler-d1.ts,
 * the discovery and parser check-wrangler-migrations-dir.sh uses too).
 * Env: MIGRATIONS_CONTRACT_ROOT — override the repository root (self-test harness).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { kitSchemaPayloadSha256 } from './lib/kit-schema-payload'
import { d1MigrationDirs, wranglerConfigs } from './lib/wrangler-d1'

const ROOT = resolve(process.env.MIGRATIONS_CONTRACT_ROOT ?? join(import.meta.dirname, '../..'))
const KIT_REGISTER = 'config/kit/migrations-contract-grandfathered.txt'
const PRODUCT_REGISTER = 'config/product/migrations-contract-grandfathered.txt'
const CATALOG = 'config/kit/kit-schema-modules.json'
const ZONES = 'config/kit/zero-edit-zones.json'
/** SQLite's own objects; nothing else exists in the measuring database but what the chain creates. */
const INTERNAL = /^sqlite_/

/** columns: name → "type|notnull|default|pk", for tables and views. */
type TableShape = {
  type: string
  rootpage: number
  columns: Map<string, string>
  uniques: Set<string>
}
type Chain = { dir: string; files: string[] }
type Row = Record<string, unknown>
type RegisterOwner = 'kit' | 'product'
type IsKitApp = (path: string) => boolean

/** Kit apps = the `apps/<name>/` protected_prefixes, the list zero-edit protects (Roxabi/roxabi-boilerplate-cf#318). */
function kitAppPrefixes(errors: string[]): string[] {
  let zones: unknown
  try {
    zones = JSON.parse(readFileSync(join(ROOT, ZONES), 'utf8'))
  } catch (e) {
    errors.push(`${ZONES}: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
  const prefixes =
    zones && typeof zones === 'object' && 'protected_prefixes' in zones
      ? zones.protected_prefixes
      : undefined
  const apps = Array.isArray(prefixes)
    ? prefixes.filter((p): p is string => typeof p === 'string' && /^apps\/[^/]+\/$/.test(p))
    : []
  if (apps.length === 0) {
    errors.push(
      `${ZONES}: protected_prefixes names no apps/<name>/ — kit apps cannot be told apart`,
    )
  }
  return apps
}

/** A register holds its owner's app paths only: a pin in the other one escapes that owner's check (Roxabi/roxabi-boilerplate-cf#318). */
function ownerProblem(path: string, owner: RegisterOwner, isKitApp: IsKitApp): string | null {
  const kitApp = isKitApp(path)
  if (owner === 'kit' && !kitApp)
    return `${path} is not a kit app path — product migrations are grandfathered in ${PRODUCT_REGISTER}`
  if (owner === 'product' && kitApp)
    return `${path} is a kit app path — kit migrations are grandfathered in ${KIT_REGISTER}`
  return null
}

function readRegister(
  rel: string,
  owner: RegisterOwner,
  isKitApp: IsKitApp,
  errors: string[],
): Map<string, string> {
  const pins = new Map<string, string>()
  const path = join(ROOT, rel)
  if (!existsSync(path)) return pins
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const text = line.replace(/#.*$/, '').trim()
      if (!text) return
      const m = /^(apps\/\S+\.sql)\s+([0-9a-f]{64})$/.exec(text)
      if (!(m?.[1] && m[2])) {
        errors.push(`${rel}:${i + 1}: expected '<apps/…/*.sql> <sha256>', got '${text}'`)
        return
      }
      const problem = ownerProblem(m[1], owner, isKitApp)
      if (problem) {
        errors.push(`${rel}:${i + 1}: ${problem}`)
        return
      }
      pins.set(m[1], m[2])
    })
  return pins
}

/** kitSha256 of every catalog module; a product copy with that payload is judged at the kit source. */
function catalogShas(): Set<string> {
  const path = join(ROOT, CATALOG)
  if (!existsSync(path)) return new Set()
  const catalog: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const shas = new Set<string>()
  if (
    catalog &&
    typeof catalog === 'object' &&
    'modules' in catalog &&
    Array.isArray(catalog.modules)
  ) {
    for (const m of catalog.modules) {
      if (m && typeof m === 'object' && 'kitSha256' in m && typeof m.kitSha256 === 'string')
        shas.add(m.kitSha256)
    }
  }
  return shas
}

/** Absolute migration dirs discovered under apps/ (wrangler + legacy migrations/). */
function collectMigrationDirs(errors: string[]): string[] {
  const appsDir = join(ROOT, 'apps')
  if (!existsSync(appsDir)) return []
  const dirs = new Set<string>()
  for (const config of wranglerConfigs(appsDir)) {
    try {
      for (const d of d1MigrationDirs(config)) dirs.add(resolve(dirname(config), d))
    } catch (e) {
      errors.push(`${relative(ROOT, config)}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  for (const app of readdirSync(appsDir)) {
    if (existsSync(join(appsDir, app, 'migrations'))) dirs.add(join(appsDir, app, 'migrations'))
  }
  return [...dirs].sort()
}

/** One chain per migrations_dir: each is its own database. */
function chains(errors: string[]): Chain[] {
  const out: Chain[] = []
  for (const abs of collectMigrationDirs(errors)) {
    if (!(existsSync(abs) && statSync(abs).isDirectory())) continue
    const dir = relative(ROOT, abs)
    const files = readdirSync(abs)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => `${dir}/${f}`)
    if (files.length) out.push({ dir, files })
  }
  return out
}

function tableColumns(
  all: (sql: string, ...args: string[]) => Row[],
  name: string,
): Map<string, string> {
  const columns = new Map<string, string>()
  let info: Row[] = []
  try {
    info = all('SELECT name, type, "notnull" AS nn, dflt_value, pk FROM pragma_table_info(?)', name)
  } catch {
    // A view over a dropped table or column yields nothing any more: every column is gone.
  }
  for (const c of info) {
    columns.set(String(c.name), `${c.type}|${c.nn}|${c.dflt_value ?? ''}|${c.pk}`)
  }
  return columns
}

function tableUniques(all: (sql: string, ...args: string[]) => Row[], name: string): Set<string> {
  const uniques = new Set<string>()
  for (const idx of all('SELECT name, origin FROM pragma_index_list(?) WHERE "unique" = 1', name)) {
    const cols = all('SELECT name FROM pragma_index_info(?) ORDER BY seqno', String(idx.name))
      .map((c) => String(c.name))
      .join(',')
    uniques.add(`${idx.origin === 'pk' ? 'PRIMARY KEY' : 'UNIQUE'}(${cols})`)
  }
  return uniques
}

function shape(db: DatabaseSync): Map<string, TableShape> {
  const objects = new Map<string, TableShape>()
  const all = (sql: string, ...args: string[]) => db.prepare(sql).all(...args) as Row[]
  for (const row of all(
    "SELECT type, name, rootpage FROM sqlite_master WHERE type IN ('table', 'view')",
  )) {
    const name = String(row.name)
    if (INTERNAL.test(name)) continue
    objects.set(name, {
      type: String(row.type),
      rootpage: Number(row.rootpage ?? 0),
      columns: tableColumns(all, name),
      uniques: row.type === 'table' ? tableUniques(all, name) : new Set(),
    })
  }
  return objects
}

/** What a still-deployed release could be reading that the file took away. */
function removedObjectProblems(
  name: string,
  was: TableShape,
  now: TableShape | undefined,
): string[] {
  if (!now || now.type !== was.type) return [`${was.type} ${name} is gone`]
  const out: string[] = []
  if (was.type === 'table' && now.rootpage !== was.rootpage) out.push(`table ${name} was rebuilt`)
  for (const [c, def] of was.columns) {
    const cur = now.columns.get(c)
    if (cur === undefined) out.push(`column ${name}.${c} is gone`)
    else if (cur !== def) out.push(`column ${name}.${c} changed (${def} → ${cur})`)
  }
  for (const u of was.uniques) if (!now.uniques.has(u)) out.push(`${u} on ${name} is gone`)
  return out
}

function removed(before: Map<string, TableShape>, after: Map<string, TableShape>): string[] {
  const out: string[] = []
  for (const [name, was] of before) out.push(...removedObjectProblems(name, was, after.get(name)))
  return out
}

type GitRun = { status: number | null; stdout: string }

function gitRun(args: string[], noReplace = false): GitRun {
  const result = spawnSync(
    'git',
    [...(noReplace ? ['--no-replace-objects'] : []), '-C', ROOT, ...args],
    { encoding: 'utf8' },
  )
  return { status: result.status, stdout: result.stdout ?? '' }
}

/** Active graft override. Unreadable common dir fails closed: the waiver must not guess. */
function graftOverrideActive(): boolean {
  if (process.env.GIT_GRAFT_FILE) return true
  const common = gitRun(['rev-parse', '--git-common-dir'])
  if (common.status !== 0 || !common.stdout.trim()) return true
  const dir = common.stdout.trim()
  const grafts = join(dir.startsWith('/') ? dir : resolve(ROOT, dir), 'info', 'grafts')
  if (!existsSync(grafts)) return false
  try {
    return readFileSync(grafts, 'utf8')
      .split('\n')
      .some((line) => {
        const trimmed = line.trim()
        return trimmed.length > 0 && !trimmed.startsWith('#')
      })
  } catch {
    return true
  }
}

/** Raw commit header, not a walk. Shallow objects keep `parent` lines; walking hides them. */
function rawParentless(sha: string): boolean {
  const commit = gitRun(['cat-file', 'commit', sha], true)
  if (commit.status !== 0) return false
  const header = commit.stdout.split('\n\n', 1)[0] ?? ''
  return !/^parent /m.test(header)
}

/**
 * Initial snapshot of this repository: raw worktree bytes match the blob at `file` in a
 * parentless commit reachable from HEAD. Not a proof of commits this repository does not contain.
 * `rev-list --max-parents=0` only enumerates candidates; the raw header decides.
 */
function snapshotBootstrap(file: string): boolean {
  const shallow = gitRun(['rev-parse', '--is-shallow-repository'])
  if (shallow.status !== 0 || shallow.stdout.trim() !== 'false') return false
  if (graftOverrideActive()) return false
  const replacements = gitRun(['for-each-ref', '--format=%(refname)', 'refs/replace'])
  if (replacements.status !== 0 || replacements.stdout.trim()) return false
  const listed = gitRun(['rev-list', '--max-parents=0', 'HEAD'])
  if (listed.status !== 0) return false
  const raw = gitRun(['hash-object', '--no-filters', '--', file])
  if (raw.status !== 0) return false
  const blob = raw.stdout.trim()
  for (const sha of listed.stdout.split('\n').filter(Boolean)) {
    if (!rawParentless(sha)) continue
    const at = gitRun(['rev-parse', `${sha}:${file}`], true)
    if (at.status === 0 && at.stdout.trim() === blob) return true
  }
  return false
}

function releasedWithoutBaseline(
  git: (args: string[]) => { status: number | null },
  ref: string,
  file: string,
): string | null {
  if (!/^[0-9a-f]{40}$/.test(ref)) {
    return `released=${ref} is not a full 40-hex commit sha (a ref or short sha moves)`
  }
  if (
    git(['cat-file', '-e', `${ref}^{commit}`]).status === 0 &&
    git(['cat-file', '-e', `${ref}:${file}`]).status === 0
  ) {
    return `released=${ref} already contains ${file} — the contract must ship in a later release`
  }
  if (snapshotBootstrap(file)) return null
  return `released=${ref} cannot be checked: no origin/deploy/* nor origin/main`
}

/**
 * `released=<sha>`: a full commit sha (a moving ref would re-judge the file on every later commit)
 * that does not contain this migration yet and was deployed everywhere the file will be applied.
 * No baseline ref: `releasedWithoutBaseline` (Roxabi/roxabi-boilerplate-cf#591).
 */
function releasedProblem(ref: string, file: string): string | null {
  const git = (args: string[]) => spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' })
  const refs = (prefix: string) =>
    git(['for-each-ref', '--format=%(refname)', prefix]).stdout.split('\n').filter(Boolean)
  const deploy = refs('refs/remotes/origin/deploy/')
  const bases = deploy.length
    ? deploy
    : [...refs('refs/remotes/origin/main'), ...refs('refs/remotes/origin/staging')]
  const shown = bases.map((b) => b.replace('refs/remotes/', '')).join(', ')
  if (!bases.length) return releasedWithoutBaseline(git, ref, file)
  if (bases.every((b) => git(['cat-file', '-e', `${b}:${file}`]).status === 0)) return null
  if (!/^[0-9a-f]{40}$/.test(ref)) {
    return `released=${ref} is not a full 40-hex commit sha (a ref or short sha moves)`
  }
  if (git(['cat-file', '-e', `${ref}^{commit}`]).status !== 0) {
    return `released=${ref} does not resolve to a commit in this repository`
  }
  if (git(['cat-file', '-e', `${ref}:${file}`]).status === 0) {
    return `released=${ref} already contains ${file} — the contract must ship in a later release`
  }
  const missing = bases.filter((b) => git(['merge-base', '--is-ancestor', ref, b]).status !== 0)
  if (missing.length) {
    return `released=${ref} is not deployed on ${missing.map((b) => b.replace('refs/remotes/', '')).join(', ')} (checked: ${shown})`
  }
  return null
}

function apply(db: DatabaseSync, sql: string): string | null {
  try {
    db.exec('BEGIN')
    db.exec(sql)
    db.exec('COMMIT')
    return null
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // no transaction left to roll back
    }
    return e instanceof Error ? e.message : String(e)
  }
}
type JudgeCtx = {
  pins: Map<string, string>
  kitModules: Set<string>
  productMode: boolean
  isKitApp: IsKitApp
  note: (file: string, problem: string) => void
}

type JudgeResult =
  | { kind: 'break' }
  | { kind: 'grandfathered' }
  | { kind: 'kit-copy' }
  | { kind: 'judged' }

function pinVerdict(file: string, abs: string, ctx: JudgeCtx): JudgeResult | null {
  const pin = ctx.pins.get(file)
  if (pin === undefined) return null
  if (pin === createHash('sha256').update(readFileSync(abs)).digest('hex')) {
    return { kind: 'grandfathered' }
  }
  ctx.note(file, 'grandfathered with another sha256 — an applied migration was edited')
  return { kind: 'judged' }
}

function kitCopyVerdict(file: string, abs: string, sql: string, ctx: JudgeCtx): JudgeResult | null {
  // Only the starter's headed copies may reuse the catalog verdict inside a kit app.
  // Kit source migrations and every other kit app remain independently judged.
  if (ctx.isKitApp(file)) {
    if (!/^apps\/starter-api\/migrations\/[^/]+\.sql$/.test(file)) return null
    if (!sql.startsWith('-- kit-schema: ')) return null
  }
  const payload = kitSchemaPayloadSha256(abs)
  if (payload !== null && ctx.kitModules.has(payload)) return { kind: 'kit-copy' }
  return null
}

function noteContractProblems(
  file: string,
  sql: string,
  before: Map<string, TableShape>,
  db: DatabaseSync,
  ctx: JudgeCtx,
): void {
  const marker = /^\s*--\s*kit:contract\b(.*)$/m.exec(sql)
  const ref = marker?.[1] ? /\breleased=(\S+)/.exec(marker[1])?.[1] : undefined
  if (marker && !ref) {
    ctx.note(
      file,
      '`-- kit:contract` needs released=<full sha of the release that stopped using the object>',
    )
  }
  // In a product, a kit app's contract was judged against the kit's own deploys.
  const problem =
    ref && !(ctx.productMode && ctx.isKitApp(file)) ? releasedProblem(ref, file) : null
  if (problem) ctx.note(file, problem)
  const destroyed = removed(before, shape(db))
  if (destroyed.length && !(ref && !problem)) {
    for (const d of destroyed)
      ctx.note(file, `${d} without a valid \`-- kit:contract released=<commit>\``)
  }
}

function judgeOneMigration(db: DatabaseSync, file: string, ctx: JudgeCtx): JudgeResult {
  const abs = join(ROOT, file)
  const sql = readFileSync(abs, 'utf8')
  const before = shape(db)
  const failure = apply(db, sql)
  if (failure) {
    ctx.note(file, `cannot be applied to SQLite, so it cannot be judged: ${failure}`)
    return { kind: 'break' }
  }
  const pinned = pinVerdict(file, abs, ctx)
  if (pinned) return pinned
  const kit = kitCopyVerdict(file, abs, sql, ctx)
  if (kit) return kit
  noteContractProblems(file, sql, before, db, ctx)
  return { kind: 'judged' }
}

function tallyResult(
  result: JudgeResult,
  counts: { grandfathered: number; kitCopies: number },
): 'continue' | 'break' {
  if (result.kind === 'break') return 'break'
  if (result.kind === 'grandfathered') counts.grandfathered++
  if (result.kind === 'kit-copy') counts.kitCopies++
  return 'continue'
}

function runChains(
  errors: string[],
  ctx: JudgeCtx,
): { files: number; grandfathered: number; kitCopies: number } {
  const counts = { grandfathered: 0, kitCopies: 0 }
  let files = 0
  for (const chain of chains(errors)) {
    // Double-quoted string literals stay allowed, as in stock SQLite.
    const db = new DatabaseSync(':memory:', { enableDoubleQuotedStringLiterals: true })
    db.exec('PRAGMA foreign_keys = ON')
    for (const file of chain.files) {
      files++
      if (tallyResult(judgeOneMigration(db, file, ctx), counts) === 'break') break
    }
    db.close()
  }
  return { files, ...counts }
}

function reportFindings(errors: string[], findings: Map<string, string[]>): boolean {
  for (const e of errors) console.error(`check-migrations-contract: config error: ${e}`)
  for (const [file, problems] of findings) {
    console.error(`check-migrations-contract: ${file}`)
    for (const p of problems) console.error(`  ${p}`)
  }
  return errors.length > 0 || findings.size > 0
}

function main(): void {
  const errors: string[] = []
  const kitApps = kitAppPrefixes(errors)
  const isKitApp: IsKitApp = (path) => kitApps.some((prefix) => path.startsWith(prefix))
  const pins = new Map([
    ...readRegister(KIT_REGISTER, 'kit', isKitApp, errors),
    ...readRegister(PRODUCT_REGISTER, 'product', isKitApp, errors),
  ])
  const findings = new Map<string, string[]>()
  const note = (file: string, problem: string) =>
    findings.set(file, [...(findings.get(file) ?? []), problem])
  const ctx: JudgeCtx = {
    pins,
    kitModules: catalogShas(),
    productMode: existsSync(join(ROOT, 'config/product/inheritance.json')),
    isKitApp,
    note,
  }
  const { files, grandfathered, kitCopies } = runChains(errors, ctx)
  if (reportFindings(errors, findings)) {
    console.error(
      'check-migrations-contract: FAIL — expand (additive migration + code tolerant of both schemas) → deploy → contract (destructive migration in a later release, marked). docs/kit/deploy-cloudflare.md §5b',
    )
    process.exit(1)
  }
  console.log(
    `check-migrations-contract: OK (${files} migration(s), ${grandfathered} grandfathered, ${kitCopies} kit-module copies)`,
  )
}

main()
