#!/usr/bin/env bun
/**
 * Deploy verify (go-silex/unkillable-kit#215). The Deploy gate moves `deploy/<branch>`; Cloudflare
 * then builds and deploys it with no signal back to GitHub. This script checks from outside, with no
 * Cloudflare credential, that every health URL listed for `<branch>` in
 * `config/product/deploy-verify.json` serves the promoted commit in its `versionTag` field.
 *
 * It polls until one round sees every target serve the expected SHA, until `deploy/<branch>` moves
 * on (superseded: the gate run that moved it starts the next verification), or until the deadline:
 * promotion time, read from the branch activity, plus the config timeout (the run start when that
 * time is unknown or a SHA is pinned). At the deadline it writes the Slack alert text to
 * `$ALERT_FILE` and `alert=true` to `$GITHUB_OUTPUT`, unless a `marker` artifact uploaded by an
 * earlier Deploy verify run started by `workflow_run` shows that this branch and SHA were already
 * alerted; a pinned check reads no marker. The workflow posts the alert, then, on `workflow_run`
 * only, uploads that marker; this script never holds the Slack token.
 *
 * Trust: the workflow runs this from a checkout of `deploy/<branch>` at the verified SHA, so the
 * code, the config and the Bun runtime are that reviewed, green revision. Health answers, the config
 * and API answers are untrusted: log lines are rendered command-inert, annotation messages carry no
 * value read from them, and the alert text escapes them.
 * Env:   GITHUB_REPOSITORY · SOURCE_BRANCH (`main` | `staging`) · DEPLOY_SHA (deploy/<branch> as
 *        checked out) · EXPECTED_SHA (optional: verify this SHA, without following the branch) ·
 *        GATE_RUN_ID (optional) · GITHUB_SERVER_URL · GITHUB_RUN_ID · ALERT_FILE · GITHUB_OUTPUT ·
 *        GH_TOKEN (contents: read, actions: read) for `gh api`
 * Exit:  0 — served, superseded, or nothing to verify; 1 — not served by the deadline, or refused
 *        (bad input or config).
 */
import { execFile } from 'node:child_process'
import { appendFileSync, lstatSync, readFileSync, type Stats, writeFileSync } from 'node:fs'
import {
  type AlertContext,
  alertText,
  CONFIG_PATH,
  isSha,
  isSourceBranch,
  markerName,
  type Observation,
  parseConfig,
  readHealth,
  recordedWithin,
  type SourceBranch,
  serves,
  type VerifyIo,
  verify,
} from './lib/deploy-verify'

const MAX_CONFIG_BYTES = 64 * 1024
const MAX_BODY_BYTES = 64 * 1024
/** Budget of the earlier-alert lookup: past it the run alerts, well inside the job time limit. */
const DEDUP_MS = 60_000

type Inputs = {
  repo: string
  branch: SourceBranch
  deploySha: string
  pinned: string | null
  gateRunUrl: string | null
  runId: string
  runUrl: string
  alertFile: string
}

/** One log line. Control characters and workflow-command markers in untrusted text stay inert. */
function commandInert(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '\r') out += '\\r'
    else if (ch === '\n') out += '\\n'
    else if (code < 0x20 || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
    } else out += ch
  }
  return out.replace(/::/g, ':\\:').replace(/##\[/g, '#\\#[')
}

function logLine(text: string): void {
  console.log(commandInert(text))
}

/** A workflow annotation; `message` must hold only values this script validated. */
function annotate(level: 'notice' | 'warning' | 'error', title: string, message: string): void {
  console.log(`::${level} title=${title}::${message}`)
}

function refuse(message: string): never {
  console.error(commandInert(`deploy-verify: REFUSED — ${message}`))
  process.exit(1)
}

function output(values: Record<string, string>): void {
  const text = Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('')
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text)
  else process.stdout.write(text)
}

const SHA_OR_EMPTY = /^(|[0-9a-f]{40})$/
const RUN_ID_OR_EMPTY = /^[0-9]*$/

