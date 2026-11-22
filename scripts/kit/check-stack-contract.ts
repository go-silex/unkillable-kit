#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { checkStackDocStatus } from './lib/stack-doc-status'

/**
 * Key-level contract for product-owned `.dev/stack.yml` (Roxabi/roxabi-boilerplate-cf#260).
 * Kit mode (no inheritance marker): shape, plus `docs/kit/standards/stack.md` row status vs
 * `bun.lock` (lib/stack-doc-status.ts).
 * Product mode diffs HEAD against `git show <upstreamCommit>:.dev/stack.yml`.
 * An API-only product may replace the whole `frontend` block with the canonical null scalar
 * `frontend: null` (Roxabi/roxabi-boilerplate-cf#591). That recognition is product mode only and
 * does not weaken other product guards. The guard compares values, not filesystem existence.
 * Parses with the `yaml` package (`uniqueKeys`) already depended on by `@kit/flows`,
 * because omp-build's line scanner honours shapes Bun.YAML drops. The package launcher disables
 * Bun auto-install, so this invocation makes no network request.
 */

const requireYaml = createRequire(join(import.meta.dirname, '../../packages/flows/package.json'))

type StackYamlDocument = {
  errors: Array<{ message: string }>
  toJS: () => unknown
  get: (key: string, keepScalar: true) => { value: unknown; source?: string | null } | undefined
}

function loadYaml(): {
  parseDocument: (text: string, options: { uniqueKeys: boolean }) => StackYamlDocument
} {
  let yamlPath: string
  try {
    yamlPath = requireYaml.resolve('yaml')
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'MODULE_NOT_FOUND'
    ) {
      console.error('check-stack-contract: yaml is not installed; run bun install')
      process.exit(1)
    }
    throw error
  }
  return requireYaml(yamlPath) as {
    parseDocument: (text: string, options: { uniqueKeys: boolean }) => StackYamlDocument
  }
}

const { parseDocument } = loadYaml()

const ROOT = realpathSync(
  resolve(process.env.STACK_CONTRACT_ROOT ?? join(import.meta.dirname, '../..')),
)
const STACK = '.dev/stack.yml'
const INHERITANCE = 'config/product/inheritance.json'
const PINNED_COMMANDS = [
  'validate',
  'validate_full',
  'lint',
  'test',
  'typecheck',
  'zero_edit',
  'quality_gates_check',
  'worktree_setup',
] as const
const AGENT_OVERRIDES = ['default', 'always', 'never']
const DEFAULT_MAX_AGENTS = 3
const BUN_VERSION_KEY = /bun.*version/i
const SCANNED_SECTIONS = ['review', 'landing']

const issues: string[] = []

function report(message: string): void {
  issues.push(message)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function walkKeys(value: unknown, visit: (key: string) => void): void {
  const record = asRecord(value)
  if (!record) return
  for (const [key, child] of Object.entries(record)) {
    visit(key)
    walkKeys(child, visit)
  }
}

function scalar(doc: unknown, path: string[]): string | null {
  let current: unknown = doc
  for (const key of path) {
    const record = asRecord(current)
    if (!(record && Object.hasOwn(record, key))) return null
    current = record[key]
  }
  if (typeof current !== 'string' || current.trim() === '') return null
  return current.trim()
}

function lineIndent(line: string): number {
  return line.match(/^[ ]*/)?.[0].length ?? 0
}

/** `#` glued to the previous token, outside quotes. A spaced `# comment` is fine. */
function gluedHash(line: string): boolean {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quote) {
      if (char === quote && line[i - 1] !== '\\') quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && i > 0 && line[i - 1] !== ' ' && line[i - 1] !== '\t') return true
  }
  return false
}

function sectionName(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.endsWith(':') || trimmed.includes('#')) return null
  const name = trimmed.slice(0, -1).trim()
  return SCANNED_SECTIONS.includes(name) ? name : null
}

