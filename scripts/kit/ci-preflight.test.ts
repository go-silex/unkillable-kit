import assert from 'node:assert/strict'
import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { data, Evaluator, Lexer, Parser } from '@actions/expressions'

const root = resolve(import.meta.dirname, '../..')
type Step = {
  name?: string
  uses?: string
  run?: string
  if?: string
  env?: Record<string, string>
  with?: Record<string, string>
}
type Job = {
  if?: string
  needs?: string | string[]
  steps?: Step[]
  uses?: string
  strategy?: { matrix?: Record<string, string> }
}
const workflow = Bun.YAML.parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, Job>
}
const jobs = workflow.jobs
const appWorkflow = Bun.YAML.parse(
  readFileSync(join(root, '.github/workflows/coverage-app.yml'), 'utf8'),
) as { jobs: Record<string, Job> }
type Value = string | boolean | { [key: string]: Value }
function dictionary(input: Record<string, Value>): data.Dictionary {
  return new data.Dictionary(
    ...Object.entries(input).map(([key, value]) => ({
      key,
      value:
        typeof value === 'string'
          ? new data.StringData(value)
          : typeof value === 'boolean'
            ? new data.BooleanData(value)
            : dictionary(value),
    })),
  )
}
function evaluate(expression: string, context: Record<string, Value>, successful: boolean): string {
  const body = expression
    .trim()
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
  const funcs = ['always', 'success', 'failure', 'cancelled']
  const parsed = new Parser(
    new Lexer(body).lex().tokens,
    ['github', 'needs'],
    funcs.map((name) => ({ name, minArgs: 0, maxArgs: 0 })),
  ).parse()
  return new Evaluator(
    parsed,
    dictionary(context),
    new Map(
      funcs.map((name) => [
        name,
        {
          name,
          minArgs: 0,
          maxArgs: 0,
          call: () =>
            new data.BooleanData(
              name === 'always' ||
                (name === 'success' && successful) ||
                (name === 'failure' && !successful),
            ),
        },
      ]),
    ),
  )
    .evaluate()
    .coerceString()
}