/** The env value, or a refusal naming what it must be. */
function envMatching(name: string, pattern: RegExp, what: string, fallback = ''): string {
  const value = process.env[name] || fallback
  if (!pattern.test(value)) refuse(`${name} is not ${what}`)
  return value
}

function readInputs(): Inputs {
  const repo = envMatching('GITHUB_REPOSITORY', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'owner/repo')
  const branch = process.env.SOURCE_BRANCH ?? ''
  if (!isSourceBranch(branch)) refuse('SOURCE_BRANCH is not main or staging')
  const deploySha = envMatching('DEPLOY_SHA', /^[0-9a-f]{40}$/, 'a full lowercase SHA')
  const pinned = envMatching('EXPECTED_SHA', SHA_OR_EMPTY, 'empty or a full lowercase SHA')
  const server = envMatching(
    'GITHUB_SERVER_URL',
    /^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?$/,
    'an https origin',
    'https://github.com',
  )
  const runId = envMatching('GITHUB_RUN_ID', /^[0-9]+$/, 'a run id')
  const gateRunId = envMatching('GATE_RUN_ID', RUN_ID_OR_EMPTY, 'empty or a run id')
  const alertFile = envMatching('ALERT_FILE', /./, 'set')
  return {
    repo,
    branch,
    deploySha,
    pinned: pinned || null,
    gateRunUrl: gateRunId ? `${server}/${repo}/actions/runs/${gateRunId}` : null,
    runId,
    runUrl: `${server}/${repo}/actions/runs/${runId}`,
    alertFile,
  }
}

type ExecResult = { code: number; out: string; err: string }

function exec(cmd: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  const { promise, resolve } = Promise.withResolvers<ExecResult>()
  execFile(
    cmd,
    args,
    { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ code, out: stdout ?? '', err: stderr ?? '' })
    },
  )
  return promise
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

async function ghJson(path: string, timeoutMs = 30_000): Promise<unknown> {
  const r = await exec('gh', ['api', path], timeoutMs)
  if (r.code !== 0) throw new Error(`gh api ${path} failed: ${r.err.trim() || r.out.trim()}`)
  return JSON.parse(r.out)
}

/** `value[key]` when `value` is an object that owns `key`, else undefined: untrusted JSON, no cast. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, key)
    ? Reflect.get(value, key)
    : undefined
}

/** One health request: https only, no redirect, no URL globbing, no ~/.curlrc, bounded time and size. */
async function probe(url: string): Promise<Observation> {
  const r = await exec(
    'curl',
    [
      '--disable',
      '--globoff',
      '--silent',
      '--show-error',
      '--proto',
      '=https',
      '--max-time',
      '10',
      '--max-filesize',
      String(MAX_BODY_BYTES),
      '--header',
      'Accept: application/json',
      '--header',
      'Cache-Control: no-cache',
      '--user-agent',
      'kit-deploy-verify',
      '--output',
      '-',
      '--write-out',
      '\n%{http_code}',
      '--url',
      url,
    ],
    20_000,
  )
  if (r.code !== 0) {
    const reason = r.err.trim().split('\n')[0] || 'no answer'
    return { kind: 'unreachable', detail: `curl exit ${r.code}: ${reason}` }
  }
  const cut = r.out.lastIndexOf('\n')
  const status = Number(r.out.slice(cut + 1))
  if (cut < 0 || !Number.isInteger(status)) return { kind: 'unreachable', detail: 'no HTTP status' }
  return readHealth(status, r.out.slice(0, cut))
}

async function readTip(repo: string, branch: SourceBranch): Promise<string | null> {
  try {
    const sha = field(
      field(await ghJson(`repos/${repo}/branches/deploy%2F${branch}`), 'commit'),
      'sha',
    )
    return typeof sha === 'string' && isSha(sha) ? sha : null
  } catch (error) {
    logLine(`deploy-verify: cannot read deploy/${branch} (${String(error)}); still polling`)
    return null
  }
}

