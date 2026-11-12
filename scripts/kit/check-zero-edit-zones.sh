#!/usr/bin/env bash
# Fail if a product consumer diverges from inherited kit tip on protected paths
# without a valid, non-expired exception entry. ADR-0009.
#
# Modes:
#   kit     — allowlisted kit/mirror origin, no product inheritance marker
#   product — inheritance marker (or transitional kit-baseline) present
#
# Base (product): config/product/inheritance.json → upstreamCommit
#   transitional: docs/product/kit-baseline
#   NEVER upstream/main. NEVER auto-fetch.
#   The base must be an inherited kit/mirror tip: it may not descend from the commit that introduced the
#   marker (a product commit), and the history must be complete (shallow clone fails closed).
#   Exceptions granted/extended after zones exception_expiry.effective_from run at most max_days.
#
# See config/kit/zero-edit-zones.json · docs/kit/architecture/adr/0009-…
set -euo pipefail

# Script lives at scripts/kit/ → monorepo is ../..
CHECKER_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${ZERO_EDIT_ROOT:-$(cd "$CHECKER_DIR/../.." && pwd)}"
cd "$ROOT"

ZONES_FILE="${ZERO_EDIT_ZONES_FILE:-config/kit/zero-edit-zones.json}"
if [[ ! -f "$ZONES_FILE" ]]; then
  echo "check-zero-edit-zones: missing $ZONES_FILE" >&2
  exit 1
fi

export ROOT ZONES_FILE CHECKER_DIR
export ZERO_EDIT_MODE="${ZERO_EDIT_MODE:-}"
export ZERO_EDIT_HARNESS_SENTINEL="${ZERO_EDIT_HARNESS_SENTINEL:-}"
export ZERO_EDIT_DEPENDABOT_PREFLIGHT="${1:-}"

exec node --input-type=module <<'NODE'
import { readFileSync, existsSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { lstatSync } from 'node:fs'
const require = createRequire(join(process.env.ROOT, 'package.json'))

const root = process.env.ROOT
// resolve: ZERO_EDIT_ZONES_FILE may be absolute (dry-running a consumer with this checkout's zones).
const zonesPath = resolve(root, process.env.ZONES_FILE)

function die(msg, code = 1) {
  console.error(`check-zero-edit-zones: ${msg}`)
  process.exit(code)
}

function loadJson(path, label) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    die(`invalid JSON (${label}): ${path}: ${e.message}`)
  }
}

function git(args, { allowFail = false, trim = true } = {}) {
  try {
    const out = execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    return trim ? out.trim() : out
  } catch (e) {
    if (allowFail) return ''
    const err = (e.stderr || e.message || '').toString()
    die(`git ${args.join(' ')} failed:\n${err}`)
  }
}

function gitLines(args) {
  const out = git(args)
  if (!out) return []
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

function gitPaths(args) {
  return git(args, { trim: false }).split('\0').filter(Boolean)
}

function refExists(ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return true
  } catch {
    return false
  }
}

