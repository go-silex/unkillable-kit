/**
 * Deploy-gate declaration check (Roxabi/roxabi-boilerplate-cf#317, Roxabi/roxabi-boilerplate-cf#325).
 * Shared with promotion so `--check` and `requiredWorkflows()` judge the same product config.
 * Workflow rules follow the GitHub Actions filter-pattern cheat sheet (not Bun.Glob / minimatch):
 * `*` is any run of non-`/` chars, `**` is any chars, `?` / `+` quantify the preceding atom, `[]`
 * is one listed char or range, a leading `!` excludes, last match wins.
 *
 * Kit workflows `ci.yml` and `secret-scan.yml` are judged by the same push and job rules. The
 * Product CI name rule is not applied to them. An undeclared product workflow is not a finding:
 * a staged retirement keeps the old file until that undeclaration is promoted.
 *
 * `continue-on-error` on an inspected job, step, or callee is a finding unless it is boolean
 * false. Absent is accepted. An expression is not. Step-level `if` is ignored.
 *
 * A job-level `if` is a finding unless this checker can prove it true on push. It never evaluates
 * expressions. After stripping an optional `${{ }}` wrapper and balanced outer groups, it splits
 * top-level `||` then `&&`, outside single quotes and nested groups. OR needs one proven branch;
 * AND needs every branch proven. The recognized atoms are exact `always()` and
 * `github.event_name != 'pull_request'` or `github.event_name == 'push'` with either operand order.
 * Unknown atoms, negation and unbalanced quotes or groups are not proven. Expression syntax is
 * independently checked by pinned actionlint in `promote-deploy.ts --check`. A local callee whose
 * `on` has no `workflow_call` is a finding too: actionlint only sees that in a git project.
 *
 * A shape the checker does not model is a finding, never skipped: a `push` that is neither null
 * nor a mapping, a `branches` value that is not a string or a list of strings (YAML parses an
 * unquoted `!main` as null), a job that is not a mapping, a `needs` naming no job of the workflow,
 * a local `uses: ./…` callee that is not a file under `.github/workflows/` or is already in its
 * own call chain, and a remote job-level `uses:` (the checker cannot open it). A local callee's
 * jobs are judged by the same job rules in the caller's push context (a called workflow's
 * `github` context is the caller's).
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { INHERITANCE_MARKER, PRODUCT_CONFIG, parseDeclaration } from './product-declaration.cjs'

export const KIT_WORKFLOWS = [
  '.github/workflows/ci.yml',
  '.github/workflows/secret-scan.yml',
] as const

export const PRODUCT_WORKFLOW_NAME = 'Product CI'

export type GateFinding = { file: string; finding: string }

type LoadedWorkflows = {
  paths: string[]
  product: string[]
  /** Promotion refuses on the first; `--check` prints every `finding`. */
  findings: Array<GateFinding & { refusal: string }>
}

/** Product workflows declared for this tree. Does not exit — `--check` reports every finding. */
function loadRequiredWorkflows(root = '.'): LoadedWorkflows {
  let text: string | null = null
  try {
    text = readFileSync(join(root, PRODUCT_CONFIG), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      const detail = error instanceof Error ? error.message : String(error)
      const refusal = `${PRODUCT_CONFIG} is not readable: ${detail}`
      return {
        paths: [...KIT_WORKFLOWS],
        product: [],
        findings: [{ file: PRODUCT_CONFIG, finding: refusal, refusal }],
      }
    }
  }
  const { product, findings } = parseDeclaration(text, existsSync(join(root, INHERITANCE_MARKER)))
  return {
    paths: [...KIT_WORKFLOWS, ...product],
    product,
    findings: findings.map((finding) => ({ file: PRODUCT_CONFIG, ...finding })),
  }
}

function escapeRegex(ch: string): string {
  return /[\\^$+*?()|[\]{}.]/.test(ch) ? `\\${ch}` : ch
}

const isRangeChar = (ch: string | undefined): ch is string =>
  ch !== undefined && /[a-zA-Z0-9]/.test(ch)

function classChar(ch: string): string {
  return ch === '\\' || ch === ']' || ch === '^' || ch === '-' ? `\\${ch}` : ch
}