/** When deploy/<branch> moved to `sha`, from the branch activity; null when unknown. */
async function promotedAt(repo: string, branch: SourceBranch, sha: string): Promise<Date | null> {
  try {
    const events = await ghJson(`repos/${repo}/activity?ref=refs/heads/deploy/${branch}&per_page=1`)
    const last: unknown = Array.isArray(events) ? events[0] : undefined
    const timestamp = field(last, 'timestamp')
    if (field(last, 'after') !== sha || typeof timestamp !== 'string') return null
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp)) return null
    const at = new Date(timestamp)
    return Number.isNaN(at.getTime()) ? null : at
  } catch (error) {
    logLine(`deploy-verify: cannot read the activity of deploy/${branch} (${String(error)})`)
    return null
  }
}

/**
 * True when a Deploy verify run started by `workflow_run` recorded the marker: such a run uses the
 * default branch's YAML. Another workflow, a dispatch from any ref or a fork pull request can upload
 * an artifact of that name. A run that cannot be read does not count.
 */
async function recordedByDeployVerify(
  repo: string,
  artifact: unknown,
  workflowId: number,
  msLeft: number,
): Promise<boolean> {
  const runId = field(field(artifact, 'workflow_run'), 'id')
  if (typeof runId !== 'number' || !Number.isSafeInteger(runId)) return false
  try {
    const run = await ghJson(`repos/${repo}/actions/runs/${runId}`, msLeft)
    return field(run, 'workflow_id') === workflowId && field(run, 'event') === 'workflow_run'
  } catch (error) {
    logLine(
      `deploy-verify: cannot read run ${runId} (${String(error)}); its artifact does not count`,
    )
    return false
  }
}

/**
 * True when an unexpired marker recorded by Deploy verify exists; false or null (unreadable, or
 * not settled within DEDUP_MS) both alert: a duplicate beats a miss.
 */
async function alreadyAlerted(
  repo: string,
  marker: string,
  runId: string,
): Promise<boolean | null> {
  const deadline = Date.now() + DEDUP_MS
  try {
    const artifacts = field(
      await ghJson(`repos/${repo}/actions/artifacts?name=${marker}&per_page=100`, DEDUP_MS),
      'artifacts',
    )
    if (!Array.isArray(artifacts)) throw new Error('no artifacts list')
    const live = artifacts.filter(
      (a) => field(a, 'name') === marker && field(a, 'expired') === false,
    )
    if (live.length === 0) return false
    const workflowId = field(
      await ghJson(`repos/${repo}/actions/runs/${runId}`, Math.max(1, deadline - Date.now())),
      'workflow_id',
    )
    if (typeof workflowId !== 'number') throw new Error('this run has no workflow id')
    const seen = await recordedWithin(
      live,
      (artifact, left) => recordedByDeployVerify(repo, artifact, workflowId, left),
      deadline,
      Date.now,
    )
    if (seen === null)
      logLine(`deploy-verify: earlier alerts not settled in ${DEDUP_MS / 1000} s; alerting`)
    if (seen === false)
      logLine(
        `deploy-verify: no Deploy verify run after a Deploy gate run recorded ${marker}; alerting`,
      )
    return seen
  } catch (error) {
    logLine(`deploy-verify: cannot read earlier alerts (${String(error)}); alerting`)
    return null
  }
}

function readConfigText(): string | null {
  let stat: Stats
  try {
    stat = lstatSync(CONFIG_PATH)
  } catch (error) {
    if (field(error, 'code') === 'ENOENT') return null
    refuse(`${CONFIG_PATH} is not readable`)
  }
  if (!stat.isFile()) refuse(`${CONFIG_PATH} is not a regular file`)
  if (stat.size > MAX_CONFIG_BYTES)
    refuse(`${CONFIG_PATH} is larger than ${MAX_CONFIG_BYTES} bytes`)
  return readFileSync(CONFIG_PATH, 'utf8')
}

