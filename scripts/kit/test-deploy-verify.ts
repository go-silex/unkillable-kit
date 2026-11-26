#!/usr/bin/env bun
/**
 * Self-test for Deploy verify (go-silex/unkillable-kit#215). The core runs on a fake clock: a target
 * that serves the promoted SHA, one that never does, one unreachable or with an invalid body, a
 * moved deploy branch. The CLI then runs hermetically, `gh` and `curl` stubbed on PATH, with the
 * promotion already older than the timeout, so the deadline cases need no waiting: no config, the
 * alert and its marker, the second run that does not alert again, refusals and inert output.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type AlertContext,
  alertText,
  DEFAULT_TIMEOUT_MINUTES,
  describe,
  markerName,
  type Observation,
  POLL_MS,
  parseConfig,
  readHealth,
  type VerifyIo,
  verify,
} from './lib/deploy-verify'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CLI = join(ROOT, 'scripts/kit/deploy-verify.ts')
const SHA = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const NEXT = 'c'.repeat(40)
const API = 'https://api.example.com/health'
const WEB = 'https://www.example.com/api/health'

let passed = 0
async function check(name: string, body: () => void | Promise<void>): Promise<void> {
  await body()
  passed += 1
  console.log(`PASS: ${name}`)
}

function errorsOf(text: string): string[] {
  const result = parseConfig(text)
  return result.ok ? [] : result.errors
}

// ── Config ──────────────────────────────────────────────────────────────────────────────────────
await check('a minimal config takes the default timeout', () => {
  const result = parseConfig(JSON.stringify({ targets: { main: [API] } }))
  assert.deepEqual(result, {
    ok: true,
    config: { timeoutMinutes: DEFAULT_TIMEOUT_MINUTES, targets: { main: [API] } },
  })
})

await check('several targets per branch, both branches, an explicit timeout', () => {
  const result = parseConfig(
    JSON.stringify({ timeoutMinutes: 45, targets: { main: [API, WEB], staging: [WEB] } }),
  )
  assert.deepEqual(result, {
    ok: true,
    config: { timeoutMinutes: 45, targets: { main: [API, WEB], staging: [WEB] } },
  })
})

await check('every config problem is reported, none is skipped', () => {
  assert.deepEqual(errorsOf('{'), ['the file is not JSON'])
  assert.deepEqual(errorsOf('[]'), ['the top level is not a JSON object'])
  assert.deepEqual(errorsOf('{}'), ['targets is missing'])
  assert.deepEqual(errorsOf('{"targets":[]}'), ['targets is not an object'])
  assert.deepEqual(errorsOf('{"targets":{}}'), ['targets names no branch'])
  assert.deepEqual(
    errorsOf(
      JSON.stringify({
        extra: 1,
        timeoutMinutes: 0,
        targets: { prod: [API], main: [], staging: 'x' },
      }),
    ),
    [
      'unknown key "extra"',
      'timeoutMinutes is not an integer from 1 to 60',
      'targets: "prod" is not main or staging',
      'targets.main is not a list of 1 to 10 health URLs',
      'targets.staging is not a list of 1 to 10 health URLs',
    ],
  )
  for (const timeout of [61, 1.5, '20', null]) {
    assert.deepEqual(
      errorsOf(JSON.stringify({ timeoutMinutes: timeout, targets: { main: [API] } })),
      ['timeoutMinutes is not an integer from 1 to 60'],
    )
  }
  const eleven = Array.from({ length: 11 }, (_, i) => `https://h${i}.example.com/health`)
  assert.deepEqual(errorsOf(JSON.stringify({ targets: { main: eleven } })), [
    'targets.main is not a list of 1 to 10 health URLs',
  ])
})

await check('a health URL is https, on a DNS name, without credentials or fragment', () => {
  const bad: Array<[unknown, string]> = [
    [42, 'is not a string'],
    ['http://api.example.com/health', 'is not https'],
    ['https://user:pw@api.example.com/health', 'carries credentials'],
    ['https://api.example.com/health#x', 'has a fragment'],
    ['https://192.0.2.1/health', 'names an IP address'],
    ['https://[2001:db8::1]/health', 'names an IP address'],
    ['https://localhost/health', 'has no dotted host name'],
    ['https://api.example.com/health ', 'contains whitespace or a control character'],
    ['https://api.example.com/\nhealth', 'contains whitespace or a control character'],
    ['not a url', 'contains whitespace or a control character'],
    ['notaurl', 'is not a URL'],
    [`https://api.example.com/${'x'.repeat(2048)}`, 'is longer than 2048 characters'],
  ]
  for (const [url, error] of bad) {
    assert.deepEqual(errorsOf(JSON.stringify({ targets: { main: [url] } })), [
      `targets.main[0] ${error}`,
    ])
  }
  // Two spellings of one URL are one target.
  assert.deepEqual(
    errorsOf(JSON.stringify({ targets: { main: [API, 'https://API.example.com/health'] } })),
    [`targets.main[1] repeats ${API}`],
  )
})

// ── Health answers ──────────────────────────────────────────────────────────────────────────────
await check('a health answer is a tag, unreachable or invalid', () => {
  assert.deepEqual(readHealth(200, JSON.stringify({ ok: true, versionTag: SHA })), {
    kind: 'tag',
    tag: SHA,
  })
  assert.deepEqual(readHealth(200, '{"versionTag":null}'), { kind: 'tag', tag: null })
  assert.deepEqual(readHealth(503, '{"versionTag":null}'), {
    kind: 'unreachable',
    detail: 'HTTP 503',
  })
  assert.deepEqual(readHealth(301, ''), { kind: 'unreachable', detail: 'HTTP 301' })
  assert.deepEqual(readHealth(200, '<html>'), { kind: 'invalid', detail: 'the body is not JSON' })
  assert.deepEqual(readHealth(200, '[]'), {
    kind: 'invalid',
    detail: 'the body is not a JSON object',
  })
  assert.deepEqual(readHealth(200, '{"ok":true}'), {
    kind: 'invalid',
    detail: 'no "versionTag" field',
  })
  assert.deepEqual(readHealth(200, '{"versionTag":7}'), {
    kind: 'invalid',
    detail: '"versionTag" is neither a string nor null',
  })
  assert.equal(describe({ kind: 'tag', tag: 'v1`<x>\n' }), 'serves the tag "v1?<x>?"')
})

// ── Polling on a fake clock ─────────────────────────────────────────────────────────────────────
type Answer = Observation | ((round: number) => Observation)
function fakeIo(answers: Record<string, Answer>, tips: Array<string | null> = []) {
  let clock = 0
  const sleeps: number[] = []
  const probes: Record<string, number> = {}
  let tipReads = 0
  const io: VerifyIo = {
    now: () => clock,
    sleep: async (ms) => {
      assert.ok(ms > 0 && ms <= POLL_MS, `sleep ${ms} out of range`)
      sleeps.push(ms)
      clock += ms
    },
    probe: async (url) => {
      probes[url] = (probes[url] ?? 0) + 1
      const answer = answers[url]
      if (answer === undefined) throw new Error(`unexpected probe ${url}`)
      return typeof answer === 'function' ? answer(probes[url]) : answer
    },
    readTip: async () => {
      tipReads += 1
      return tips.length > 0 ? (tips.shift() ?? null) : SHA
    },
    log: () => {},
  }
  return { io, sleeps, probes, tipReads: () => tipReads }
}
const served: Observation = { kind: 'tag', tag: SHA }
const stale: Observation = { kind: 'tag', tag: OLD }
const timeout = 20 * 60_000
const allRounds = timeout / POLL_MS + 1

await check('every target serves the expected SHA: served at once, no wait', async () => {
  const fake = fakeIo({ [API]: served, [WEB]: served })
  const outcome = await verify(
    { expected: SHA, targets: [API, WEB], deadline: timeout, followTip: true },
    fake.io,
  )
  assert.deepEqual(outcome, { kind: 'served', rounds: 1 })
  assert.deepEqual(fake.sleeps, [])
  assert.equal(fake.tipReads(), 0)
})

await check('served only when one round sees every target serve it', async () => {
  // API serves it in round 1, regresses in rounds 2–3; WEB catches up in round 3.
  const fake = fakeIo({
    [API]: (round) => (round === 1 || round > 3 ? served : stale),
    [WEB]: (round) => (round < 3 ? stale : served),
  })
  const outcome = await verify(
    { expected: SHA, targets: [API, WEB], deadline: timeout, followTip: true },
    fake.io,
  )
  assert.deepEqual(outcome, { kind: 'served', rounds: 4 })
  assert.deepEqual(fake.probes, { [API]: 4, [WEB]: 4 })
})

await check('a target that never serves it fails at the deadline, polled until then', async () => {
  const fake = fakeIo({ [API]: served, [WEB]: stale })
  const outcome = await verify(
    { expected: SHA, targets: [API, WEB], deadline: timeout, followTip: true },
    fake.io,
  )
  assert.deepEqual(outcome, {
    kind: 'unserved',
    rounds: allRounds,
    last: [
      { url: API, observation: served },
      { url: WEB, observation: stale },
    ],
  })
  assert.equal(fake.probes[WEB], allRounds)
  assert.equal(
    fake.sleeps.reduce((a, b) => a + b, 0),
    timeout,
  )
})

await check('the last wait is cut to the deadline', async () => {
  const fake = fakeIo({ [API]: stale })
  const outcome = await verify(
    { expected: SHA, targets: [API], deadline: POLL_MS + 4000, followTip: false },
    fake.io,
  )
  assert.equal(outcome.kind, 'unserved')
  assert.deepEqual(fake.sleeps, [POLL_MS, 4000])
})

await check(
  'an unreachable or invalid target is retried until the deadline, then reported',
  async () => {
    const down: Observation = { kind: 'unreachable', detail: 'curl exit 7: refused' }
    const bad: Observation = { kind: 'invalid', detail: 'no "versionTag" field' }
    const fake = fakeIo({ [API]: down, [WEB]: bad })
    const outcome = await verify(
      { expected: SHA, targets: [API, WEB], deadline: timeout, followTip: true },
      fake.io,
    )
    assert.deepEqual(outcome, {
      kind: 'unserved',
      rounds: allRounds,
      last: [
        { url: API, observation: down },
        { url: WEB, observation: bad },
      ],
    })
    assert.deepEqual(fake.probes, { [API]: allRounds, [WEB]: allRounds })
  },
)

await check('an unreachable target that comes back serving it succeeds', async () => {
  const fake = fakeIo({
    [API]: (round) => (round < 4 ? { kind: 'unreachable', detail: 'HTTP 503' } : served),
  })
  const outcome = await verify(
    { expected: SHA, targets: [API], deadline: timeout, followTip: true },
    fake.io,
  )
  assert.deepEqual(outcome, { kind: 'served', rounds: 4 })
})

await check('a probe that throws counts as unreachable', async () => {
  const io = fakeIo({}).io
  const outcome = await verify(
    { expected: SHA, targets: [API], deadline: 0, followTip: false },
    { ...io, probe: async () => Promise.reject(new Error('boom')) },
  )
  assert.deepEqual(outcome, {
    kind: 'unserved',
    rounds: 1,
    last: [{ url: API, observation: { kind: 'unreachable', detail: 'Error: boom' } }],
  })
})

await check('a moved deploy branch ends the run as superseded', async () => {
  const fake = fakeIo({ [API]: stale }, [SHA, null, NEXT])
  const outcome = await verify(
    { expected: SHA, targets: [API], deadline: timeout, followTip: true },
    fake.io,
  )
  // An unreadable tip (null) is not a move: polling goes on.
  assert.deepEqual(outcome, { kind: 'superseded', tip: NEXT, rounds: 3 })
})

await check('a pinned SHA never reads the deploy branch', async () => {
  const fake = fakeIo({ [API]: stale })
  await verify({ expected: SHA, targets: [API], deadline: timeout, followTip: false }, fake.io)
  assert.equal(fake.tipReads(), 0)
})

await check('the alert text escapes what health answers and the config bring', () => {
  const context: AlertContext = {
    repository: 'example/product',
    branch: 'main',
    expected: SHA,
    pinned: false,
    promotedAt: '2026-01-01T00:00:00.000Z',
    timeoutMinutes: 20,
    gateRunUrl: 'https://github.com/example/product/actions/runs/1',
    runUrl: 'https://github.com/example/product/actions/runs/2',
    last: [
      { url: API, observation: served },
      {
        url: 'https://www.example.com/h?a=1&b=<2>',
        observation: { kind: 'tag', tag: '<!channel> https://evil.example' },
      },
      { url: WEB, observation: { kind: 'unreachable', detail: 'HTTP 503' } },
    ],
  }
  const text = alertText(context)
  assert.ok(text.startsWith(':rotating_light: *Deploy verify* — `example/product`'))
  assert.ok(text.includes(`*Branch:* \`main\` · *Expected:* \`${SHA}\``))
  assert.ok(text.includes(`• \`${API}\` serves it`))
  assert.ok(text.includes('&amp;b=&lt;2&gt;'))
  // What a target answers stays inside a code span: no mention, no link.
  assert.ok(text.includes('` `serves the tag "&lt;!channel&gt; https://evil.example"`'))
  assert.ok(!text.includes('<!channel>'))
  assert.ok(text.includes(`• \`${WEB}\` \`unreachable: HTTP 503\``))
  assert.ok(text.includes('<https://github.com/example/product/actions/runs/1|Deploy gate run>'))
  assert.ok(text.includes('<https://github.com/example/product/actions/runs/2|Deploy verify run>'))
  assert.ok(text.includes('Waited 20 min from promotion at 2026-01-01T00:00:00.000Z.'))
  assert.ok(
    alertText({ ...context, pinned: true }).startsWith(
      ':test_tube: *Deploy verify, pinned check* — `example/product`',
    ),
  )
  assert.equal(markerName('staging', SHA, false), `deploy-verify-alert-staging-${SHA}`)
  assert.equal(markerName('staging', SHA, true), `deploy-verify-pinned-alert-staging-${SHA}`)
})

// ── The CLI, hermetic ───────────────────────────────────────────────────────────────────────────
const TMP = mkdtempSync(join(tmpdir(), 'deploy-verify-'))
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }))
const BIN = join(TMP, 'bin')
const HEALTH = join(TMP, 'health')
const RUNS = join(TMP, 'runs')
mkdirSync(BIN)
mkdirSync(HEALTH)
mkdirSync(RUNS)
// gh: only the reads the script may make; every call is logged. A run is read from $STUB_RUNS/<id>.json.
writeFileSync(
  join(BIN, 'gh'),
  `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$STUB_LOG"
case "$*" in
  "api repos/example/product/branches/deploy%2Fmain") printf '{"commit":{"sha":"%s"}}' "$STUB_TIP" ;;
  "api repos/example/product/activity?ref=refs/heads/deploy/main&per_page=1") printf '%s' "$STUB_ACTIVITY" ;;
  "api repos/example/product/actions/artifacts?name=deploy-verify-"*"-main-"*"&per_page=100")
    [ -z "\${STUB_ARTIFACTS_FAIL:-}" ] || { echo "HTTP 502" >&2; exit 1; }
    printf '%s' "$STUB_ARTIFACTS" ;;
  "api repos/example/product/actions/runs/"*)
    run="$STUB_RUNS/\${2##*/}.json"
    [ -f "$run" ] || { echo "HTTP 404" >&2; exit 1; }
    cat "$run" ;;
  *) echo "gh stub: unexpected call: $*" >&2; exit 1 ;;
