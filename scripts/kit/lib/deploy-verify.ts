/**
 * Deploy verify core (go-silex/unkillable-kit#215): the Product config, what one health answer
 * means, the polling loop and the Slack alert text behind `scripts/kit/deploy-verify.ts`. Every
 * side effect goes through `VerifyIo`, so the self-test drives the loop with a fake clock.
 *
 * Contract (docs/kit/deploy-verify.md § Contract): a verified Worker answers
 * each health URL listed for its source branch with a JSON object whose `versionTag` field is the
 * Worker version tag — the full commit SHA its Workers Build deployed — or `null` when the version
 * carries no tag.
 */

export const CONFIG_PATH = 'config/product/deploy-verify.json'
/** Field of the health JSON object that carries the Worker version tag (`version_metadata.tag`). */
const HEALTH_FIELD = 'versionTag'
const SOURCE_BRANCHES = ['main', 'staging'] as const
export type SourceBranch = (typeof SOURCE_BRANCHES)[number]
/**
 * Minutes from promotion to the alert when the config sets none. 323 successful Workers Builds of
 * `deploy/*` (four Workers, 2026-08-30 → 2026-11-26) took 52 s at the median, 132 s at p99 and
 * 1040 s at most, push to finished deploy, 983 s of it queued: 20 minutes clears the slowest with
 * margin. docs/kit/deploy-verify.md § Default timeout.
 */
export const DEFAULT_TIMEOUT_MINUTES = 20
const MAX_TIMEOUT_MINUTES = 60
const MAX_TARGETS = 10
export const POLL_MS = 15_000
const MAX_URL_LENGTH = 2048
const SHA = /^[0-9a-f]{40}$/

type DeployVerifyConfig = {
  timeoutMinutes: number
  targets: Partial<Record<SourceBranch, string[]>>
}

export type ConfigResult =
  | { ok: true; config: DeployVerifyConfig }
  | { ok: false; errors: string[] }

export type Observation =
  | { kind: 'tag'; tag: string | null }
  | { kind: 'unreachable'; detail: string }
  | { kind: 'invalid'; detail: string }

type TargetResult = { url: string; observation: Observation }

export type VerifyOutcome =
  | { kind: 'served'; rounds: number }
  | { kind: 'superseded'; tip: string; rounds: number }
  | { kind: 'unserved'; rounds: number; last: TargetResult[] }

export type VerifyPlan = {
  expected: string
  targets: string[]
  /** Epoch ms after which a target still not serving `expected` fails the run. */
  deadline: number
  /** Stop as superseded when deploy/<branch> moves away from `expected` (not for a pinned SHA). */
  followTip: boolean
}

export type VerifyIo = {
  now(): number
  sleep(ms: number): Promise<void>
  /** One health request; never throws. */
  probe(url: string): Promise<Observation>
  /** Current SHA of deploy/<branch>, or null when it cannot be read. */
  readTip(): Promise<string | null>
  log(line: string): void
}

export type AlertContext = {
  repository: string
  branch: SourceBranch
  expected: string
  /** ISO time deploy/<branch> moved to `expected`, when known. */
  promotedAt: string | null
  timeoutMinutes: number
  gateRunUrl: string | null
  runUrl: string
  last: TargetResult[]
}

export function isSourceBranch(value: string): value is SourceBranch {
  return SOURCE_BRANCHES.some((branch) => branch === value)
}