/** Inclusive range `a-z` starting at `i`, or null. Ranges are alphanumeric only. */
function classRange(pattern: string, i: number): { text: string; next: number } | null {
  const start = pattern[i]
  const dash = pattern[i + 1]
  const end = pattern[i + 2]
  if (dash !== '-' || end === ']' || !isRangeChar(start) || !isRangeChar(end) || start > end) {
    return null
  }
  return { text: `${start}-${end}`, next: i + 3 }
}

/** One `[...]` atom, or null when unclosed (`[` stays literal). `!` inside is not negation. */
function classAtom(pattern: string, start: number): { atom: string; next: number } | null {
  let i = start + 1
  let body = ''
  let first = true
  while (i < pattern.length) {
    const ch = pattern[i] ?? ''
    if (ch === '\\' && i + 1 < pattern.length) {
      body += classChar(pattern[i + 1] ?? '')
      i += 2
      first = false
      continue
    }
    if (ch === ']' && !first) {
      return { atom: body.length === 0 ? '(?!)' : `[${body}]`, next: i + 1 }
    }
    const range = classRange(pattern, i)
    if (range) {
      body += range.text
      i = range.next
      first = false
      continue
    }
    body += classChar(ch)
    i += 1
    first = false
  }
  return null
}

type Piece = { source: string; quantified: boolean }

function pushPiece(pieces: Piece[], source: string): void {
  pieces.push({ source, quantified: false })
}

function quantifyLast(pieces: Piece[], mark: '?' | '+'): void {
  const last = pieces.at(-1)
  if (!last || last.quantified) {
    pushPiece(pieces, escapeRegex(mark))
    return
  }
  last.source = mark === '?' ? `(?:${last.source})?` : `(?:${last.source})+`
  last.quantified = true
}

function takeAtom(pattern: string, i: number, pieces: Piece[]): number {
  const ch = pattern[i] ?? ''
  if (ch === '\\' && i + 1 < pattern.length) {
    pushPiece(pieces, escapeRegex(pattern[i + 1] ?? ''))
    return i + 2
  }
  if (ch === '*' && pattern[i + 1] === '*') {
    pushPiece(pieces, '[\\s\\S]*')
    return i + 2
  }
  if (ch === '*') {
    pushPiece(pieces, '[^/]*')
    return i + 1
  }
  if (ch === '?' || ch === '+') {
    quantifyLast(pieces, ch)
    return i + 1
  }
  if (ch === '[') {
    const parsed = classAtom(pattern, i)
    if (parsed) {
      pushPiece(pieces, parsed.atom)
      return parsed.next
    }
  }
  pushPiece(pieces, escapeRegex(ch))
  return i + 1
}

/** One GitHub filter pattern, anchored. `?`/`+` quantify the preceding atom. */
function filterMatches(pattern: string, value: string): boolean {
  const pieces: Piece[] = []
  let i = 0
  while (i < pattern.length) i = takeAtom(pattern, i, pieces)
  return new RegExp(`^${pieces.map((piece) => piece.source).join('')}$`).test(value)
}

/**
 * Branch list under GitHub filter-pattern semantics. Only-negative lists match
 * nothing. A leading `!` excludes; the last matching pattern wins.
 */
function filterAdmits(patterns: readonly string[], branch: string): boolean {
  let matched = false
  let positive = false
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (filterMatches(pattern.slice(1), branch)) matched = false
      continue
    }
    positive = true
    if (filterMatches(pattern, branch)) matched = true
  }
  return positive && matched
}

/** Null unless a string or a list of strings: an unquoted `!main` entry parses as null. */
function patternsOf(value: unknown): string[] | null {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return null
  return value.every((entry): entry is string => typeof entry === 'string') ? value : null
}

function filterPresent(push: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(push, key) && push[key] != null
}

function namedPushFilters(push: Record<string, unknown>): string[] {
  const findings: string[] = []
  for (const key of ['paths', 'paths-ignore', 'branches-ignore'] as const) {
    if (filterPresent(push, key)) findings.push(`push has ${key}`)
  }
  return findings
}

function tagOnlyFinding(push: Record<string, unknown>): string | null {
  if (filterPresent(push, 'branches') || filterPresent(push, 'branches-ignore')) return null
  const tagKeys = ['tags', 'tags-ignore'].filter((key) => filterPresent(push, key))
  if (tagKeys.length === 0) return null
  return `push has ${tagKeys.join(' and ')} but no branches — branch pushes never run it`
}

