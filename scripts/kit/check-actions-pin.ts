#!/usr/bin/env bun
/**
 * Enforce the supply-chain pin policy stated in .github/workflows/ci.yml:
 * every third-party `uses:` GitHub will run is a 40-hex commit SHA carrying
 * a trailing version comment, and one action never drifts to two SHAs.
 * No network access.
 *
 * Scope decisions (see docs/kit/testing/critical-path.md CP-ACTIONS-PIN):
 * - `./...` refs (local composite actions, local reusable workflows) are exempt
 *   as *refs*: the pointer is this repository at this commit, so a SHA would be
 *   self-referential and unmaintainable. The exemption is identity of the ref,
 *   not transitive. If the target file exists, composite `action.yml` /
 *   `action.yaml` (`runs.steps[].uses`) and local reusable workflows (the same
 *   job/`uses` walk) are parsed too. A missing local file is counted as local
 *   and does not fail.
 * - A shape the walk cannot read — `jobs` or a job that is not a mapping,
 *   `steps` that are not a list, a step that is not a mapping, composite `runs`
 *   that are not a mapping — is a violation, never skipped: it could hold a
 *   `uses:` the scan never saw.
 * - `trufflesecurity/trufflehog` gets no special case here — its pins already are
 *   40-hex, so the generic rule covers them, and the drift rule covers a half-bump
 *   of the two `uses:` lines. Agreement with the SSoT
 *   `config/kit/trufflehog.version#action_sha` stays owned by
 *   `scripts/kit/trufflehog-check.sh --assert-pin`; duplicating it here would
 *   create a second owner for one fact.
 * - `docs/kit/templates/**` is out of scope on purpose: Dependabot's
 *   `github-actions` ecosystem only rewrites live workflows, so gating the
 *   example templates would red-line every actions bump PR and block
 *   dependabot-automerge. Template pins are illustrative, not operational.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const ROOT = realpathSync(
  resolve(process.env.ACTIONS_PIN_ROOT ?? join(import.meta.dirname, '../..')),
)
const WORKFLOWS = '.github/workflows'
const SHA = /^[0-9a-f]{40}$/
const VERSION_COMMENT = /^v\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/
const ACTION = /^([A-Za-z0-9][\w.-]*\/[\w.-]+)(?:\/[^@\s]+)?@(\S+)$/

type Issue = { file: string; line: number; message: string }
type Pin = { file: string; line: number; action: string; sha: string }
type Counts = { local: number; remote: number }

const issues: Issue[] = []

function rel(path: string): string {
  return relative(ROOT, path).split(sep).join('/') || '.'
}

function report(file: string, line: number, message: string): void {
  issues.push({ file: file.split(sep).join('/'), line, message })
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Split a YAML line into code and comment, ignoring `#` inside quotes. */
function splitComment(line: string): [string, string] {
  let quote = ''
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote) {
      if (char === quote && line[index - 1] !== '\\') quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '#') return [line.slice(0, index), line.slice(index + 1)]
  }
  return [line, '']
}

function walkYaml(dir: string, output: string[]): void {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) walkYaml(path, output)
    else if (stat.isFile() && /\.ya?ml$/i.test(name)) output.push(path)
  }
}

function loadYaml(path: string): { file: string; lines: string[]; doc: unknown } | null {
  const file = rel(path)
  const source = readFileSync(path, 'utf8')
  const lines = source.split(/\r?\n/)
  try {
    return { file, lines, doc: Bun.YAML.parse(source) }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error'
    report(file, 1, `YAML parse failed — cannot verify pins (${detail})`)
    return null
  }
}

function resolveLocal(value: string): { kind: 'workflow' | 'action'; path: string } | null {
  if (!value.startsWith('./')) return null
  const target = resolve(ROOT, value.slice(2))
  if (!(existsSync(target) && (target === ROOT || target.startsWith(`${ROOT}${sep}`)))) return null
  const stat = statSync(target)
  if (stat.isFile() && /\.ya?ml$/i.test(target)) return { kind: 'workflow', path: target }
  if (!stat.isDirectory()) return null
  for (const name of ['action.yml', 'action.yaml'] as const) {
    const action = join(target, name)
    if (existsSync(action) && statSync(action).isFile()) return { kind: 'action', path: action }
  }
  return null
}

function takeUses(
  raw: unknown,
  file: string,
  lines: string[],
  pins: Pin[],
  counts: Counts,
  visited: Set<string>,
): void {
  if (raw === undefined || raw === null) return
  if (typeof raw !== 'string') {
    report(file, 1, 'non-string `uses` — cannot verify pin')
    return
  }
  const value = raw.trim()
  if (value === '') return
  const found = lines.findIndex((candidate) => candidate.includes(value))
  const line = found < 0 ? 1 : found + 1
  if (value.startsWith('./')) {
    counts.local += 1
    followLocal(value, pins, counts, visited)
    return
  }
  counts.remote += 1
  const action = value.match(ACTION)
  if (!(action && SHA.test(action[2]))) {
    const ref = action ? action[2] : value
    report(file, line, `unpinned ref \`${ref}\`: third-party uses must be a 40-hex commit SHA`)
    return
  }
  const sourceLine = lines[line - 1] ?? ''
  const comment = sourceLine.includes(value) ? splitComment(sourceLine)[1] : ''
  if (!VERSION_COMMENT.test(comment.trim().split(/\s+/)[0] ?? '')) {
    report(file, line, 'SHA pin needs a trailing version comment (for example `# v7.0.1`)')
  }
  pins.push({ file, line, action: action[1], sha: action[2] })
}