export function isSha(value: string): boolean {
  return SHA.test(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Printable ASCII without backticks, truncated: safe inside a Slack code span and a log line. */
function printable(text: string, max = 80): string {
  const kept = text.replace(/[^\x20-\x5f\x61-\x7e]/g, '?')
  return kept.length > max ? `${kept.slice(0, max)}…` : kept
}

/** A health URL from the config: https, a DNS host, no credentials or fragment. */
function checkUrl(value: unknown): string | { error: string } {
  if (typeof value !== 'string') return { error: 'is not a string' }
  if (value.length > MAX_URL_LENGTH) return { error: `is longer than ${MAX_URL_LENGTH} characters` }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
  if (/[\s\x00-\x1f\x7f]/.test(value))
    return { error: 'contains whitespace or a control character' }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { error: 'is not a URL' }
  }
  if (url.protocol !== 'https:') return { error: 'is not https' }
  if (url.username !== '' || url.password !== '') return { error: 'carries credentials' }
  if (value.includes('#')) return { error: 'has a fragment' }
  const host = url.hostname
  if (host.startsWith('[') || /^[0-9.]+$/.test(host)) return { error: 'names an IP address' }
  if (!host.includes('.')) return { error: 'has no dotted host name' }
  return url.href
}

function parseTimeout(doc: Record<string, unknown>, errors: string[]): number {
  if (!Object.hasOwn(doc, 'timeoutMinutes')) return DEFAULT_TIMEOUT_MINUTES
  const value = doc.timeoutMinutes
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_TIMEOUT_MINUTES
  )
    return value
  errors.push(`timeoutMinutes is not an integer from 1 to ${MAX_TIMEOUT_MINUTES}`)
  return DEFAULT_TIMEOUT_MINUTES
}

function parseBranchTargets(branch: SourceBranch, list: unknown, errors: string[]): string[] {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_TARGETS) {
    errors.push(`targets.${branch} is not a list of 1 to ${MAX_TARGETS} health URLs`)
    return []
  }
  const urls: string[] = []
  list.forEach((entry, index) => {
    const checked = checkUrl(entry)
    if (typeof checked !== 'string') errors.push(`targets.${branch}[${index}] ${checked.error}`)
    else if (urls.includes(checked))
      errors.push(`targets.${branch}[${index}] repeats ${printable(checked, 200)}`)
    else urls.push(checked)
  })
  return urls
}

function parseTargets(
  doc: Record<string, unknown>,
  errors: string[],
): DeployVerifyConfig['targets'] {
  const targets: DeployVerifyConfig['targets'] = {}
  const declared = doc.targets
  if (!Object.hasOwn(doc, 'targets')) errors.push('targets is missing')
  else if (!isPlainObject(declared)) errors.push('targets is not an object')
  else if (Object.keys(declared).length === 0) errors.push('targets names no branch')
  else {
    for (const [branch, list] of Object.entries(declared)) {
      if (isSourceBranch(branch)) targets[branch] = parseBranchTargets(branch, list, errors)
      else errors.push(`targets: "${printable(branch, 40)}" is not main or staging`)
    }
  }
  return targets
}

/** Strict reading of `config/product/deploy-verify.json`; every problem is reported. */
export function parseConfig(text: string): ConfigResult {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return { ok: false, errors: ['the file is not JSON'] }
  }
  if (!isPlainObject(doc)) return { ok: false, errors: ['the top level is not a JSON object'] }
  const errors = Object.keys(doc)
    .filter((key) => key !== 'targets' && key !== 'timeoutMinutes')
    .map((key) => `unknown key "${printable(key, 40)}"`)
  const timeoutMinutes = parseTimeout(doc, errors)
  const targets = parseTargets(doc, errors)
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, config: { timeoutMinutes, targets } }
}

/** What one health answer says about the served version. */
export function readHealth(status: number, body: string): Observation {
  if (status < 200 || status > 299) return { kind: 'unreachable', detail: `HTTP ${status}` }
  let doc: unknown
  try {
    doc = JSON.parse(body)
  } catch {
    return { kind: 'invalid', detail: 'the body is not JSON' }
  }
  if (!isPlainObject(doc)) return { kind: 'invalid', detail: 'the body is not a JSON object' }
  if (!Object.hasOwn(doc, HEALTH_FIELD))
    return { kind: 'invalid', detail: `no "${HEALTH_FIELD}" field` }
  const tag = doc[HEALTH_FIELD]
  if (tag !== null && typeof tag !== 'string')
    return { kind: 'invalid', detail: `"${HEALTH_FIELD}" is neither a string nor null` }
  return { kind: 'tag', tag }
}

