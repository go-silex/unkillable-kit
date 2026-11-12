import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
}
type Job = { if?: string; needs?: string | string[]; steps?: Step[] }
const workflow = Bun.YAML.parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, Job>
}
const jobs = workflow.jobs
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
function dependencies(job: Job): string[] {
  return job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs]
}
function context(
  event: 'push' | 'pull_request',
  results: Record<string, Result>,
): Record<string, Value> {
  return {
    github: { event_name: event, event: { pull_request: { draft: false } } },
    needs: Object.fromEntries(Object.entries(results).map(([key, result]) => [key, { result }])),
  }
}
function enabled(
  job: Job,
  event: 'push' | 'pull_request',
  results: Record<string, Result>,
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
      context(event, results),
      successful,
    ) === 'true'
  )
}
function joinVerdict(event: 'push' | 'pull_request', results: Record<string, Result>): string {
  const job = jobs.ci
  assert.ok(enabled(job, event, results), 'final ci must run after failure or skip')
  const joinStep = job.steps?.find((step) => step.env?.PRODUCERS_RESULT !== undefined)
  assert.ok(joinStep?.run, 'missing receipt join step')
  assert.ok(
    joinStep.if && /\b(always|failure|cancelled)\s*\(/.test(joinStep.if),
    'receipt join must run after earlier step failure',
  )
  assert.equal(evaluate(joinStep.if, context(event, results), false), 'true')
  const direct = Object.fromEntries(dependencies(job).map((id) => [id, results[id]]))
  return evaluate(joinStep.env!.PRODUCERS_RESULT, context(event, direct), false)
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
      for (const id of ['quality', 'coverage']) {
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
      for (const id of ['quality', 'coverage']) {
        assert.equal(enabled(jobs[id], event, results), false, `${id} must not start`)
        results[id] = 'skipped'
      }
      assert.equal(joinVerdict(event, results), 'failure')
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

function successfulPreflight() {
  assert.equal(preflight(root), true)
  for (const event of ['push', 'pull_request'] as const) {
    const results: Record<string, Result> = { 'coverage-plan': 'success' }
    for (const id of ['quality', 'coverage']) {
      assert.equal(enabled(jobs[id], event, results), true, `${id} must start`)
      results[id] = 'success'
    }
    assert.equal(joinVerdict(event, results), 'success')
    for (const id of ['coverage-plan', 'quality', 'coverage']) {
      for (const result of ['failure', 'skipped', 'cancelled'] as const) {
        assert.equal(
          joinVerdict(event, { ...results, [id]: result }),
          'failure',
          `${id}: ${result}`,
        )
      }
    }
  }
}

failedPreflight()
protectedDriftPreflight()
successfulPreflight()
console.log('CI preflight workflow fixtures passed')