function branchPushFindings(push: Record<string, unknown>, branch: string): string[] {
  const findings: string[] = []
  const tags = tagOnlyFinding(push)
  if (tags) findings.push(tags)
  if (!filterPresent(push, 'branches')) return findings
  const patterns = patternsOf(push.branches)
  if (patterns === null) {
    findings.push(
      'push.branches is not a string or a list of strings — quote patterns that start with !, * or [',
    )
  } else if (!filterAdmits(patterns, branch)) {
    findings.push(`push.branches does not admit '${branch}'`)
  }
  return findings
}

function pushMapFindings(push: unknown, branch: string): string[] {
  if (push === null) return []
  if (typeof push !== 'object' || Array.isArray(push)) {
    return [`push is ${JSON.stringify(push)}, not a mapping of filters`]
  }
  const map = push as Record<string, unknown>
  return [...namedPushFilters(map), ...branchPushFindings(map, branch)]
}

/** YAML 1.1 may parse the bare key `on` as boolean true (object key `"true"`). */
function triggerValue(doc: Record<string, unknown>): unknown {
  if (Object.hasOwn(doc, 'on')) return doc.on
  if (Object.hasOwn(doc, 'true')) return doc.true
  return undefined
}

function pushEvent(on: unknown): { present: false } | { present: true; push: unknown } {
  if (on === 'push' || (Array.isArray(on) && on.includes('push'))) {
    return { present: true, push: null }
  }
  if (on === null || typeof on !== 'object' || Array.isArray(on)) return { present: false }
  const map = on as Record<string, unknown>
  if (!Object.hasOwn(map, 'push')) return { present: false }
  return { present: true, push: map.push }
}

function nameFinding(doc: Record<string, unknown>): string | null {
  if (doc.name === PRODUCT_WORKFLOW_NAME) return null
  const got =
    typeof doc.name === 'string'
      ? `'${doc.name}'`
      : doc.name === undefined
        ? 'missing'
        : JSON.stringify(doc.name)
  return `name is ${got}, not '${PRODUCT_WORKFLOW_NAME}'`
}

/** Operands that cannot be false on push. Lookup only — expressions are not evaluated. */
const PUSH_TRUE_OPERAND: Record<string, true> = {
  "github.event_name != 'pull_request'": true,
  "'pull_request' != github.event_name": true,
  "github.event_name == 'push'": true,
  "'push' == github.event_name": true,
}

function unwrapExpression(raw: string): string | null {
  const text = raw.trim()
  if (!text.startsWith('${{')) return text
  if (!text.endsWith('}}')) return null
  return text.slice(3, -2).trim()
}

type ExprScan = { depth: number; quote: boolean; broken: boolean }

function applyChar(depth: number, quote: boolean, ch: string): ExprScan {
  if (quote) return { depth, quote: ch !== "'", broken: false }
  if (ch === "'") return { depth, quote: true, broken: false }
  if (ch === '(') return { depth: depth + 1, quote, broken: false }
  if (ch !== ')') return { depth, quote, broken: false }
  if (depth === 0) return { depth, quote, broken: true }
  return { depth: depth - 1, quote, broken: false }
}

/** Split a top-level boolean operator outside quotes; reject unbalanced input. */
function splitTopLevel(expr: string, operator: '||' | '&&'): string[] | null {
  const parts: string[] = []
  let start = 0
  let depth = 0
  let quote = false
  for (let i = 0; i < expr.length; i++) {
    const next = applyChar(depth, quote, expr[i] ?? '')
    if (next.broken) return null
    depth = next.depth
    quote = next.quote
    if (depth !== 0 || quote || expr[i] !== operator[0] || expr[i + 1] !== operator[1]) continue
    parts.push(expr.slice(start, i))
    i += 1
    start = i + 1
  }
  if (quote || depth !== 0) return null
  parts.push(expr.slice(start))
  return parts
}

/** True when `text` is one parenthesized span. False if not; null if unbalanced. */
function wrapsInParens(text: string): boolean | null {
  if (!text.startsWith('(')) return false
  let depth = 0
  let quote = false
  let closedAt = -1
  for (let i = 0; i < text.length; i++) {
    const next = applyChar(depth, quote, text[i] ?? '')
    if (next.broken) return null
    depth = next.depth
    quote = next.quote
    if (depth === 0 && text[i] === ')' && closedAt === -1) closedAt = i
  }
  if (quote || depth !== 0) return null
  return closedAt === text.length - 1
}