esac
`,
)
// Workflow runs as the API reports them: this Deploy verify run (42), an earlier one (40), a fork
// pull request's CI run (39) and a fork pull request that edits deploy-verify.yml (38).
const deployVerifyRun = {
  workflow_id: 7,
  event: 'workflow_run',
  head_repository: { full_name: 'example/product' },
}
const runs: Record<string, unknown> = {
  42: deployVerifyRun,
  40: { ...deployVerifyRun, event: 'workflow_dispatch' },
  39: { workflow_id: 3, event: 'pull_request', head_repository: { full_name: 'fork/product' } },
  38: { workflow_id: 7, event: 'pull_request', head_repository: { full_name: 'fork/product' } },
}
for (const [id, run] of Object.entries(runs))
  writeFileSync(join(RUNS, `${id}.json`), JSON.stringify(run))
// curl: the answer for the --url value, from files named by its md5; the argv is logged.
writeFileSync(
  join(BIN, 'curl'),
  `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >>"$STUB_LOG"
url=""
while [ "$#" -gt 0 ]; do [ "$1" = --url ] && url="$2"; shift; done
key="$(printf '%s' "$url" | md5sum | cut -c1-32)"
if [ -f "$STUB_HEALTH/$key.exit" ]; then echo "curl: (7) Failed to connect" >&2; exit "$(cat "$STUB_HEALTH/$key.exit")"; fi
cat "$STUB_HEALTH/$key.body"; printf '\\n%s' "$(cat "$STUB_HEALTH/$key.status")"
`,
)
chmodSync(join(BIN, 'gh'), 0o755)
chmodSync(join(BIN, 'curl'), 0o755)

function health(url: string, answer: { status?: number; body?: unknown; exit?: number }): void {
  const key = createHash('md5').update(url).digest('hex')
  for (const ext of ['exit', 'body', 'status'])
    rmSync(join(HEALTH, `${key}.${ext}`), { force: true })
  if (answer.exit !== undefined) writeFileSync(join(HEALTH, `${key}.exit`), String(answer.exit))
  else {
    writeFileSync(join(HEALTH, `${key}.status`), String(answer.status ?? 200))
    writeFileSync(join(HEALTH, `${key}.body`), JSON.stringify(answer.body))
  }
}

const longAgo = new Date(Date.now() - 2 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
type Run = {
  code: number
  stdout: string
  stderr: string
  outputs: string
  alert: string | null
  calls: string
}
function runCli(config: unknown, env: Record<string, string> = {}): Run {
  const work = mkdtempSync(join(TMP, 'work-'))
  if (config !== undefined) {
    mkdirSync(join(work, 'config/product'), { recursive: true })
    writeFileSync(
      join(work, 'config/product/deploy-verify.json'),
      typeof config === 'string' ? config : JSON.stringify(config),
    )
  }
  const log = join(work, 'calls.log')
  const outputs = join(work, 'github-output')
  const alertFile = join(work, 'alert.txt')
  writeFileSync(log, '')
  writeFileSync(outputs, '')
  const r = spawnSync(process.execPath, ['--no-env-file', CLI], {
    cwd: work,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: `${BIN}:/usr/bin:/bin`,
      HOME: work,
      GITHUB_REPOSITORY: 'example/product',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_RUN_ID: '42',
      GATE_RUN_ID: '41',
      SOURCE_BRANCH: 'main',
      DEPLOY_SHA: SHA,
      ALERT_FILE: alertFile,
      GITHUB_OUTPUT: outputs,
      STUB_LOG: log,
      STUB_HEALTH: HEALTH,
      STUB_RUNS: RUNS,
      STUB_TIP: SHA,
      STUB_ACTIVITY: JSON.stringify([{ after: SHA, timestamp: longAgo }]),
      STUB_ARTIFACTS: JSON.stringify({ total_count: 0, artifacts: [] }),
      ...env,
    },
  })
  return {
    code: r.status ?? -1,
    stdout: r.stdout,
    stderr: r.stderr,
    outputs: readFileSync(outputs, 'utf8'),
    alert: existsSync(alertFile) ? readFileSync(alertFile, 'utf8') : null,
    calls: readFileSync(log, 'utf8'),
  }
}
const config = { targets: { main: [API, WEB] } }
const marker = markerName('main', SHA, false)
/** The artifact list for `name`, each entry uploaded by the given run. */
function artifactsOf(name: string, ...from: Array<{ run: number; expired?: boolean }>): string {
  const artifacts = from.map(({ run, expired }) => ({
    name,
    expired: expired ?? false,
    workflow_run: { id: run },
  }))
  return JSON.stringify({ total_count: artifacts.length, artifacts })
}

await check('CLI: no config — a notice, nothing verified, no request', () => {
  const r = runCli(undefined)
  assert.equal(r.code, 0, r.stderr)
  assert.ok(r.stdout.includes('::notice title=Deploy verify: no config::deploy/main has no'))
  assert.equal(r.outputs, 'verdict=no-config\nalert=false\n')
  assert.equal(r.calls, '')
})

await check('CLI: a config without this branch verifies nothing', () => {
  const r = runCli({ targets: { staging: [API] } })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.outputs, 'verdict=no-targets\nalert=false\n')
  assert.equal(r.calls, '')
})

await check('CLI: an invalid config is refused with every finding, and alerts nobody', () => {
  const r = runCli({ extra: true, targets: { main: ['http://api.example.com/health'] } })
  assert.equal(r.code, 1)
  assert.ok(r.stderr.includes('deploy-verify.json: unknown key "extra"'))
  assert.ok(r.stderr.includes('targets.main[0] is not https'))
  assert.ok(r.stderr.includes('REFUSED'))
  assert.equal(r.outputs, '')
  assert.equal(r.calls, '')
  assert.equal(runCli('{"targets":', {}).code, 1)
})

await check('CLI: every target serves the promoted SHA — success, no alert', () => {
  health(API, { body: { ok: true, versionTag: SHA } })
  health(WEB, { body: { versionTag: SHA } })
  const r = runCli(config)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.outputs, 'verdict=served\nalert=false\n')
  assert.equal(r.alert, null)
  assert.ok(
    r.stdout.includes(`::notice title=Deploy verify::2 target(s) serve ${SHA} (deploy/main).`),
  )
  // https only, no redirect, no URL globbing, no curlrc: the probe's own guards.
  assert.match(
    r.calls,
    /^curl --disable --globoff --silent --show-error --proto =https --max-time 10 /m,
  )
  assert.doesNotMatch(r.calls, /--location|-L /)
})

await check('CLI: a URL with brackets in its query is requested literally', () => {
  const bracketed = 'https://api.example.com/health?check[]=db'
  health(bracketed, { body: { versionTag: SHA } })
  const r = runCli({ targets: { main: [bracketed] } })
  assert.equal(r.code, 0, r.stderr)
  assert.ok(r.calls.includes(`--globoff `))
  assert.ok(r.calls.includes(`--url ${bracketed}\n`))
})

await check('CLI: a target that never serves it — failure past the deadline, one alert', () => {
  health(WEB, { body: { versionTag: OLD } })
  const r = runCli(config)
  assert.equal(r.code, 1)
  assert.equal(r.outputs, `verdict=unserved\nalert=true\nmarker=${marker}\n`)
  assert.ok(
    r.stdout.includes('::error title=Deploy verify: not served::1 of 2 target(s) do not serve'),
  )
  assert.ok(r.alert?.includes(`• \`${API}\` serves it`))
  assert.ok(r.alert?.includes(`• \`${WEB}\` \`serves ${OLD}\``))
  assert.ok(r.alert?.includes(`from promotion at ${longAgo.replace('Z', '.000Z')}`))
  assert.ok(
    r.alert?.includes('<https://github.com/example/product/actions/runs/41|Deploy gate run>'),
  )
  assert.ok(
    r.alert?.includes('<https://github.com/example/product/actions/runs/42|Deploy verify run>'),
  )
})