type Result = 'success' | 'failure' | 'skipped' | 'cancelled'
type Plan = { groups?: string; parts?: string; draft?: boolean }
function dependencies(job: Job): string[] {
  return job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs]
}
function context(
  event: 'push' | 'pull_request',
  results: Record<string, Result>,
  tooling = '',
  plan: Plan = {},
): Record<string, Value> {
  return {
    github: { event_name: event, event: { pull_request: { draft: plan.draft ?? false } } },
    needs: Object.fromEntries(
      Object.entries(results).map(([key, result]) => [
        key,
        {
          result,
          outputs: {
            tooling: key === 'coverage-plan' ? tooling : '',
            groups: key === 'coverage-plan' ? (plan.groups ?? '') : '',
            parts: key === 'coverage-plan' ? (plan.parts ?? '') : '',
          },
        },
      ]),
    ),
  }
}
function enabled(
  job: Job,
  event: 'push' | 'pull_request',
  results: Record<string, Result>,
  tooling = '',
  plan: Plan = {},
): boolean {
  const needs = dependencies(job)
  for (const id of needs) assert.ok(results[id], `missing result for dependency ${id}`)
  const successful = needs.every((id) => results[id] === 'success')
  const condition = job.if ?? 'true'
  // GitHub implicitly adds success() unless a status-check function is present.
  if (!(/\b(always|success|failure|cancelled)\s*\(/.test(condition) || successful)) return false
  return (
    evaluate(
      `!!(${condition.replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '')})`,
      context(event, results, tooling, plan),
      successful,
    ) === 'true'
  )
}
function joinVerdict(
  event: 'push' | 'pull_request',
  results: Record<string, Result>,
  tooling = '',
): string {
  const job = jobs.ci
  assert.ok(enabled(job, event, results), 'final ci must run after failure or skip')
  const joinStep = job.steps?.find((step) => step.name === 'Join Root receipts')
  assert.ok(joinStep?.run, 'missing receipt join step')
  assert.ok(
    joinStep.if && /\b(always|failure|cancelled)\s*\(/.test(joinStep.if),
    'receipt join must run after earlier step failure',
  )
  assert.equal(evaluate(joinStep.if, context(event, results, tooling), false), 'true')
  const direct = Object.fromEntries(dependencies(job).map((id) => [id, results[id]]))
  return evaluate(joinStep.env!.PRODUCERS_RESULT, context(event, direct, tooling), false)
}

function preflight(cwd: string, env = process.env, output: string[] = []): boolean {
  const steps = jobs['coverage-plan'].steps
  assert.ok(steps)
  let reachedSetup = false
  for (const step of steps) {
    if (step.uses?.startsWith('oven-sh/setup-bun@')) {
      reachedSetup = true
      break
    }
    if (step.run) {
      const result = spawnSync('bash', ['-e', '-c', step.run], { cwd, env, encoding: 'utf8' })
      output.push(result.stdout, result.stderr)
      if (result.error) throw result.error
      if (result.status !== 0) return false
    }
  }
  assert.ok(reachedSetup, 'coverage plan must reach setup after preflight')
  return true
}

function failedPreflight() {
  const fixture = mkdtempSync(join(tmpdir(), 'ci-preflight-'))
  try {
    mkdirSync(join(fixture, 'config/product'), { recursive: true })
    symlinkSync(join(root, 'scripts'), join(fixture, 'scripts'), 'dir')
    writeFileSync(join(fixture, 'config/product/inheritance.json'), '{invalid')
    assert.equal(preflight(fixture), false)
    for (const event of ['push', 'pull_request'] as const) {
      const results: Record<string, Result> = { 'coverage-plan': 'failure' }
      for (const id of ['quality', 'coverage', 'coverage-partitions', 'tooling']) {
        assert.equal(enabled(jobs[id], event, results), false, `${id} must not start`)
        results[id] = 'skipped'
      }
      assert.equal(joinVerdict(event, results), 'failure')
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

function protectedDriftPreflight() {
  const fixture = mkdtempSync(join(tmpdir(), 'ci-preflight-product-'))
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !(key.startsWith('GIT_') || key.startsWith('ZERO_EDIT_')) && key !== 'GITHUB_REPOSITORY',
      ),
    )
    Object.assign(env, {
      HOME: fixture,
      XDG_CONFIG_HOME: join(fixture, 'xdg'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
      GITHUB_REPOSITORY: 'example/product',
    })
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: fixture, env, encoding: 'utf8' })
      if (result.error) throw result.error
      assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
      return result.stdout.trim()
    }
    git('init', '-q')
    mkdirSync(join(fixture, 'config/kit'), { recursive: true })
    mkdirSync(join(fixture, 'scripts/kit'), { recursive: true })
    mkdirSync(join(fixture, 'config/product'), { recursive: true })
    for (const path of [
      'config/kit/zero-edit-zones.json',
      'scripts/kit/inheritance-preflight.sh',
      'scripts/kit/check-zero-edit-zones.sh',
    ]) {
      writeFileSync(join(fixture, path), readFileSync(join(root, path)))
    }
    writeFileSync(join(fixture, 'package.json'), '{"name":"kit"}\n')
    git('add', 'config/kit', 'scripts/kit', 'package.json')
    git('-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'commit', '-qm', 'kit tip')
    const base = git('rev-parse', 'HEAD')
    writeFileSync(
      join(fixture, 'config/product/inheritance.json'),
      JSON.stringify({ version: 1, upstreamCommit: base }),
    )
    git('add', 'config/product/inheritance.json')
    git('-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'commit', '-qm', 'product inheritance')

    const cleanOutput: string[] = []
    assert.equal(preflight(fixture, env, cleanOutput), true, cleanOutput.join(''))

    writeFileSync(join(fixture, 'package.json'), '{"name":"product-drift"}\n')
    git('add', 'package.json')
    git('-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'commit', '-qm', 'protected drift')
    const output: string[] = []
    assert.equal(
      preflight(fixture, env, output),
      false,
      'protected drift must fail before Bun setup',
    )
    assert.match(output.join(''), new RegExp(`inheritance upstreamCommit=${base}`))
    assert.match(output.join(''), /FORBIDDEN package\.json/)
    for (const event of ['push', 'pull_request'] as const) {
      const results: Record<string, Result> = { 'coverage-plan': 'failure' }
      for (const id of ['quality', 'coverage', 'coverage-partitions', 'tooling']) {
        assert.equal(enabled(jobs[id], event, results), false, `${id} must not start`)
        results[id] = 'skipped'
      }
      assert.equal(joinVerdict(event, results), 'failure')
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

function coverageParticipation() {
  const results = { 'coverage-plan': 'success' } as const
  const producers = [
    ['coverage', 'groups'],
    ['coverage-partitions', 'parts'],
  ] as const
  for (const [id, output] of producers) {
    const job = jobs[id]
    const selected = '[{}]'
    assert.equal(enabled(job, 'pull_request', results, '', { [output]: selected }), true, id)
    assert.equal(enabled(job, 'pull_request', results, '', { [output]: '[]' }), false, id)
    assert.equal(enabled(job, 'pull_request', results, '', { [output]: '' }), true, id)
    assert.equal(
      enabled(job, 'pull_request', results, '', { [output]: selected, draft: true }),
      false,
      id,
    )
    assert.equal(enabled(job, 'push', results, '', { [output]: '[]' }), true, id)
    assert.equal(enabled(job, 'push', { 'coverage-plan': 'failure' }), false, id)
  }
}

function coverageJoinArguments(event: 'push' | 'pull_request', results: Record<string, Result>) {
  const joinStep = jobs.ci.steps?.find((step) => step.name === 'Join Root receipts')
  assert.ok(joinStep?.run && joinStep.env)
  const direct = Object.fromEntries(dependencies(jobs.ci).map((id) => [id, results[id]]))
  const evaluationContext = context(event, direct, 'true')
  // Exercise the checked-in shell invocation with evaluated Actions expressions.
  const env = {
    ...process.env,
    RUNNER_TEMP: '/fixture with spaces',
    ...Object.fromEntries(
      Object.entries(joinStep.env).map(([key, expression]) => [
        key,
        evaluate(expression, evaluationContext, false),
      ]),
    ),
  }
  const args = spawnSync('bash', ['-euc', `bun() { printf '%s\\0' "$@"; }\n${joinStep.run}`], {
    env,
    encoding: 'utf8',
  })
  if (args.error) throw args.error
  assert.equal(args.status, 0, args.stderr)
  assert.deepEqual(args.stdout.split('\0').slice(0, -1), [
    'run',
    'validate:full',
    '--',
    '--ci-join',
    '/fixture with spaces/root-receipts',
    '--producers-result',
    'success',
    '--coverage-result',
    results.coverage,
    '--parts-result',
    results['coverage-partitions'],
  ])
}

function successfulPreflight() {
  assert.equal(preflight(root), true)
  for (const event of ['push', 'pull_request'] as const) {
    const results: Record<string, Result> = { 'coverage-plan': 'success' }
    for (const id of ['quality', 'coverage']) {
      assert.equal(enabled(jobs[id], event, results), true, `${id} must start`)
      results[id] = 'success'
    }
    assert.equal(enabled(jobs.tooling, event, results, 'true'), true)
    results.tooling = 'success'
    results['coverage-partitions'] = 'success'
    for (const [coverage, parts] of [
      ['success', 'success'],
      ['skipped', 'success'],
      ['success', 'skipped'],
      ['skipped', 'skipped'],
      ['failure', 'cancelled'],
      ['cancelled', 'failure'],
    ] as const) {
      coverageJoinArguments(event, { ...results, coverage, 'coverage-partitions': parts })
    }
    assert.equal(enabled(jobs.tooling, event, results, 'false'), true)
    const toolingStep = jobs.tooling.steps?.find((step) => step.name === 'Validate tooling')
    assert.ok(toolingStep?.if, 'tooling execution must be conditional')
    assert.equal(evaluate(toolingStep.if, context(event, results, 'true'), true), 'true')
    assert.equal(evaluate(toolingStep.if, context(event, results, 'false'), true), 'false')
    const toolingJoin = jobs.ci.steps?.find((step) => step.name === 'Join Tooling receipts')
    assert.ok(toolingJoin?.if && toolingJoin.env?.PRODUCERS_RESULT)
    assert.equal(evaluate(toolingJoin.if, context(event, results, 'true'), false), 'true')
    assert.equal(evaluate(toolingJoin.if, context(event, results, 'false'), false), 'false')
    for (const result of ['failure', 'skipped', 'cancelled'] as const) {
      assert.equal(joinVerdict(event, { ...results, tooling: result }, 'true'), 'failure')
      assert.equal(joinVerdict(event, { ...results, tooling: result }, 'false'), 'failure')
      assert.equal(
        evaluate(
          toolingJoin.env.PRODUCERS_RESULT,
          context(event, { ...results, tooling: result }, 'true'),
          false,
        ),
        'failure',
      )
    }
    assert.equal(joinVerdict(event, results, 'invalid'), 'failure')
    assert.equal(joinVerdict(event, results, 'false'), 'success')
    assert.equal(joinVerdict(event, results), 'failure')
    for (const id of ['coverage-plan', 'quality']) {
      for (const result of ['failure', 'skipped', 'cancelled'] as const) {
        assert.equal(
          joinVerdict(event, { ...results, [id]: result }, 'true'),
          'failure',
          `${id}: ${result}`,
        )
      }
    }
  }
}

function rawArtifactPattern() {
  const download = appWorkflow.jobs.merge.steps?.find((step) =>
    step.uses?.startsWith('actions/download-artifact@'),
  )
  assert.ok(download?.with?.pattern)
  const pattern = download.with.pattern
    .replace(`\${{ github.run_id }}`, '123')
    .replace(`\${{ github.run_attempt }}`, '1')
    .replace(`\${{ steps.target.outputs.safe }}`, 'apps__example-api')
  const matches = (name: string) =>
    spawnSync('bash', ['-c', '[[ "$1" == $2 ]]', 'glob', name, pattern]).status === 0
  assert.equal(matches('coverage-raw-123-1-apps__example-api-1-of-2'), true)
  assert.equal(matches('coverage-raw-123-1-apps__example-api-2-of-2'), true)
  assert.equal(matches('coverage-raw-123-1-apps__example-api-v2-1-of-2'), false)
  assert.equal(matches('coverage-raw-123-1-apps__example-api-1-of-2-extra'), false)
}

function coverageReceiptStaging() {
  const steps = jobs.ci.steps
  const download = steps?.find((step) => step.name === 'Download Coverage receipts')
  const staging = steps?.find((step) => step.name === 'Stage Coverage receipts')
  assert.ok(staging?.run, 'coverage receipts need exclusive staging before the join')
  assert.ok(download?.with)
  assert.equal(
    download.with.pattern,
    `root-coverage-\${{ github.run_id }}-\${{ github.run_attempt }}-*`,
  )
  assert.notEqual(String(download.with['merge-multiple']), 'true')
  assert.equal(
    evaluate(
      download.if ?? 'success()',
      context('pull_request', { coverage: 'skipped', 'coverage-partitions': 'skipped' }),
      false,
    ),
    'true',
  )

  const ordinary = 'root-coverage-packages__example.json'
  const partitioned = 'root-coverage-apps__example-api.json'
  const group = 'root-coverage-123-1-packages-1'
  const merge = 'root-coverage-123-1-merge-apps__example-api'
  for (const [inputs, expected] of [
    [[], []],
    [[ordinary], [ordinary]],
    [
      [`${group}/${ordinary}`, `${merge}/${partitioned}`],
      [ordinary, partitioned],
    ],
    [[`${group}/${ordinary}`, `${merge}/${ordinary}`], null],
    [[`${group}/nested/${ordinary}`, `${merge}/${partitioned}`], null],
  ] as const) {
    const fixture = mkdtempSync(join(tmpdir(), 'ci-receipt-staging-'))
    try {
      const target = join(fixture, 'root-receipts')
      mkdirSync(target)
      writeFileSync(join(target, 'root-core.json'), 'core')
      for (const file of inputs) {
        const receipt = join(fixture, 'coverage-receipts', file)
        mkdirSync(resolve(receipt, '..'), { recursive: true })
        writeFileSync(receipt, file)
      }
      const staged: SpawnSyncReturns<string> = spawnSync('bash', ['-euc', staging.run], {
        env: {
          ...process.env,
          RUNNER_TEMP: fixture,
          GITHUB_RUN_ID: '123',
          GITHUB_RUN_ATTEMPT: '1',
        },
        encoding: 'utf8',
      })
      if (staged.error) throw staged.error
      if (expected === null) {
        assert.notEqual(staged.status, 0, inputs.join(', '))
      } else {
        assert.equal(staged.status, 0, staged.stderr)
        assert.deepEqual(readdirSync(target).sort(), ['root-core.json', ...expected].sort())
        for (const file of expected) {
          const source: string | undefined = inputs.find((candidate) => candidate.endsWith(file))
          assert.equal(readFileSync(join(target, file), 'utf8'), source)
        }
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  }
}

function appIsolation() {
  const caller = jobs['coverage-partitions']
  assert.equal(caller.uses, './.github/workflows/coverage-app.yml')
  assert.deepEqual(dependencies(caller), ['coverage-plan'])
  assert.equal(
    caller.strategy?.matrix?.partition,
    `\${{ fromJson(needs.coverage-plan.outputs.parts) }}`,
  )
  assert.equal(appWorkflow.jobs.part.strategy?.matrix?.index, `\${{ fromJson(inputs.indices) }}`)
  assert.equal(appWorkflow.jobs.part.if, undefined)
  assert.equal(appWorkflow.jobs.merge.if, undefined)
  assert.deepEqual(dependencies(appWorkflow.jobs.merge), ['part'])
  const uploads = appWorkflow.jobs.merge.steps?.filter((step) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  )
  assert.equal(uploads?.length, 2)
  for (const upload of uploads ?? []) {
    assert.ok(upload.with?.name?.includes(`\${{ steps.target.outputs.safe }}`))
    assert.ok(!upload.with?.name?.includes('job-index'))
  }
  assert.equal(enabled(appWorkflow.jobs.merge, 'push', { part: 'success', other: 'failure' }), true)
  assert.equal(
    enabled(appWorkflow.jobs.merge, 'push', { part: 'failure', other: 'success' }),
    false,
  )
}

coverageReceiptStaging()
coverageParticipation()
failedPreflight()
protectedDriftPreflight()
successfulPreflight()
appIsolation()
rawArtifactPattern()
console.log('CI preflight workflow fixtures passed')