export function describe(observation: Observation): string {
  switch (observation.kind) {
    case 'tag':
      if (observation.tag === null) return 'serves no version tag (null)'
      return isSha(observation.tag)
        ? `serves ${observation.tag}`
        : `serves the tag "${printable(observation.tag, 64)}"`
    case 'unreachable':
      return `unreachable: ${printable(observation.detail, 160)}`
    case 'invalid':
      return `invalid body: ${printable(observation.detail, 160)}`
  }
}

/**
 * One round over the pending targets, in config order: each answer is kept in `last`, and a target
 * that serves `expected` leaves `pending`. A probe that throws counts as unreachable.
 */
async function runRound(
  rounds: number,
  expected: string,
  io: VerifyIo,
  pending: Set<string>,
  last: Map<string, Observation>,
): Promise<void> {
  const seen = await Promise.all(
    [...pending].map(
      async (url): Promise<[string, Observation]> => [
        url,
        await io
          .probe(url)
          .catch((error: unknown): Observation => ({ kind: 'unreachable', detail: String(error) })),
      ],
    ),
  )
  for (const [url, observation] of seen) {
    last.set(url, observation)
    if (observation.kind === 'tag' && observation.tag === expected) pending.delete(url)
    io.log(`deploy-verify: round ${rounds} — ${url} ${describe(observation)}`)
  }
}

/**
 * Polls until every target serves `expected`. A target that serves it is not asked again. Between
 * rounds, a followed deploy/<branch> that moved ends the run as superseded: the Deploy gate run
 * that moved it starts the verification of the new SHA.
 */
export async function verify(plan: VerifyPlan, io: VerifyIo): Promise<VerifyOutcome> {
  const last = new Map<string, Observation>()
  const pending = new Set(plan.targets)
  for (let rounds = 1; ; rounds++) {
    await runRound(rounds, plan.expected, io, pending, last)
    if (pending.size === 0) return { kind: 'served', rounds }
    if (plan.followTip) {
      const tip = await io.readTip()
      if (tip !== null && tip !== plan.expected) return { kind: 'superseded', tip, rounds }
    }
    const left = plan.deadline - io.now()
    if (left <= 0) {
      // Every target was probed in round 1, in config order; a Map keeps that first insertion order.
      const results = [...last].map(([url, observation]) => ({ url, observation }))
      return { kind: 'unserved', rounds, last: results }
    }
    await io.sleep(Math.min(POLL_MS, left))
  }
}

/** Artifact name recording that the alert for this branch and SHA was posted. */
export function markerName(branch: SourceBranch, sha: string): string {
  return `deploy-verify-alert-${branch}-${sha}`
}

function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Slack mrkdwn for one unserved verification. Every dynamic value is escaped or printable. */
export function alertText(context: AlertContext): string {
  const { repository, branch, expected } = context
  const lines = [
    `:rotating_light: *Deploy verify* — \`${slackEscape(repository)}\`: production does not serve the commit promoted to \`deploy/${branch}\``,
    `*Branch:* \`${branch}\` · *Expected:* \`${expected}\``,
  ]
  for (const { url, observation } of context.last) {
    const served = observation.kind === 'tag' && observation.tag === expected
    lines.push(
      `• \`${slackEscape(printable(url, 200))}\` ${slackEscape(served ? 'serves it' : describe(observation))}`,
    )
  }
  const since = context.promotedAt ? `promotion at ${context.promotedAt}` : 'the start of the run'
  lines.push(`Waited ${context.timeoutMinutes} min from ${since}.`)
  const links = [`<${context.runUrl}|Deploy verify run>`]
  if (context.gateRunUrl) links.unshift(`<${context.gateRunUrl}|Deploy gate run>`)
  lines.push(`${links.join(' · ')} · runbook: docs/kit/deploy-verify.md`)
  return `${lines.join('\n')}\n`
}