await check('CLI: another run for the same branch and SHA does not alert again', () => {
  const r = runCli(config, { STUB_ARTIFACTS: artifactsOf(marker, { run: 40 }) })
  assert.equal(r.code, 1)
  assert.equal(r.outputs, `verdict=unserved\nalert=false\nmarker=${marker}\n`)
  assert.equal(r.alert, null)
  assert.ok(r.stdout.includes('was already alerted'))
  // An expired marker no longer counts; an unreadable one alerts rather than stay silent.
  const expired = artifactsOf(marker, { run: 40, expired: true })
  assert.ok(runCli(config, { STUB_ARTIFACTS: expired }).outputs.includes('alert=true'))
  assert.ok(runCli(config, { STUB_ARTIFACTS_FAIL: '1' }).outputs.includes('alert=true'))
})

await check('CLI: a marker that Deploy verify did not record does not silence the alert', () => {
  // Another workflow's artifact, a fork pull request editing deploy-verify.yml, an unknown run.
  for (const run of [39, 38, 99]) {
    const r = runCli(config, { STUB_ARTIFACTS: artifactsOf(marker, { run }) })
    assert.equal(r.code, 1)
    assert.ok(r.outputs.includes('alert=true'), `run ${run}`)
  }
  // A trusted marker among untrusted ones still counts.
  const mixed = artifactsOf(marker, { run: 39 }, { run: 40 })
  assert.ok(runCli(config, { STUB_ARTIFACTS: mixed }).outputs.includes('alert=false'))
})