function rejectNonCanonicalLines(text: string): void {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let section: string | null = null
  for (const raw of lines) {
    const indent = lineIndent(raw)
    const trimmed = raw.trim()
    if (indent === 0 && trimmed && !trimmed.startsWith('#')) {
      section = sectionName(raw)
    }
    if (!(section && trimmed) || trimmed.startsWith('#')) continue
    if (gluedHash(raw)) report('glued # under review or landing')
    if (/:\s*[|>][+-]?\s*(#.*)?$/.test(trimmed)) {
      report('block scalar under review or landing')
    }
  }
}

function checkLanding(doc: unknown): void {
  const landing = asRecord(asRecord(doc)?.landing)
  const mode = landing?.mode
  if (typeof mode !== 'string' || (mode !== 'merge-on-green' && mode !== 'native')) {
    report('landing.mode must be merge-on-green or native')
  }
  if (landing && Object.hasOwn(landing, 'required_checks')) {
    report('landing.required_checks is forbidden')
  }
}

function checkAgentOverrides(doc: unknown): void {
  const agents = asRecord(asRecord(asRecord(asRecord(doc)?.review)?.roster)?.agents)
  if (!agents) return
  for (const [name, value] of Object.entries(agents)) {
    const override = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (!AGENT_OVERRIDES.includes(override)) {
      report(`review.roster.agents.${name} must be a scalar`)
    }
  }
}

function checkWorktreeSetupPin(doc: unknown): void {
  // Two keys name one script: dev-core reads commands.worktree_setup,
  // omp-build reads worktree.setup. Both must be present and agree, or one
  // runner silently bootstraps nothing (feature-init appends setup: "" when
  // the block is absent). An empty/absent command must not disable the pin.
  const setupCommand = commandMap(doc).worktree_setup
  if (!setupCommand || setupCommand.trim() === '') {
    report('commands.worktree_setup must be a non-empty string')
    return
  }
  const setup = asRecord(asRecord(doc)?.worktree)?.setup
  if (setup !== `bash ${setupCommand}`) {
    report(`worktree.setup must equal "bash ${setupCommand}"`)
  }
}

function shape(doc: unknown): void {
  checkLanding(doc)
  checkAgentOverrides(doc)
  walkKeys(doc, (key) => {
    if (BUN_VERSION_KEY.test(key)) report(`bun version key is forbidden: ${key}`)
  })
  checkWorktreeSetupPin(doc)
}

function rosterOf(doc: unknown): { maxAgents: number; never: Set<string> } {
  const roster = asRecord(asRecord(asRecord(doc)?.review)?.roster)
  const agents = asRecord(roster?.agents)
  const never = new Set<string>()
  if (agents) {
    for (const [name, value] of Object.entries(agents)) {
      if (String(value).trim().toLowerCase() === 'never') never.add(name)
    }
  }
  let maxAgents = DEFAULT_MAX_AGENTS
  if (roster && Object.hasOwn(roster, 'max_agents')) {
    const parsed = Number(roster.max_agents)
    if (Number.isInteger(parsed)) maxAgents = parsed
  }
  return { maxAgents, never }
}

function commandMap(doc: unknown): Record<string, string> {
  const commands = asRecord(asRecord(doc)?.commands) ?? {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(commands)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/** Recognize the canonical null scalar, including anchors or tags decorating it. */
function explicitNoFrontend(document: StackYamlDocument): boolean {
  const node = document.get('frontend', true)
  return !!node && node.value === null && node.source === 'null'
}

function mustDiffer(head: unknown, upstream: unknown, path: string[], label: string): void {
  const upstreamValue = scalar(upstream, path)
  if (!upstreamValue) return
  const headValue = scalar(head, path)
  if (!headValue || headValue === upstreamValue) report(`${label} must differ from upstream`)
}

function compareProduct(head: unknown, upstream: unknown, headDocument: StackYamlDocument): void {
  const headRoster = rosterOf(head)
  const upstreamRoster = rosterOf(upstream)
  for (const agent of [...headRoster.never].sort()) {
    if (!upstreamRoster.never.has(agent)) {
      report(`review.roster never override not in upstream: ${agent}`)
    }
  }
  if (headRoster.maxAgents < upstreamRoster.maxAgents) {
    report(
      `review.roster max_agents ${headRoster.maxAgents} is below upstream ${upstreamRoster.maxAgents}`,
    )
  }
  const headCommands = commandMap(head)
  const upstreamCommands = commandMap(upstream)
  for (const key of PINNED_COMMANDS) {
    if (!Object.hasOwn(upstreamCommands, key)) continue
    if (!Object.hasOwn(headCommands, key)) {
      report(`commands.${key} removed`)
      continue
    }
    if (headCommands[key] !== upstreamCommands[key]) report(`commands.${key} changed`)
  }
  mustDiffer(head, upstream, ['name'], 'name')
  mustDiffer(head, upstream, ['release', 'component'], 'release.component')
  if (scalar(head, ['release', 'component']) === 'roxabi-boilerplate-cf') {
    report('release.component must not reuse the legacy Kit component roxabi-boilerplate-cf')
  }
  mustDiffer(head, upstream, ['backend', 'path'], 'backend.path')
  if (!explicitNoFrontend(headDocument)) {
    mustDiffer(head, upstream, ['frontend', 'path'], 'frontend.path')
  }
}

function finish(mode: 'kit' | 'product'): void {
  if (issues.length > 0) {
    for (const issue of issues) console.error(`check-stack-contract: ${issue}`)
    console.error(`check-stack-contract: FAIL (${mode}, ${issues.length})`)
    process.exitCode = 1
    return
  }
  console.log(`check-stack-contract: OK (${mode})`)
}

function readYaml(
  text: string,
  label: string,
): { value: unknown; document: StackYamlDocument } | null {
  rejectNonCanonicalLines(text)
  const document = parseDocument(text, { uniqueKeys: true })
  if (document.errors.length > 0) {
    const first = document.errors[0]?.message.split('\n')[0] ?? 'unparseable'
    report(`non-canonical YAML (${label}): ${first}`)
    return null
  }
  return { value: document.toJS(), document }
}

/**
 * The commit that introduced the marker anywhere in the base's ancestry, if any. The base must be an
 * inherited kit/mirror tip: a product commit — even one whose own tree lost the marker (the delete and
 * re-add launder) — descends from the commit that introduced it. Same rule as check-zero-edit-zones.sh
 * (ADR-0009 D4 threat model); a shallow clone cannot answer it, so it counts as a hit.
 */
function markerIntroducedInAncestry(sha: string): string {
  const git = (args: string[]): string =>
    execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  try {
    if (git(['rev-parse', '--is-shallow-repository']) === 'true') return 'shallow-clone'
    return git([
      'log',
      '--full-history',
      '-m',
      '--no-renames',
      '--diff-filter=A',
      '-1',
      '--format=%H',
      sha,
      '--',
      INHERITANCE,
    ])
  } catch {
    return 'unreadable-history'
  }
}

function main(): void {
  const stackPath = join(ROOT, STACK)
  if (!existsSync(stackPath)) {
    report('missing stack manifest')
    finish('kit')
    return
  }
  const headText = readFileSync(stackPath, 'utf8')
  const headParsed = readYaml(headText, STACK)
  // Empty-document toJS() is null and used to return from readYaml as null, skipping shape.
  if (headParsed === null || headParsed.value === null) {
    finish('kit')
    return
  }
  const head = headParsed.value
  shape(head)

  const markerPath = join(ROOT, INHERITANCE)
  if (!existsSync(markerPath)) {
    checkStackDocStatus(ROOT, report)
    finish('kit')
    return
  }
  let marker: { upstreamCommit?: unknown }
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { upstreamCommit?: unknown }
  } catch (error) {
    report(
      `inheritance marker is unparseable: ${error instanceof Error ? error.message : String(error)}`,
    )
    finish('product')
    return
  }
  const sha = String(marker.upstreamCommit ?? '').trim()
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    report('inheritance upstreamCommit must be a full SHA')
    finish('product')
    return
  }
  const introducedBy = markerIntroducedInAncestry(sha)
  if (introducedBy) {
    report(
      `upstreamCommit descends from ${introducedBy} (${INHERITANCE} introduced, or history unverifiable) — it must be an inherited kit/mirror tip, not a product commit`,
    )
  }
  let upstreamText = ''
  try {
    upstreamText = execFileSync('git', ['show', `${sha}:${STACK}`], {
      cwd: ROOT,
      encoding: 'utf8',
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    report(`cannot read ${sha}:${STACK}: ${detail}`)
    finish('product')
    return
  }
  const upstreamParsed = readYaml(upstreamText, `${sha}:${STACK}`)
  if (upstreamParsed === null || upstreamParsed.value === null) {
    finish('product')
    return
  }
  compareProduct(head, upstreamParsed.value, headParsed.document)
  finish('product')
}

main()