/** Annotates an unserved verification, then hands the alert to the workflow unless already posted. */
async function reportUnserved(context: AlertContext, inputs: Inputs): Promise<never> {
  const { repository, branch, expected, last } = context
  const missing = last.filter((r) => !serves(r.observation, expected)).length
  annotate(
    'error',
    'Deploy verify: not served',
    `${missing} of ${last.length} target(s) do not serve ${expected} (deploy/${branch}) ${context.timeoutMinutes} min after ${context.promotedAt ? 'promotion' : 'the start'}; details in the log.`,
  )
  // A pinned check never reads markers: dispatches record none, and it always reports.
  const marker = markerName(branch, expected)
  if (!context.pinned && (await alreadyAlerted(repository, marker, inputs.runId)) === true) {
    logLine(
      `deploy-verify: ${branch} ${expected} was already alerted (artifact ${marker}); no new alert`,
    )
    output({ verdict: 'unserved', alert: 'false', marker })
    process.exit(1)
  }
  writeFileSync(inputs.alertFile, alertText(context))
  output({ verdict: 'unserved', alert: 'true', marker })
  process.exit(1)
}

async function main(): Promise<void> {
  const inputs = readInputs()
  const { repo, branch } = inputs
  const text = readConfigText()
  if (text === null) {
    annotate(
      'notice',
      'Deploy verify: no config',
      `deploy/${branch} has no ${CONFIG_PATH}: nothing verified.`,
    )
    output({ verdict: 'no-config', alert: 'false' })
    return
  }
  const parsed = parseConfig(text)
  if (!parsed.ok) {
    for (const error of parsed.errors)
      console.error(commandInert(`deploy-verify: ${CONFIG_PATH}: ${error}`))
    refuse(
      `${CONFIG_PATH} at deploy/${branch} is invalid (docs/kit/deploy-verify.md § Configuration)`,
    )
  }
  const { timeoutMinutes } = parsed.config
  const targets = parsed.config.targets[branch]
  if (!targets) {
    annotate(
      'notice',
      'Deploy verify: no target',
      `${CONFIG_PATH} at deploy/${branch} lists no target for ${branch}: nothing verified.`,
    )
    output({ verdict: 'no-targets', alert: 'false' })
    return
  }

  const expected = inputs.pinned ?? inputs.deploySha
  const followTip = inputs.pinned === null
  const promoted = followTip ? await promotedAt(repo, branch, expected) : null
  const start = promoted?.getTime() ?? Date.now()
  const deadline = start + timeoutMinutes * 60_000
  logLine(
    `deploy-verify: expecting ${expected} (${followTip ? `deploy/${branch}` : 'pinned'}) on ${targets.length} target(s), ` +
      `${timeoutMinutes} min from ${promoted ? `promotion at ${promoted.toISOString()}` : 'now'} — until ${new Date(deadline).toISOString()}`,
  )

  const io: VerifyIo = {
    now: () => Date.now(),
    sleep,
    probe,
    readTip: () => readTip(repo, branch),
    log: logLine,
  }
  const outcome = await verify({ expected, targets, deadline, followTip }, io)

  if (outcome.kind === 'served') {
    annotate(
      'notice',
      'Deploy verify',
      `${targets.length} target(s) serve ${expected} (deploy/${branch}).`,
    )
    output({ verdict: 'served', alert: 'false' })
    return
  }
  if (outcome.kind === 'superseded') {
    annotate(
      'notice',
      'Deploy verify: superseded',
      `deploy/${branch} moved from ${expected} to ${outcome.tip}; the Deploy gate run that moved it verifies the new SHA.`,
    )
    output({ verdict: 'superseded', alert: 'false' })
    return
  }

  await reportUnserved(
    {
      repository: repo,
      branch,
      expected,
      pinned: !followTip,
      promotedAt: promoted ? promoted.toISOString() : null,
      timeoutMinutes,
      gateRunUrl: inputs.gateRunUrl,
      runUrl: inputs.runUrl,
      last: outcome.last,
    },
    inputs,
  )
}

await main()