await check('CLI: unreachable and invalid targets are reported as such', () => {
  health(API, { exit: 7 })
  health(WEB, { status: 200, body: '<html>' })
  const r = runCli(config)
  assert.equal(r.code, 1)
  assert.ok(
    r.alert?.includes(`• \`${API}\` \`unreachable: curl exit 7: curl: (7) Failed to connect\``),
  )
  assert.ok(r.alert?.includes(`• \`${WEB}\` \`invalid body: the body is not a JSON object\``))
})

await check('CLI: a moved deploy branch is superseded, not alerted', () => {
  health(API, { body: { versionTag: OLD } })
  health(WEB, { body: { versionTag: OLD } })
  const r = runCli(config, { STUB_TIP: NEXT })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.outputs, 'verdict=superseded\nalert=false\n')
})

await check('CLI: a pinned SHA is verified as given, without the branch or its activity', () => {
  health(API, { body: { versionTag: NEXT } })
  health(WEB, { body: { versionTag: NEXT } })
  const r = runCli(config, { EXPECTED_SHA: NEXT })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.outputs, 'verdict=served\nalert=false\n')
  assert.doesNotMatch(r.calls, /^api /m)
})

await check('CLI: bad inputs are refused before any request', () => {
  const refused: Array<Record<string, string>> = [
    { EXPECTED_SHA: 'main' },
    { EXPECTED_SHA: SHA.toUpperCase() },
    { SOURCE_BRANCH: 'deploy/main' },
    { DEPLOY_SHA: '' },
    { GATE_RUN_ID: '1;2' },
    { GITHUB_REPOSITORY: 'example/product/x' },
  ]
  for (const env of refused) {
    const r = runCli(config, env)
    assert.equal(r.code, 1, JSON.stringify(env))
    assert.ok(r.stderr.includes('REFUSED'), JSON.stringify(env))
    assert.equal(r.calls, '', JSON.stringify(env))
  }
})

await check('CLI: health content cannot form a workflow command or a Slack mention', () => {
  health(API, { body: { versionTag: '::error title=x::pwned <!channel>' } })
  health(WEB, { body: { versionTag: SHA } })
  const r = runCli(config)
  assert.equal(r.code, 1)
  assert.doesNotMatch(r.stdout, /^::error title=x::/m)
  assert.ok(!r.stdout.includes('::pwned'))
  assert.ok(r.alert?.includes('&lt;!channel&gt;'))
  assert.ok(!r.alert?.includes('<!channel>'))
})

console.log(`deploy-verify: ${passed} checks OK`)