function stripOuterParens(operand: string): string | null {
  let text = operand.trim()
  while (true) {
    const wraps = wrapsInParens(text)
    if (wraps === null) return null
    if (!wraps) return text
    text = text.slice(1, -1).trim()
  }
}

function pushExpressionHolds(expr: string): boolean {
  const text = stripOuterParens(expr)
  if (text === null) return false
  const alternatives = splitTopLevel(text, '||')
  if (alternatives === null) return false
  if (alternatives.length > 1) return alternatives.some(pushExpressionHolds)
  const conjuncts = splitTopLevel(text, '&&')
  if (conjuncts === null) return false
  if (conjuncts.length > 1) return conjuncts.every(pushExpressionHolds)
  return text === 'always()' || PUSH_TRUE_OPERAND[text.replaceAll(/\s+/g, ' ')] === true
}

function pushIfHolds(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const expr = unwrapExpression(value)
  return expr !== null && pushExpressionHolds(expr)
}

const LOCAL_CALLEE = /^\.\/\.github\/workflows\/[\w.-]+\.ya?ml$/

function needsFindings(id: string, needs: unknown, ids: readonly string[]): string[] {
  if (needs === undefined) return []
  const list = typeof needs === 'string' ? [needs] : needs
  if (!(Array.isArray(list) && list.every((need): need is string => typeof need === 'string'))) {
    return [`job '${id}' needs is not a job id or a list of job ids`]
  }
  return list
    .filter((need) => !ids.includes(need))
    .map((need) => `job '${id}' needs '${need}', which is not a job in this workflow`)
}

function continueOnErrorFinding(owner: string, value: unknown): string | null {
  if (value === false) return null
  return `${owner} continue-on-error is not false`
}

function stepFindings(id: string, steps: unknown): string[] {
  if (steps === undefined) return []
  if (!Array.isArray(steps)) return [`job '${id}' steps is not a list`]
  const findings: string[] = []
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]
    const owner = `job '${id}' step ${index + 1}`
    if (step === null || typeof step !== 'object' || Array.isArray(step)) {
      findings.push(`${owner} is not a mapping`)
      continue
    }
    const map = step as Record<string, unknown>
    if (!('continue-on-error' in map)) continue
    const finding = continueOnErrorFinding(owner, map['continue-on-error'])
    if (finding) findings.push(finding)
  }
  return findings
}

/** Presence only. actionlint cannot read a local callee unless the tree is a git project. */
function hasWorkflowCall(on: unknown): boolean {
  if (on === 'workflow_call') return true
  if (Array.isArray(on)) return on.includes('workflow_call')
  if (on !== null && typeof on === 'object') {
    return Object.hasOwn(on, 'workflow_call')
  }
  return false
}

/**
 * A job-level `uses:` runs another workflow's jobs in this run. A local callee GitHub cannot load
 * fails the run at startup; a loadable one is judged by the job rules over its own jobs. A remote
 * callee cannot be opened, so it is a shape the check does not model.
 */
function calleeFindings(
  root: string,
  id: string,
  uses: unknown,
  chain: readonly string[],
  files: Set<string>,
): string[] {
  if (uses === undefined) return []
  if (typeof uses !== 'string') return [`job '${id}' uses is not a workflow reference`]
  if (!uses.startsWith('./'))
    return [`job '${id}' calls ${uses}, a remote workflow the check cannot open`]
  const abs = join(root, uses)
  if (!(LOCAL_CALLEE.test(uses) && existsSync(abs) && statSync(abs).isFile())) {
    return [`job '${id}' calls ${uses}, which is not a workflow file under .github/workflows/`]
  }
  if (chain.includes(uses)) return [`job '${id}' calls ${uses}, which is already in its call chain`]
  files.add(uses.startsWith('./') ? uses.slice(2) : uses)
  const doc = readWorkflowDoc(abs)
  const prefix = `job '${id}' calls ${uses}`
  if (typeof doc === 'string') return [`${prefix}: ${doc}`]
  const findings: string[] = []
  if (!hasWorkflowCall(triggerValue(doc))) {
    findings.push(`${prefix}, whose on has no workflow_call`)
  }
  findings.push(
    ...jobFindings(doc.jobs, root, [...chain, uses], files).map(
      (finding) => `${prefix}: ${finding}`,
    ),
  )
  return findings
}

