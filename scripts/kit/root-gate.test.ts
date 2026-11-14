import assert from 'node:assert/strict'
import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const kitScripts = import.meta.dirname

function command(cwd: string, env: NodeJS.ProcessEnv, executable: string, args: string[]) {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}

function requireSuccess(result: SpawnSyncReturns<string>) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
}

function withFixture(
  coverageScript: string,
  exercise: (fixture: string, env: NodeJS.ProcessEnv) => void,
) {
  const fixture = mkdtempSync(join(tmpdir(), 'kit-root-gate-'))
  try {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (
        key.startsWith('GIT_') ||
        key.startsWith('GITHUB_') ||
        key === 'COVERAGE_LIST_ONLY' ||
        key === 'COVERAGE_LIST_KIT' ||
        key === 'COVERAGE_ONLY' ||
        key === 'COVERAGE_CHANGED_BASE' ||
        key === 'ROOT_FIXTURE_FAIL'
      )
        delete env[key]
    }
    env.GIT_CONFIG_GLOBAL = join(fixture, 'gitconfig')
    env.GIT_CONFIG_NOSYSTEM = '1'
    env.GITHUB_ACTIONS = 'true'
    env.GITHUB_REPOSITORY = 'kit/root-gate-fixture'
    env.GITHUB_RUN_ID = '12345'
    env.GITHUB_RUN_ATTEMPT = '1'
    writeFileSync(env.GIT_CONFIG_GLOBAL, '[maintenance]\n auto = false\n[gc]\n auto = 0\n')

    const fixtureScripts = join(fixture, 'scripts/kit')
    mkdirSync(fixtureScripts, { recursive: true })
    for (const name of readdirSync(kitScripts)) {
      if (
        (name === 'root-gate.ts' || /^root-gate-.*\.ts$/.test(name)) &&
        !name.endsWith('.test.ts')
      ) {
        copyFileSync(join(kitScripts, name), join(fixtureScripts, name))
      }
    }
    writeFileSync(
      join(fixture, 'package.json'),
      JSON.stringify({
        private: true,
        scripts: {
          'validate:full':
            'bun run scripts/kit/root-gate.ts core:first test:coverage core:last core:tail',
          'validate:tooling':
            'bun run scripts/kit/root-gate.ts tooling:first tooling:last tooling:tail',
          'tooling:first': 'bun run task.ts tooling:first',
          'tooling:last': 'bun run task.ts tooling:last',
          'tooling:tail': 'bun run task.ts tooling:tail',
          'core:first': 'bun run task.ts core:first',
          'test:coverage': coverageScript,
          'core:last': 'bun run task.ts core:last',
          'core:tail': 'bun run task.ts core:tail',
        },
      }),
    )
    writeFileSync(
      join(fixture, 'task.ts'),
      "import { appendFileSync } from 'node:fs'\nappendFileSync('effects.txt', process.argv[2] + '\\n')\nif (process.env.ROOT_FIXTURE_FAIL === process.argv[2]) process.exit(17)\n",
    )

    const git = (...args: string[]) => command(fixture, env, 'git', args)
    requireSuccess(git('init', '-q'))
    requireSuccess(git('config', 'user.name', 'Root Gate Fixture'))
    requireSuccess(git('config', 'user.email', 'root-gate@example.invalid'))
    requireSuccess(git('add', '--all'))
    requireSuccess(git('commit', '-q', '-m', 'fixture'))
    const sha = git('rev-parse', 'HEAD')
    requireSuccess(sha)
    env.GITHUB_SHA = sha.stdout.trim()
    exercise(fixture, env)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

function sameRunJoin() {
  withFixture('bun run task.ts test:coverage', (fixture, env) => {
    const receipts = join(fixture, 'receipts')
    mkdirSync(receipts)
    const root = (...args: string[]) =>
      command(fixture, env, process.execPath, ['run', 'validate:full', '--', ...args])
    requireSuccess(root('--ci-group', 'core', '--receipt', join(receipts, 'root-core.json')))
    assert.equal(
      readFileSync(join(fixture, 'effects.txt'), 'utf8'),
      'core:first\ncore:last\ncore:tail\n',
    )
    requireSuccess(
      root('--ci-group', 'coverage', '--receipt', join(receipts, 'root-coverage.json')),
    )
    assert.equal(
      readFileSync(join(fixture, 'effects.txt'), 'utf8'),
      'core:first\ncore:last\ncore:tail\ntest:coverage\n',
    )

    requireSuccess(root('--ci-join', receipts, '--producers-result', 'success'))
    rmSync(join(receipts, 'root-coverage.json'))
    const missingCoverage = root('--ci-join', receipts, '--producers-result', 'success')
    assert.ok(
      missingCoverage.status !== null && missingCoverage.status !== 0,
      'missing Coverage must fail',
    )
  })
}

function refuseCoverageListing() {
  const coverageScript = `bash '${join(kitScripts, 'test-coverage.sh')}'`
  const failures: string[] = []
  const flags = [
    ['COVERAGE_LIST_ONLY', '1', 'coverage listing mode cannot execute the Root gate'],
    ['COVERAGE_LIST_KIT', '1', 'coverage listing mode cannot execute the Root gate'],
    ['COVERAGE_CHANGED_BASE', 'HEAD', 'changed-only coverage cannot execute the Root gate'],
    ['COVERAGE_ONLY', 'apps/example-api', 'narrowed coverage cannot execute the Root gate'],
  ] as const
  for (const [flag, value, marker] of flags) {
    for (const mode of ['full', 'coverage']) {
      try {
        withFixture(coverageScript, (fixture, env) => {
          env[flag] = value
          const receipt = join(fixture, 'root-coverage.json')
          const args = mode === 'full' ? [] : ['--', '--ci-group', 'coverage', '--receipt', receipt]
          const result = command(fixture, env, process.execPath, ['run', 'validate:full', ...args])
          assert.ok(
            result.status !== null && result.status !== 0,
            `${flag}/${mode} accepted a narrowed coverage mode\n${result.stdout}\n${result.stderr}`,
          )
          assert.match(
            result.stderr,
            new RegExp(marker),
            `${flag}/${mode} did not refuse in the gate`,
          )
          assert.equal(
            existsSync(join(fixture, 'effects.txt')),
            false,
            `${flag}/${mode} ran a task before refusal`,
          )
          if (existsSync(receipt)) {
            const data = JSON.parse(readFileSync(receipt, 'utf8'))
            assert.notEqual(data.complete, true, `${flag}/${mode} produced a complete receipt`)
          }
        })
      } catch (error) {
        failures.push(`${flag}/${mode}: ${String(error)}`)
      }
    }
  }
  assert.deepEqual(failures, [], 'narrowed coverage modes must not produce a Root verdict')
}

function coverageShard() {
  withFixture('bun run task.ts test:coverage', (fixture, env) => {
    const receipts = join(fixture, 'receipts')
    mkdirSync(receipts)
    const invoke = (...args: string[]) =>
      command(fixture, env, process.execPath, ['run', 'validate:full', '--', ...args])
    const receipt = join(receipts, 'root-coverage-apps__example-api.json')
    requireSuccess(invoke('--ci-coverage-shard', 'apps/example-api', '--receipt', receipt))
    assert.equal(readFileSync(join(fixture, 'effects.txt'), 'utf8'), 'test:coverage\n')
    const body = JSON.parse(readFileSync(receipt, 'utf8')) as { shard?: string; complete?: boolean }
    assert.equal(body.shard, 'apps/example-api')
    assert.equal(body.complete, true)
    rmSync(join(fixture, 'effects.txt'))
    rmSync(receipt)
    const wrong = invoke(
      '--ci-coverage-shard',
      'apps/example-api',
      '--receipt',
      join(receipts, 'root-coverage.json'),
    )
    assert.notEqual(wrong.status, 0)
    assert.match(wrong.stderr, /incorrect receipt filename/)
    assert.equal(existsSync(join(fixture, 'effects.txt')), false)
    env.COVERAGE_ONLY = 'apps/other-api'
    const mismatch = invoke('--ci-coverage-shard', 'apps/example-api', '--receipt', receipt)
    assert.notEqual(mismatch.status, 0)
    assert.match(mismatch.stderr, /does not match the coverage shard/)
    assert.equal(existsSync(join(fixture, 'effects.txt')), false)
    delete env.COVERAGE_ONLY
    env.COVERAGE_CHANGED_BASE = 'HEAD'
    const changed = invoke('--ci-coverage-shard', 'apps/example-api', '--receipt', receipt)
    assert.notEqual(changed.status, 0)
    assert.match(changed.stderr, /changed-only coverage cannot execute the Root gate/)
    assert.equal(existsSync(join(fixture, 'effects.txt')), false)
  })
}

function coverageShardJoin() {
  const repo = join(kitScripts, '../..')
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GITHUB_') || key.startsWith('COVERAGE_')) delete env[key]
  }
  env.GITHUB_ACTIONS = 'true'
  env.GITHUB_REPOSITORY = 'Roxabi/roxabi-boilerplate-cf'
  env.GITHUB_RUN_ID = '12345'
  env.GITHUB_RUN_ATTEMPT = '1'
  const sha = command(repo, env, 'git', ['rev-parse', 'HEAD'])
  requireSuccess(sha)
  env.GITHUB_SHA = sha.stdout.trim()
  const plan = command(repo, env, process.execPath, ['run', 'validate:full', '--', '--plan'])
  requireSuccess(plan)
  const parsed = JSON.parse(plan.stdout) as {
    core: string[]
    recipeHash: string
    runnerHash: string
  }
  const listed = command(repo, { ...env, COVERAGE_LIST_ONLY: '1' }, 'bash', [
    'scripts/kit/test-coverage.sh',
  ])
  requireSuccess(listed)
  const workspaces = listed.stdout.trim().split('\n').filter(Boolean)
  assert.ok(workspaces.length > 1, 'the live bar must have more than one workspace')
  const dir = mkdtempSync(join(tmpdir(), 'kit-coverage-shards-'))
  try {
    const bound = {
      repository: env.GITHUB_REPOSITORY,
      checkoutSha: env.GITHUB_SHA,
      runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
      recipeHash: parsed.recipeHash,
      runnerHash: parsed.runnerHash,
    }
    writeFileSync(
      join(dir, 'root-core.json'),
      `${JSON.stringify({
        version: 1,
        group: 'core',
        ...bound,
        tasks: parsed.core,
        results: parsed.core.map((task) => ({ task, exitCode: 0 })),
        complete: true,
      })}\n`,
    )
    const writeShard = (workspace: string) => {
      writeFileSync(
        join(dir, `root-coverage-${workspace.replace('/', '__')}.json`),
        `${JSON.stringify({
          version: 1,
          group: 'coverage',
          shard: workspace,
          ...bound,
          tasks: ['test:coverage'],
          results: [{ task: 'test:coverage', exitCode: 0 }],
          complete: true,
        })}\n`,
      )
    }
    for (const workspace of workspaces) writeShard(workspace)
    const joinGate = () =>
      command(repo, env, process.execPath, [
        'run',
        'validate:full',
        '--',
        '--ci-join',
        dir,
        '--producers-result',
        'success',
      ])
    requireSuccess(joinGate())
    const dropped = workspaces[0]
    rmSync(join(dir, `root-coverage-${dropped.replace('/', '__')}.json`))
    const missing = joinGate()
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /do not match the discovered workspace bar/)
    writeShard(dropped)
    writeFileSync(join(dir, 'root-coverage.json'), '{}\n')
    const ambiguous = joinGate()
    assert.notEqual(ambiguous.status, 0)
    assert.match(ambiguous.stderr, /expected exactly two receipt files/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function fullAndPlan() {
  withFixture('bun run task.ts test:coverage', (fixture, env) => {
    const invoke = (...args: string[]) =>
      command(fixture, env, process.execPath, ['run', 'validate:full', ...args])
    const effects = join(fixture, 'effects.txt')
    requireSuccess(invoke('--', '--plan'))
    assert.equal(existsSync(effects), false, 'plan must not execute tasks')
    const invalid = invoke('--', '--plan', '--ci-group', 'core')
    assert.ok(invalid.status !== null && invalid.status !== 0, 'mixed modes must fail')
    assert.equal(existsSync(effects), false, 'invalid CLI must not execute tasks')
    requireSuccess(invoke())
    assert.equal(readFileSync(effects, 'utf8'), 'core:first\ntest:coverage\ncore:last\ncore:tail\n')
    rmSync(effects)
    env.ROOT_FIXTURE_FAIL = 'core:last'
    const failed = invoke()
    assert.ok(failed.status !== null && failed.status !== 0, 'failed child must fail Root')
    assert.equal(readFileSync(effects, 'utf8'), 'core:first\ntest:coverage\ncore:last\n')
  })
}

function toolingAndPlan() {
  withFixture('bun run task.ts test:coverage', (fixture, env) => {
    const invoke = (...args: string[]) =>
      command(fixture, env, process.execPath, ['run', 'validate:tooling', ...args])
    const effects = join(fixture, 'effects.txt')
    const plan = invoke('--', '--plan')
    requireSuccess(plan)
    const parsed = JSON.parse(plan.stdout)
    assert.deepEqual(parsed.tasks, ['tooling:first', 'tooling:last', 'tooling:tail'])
    assert.deepEqual(parsed.core, parsed.tasks)
    assert.deepEqual(parsed.coverage, [])
    assert.equal(existsSync(effects), false, 'tooling plan must not execute tasks')
    const invalid = invoke('--', '--plan', '--ci-group', 'core')
    assert.ok(invalid.status !== null && invalid.status !== 0)
    assert.equal(existsSync(effects), false, 'invalid options must not execute tasks')
    requireSuccess(invoke())
    assert.equal(readFileSync(effects, 'utf8'), 'tooling:first\ntooling:last\ntooling:tail\n')
    rmSync(effects)
    env.ROOT_FIXTURE_FAIL = 'tooling:last'
    const failed = invoke()
    assert.ok(failed.status !== null && failed.status !== 0)
    assert.equal(readFileSync(effects, 'utf8'), 'tooling:first\ntooling:last\n')
    rmSync(effects)

    const manifestPath = join(fixture, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const recipe of [
      'bun run scripts/kit/root-gate.ts tooling:first tooling:first',
      'bun run scripts/kit/root-gate.ts tooling:first test:coverage',
      'bun run scripts/kit/root-gate.ts tooling:first validate:tooling',
      'bun run scripts/kit/root-gate.ts tooling:first validate:full',
      'bun run scripts/kit/root-gate.ts tooling:first missing:task',
      'bun run scripts/kit/root-gate.ts tooling:first  tooling:last',
    ]) {
      manifest.scripts['validate:tooling'] = recipe
      writeFileSync(manifestPath, JSON.stringify(manifest))
      const rejected = invoke('--', '--plan')
      assert.ok(rejected.status !== null && rejected.status !== 0, `must reject ${recipe}`)
      assert.equal(existsSync(effects), false, 'rejected recipe must not execute tasks')
    }
  })
}

function coveragePlan() {
  withFixture('bun run task.ts test:coverage', (fixture, env) => {
    const listing = join(fixture, 'listing.txt')
    writeFileSync(
      join(fixture, 'scripts/kit/test-coverage.sh'),
      [
        '#!/bin/bash',
        `if [[ -n "\${COVERAGE_ONLY:-}" ]]; then printf "%s\\n" "$COVERAGE_ONLY";`,
        `elif [[ -n "\${COVERAGE_CHANGED_BASE:-}" || "\${COVERAGE_LIST_KIT:-}" == 1 ]]; then echo apps/truncated;`,
        'else cat listing.txt; fi',
        '',
      ].join('\n'),
    )
    const invoke = () =>
      command(fixture, env, process.execPath, ['run', 'validate:full', '--', '--coverage-plan'])
    const plan = (inventory: string[]) => {
      writeFileSync(listing, `${inventory.join('\n')}\n`)
      const result = invoke()
      requireSuccess(result)
      return JSON.parse(result.stdout) as { id: string; workspaces: string[] }[]
    }
    const packages = [
      'packages/shared',
      'packages/zeta',
      'packages/alpha',
      'packages/beta',
      'packages/gamma',
      'packages/delta',
      'packages/epsilon',
      'packages/eta',
      'packages/theta',
    ]
    const apps = ['apps/shared', 'apps/unknown-product', 'apps/example-api']
    const inventory = [apps[0], ...packages.slice(0, 5), apps[1], ...packages.slice(5), apps[2]]
    const expected = [
      { id: 'packages-1', workspaces: [packages[0], packages[3], packages[6]] },
      { id: 'packages-2', workspaces: [packages[1], packages[4], packages[7]] },
      { id: 'packages-3', workspaces: [packages[2], packages[5], packages[8]] },
      { id: 'apps__shared', workspaces: [apps[0]] },
      { id: 'apps__unknown-product', workspaces: [apps[1]] },
      { id: 'apps__example-api', workspaces: [apps[2]] },
    ]
    const actual = plan(inventory)
    assert.deepEqual(actual, expected, 'groups preserve package order and isolate every app')
    assert.deepEqual(plan(inventory), actual, 'identical inventory produces an identical plan')
    const planned = actual.flatMap((group) => group.workspaces)
    assert.deepEqual(
      [...planned].sort(),
      [...inventory].sort(),
      'every listed workspace occurs once',
    )
    assert.equal(new Set(planned).size, inventory.length)
    assert.equal(existsSync(join(fixture, 'effects.txt')), false, 'planning must not execute tasks')

    for (const [count, sizes] of [
      [0, []],
      [1, [1]],
      [4, [4]],
      [5, [3, 2]],
      [8, [4, 4]],
      [9, [3, 3, 3]],
    ] as [number, number[]][]) {
      const groups = plan([...packages.slice(0, count), apps[0]])
      assert.deepEqual(
        groups
          .filter((group) => group.id.startsWith('packages-'))
          .map((group) => group.workspaces.length),
        sizes,
        `package group cap at ${count} packages`,
      )
      assert.deepEqual(groups.at(-1), { id: 'apps__shared', workspaces: [apps[0]] })
    }

    for (const [flag, value] of [
      ['COVERAGE_ONLY', 'apps/shared'],
      ['COVERAGE_CHANGED_BASE', 'HEAD'],
      ['COVERAGE_LIST_KIT', '1'],
      ['COVERAGE_LIST_ONLY', '1'],
    ]) {
      env[flag] = value
      assert.deepEqual(plan(inventory), expected, `${flag} must not narrow the plan`)
      delete env[flag]
    }

    for (const [label, output] of [
      ['empty', ''],
      ['blank line', 'packages/shared\n\napps/shared\n'],
      ['malformed namespace', 'other/shared\n'],
      ['malformed path', 'packages/../escape\n'],
      ['duplicate', 'packages/shared\napps/shared\npackages/shared\n'],
    ]) {
      writeFileSync(listing, output)
      const result = invoke()
      assert.ok(
        result.status !== null && result.status !== 0,
        `${label} listing accepted\n${result.stdout}\n${result.stderr}`,
      )
    }
    assert.equal(existsSync(join(fixture, 'effects.txt')), false)
  })
}

type FixtureReceipt = {
  tasks: string[]
  results: { task: string; exitCode: number | string }[]
  complete: boolean | string
  group: string
}

function joinAdmission() {
  withFixture('bun run task.ts test:coverage', (fixture, env) => {
    const dir = join(fixture, 'receipts')
    mkdirSync(dir)
    const corePath = join(dir, 'root-core.json')
    const coveragePath = join(dir, 'root-coverage.json')
    const root = (...args: string[]) =>
      command(fixture, env, process.execPath, ['run', 'validate:full', '--', ...args])
    requireSuccess(root('--ci-group', 'core', '--receipt', corePath))
    requireSuccess(root('--ci-group', 'coverage', '--receipt', coveragePath))
    assert.equal(
      readFileSync(join(fixture, 'effects.txt'), 'utf8'),
      'core:first\ncore:last\ncore:tail\ntest:coverage\n',
    )
    const originalCore = readFileSync(corePath, 'utf8')
    const originalCoverage = readFileSync(coveragePath, 'utf8')
    const restore = () => {
      writeFileSync(corePath, originalCore)
      writeFileSync(coveragePath, originalCoverage)
    }
    const joinResult = (status = 'success') => root('--ci-join', dir, '--producers-result', status)
    const refused = (label: string, status = 'success') => {
      const result = joinResult(status)
      assert.ok(
        result.status !== null && result.status !== 0,
        `${label} accepted\n${result.stdout}\n${result.stderr}`,
      )
    }
    requireSuccess(joinResult())
    for (const status of ['failure', 'cancelled', 'skipped']) refused(`producer ${status}`, status)
    for (const [field, value] of Object.entries({
      repository: 'foreign/repository',
      checkoutSha: 'f'.repeat(40),
      runId: '99999',
      runAttempt: '9',
      recipeHash: 'f'.repeat(64),
      runnerHash: 'f'.repeat(64),
    })) {
      const core = JSON.parse(originalCore)
      const coverage = JSON.parse(originalCoverage)
      core[field] = value
      coverage[field] = value
      writeFileSync(corePath, JSON.stringify(core))
      writeFileSync(coveragePath, JSON.stringify(coverage))
      refused(`same foreign ${field}`)
      restore()
    }
    const defects: [string, (receipt: FixtureReceipt) => void][] = [
      [
        'missing task',
        (r) => {
          r.tasks.pop()
        },
      ],
      [
        'duplicate task',
        (r) => {
          r.tasks[2] = r.tasks[1]
        },
      ],
      [
        'reordered tail tasks',
        (r) => {
          ;[r.tasks[1], r.tasks[2]] = [r.tasks[2], r.tasks[1]]
        },
      ],
      [
        'missing result',
        (r) => {
          r.results.pop()
        },
      ],
      [
        'reordered results',
        (r) => {
          ;[r.results[1], r.results[2]] = [r.results[2], r.results[1]]
        },
      ],
      [
        'nonzero result',
        (r) => {
          r.results[0].exitCode = 1
        },
      ],
      [
        'string zero result',
        (r) => {
          r.results[0].exitCode = '0'
        },
      ],
      [
        'incomplete receipt',
        (r) => {
          r.complete = false
        },
      ],
      [
        'non-boolean complete',
        (r) => {
          r.complete = 'true'
        },
      ],
      [
        'duplicate group',
        (r) => {
          r.group = 'coverage'
        },
      ],
    ]
    for (const [label, mutate] of defects) {
      const core: FixtureReceipt = JSON.parse(originalCore)
      mutate(core)
      writeFileSync(corePath, JSON.stringify(core))
      refused(label)
      restore()
    }
    writeFileSync(join(dir, 'extra.json'), '{}')
    refused('extra receipt')
    rmSync(join(dir, 'extra.json'))
    writeFileSync(corePath, '{')
    refused('malformed receipt')
    rmSync(corePath)
    const target = join(fixture, 'linked-core.json')
    writeFileSync(target, originalCore)
    symlinkSync(target, corePath)
    refused('symlink receipt')
    rmSync(corePath)
    restore()
    requireSuccess(joinResult())
  })
}

sameRunJoin()
console.log('PASS same-run Core and Coverage join; missing Coverage refused')
refuseCoverageListing()
coverageShard()
coverageShardJoin()
fullAndPlan()
toolingAndPlan()
coveragePlan()
joinAdmission()
console.log('PASS full execution, plan, fail-fast and join admission guards')
console.log('PASS coverage listing modes refused in full and Coverage group')