function followLocal(value: string, pins: Pin[], counts: Counts, visited: Set<string>): void {
  const resolved = resolveLocal(value)
  if (!resolved) return
  const key = realpathSync(resolved.path)
  if (visited.has(key)) return
  visited.add(key)
  if (resolved.kind === 'workflow') scanWorkflow(resolved.path, pins, counts, visited)
  else scanComposite(resolved.path, pins, counts, visited)
}

/** Absent `steps` (a reusable-workflow job, a non-composite action) is fine; any other non-list is not. */
function scanSteps(
  steps: unknown,
  owner: string,
  file: string,
  lines: string[],
  pins: Pin[],
  counts: Counts,
  visited: Set<string>,
): void {
  if (steps === undefined) return
  if (!Array.isArray(steps)) {
    report(file, 1, `${owner} steps is not a list — cannot verify pins`)
    return
  }
  steps.forEach((step, index) => {
    if (isMapping(step)) takeUses(step.uses, file, lines, pins, counts, visited)
    else report(file, 1, `${owner} step ${index + 1} is not a mapping — cannot verify pins`)
  })
}

function scanWorkflow(path: string, pins: Pin[], counts: Counts, visited: Set<string>): void {
  const loaded = loadYaml(path)
  if (!loaded) return
  const { file, lines, doc } = loaded
  if (!(isMapping(doc) && isMapping(doc.jobs))) {
    report(file, 1, '`jobs` is not a mapping — cannot verify pins')
    return
  }
  for (const [id, job] of Object.entries(doc.jobs)) {
    if (!isMapping(job)) {
      report(file, 1, `job '${id}' is not a mapping — cannot verify pins`)
      continue
    }
    takeUses(job.uses, file, lines, pins, counts, visited)
    scanSteps(job.steps, `job '${id}'`, file, lines, pins, counts, visited)
  }
}

function scanComposite(path: string, pins: Pin[], counts: Counts, visited: Set<string>): void {
  const loaded = loadYaml(path)
  if (!loaded) return
  const { file, lines, doc } = loaded
  if (!(isMapping(doc) && isMapping(doc.runs))) {
    report(file, 1, '`runs` is not a mapping — cannot verify pins')
    return
  }
  scanSteps(doc.runs.steps, 'runs', file, lines, pins, counts, visited)
}

/** One action, one SHA per tree: a half-applied bump is drift, not a pin. */
function checkDrift(pins: Pin[]): void {
  const first = new Map<string, Pin>()
  for (const pin of pins) {
    const seen = first.get(pin.action)
    if (!seen) {
      first.set(pin.action, pin)
      continue
    }
    if (seen.sha === pin.sha) continue
    report(
      pin.file,
      pin.line,
      `pin drift for ${pin.action}: ${pin.sha} here vs ${seen.sha} at ${seen.file}:${seen.line}`,
    )
  }
}

function main(): void {
  const files: string[] = []
  walkYaml(join(ROOT, WORKFLOWS), files)
  files.sort((a, b) => compareText(rel(a), rel(b)))
  const pins: Pin[] = []
  const counts: Counts = { local: 0, remote: 0 }
  const visited = new Set<string>()
  for (const path of files) {
    const key = realpathSync(path)
    if (visited.has(key)) continue
    visited.add(key)
    scanWorkflow(path, pins, counts, visited)
  }
  checkDrift(pins)
  if (files.length === 0) {
    report(WORKFLOWS, 1, 'no workflow file found — discovery is broken')
  } else if (counts.remote + counts.local === 0) {
    // Anti-neutering: workflows that reference no action at all mean a blind scanner.
    report(WORKFLOWS, 1, 'no `uses:` reference found in any workflow — scanner is blind')
  }
  issues.sort(
    (a, b) => compareText(a.file, b.file) || a.line - b.line || compareText(a.message, b.message),
  )
  if (issues.length > 0) {
    for (const issue of issues) console.error(`${issue.file}:${issue.line}: ${issue.message}`)
    console.error(`check-actions-pin: FAIL (${issues.length} violation(s))`)
    process.exitCode = 1
    return
  }
  console.log(
    `check-actions-pin: OK (${counts.remote} pinned ref(s), ${new Set(pins.map((pin) => pin.action)).size} action(s), ${counts.local} local ref(s), ${files.length} workflow file(s))`,
  )
}

main()