function oneJobFindings(
  root: string,
  id: string,
  job: unknown,
  ids: readonly string[],
  chain: readonly string[],
  files: Set<string>,
): string[] {
  if (job === null || typeof job !== 'object' || Array.isArray(job)) {
    return [`job '${id}' is not a mapping`]
  }
  const map = job as Record<string, unknown>
  const findings = needsFindings(id, map.needs, ids)
  if ('if' in map && !pushIfHolds(map.if)) {
    findings.push(`job '${id}' has a job-level if the check cannot prove true on push`)
  }
  if ('continue-on-error' in map) {
    const finding = continueOnErrorFinding(`job '${id}'`, map['continue-on-error'])
    if (finding) findings.push(finding)
  }
  findings.push(...stepFindings(id, map.steps))
  findings.push(...calleeFindings(root, id, map.uses, chain, files))
  return findings
}

/** `chain` holds the `./`-relative workflows of the current call path, outermost first. */
function jobFindings(
  jobs: unknown,
  root: string,
  chain: readonly string[],
  files: Set<string>,
): string[] {
  if (jobs === null || typeof jobs !== 'object' || Array.isArray(jobs)) return ['zero jobs']
  const map = jobs as Record<string, unknown>
  const ids = Object.keys(map)
  if (ids.length === 0) return ['zero jobs']
  return ids.sort().flatMap((id) => oneJobFindings(root, id, map[id], ids, chain, files))
}

function workflowFindings(
  doc: Record<string, unknown>,
  branch: string,
  root: string,
  rel: string,
  enforceName: boolean,
  files: Set<string>,
): string[] {
  const findings: string[] = []
  if (enforceName) {
    const name = nameFinding(doc)
    if (name) findings.push(name)
  }
  const event = pushEvent(triggerValue(doc))
  if (!event.present) findings.push('no push trigger')
  else findings.push(...pushMapFindings(event.push, branch))
  findings.push(...jobFindings(doc.jobs, root, [`./${rel}`], files))
  files.add(rel)
  return findings
}

/** The YAML mapping at `abs`, or why it is not one. */
function readWorkflowDoc(abs: string): Record<string, unknown> | string {
  let doc: unknown
  try {
    doc = Bun.YAML.parse(readFileSync(abs, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error)
    return `not parseable YAML (${detail})`
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return 'not a YAML mapping'
  return doc as Record<string, unknown>
}

function inspectWorkflow(
  root: string,
  rel: string,
  branch: string,
  enforceName: boolean,
): { findings: GateFinding[]; files: string[] } {
  const abs = join(root, rel)
  if (!(existsSync(abs) && statSync(abs).isFile())) {
    return { findings: [{ file: rel, finding: 'file missing' }], files: [] }
  }
  const doc = readWorkflowDoc(abs)
  const files = new Set<string>()
  const raw =
    typeof doc === 'string' ? [doc] : workflowFindings(doc, branch, root, rel, enforceName, files)
  if (typeof doc !== 'string') files.add(rel)
  return { findings: raw.map((finding) => ({ file: rel, finding })), files: [...files] }
}

/** Working-tree declaration, plus `retained` paths judged here even if undeclared. Each path once. `count` is the declaration size. */
export function checkDeployGate(
  root: string,
  branch: string,
  retained: readonly string[] = [],
): { count: number; findings: GateFinding[]; syntaxFiles: string[] } {
  const loaded = loadRequiredWorkflows(root)
  const findings: GateFinding[] = loaded.findings.map(({ file, finding }) => ({ file, finding }))
  const syntaxFiles = new Set<string>()
  const seen = new Set<string>()
  const inspect = (rel: string, enforceName: boolean) => {
    if (seen.has(rel)) return
    seen.add(rel)
    const inspected = inspectWorkflow(root, rel, branch, enforceName)
    findings.push(...inspected.findings)
    for (const file of inspected.files) syntaxFiles.add(file)
  }
  for (const rel of KIT_WORKFLOWS) inspect(rel, false)
  for (const rel of loaded.product) inspect(rel, true)
  for (const rel of retained) inspect(rel, true)
  return { count: loaded.product.length, findings, syntaxFiles: [...syntaxFiles] }
}