function isAncestor(anc, head = 'HEAD') {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', anc, head], {
      cwd: root,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

function normalizeOriginUrl(url) {
  let u = (url || '').trim()
  if (!u) return ''
  u = u.replace(/\.git$/, '')
  const ssh = u.match(/^git@github\.com:(.+)$/)
  if (ssh) return ssh[1]
  const https = u.match(/^https:\/\/github\.com\/(.+)$/)
  if (https) return https[1]
  return u
}

function listTrackedUnder(prefix) {
  return gitPaths(['ls-files', '-z', '--', prefix])
}

/**
 * Walk working tree dirs for unclassified paths under namespaced trees (tracked only).
 * ADR-0009 D1 amendment (Roxabi/roxabi-boilerplate-cf#259): a path an external tool fixes outside the namespaces is
 * classified only when listed exactly in tool_mandated_paths — never by protected_files alone,
 * never by directory or basename.
 */
function inventoryUnclassified(zones) {
  const trees = zones.namespaced_trees || ['config', 'scripts', 'docs']
  const kitNs = zones.kit_namespace || 'kit'
  const prodNs = zones.product_namespace || 'product'
  const listed = new Set(zones.tool_mandated_paths || [])
  const bad = []
  for (const tree of trees) {
    const files = listTrackedUnder(`${tree}/`)
    for (const f of files) {
      if (listed.has(f)) continue
      const parts = f.split('/')
      if (parts.length < 2) {
        bad.push(f)
        continue
      }
      const ns = parts[1]
      if (ns !== kitNs && ns !== prodNs) bad.push(f)
    }
  }
  return bad
}

/** Tracked workflows must be product-prefixed or listed in protected_files (ADR-0009 D6, ADR-0013). */
function inventoryUnclassifiedWorkflows(zones) {
  const dir = zones.workflow_dir || '.github/workflows'
  const prefix = zones.workflow_product_prefix || 'product-'
  const listed = new Set(zones.protected_files || [])
  const bad = []
  for (const f of listTrackedUnder(dir)) {
    if (basename(f).startsWith(prefix)) continue
    if (!listed.has(f)) bad.push(f)
  }
  return bad
}

const zones = loadJson(zonesPath, 'zones')
if (!zones || zones.version !== 1) die(`zones config must have version: 1 (${zonesPath})`)
if (!Array.isArray(zones.protected_prefixes) || !Array.isArray(zones.protected_files)) {
  die('zones must define protected_prefixes and protected_files arrays')
}
// A tool-mandated path is kit-owned: it must also be dual-edit protected, or the inventory
// would classify a file every product could rewrite (ADR-0009 D1 amendment).
if (zones.tool_mandated_paths !== undefined && !Array.isArray(zones.tool_mandated_paths)) {
  die('zones tool_mandated_paths must be an array')
}
for (const p of zones.tool_mandated_paths || []) {
  if (!zones.protected_files.includes(p)) die(`tool_mandated_paths entry not in protected_files: ${p}`)
}
// The apps/<name>/ protected_prefixes are the kit-app list (Roxabi/roxabi-boilerplate-cf#318). Any other apps entry would stay
// protected while isFreeProductAppPath, the migrations contract and extract-dry-run read that app
// as a product app, so the shape is a config error.
for (const p of zones.protected_prefixes) {
  if (/^(\.\/)?apps(\/|$)/.test(p) && !/^apps\/[^/]+\/$/.test(p)) {
    die(`protected_prefixes apps entry must be exactly apps/<name>/ (the kit-app list, Roxabi/roxabi-boilerplate-cf#318): ${p}`)
  }
}

// Exceptions are time-boxed from the day their expiry was granted, not from a date the product picks
// (ADR-0009 D4 threat model). The cap is kit-owned config: absent/malformed is a config error, never "no cap".
const expiryCap = zones.exception_expiry
if (
  !expiryCap ||
  !Number.isInteger(expiryCap.max_days) ||
  expiryCap.max_days < 1 ||
  !/^\d{4}-\d{2}-\d{2}$/.test(expiryCap.effective_from || '')
) {
  die('zones exception_expiry must be { max_days: <int ≥ 1>, effective_from: "YYYY-MM-DD" }')
}

const inheritanceFile = zones.inheritance_file || 'config/product/inheritance.json'
const inheritancePath = join(root, inheritanceFile)
const allowlist = new Set(zones.kit_origin_allowlist || [])

const originUrl = git(['remote', 'get-url', 'origin'], { allowFail: true })
const originId = normalizeOriginUrl(originUrl)
const ghRepo = (process.env.GITHUB_REPOSITORY || '').trim()
const identity = ghRepo || originId
const onAllowlist = identity !== '' && allowlist.has(identity)

const inheritanceDoc = loadJson(inheritancePath, 'inheritance')
const hasInheritance = Boolean(inheritanceDoc?.upstreamCommit)

// Mode resolution (ADR-0009 D5)
let mode
const modeEnv = process.env.ZERO_EDIT_MODE || ''
const harnessOk =
  modeEnv &&
  process.env.ZERO_EDIT_HARNESS_SENTINEL &&
  existsSync(process.env.ZERO_EDIT_HARNESS_SENTINEL)

if (modeEnv) {
  if (!harnessOk) {
    die(
      `ZERO_EDIT_MODE is set but ZERO_EDIT_HARNESS_SENTINEL is missing/unusable — forbidden on normal lefthook/CI (ADR-0009 D5)`,
    )
  }
  mode = modeEnv
} else if (hasInheritance) {
  if (onAllowlist) {
    die(
      `inheritance marker present on kit-allowlisted origin "${identity}" — mirrors/kits must not carry product markers`,
    )
  }
  mode = 'product'
} else if (onAllowlist) {
  mode = 'kit'
} else {
  die(
    `cannot classify repo (no marker, origin/identity "${identity || '(empty)'}" not in kit_origin_allowlist).\n` +
      `  Product: add ${inheritanceFile} after merge upstream.\n` +
      `  Kit/mirror: add repo to config/kit/zero-edit-zones.json kit_origin_allowlist.`,
  )
}

console.log(`== check-zero-edit-zones: mode=${mode} identity=${identity || '(none)'} ==`)

// Inventory gate (ADR-0009 D1/D6) — always
const unclassified = inventoryUnclassified(zones)
if (unclassified.length) {
  console.error('check-zero-edit-zones: unclassified paths under config|scripts|docs (need kit/ or product/):')
  for (const f of unclassified.slice(0, 50)) console.error(`  UNCLASSIFIED ${f}`)
  if (unclassified.length > 50) console.error(`  … +${unclassified.length - 50} more`)
  die('inventory gate failed (ADR-0009 D1)')
}

const unclassifiedWorkflows = inventoryUnclassifiedWorkflows(zones)
if (unclassifiedWorkflows.length) {
  console.error(
    'check-zero-edit-zones: unclassified workflows under .github/workflows (name product-*.yml / product-*.yaml or add to protected_files):',
  )
  for (const f of unclassifiedWorkflows.slice(0, 50)) console.error(`  UNCLASSIFIED WORKFLOW ${f}`)
  if (unclassifiedWorkflows.length > 50) console.error(`  … +${unclassifiedWorkflows.length - 50} more`)
  die('workflow inventory gate failed (ADR-0009 D6, ADR-0013)')
}

const exceptionsRel = zones.exceptions_file || 'config/product/zero-edit-exceptions.json'
const exceptionsPath = join(root, exceptionsRel)
const exceptionsDoc = loadJson(exceptionsPath, 'exceptions')

/** @type {Map<string, object>} */
const exceptionByPath = new Map()
const today = new Date()
today.setHours(0, 0, 0, 0)

function validateException(ex, idx) {
  const req = [
    'path',
    'reason',
    'owner',
    'expires',
    'ticket',
    'alternatives_considered',
    'why_not_alternative',
  ]
  for (const k of req) {
    if (ex[k] === undefined || ex[k] === null || ex[k] === '') {
      die(`exception[${idx}] missing required field "${k}" in ${exceptionsPath}`)
    }
  }
  if (!Array.isArray(ex.alternatives_considered) || ex.alternatives_considered.length === 0) {
    die(`exception[${idx}] alternatives_considered must be a non-empty array`)
  }
  if (typeof ex.why_not_alternative !== 'string' || ex.why_not_alternative.trim().length < 10) {
    die(
      `exception[${idx}] why_not_alternative must explain (≥10 chars) why design overrides / product paths fail`,
    )
  }
  if (typeof ex.reason !== 'string' || ex.reason.trim().length < 10) {
    die(`exception[${idx}] reason too short`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ex.expires)) {
    die(`exception[${idx}] expires must be YYYY-MM-DD`)
  }
  const exp = new Date(ex.expires + 'T00:00:00')
  if (Number.isNaN(exp.getTime())) die(`exception[${idx}] invalid expires date`)
  return { ...ex, expired: exp < today }
}

if (exceptionsDoc) {
  if (exceptionsDoc.version !== 1) die(`exceptions version must be 1 (${exceptionsPath})`)
  if (!Array.isArray(exceptionsDoc.exceptions)) die(`exceptions.exceptions must be an array`)
  exceptionsDoc.exceptions.forEach((ex, i) => {
    const v = validateException(ex, i)
    if (exceptionByPath.has(v.path)) die(`duplicate exception path: ${v.path}`)
    exceptionByPath.set(v.path, v)
  })
}

function isProtected(relPath) {
  const p = relPath.replace(/^\.\//, '')
  for (const pref of zones.protected_prefixes) {
    if (p === pref.replace(/\/$/, '') || p.startsWith(pref)) return true
  }
  for (const f of zones.protected_files) {
    if (p === f) return true
  }
  return false
}

// Kit apps = the apps/<name>/ protected_prefixes, the list check-migrations-contract reads too (Roxabi/roxabi-boilerplate-cf#318).
const kitAppPrefixes = zones.protected_prefixes.filter((p) => /^apps\/[^/]+\/$/.test(p))

function isFreeProductAppPath(relPath) {
  const p = relPath.replace(/^\.\//, '')
  if (!p.startsWith('apps/')) return false
  return !kitAppPrefixes.some((pref) => p === pref.replace(/\/$/, '') || p.startsWith(pref))
}

if (mode === 'kit') {
  const expired = [...exceptionByPath.values()].filter((e) => e.expired)
  if (expired.length) {
    console.error(
      'check-zero-edit-zones: WARNING expired exceptions present (product cleanup when dual-mission):',
    )
    for (const e of expired) {
      console.error(`  - ${e.path} expired ${e.expires} ticket=${e.ticket}`)
    }
  }
  console.log('check-zero-edit-zones: OK (kit mode — config valid, no upstream diff)')
  if (zones.design_overrides?.patterns?.length) {
    console.log(
      `  design_overrides: ${zones.design_overrides.patterns.map((p) => p.id).join(', ')}`,
    )
  }
  process.exit(0)
}

if (mode !== 'product') {
  die(`unknown mode "${mode}" (use kit|product)`)
}

// Resolve base (ADR-0009 D4 / Roxabi/roxabi-boilerplate-cf#107) — inheritance.json only; never upstream/main
let baseRef = ''
let baseSource = inheritanceFile

if (!hasInheritance) {
  die(`product mode requires ${inheritanceFile} with upstreamCommit (full SHA)`)
}
{
  const sha = String(inheritanceDoc.upstreamCommit || '').trim()
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    die(`${inheritanceFile}: upstreamCommit must be a full 40-char SHA`)
  }
  baseRef = sha
}

if ((process.env.ZERO_EDIT_BASE_REF || '').trim()) {
  die('ZERO_EDIT_BASE_REF is removed (Roxabi/roxabi-boilerplate-cf#107) — use config/product/inheritance.json only')
}

if (!refExists(baseRef)) {
  die(
    `base commit ${baseRef} not in local history (from ${baseSource}).\n` +
      `  Deepen checkout / re-merge upstream — checker never auto-fetches.`,
  )
}

if (!isAncestor(baseRef, 'HEAD')) {
  die(`base ${baseRef} is not an ancestor of HEAD — marker must be an inherited tip`)
}

// Base lineage (ADR-0009 D4 threat model). The base must be an inherited kit/mirror tip, never a commit
// the product authored: any base that hides a kit-path edit has to contain that edit, so it has to be a
// product commit, and every product commit descends from the commit that introduced the marker.
// This also closes the delete-and-re-add launder: the commit that deleted the marker descends from its
// first introduction, so pinning the marker to it is refused here without a separate deletion rule.
// A shallow clone truncates the ancestry this reads (its boundary commit looks like an introduction),
// so it fails closed — the documented CI checkout is fetch-depth 0.
if (git(['rev-parse', '--is-shallow-repository']) === 'true') {
  die(
    'shallow clone — cannot verify the inheritance marker lineage.\n' +
      '  Deepen the checkout (fetch-depth: 0 / git fetch --unshallow) — checker never auto-fetches.',
  )
}
const productAncestor = git([
  'log', '--full-history', '-m', '--no-renames', '--diff-filter=A', '-1', '--format=%H',
  baseRef, '--', inheritanceFile,
])
if (productAncestor) {
  die(
    `base ${baseRef} descends from ${productAncestor}, which introduced ${inheritanceFile} — ` +
      `the marker must point at an inherited kit/mirror tip, not at a product commit.\n` +
      `  Re-pin it to the upstream tip you merged (e.g. git rev-parse upstream/main) — never to a commit of this repo.`,
  )
}

// Expiry cap: only an expiry granted or extended on/after effective_from is capped; earlier ones are
// grandfathered until they expire. The grant day is the author date of the first-parent commit that
// last extended the entry's expiry (a shortening keeps the old grant day), or today when uncommitted.
function isoDay(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function dayNumber(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86400000
}
function exceptionExpiriesAt(rev) {
  let text
  try {
    text = execFileSync('git', ['show', `${rev}:${exceptionsRel}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return new Map() // file absent at this revision
  }
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return null // unparsable revision: keeps the previous state
  }
  const out = new Map()
  for (const ex of Array.isArray(doc?.exceptions) ? doc.exceptions : []) {
    if (typeof ex?.path === 'string' && typeof ex?.expires === 'string') out.set(ex.path, ex.expires)
  }
  return out
}
function exceptionsOverCap() {
  if (exceptionByPath.size === 0) return []
  const granted = new Map() // path -> { expires, day }
  const revs = gitLines([
    'log', '--first-parent', '--reverse', '--format=%H%x09%aI', '--', exceptionsRel,
  ])
  for (const line of revs) {
    const [rev, authored] = line.split('\t')
    const at = exceptionExpiriesAt(rev)
    if (at === null) continue
    for (const known of [...granted.keys()]) if (!at.has(known)) granted.delete(known)
    for (const [p, expires] of at) {
      const prev = granted.get(p)
      if (!prev || expires > prev.expires) granted.set(p, { expires, day: authored.slice(0, 10) })
      else if (expires < prev.expires) granted.set(p, { expires, day: prev.day })
    }
  }
  const todayIso = isoDay(today)
  const over = []
  for (const [p, ex] of exceptionByPath) {
    const prev = granted.get(p)
    let day
    if (prev && prev.expires === ex.expires) day = prev.day
    else if (prev && ex.expires < prev.expires) day = prev.day
    else day = todayIso
    if (day < expiryCap.effective_from) continue
    const limit = dayNumber(day) + expiryCap.max_days
    if (dayNumber(ex.expires) > limit) over.push({ path: p, expires: ex.expires, day })
  }
  return over
}
const overCap = exceptionsOverCap()

const pathspecs = [...zones.protected_prefixes, ...zones.protected_files]

const changed = new Set([
  ...gitPaths(['diff', '--name-only', '-z', baseRef, 'HEAD', '--', ...pathspecs]),
  ...gitPaths(['diff', '--name-only', '-z', 'HEAD', '--', ...pathspecs]),
  ...gitPaths(['diff', '--cached', '--name-only', '-z', '--', ...pathspecs]),
  ...gitPaths(['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspecs]),
])

const violations = []
const expiredHits = []
const covered = []

const dependabotPath = '.github/dependabot.yml'
// This fixed tool path is checked independently of the untrusted zones pathspecs:
// an exception on zones must not suppress the canonical configuration rule.
const dependabotChanged = [
  ['diff', '--no-renames', '--name-only', '-z', baseRef, 'HEAD'],
  ['diff', '--no-renames', '--name-only', '-z', 'HEAD'],
  ['diff', '--no-renames', '--cached', '--name-only', '-z'],
  ['ls-files', '--others', '--exclude-standard', '-z'],
].some((args) => gitPaths([...args, '--', `:(literal)${dependabotPath}`]).length > 0)
if (dependabotChanged) changed.add(dependabotPath)
const dependabotPreflight = process.env.ZERO_EDIT_DEPENDABOT_PREFLIGHT === '--product-dependabot-preflight'
const alternateDependabot = '.github/dependabot.yaml'
let alternateExists = false
try { lstatSync(join(root, alternateDependabot)); alternateExists = true } catch (error) {
  if (error.code !== 'ENOENT') die(`cannot inspect ${alternateDependabot}: ${error.message}`)
}
if (alternateExists || gitPaths(['ls-files', '-z', '--', alternateDependabot]).length) {
  die(`${alternateDependabot} is forbidden in Product; use the canonical .github/dependabot.yml`)
}
if (dependabotChanged || dependabotPreflight) {
  for (const [path, actual] of [
    ['config/kit/zero-edit-zones.json', zonesPath],
    ['scripts/kit/lib/product-dependabot.cjs', join(process.env.CHECKER_DIR, 'lib/product-dependabot.cjs')],
  ]) {
    try {
      if (!lstatSync(actual).isFile()) throw new Error('not a regular file')
      const inherited = execFileSync('git', ['show', `${baseRef}:${path}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
      if (!readFileSync(actual).equals(inherited)) throw new Error('differs from inherited baseline')
      if (
        gitPaths(['diff', '--no-renames', '--name-only', '-z', baseRef, 'HEAD', '--', path]).length ||
        gitPaths(['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--', path]).length ||
        gitPaths(['diff', '--no-renames', '--cached', '--name-only', '-z', '--', path]).length
      ) throw new Error('index, history or working tree differs from inherited baseline')
    } catch (error) {
      die(`untrusted Product Dependabot policy ${path}: ${error.message}`)
    }
  }
}
if (dependabotChanged && !dependabotPreflight) {
  try {
    for (const p of ['.github', dependabotPath]) {
      const stat = lstatSync(join(root, p))
      if (stat.isSymbolicLink() || (p === dependabotPath ? !stat.isFile() : !stat.isDirectory())) throw new Error('noncanonical file')
    }
    const indexEntry = git(['ls-files', '--stage', '--', dependabotPath])
    if (!/^100644 [0-9a-f]+ 0\t\.github\/dependabot\.yml$/.test(indexEntry)) throw new Error('noncanonical index entry')
    const { productManifestDirectories, renderProductDependabot } = require(join(process.env.CHECKER_DIR, 'lib/product-dependabot.cjs'))
    const expected = renderProductDependabot(productManifestDirectories(root, zones))
    if (readFileSync(join(root, dependabotPath), 'utf8') !== expected) throw new Error('content differs from canonical Product configuration')
    if (gitPaths(['diff', '--cached', '--no-renames', '--name-only', '-z', '--', `:(literal)${dependabotPath}`]).length) {
      const staged = execFileSync('git', ['show', `:${dependabotPath}`], { cwd: root, encoding: 'utf8' })
      if (staged !== expected) throw new Error('staged content differs from canonical Product configuration')
    }
  } catch (error) {
    die(`invalid Product Dependabot configuration: ${error.message}`)
  }
}

for (const file of [...changed].sort()) {
  if (!isProtected(file)) continue
  if (isFreeProductAppPath(file)) continue
  if (file === dependabotPath && !exceptionByPath.has(file)) continue

  const ex = exceptionByPath.get(file)
  if (!ex) {
    violations.push(file)
    continue
  }
  if (ex.expired) {
    expiredHits.push(ex)
    continue
  }
  covered.push(ex)
}

const stale = []
for (const [path, ex] of exceptionByPath) {
  if (!changed.has(path) && !ex.expired) stale.push(ex)
}

if (covered.length) {
  console.log('check-zero-edit-zones: allowed exceptions (active):')
  for (const ex of covered) {
    console.log(`  OK  ${ex.path}`)
    console.log(`      owner=${ex.owner} expires=${ex.expires} ticket=${ex.ticket}`)
  }
}

if (stale.length) {
  console.log(
    'check-zero-edit-zones: stale exceptions (path no longer diverges — remove entry):',
  )
  for (const ex of stale) {
    console.log(`  STALE ${ex.path} (expires ${ex.expires})`)
  }
}

let failed = false

if (expiredHits.length) {
  failed = true
  console.error(
    'check-zero-edit-zones: EXPIRED exceptions (renew with new justification or drop the kit patch):',
  )
  for (const ex of expiredHits) {
    console.error(`  EXPIRED ${ex.path} since ${ex.expires}`)
    console.error(`    ticket=${ex.ticket}`)
  }
}

if (overCap.length) {
  failed = true
  console.error(
    `check-zero-edit-zones: exceptions granted or extended on/after ${expiryCap.effective_from} may run at most ${expiryCap.max_days} days:`,
  )
  for (const o of overCap) {
    console.error(`  OVER CAP ${o.path} expires ${o.expires} (granted ${o.day}, max ${expiryCap.max_days} days)`)
  }
  console.error('  Shorten the expiry, or renew in a new commit (a renewal is capped from its own date).')
}

if (violations.length) {
  failed = true
  console.error('check-zero-edit-zones: DIVERGED kit paths without exception:')
  for (const f of violations) {
    console.error(`  FORBIDDEN ${f}`)
  }
  console.error('')
  console.error('Fix options (prefer top):')
  console.error(
    `  1. Take the kit's file: git checkout ${baseRef} -- <path>; git rm a path the kit does not ship (e.g. .nvmrc)`,
  )
  console.error(
    '  2. Design override — CSS tokens / wrap @kit/ui in apps/<product>-web (see design_overrides)',
  )
  console.error('  3. Move logic to apps/<product>-* or config|docs|scripts/product/')
  console.error('  4. Contribute fix on kit parent, then merge upstream + refresh inheritance.json')
  console.error(
    `  5. Last resort: ${zones.exceptions_file} (from ${zones.exceptions_example})`,
  )
}

if (failed) {
  console.error('check-zero-edit-zones: FAILED')
  process.exit(1)
}

console.log(
  dependabotPreflight
    ? `check-zero-edit-zones: PREFLIGHT ONLY (Dependabot content not validated, base=${baseRef})`
    : `check-zero-edit-zones: OK (product mode, base=${baseRef}, source=${baseSource}, diverged_covered=${covered.length})`,
)
process.exit(0)
NODE
