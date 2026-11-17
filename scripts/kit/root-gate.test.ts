import assert from 'node:assert/strict'
import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
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
    writeFileSync(join(fixtureScripts, 'test-coverage.sh'), '#!/bin/bash\nexit 0\n')
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

function declareFixturePartition(fixture: string) {
  writeFileSync(
    join(fixture, 'scripts/kit/test-coverage.sh'),
    `#!/bin/bash\nif [[ "\${COVERAGE_LIST_PARTS:-}" == 1 ]]; then echo 'apps/example-api 2'; else echo 'apps/example-api'; fi\n`,
  )
}

function convertFixtureCoverage(dir: string) {
  const original = join(dir, 'root-coverage.json')
  const coverage = JSON.parse(readFileSync(original, 'utf8'))
  coverage.shard = 'apps/example-api'
  coverage.partition = { count: 2, blobs: ['a'.repeat(64), 'b'.repeat(64)] }
  writeFileSync(join(dir, 'root-coverage-apps__example-api.json'), JSON.stringify(coverage))
  rmSync(original)
}

function writeFixtureShard(
  dir: string,
  workspace: string,
  coverage: Record<string, unknown>,
  partitions: ReadonlyMap<string, number>,
) {
  const count = partitions.get(workspace)
  const receipt = {
    ...coverage,
    shard: workspace,
    ...(count === undefined
      ? {}
      : {
          partition: { count, blobs: Array.from({ length: count }, (_, i) => `${i}`.repeat(64)) },
        }),
  }
  writeFileSync(
    join(dir, `root-coverage-${workspace.replace('/', '__')}.json`),
    `${JSON.stringify(receipt)}\n`,
  )
}

function sameRunJoin() {
  withFixture('bun run task.ts test:coverage', (fixture, env) => {
    declareFixturePartition(fixture)
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

    convertFixtureCoverage(receipts)
    requireSuccess(root('--ci-join', receipts, '--producers-result', 'success'))
    rmSync(join(receipts, 'root-coverage-apps__example-api.json'))
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
    ['COVERAGE_LIST_PARTS', '1', 'coverage listing mode cannot execute the Root gate'],
    ['COVERAGE_PART', '1/2', 'coverage listing mode cannot execute the Root gate'],
    ['COVERAGE_BLOB', '/tmp/blob', 'coverage listing mode cannot execute the Root gate'],
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

function liveCoverageShardJoin() {
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
  coverageShardJoin(repo, env)
}

function coverageShardJoin(repo: string, env: NodeJS.ProcessEnv) {
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
  const partsPlan = command(repo, env, process.execPath, [
    'run',
    'validate:full',
    '--',
    '--coverage-parts-plan',
  ])
  requireSuccess(partsPlan)
  const partitions = new Map<string, number>(
    (JSON.parse(partsPlan.stdout) as { workspace: string; count: number }[]).map(
      ({ workspace, count }) => [workspace, count],
    ),
  )
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
    const writeShard = (workspace: string) =>
      writeFixtureShard(
        dir,
        workspace,
        {
          version: 1,
          group: 'coverage',
          ...bound,
          tasks: ['test:coverage'],
          results: [{ task: 'test:coverage', exitCode: 0 }],
          complete: true,
        },
        partitions,
      )
    for (const workspace of workspaces) writeShard(workspace)
    const skippedVerdict = 'success-without-parts'
    const joinGate = (status = 'success') =>
      command(repo, env, process.execPath, [
        'run',
        'validate:full',
        '--',
        '--ci-join',
        dir,
        '--producers-result',
        status,
      ])
    const partitionPath = join(dir, 'root-coverage-apps__example-api.json')
    const partitionReceipt = readFileSync(partitionPath, 'utf8')
    const altered = JSON.parse(partitionReceipt)
    delete altered.partition
    writeFileSync(partitionPath, JSON.stringify(altered))
    assert.notEqual(joinGate().status, 0, 'single receipt must not authorize a partitioned App')
    altered.partition = { count: 3, blobs: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)] }
    writeFileSync(partitionPath, JSON.stringify(altered))
    assert.notEqual(joinGate().status, 0, 'wrong partition count must fail')
    writeFileSync(partitionPath, partitionReceipt)
    requireSuccess(joinGate())
    const skippedWithValidReceipts = joinGate(skippedVerdict)
    assert.notEqual(skippedWithValidReceipts.status, 0)
    assert.match(skippedWithValidReceipts.stderr, /producer matrix did not succeed/)
    const ordinary = workspaces.find((ws) => !partitions.has(ws))
    assert.ok(ordinary, 'the live bar must include an unpartitioned workspace')
    const ordinaryPath = join(dir, `root-coverage-${ordinary.replace('/', '__')}.json`)
    const ordinaryReceipt = readFileSync(ordinaryPath, 'utf8')
    const wrongMode = JSON.parse(ordinaryReceipt)
    wrongMode.partition = { count: 2, blobs: ['a'.repeat(64), 'b'.repeat(64)] }
    writeFileSync(ordinaryPath, JSON.stringify(wrongMode))
    assert.notEqual(
      joinGate().status,
      0,
      'unpartitioned workspace cannot accept partition metadata',
    )
    writeFileSync(ordinaryPath, ordinaryReceipt)
    const whole = mkdtempSync(join(tmpdir(), 'kit-whole-coverage-'))
    try {
      copyFileSync(join(dir, 'root-core.json'), join(whole, 'root-core.json'))
      copyFileSync(partitionPath, join(whole, 'root-coverage.json'))
      const skippedWhole = command(repo, env, process.execPath, [
        'run',
        'validate:full',
        '--',
        '--ci-join',
        whole,
        '--producers-result',
        skippedVerdict,
      ])
      assert.notEqual(skippedWhole.status, 0)
      assert.match(skippedWhole.stderr, /producer matrix did not succeed/)
      const result = command(repo, env, process.execPath, [
        'run',
        'validate:full',
        '--',
        '--ci-join',
        whole,
        '--producers-result',
        'success',
      ])
      assert.notEqual(
        result.status,
        0,
        'whole-coverage receipt must not bypass declared partitions',
      )
      assert.match(
        result.stderr,
        /monolithic coverage receipt cannot authorize declared partitions/,
      )
    } finally {
      rmSync(whole, { recursive: true, force: true })
    }
    const dropped = workspaces[0]
    rmSync(join(dir, `root-coverage-${dropped.replace('/', '__')}.json`))
    const missing = joinGate()
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /do not match the discovered workspace bar/)
    writeShard(dropped)
    writeFileSync(join(dir, 'root-coverage.json'), '{}\n')
    const ambiguous = joinGate()
    assert.notEqual(ambiguous.status, 0)
    assert.match(ambiguous.stderr, /monolithic coverage receipt/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function consumerCoverageShardJoin() {
  withFixture('bun run task.ts test:coverage', (fixture, env) => {
    writeFileSync(
      join(fixture, 'scripts/kit/test-coverage.sh'),
      `#!/bin/bash\nif [[ "\${COVERAGE_LIST_PARTS:-}" == 1 ]]; then cat partitions.txt; else printf 'apps/example-api\\napps/acme-api\\npackages/core\\n'; fi\n`,
    )
    for (const count of [2, 3, 4]) {
      writeFileSync(join(fixture, 'partitions.txt'), `apps/example-api 2\napps/acme-api ${count}\n`)
      coverageShardJoin(fixture, env)
    }
  })
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

function toolingShards() {
  withFixture('bun run task.ts test:coverage', (fixture, env) => {
    const manifestPath = join(fixture, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const tasks = Array.from({ length: 33 }, (_, i) => `tooling:task${i}`)
    for (const task of tasks) manifest.scripts[task] = `bun run task.ts ${task}`
    const setRecipe = () => {
      manifest.scripts['validate:tooling'] = `bun run scripts/kit/root-gate.ts ${tasks.join(' ')}`
      writeFileSync(manifestPath, JSON.stringify(manifest))
    }
    setRecipe()
    const invoke = (...args: string[]) =>
      command(fixture, env, process.execPath, ['run', 'validate:tooling', '--', ...args])
    const plan = invoke('--plan')
    requireSuccess(plan)
    assert.deepEqual(
      JSON.parse(plan.stdout).toolingShards,
      [1, 2, 3].map((index) => ({ index, count: 3, id: `tooling-${index}` })),
    )
    const directory = join(fixture, 'receipts')
    mkdirSync(directory)
    const runShard = (index: number) => {
      const folder = join(directory, `tooling-12345-1-${index}`)
      mkdirSync(folder)
      const path = join(folder, `tooling-${index}.json`)
      requireSuccess(invoke('--ci-tooling-shard', `${index}/3`, '--receipt', path))
      return path
    }
    const paths = [1, 2, 3].map(runShard)
    const receipts = paths.map((path) => JSON.parse(readFileSync(path, 'utf8')))
    assert.deepEqual(
      receipts.map((receipt) => receipt.tasks),
      [0, 1, 2].map((index) => tasks.filter((_, offset) => offset % 3 === index)),
    )
    assert.equal(new Set(receipts.flatMap((receipt) => receipt.tasks)).size, 33)
    const joinReceipts = (status = 'success') =>
      invoke('--ci-tooling-join', directory, '--producers-result', status)
    requireSuccess(joinReceipts())
    assert.notEqual(joinReceipts('failure').status, 0)
    for (const bad of ['0/3', '4/3', '1/2', '01/3', '1/4', '']) {
      assert.notEqual(
        invoke('--ci-tooling-shard', bad, '--receipt', join(fixture, 'tooling-1.json')).status,
        0,
      )
    }
    assert.notEqual(
      command(fixture, env, process.execPath, [
        'run',
        'validate:full',
        '--',
        '--ci-tooling-shard',
        '1/3',
        '--receipt',
        join(fixture, 'tooling-1.json'),
      ]).status,
      0,
    )
    assert.notEqual(invoke('--ci-tooling-shard', '1/3', '--receipt', paths[0]).status, 0)
    const original = readFileSync(paths[0], 'utf8')
    for (const mutation of [
      { checkoutSha: '0'.repeat(40) },
      { repository: 'other/repo' },
      { runId: '999' },
      { runAttempt: '2' },
      { recipeHash: 'wrong' },
      { runnerHash: 'wrong' },
      { complete: false },
      { index: 2 },
      { count: 2 },
      { results: [] },
      {
        results: receipts[0].results.map((result: { task: string; exitCode: number }, i: number) =>
          i ? result : { ...result, exitCode: 1 },
        ),
      },
      { tasks: [...receipts[0].tasks].reverse() },
    ]) {
      writeFileSync(paths[0], JSON.stringify({ ...receipts[0], ...mutation }))
      assert.notEqual(joinReceipts().status, 0, JSON.stringify(mutation))
    }
    writeFileSync(paths[0], original)
    const extra = join(directory, 'extra')
    mkdirSync(extra)
    assert.notEqual(joinReceipts().status, 0)
    rmSync(extra, { recursive: true })
    const duplicate = join(directory, 'tooling-12345-1-1', 'duplicate.json')
    copyFileSync(paths[0], duplicate)
    assert.notEqual(joinReceipts().status, 0)
    rmSync(duplicate)
    rmSync(paths[0])
    assert.notEqual(joinReceipts().status, 0)
    env.ROOT_FIXTURE_FAIL = tasks[3]
    assert.notEqual(invoke('--ci-tooling-shard', '1/3', '--receipt', paths[0]).status, 0)
    const partial = JSON.parse(readFileSync(paths[0], 'utf8'))
    assert.equal(partial.complete, false)
    assert.deepEqual(
      partial.results.map((result: { task: string }) => result.task),
      [tasks[0], tasks[3]],
    )
    assert.notEqual(joinReceipts().status, 0)
    delete env.ROOT_FIXTURE_FAIL
    rmSync(paths[0])
    tasks.push('tooling:new')
    manifest.scripts['tooling:new'] = 'bun run task.ts tooling:new'
    setRecipe()
    const newPlan = invoke('--plan')
    requireSuccess(newPlan)
    assert.deepEqual(JSON.parse(newPlan.stdout).tasks, tasks)
    const newPath = join(fixture, 'tooling-1.json')
    requireSuccess(invoke('--ci-tooling-shard', '1/3', '--receipt', newPath))
    assert.equal(JSON.parse(readFileSync(newPath, 'utf8')).tasks.at(-1), 'tooling:new')
    tasks.splice(1)
    setRecipe()
    assert.notEqual(invoke('--plan').status, 0, 'empty shards refused')
  })
}

function coveragePlan() {
  withFixture('bun run task.ts test:coverage', (fixture, env) => {
    const listing = join(fixture, 'listing.txt')
    writeFileSync(
      join(fixture, 'scripts/kit/test-coverage.sh'),
      [
        '#!/bin/bash',
        `if [[ "\${COVERAGE_LIST_PARTS:-}" == 1 ]]; then exit 0;`,
        `elif [[ -n "\${COVERAGE_ONLY:-}" ]]; then printf "%s\\n" "$COVERAGE_ONLY";`,
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
    declareFixturePartition(fixture)
    const dir = join(fixture, 'receipts')
    mkdirSync(dir)
    const corePath = join(dir, 'root-core.json')
    const coveragePath = join(dir, 'root-coverage-apps__example-api.json')
    const root = (...args: string[]) =>
      command(fixture, env, process.execPath, ['run', 'validate:full', '--', ...args])
    requireSuccess(root('--ci-group', 'core', '--receipt', corePath))
    requireSuccess(root('--ci-group', 'coverage', '--receipt', join(dir, 'root-coverage.json')))
    convertFixtureCoverage(dir)
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

function emptyPartitionJoin() {
  withFixture('bun run task.ts test:coverage', (fixture, env) => {
    writeFileSync(
      join(fixture, 'scripts/kit/test-coverage.sh'),
      `#!/bin/bash\nif [[ "\${COVERAGE_LIST_PARTS:-}" == 1 ]]; then printf x >> partition-calls; exit 0; fi\nprintf "packages/core\\n"\n`,
    )
    const dir = join(fixture, 'receipts')
    mkdirSync(dir)
    const invoke = (...args: string[]) =>
      command(fixture, env, process.execPath, ['run', 'validate:full', '--', ...args])
    requireSuccess(invoke('--ci-group', 'core', '--receipt', join(dir, 'root-core.json')))
    requireSuccess(
      invoke(
        '--ci-coverage-shard',
        'packages/core',
        '--receipt',
        join(dir, 'root-coverage-packages__core.json'),
      ),
    )
    for (const status of ['success', 'success-without-parts']) {
      rmSync(join(fixture, 'partition-calls'), { force: true })
      assert.notEqual(invoke('--ci-join', dir, '--producers-result', status).status, 0)
      assert.equal(readFileSync(join(fixture, 'partition-calls'), 'utf8'), 'x')
    }
    rmSync(join(fixture, 'partition-calls'), { force: true })
    const plan = invoke('--coverage-parts-plan')
    assert.notEqual(plan.status, 0)
    assert.match(plan.stderr, /ADR-0023 D10/)
    assert.equal(readFileSync(join(fixture, 'partition-calls'), 'utf8'), 'x')
  })
}

function requiredKitPartition() {
  withFixture('bun run task.ts test:coverage', (fixture, env) => {
    const listing = join(fixture, 'scripts/kit/test-coverage.sh')
    const declarations = join(fixture, 'partitions.txt')
    writeFileSync(
      listing,
      `#!/bin/bash\nif [[ "\${COVERAGE_LIST_PARTS:-}" == 1 ]]; then cat partitions.txt; else printf 'apps/example-api\\napps/acme-api\\n'; fi\n`,
    )
    writeFileSync(declarations, 'apps/example-api 2\napps/acme-api 2\n')
    const dir = join(fixture, 'receipts')
    mkdirSync(dir)
    const invoke = (...args: string[]) =>
      command(fixture, env, process.execPath, ['run', 'validate:full', '--', ...args])
    requireSuccess(invoke('--ci-group', 'core', '--receipt', join(dir, 'root-core.json')))
    const original = join(dir, 'root-coverage.json')
    requireSuccess(invoke('--ci-group', 'coverage', '--receipt', original))
    const coverage = JSON.parse(readFileSync(original, 'utf8'))
    rmSync(original)
    const partitions = new Map<string, number>([
      ['apps/example-api', 2],
      ['apps/acme-api', 2],
    ])
    const writeShard = (workspace: string) =>
      writeFixtureShard(dir, workspace, coverage, partitions)
    writeShard('apps/acme-api')
    writeShard('apps/example-api')
    const plan = invoke('--coverage-parts-plan')
    requireSuccess(plan)
    assert.deepEqual(JSON.parse(plan.stdout), [
      { id: 'apps__example-api', workspace: 'apps/example-api', count: 2, indices: [1, 2] },
      { id: 'apps__acme-api', workspace: 'apps/acme-api', count: 2, indices: [1, 2] },
    ])
    const joinGate = () => invoke('--ci-join', dir, '--producers-result', 'success')
    requireSuccess(joinGate())
    function assertConsumerPartitions() {
      for (const count of [2, 3, 4]) {
        writeFileSync(declarations, `apps/example-api 2\napps/acme-api ${count}\n`)
        partitions.set('apps/acme-api', count)
        writeShard('apps/acme-api')
        requireSuccess(joinGate())
        partitions.delete('apps/acme-api')
        writeShard('apps/acme-api')
        const missingPartition = joinGate()
        assert.notEqual(missingPartition.status, 0)
        assert.match(missingPartition.stderr, /coverage receipt partition mode mismatch/)
        partitions.set('apps/acme-api', count === 2 ? 3 : 2)
        writeShard('apps/acme-api')
        const wrongCount = joinGate()
        assert.notEqual(wrongCount.status, 0)
        assert.match(wrongCount.stderr, /coverage receipt partition mode mismatch/)
      }
    }
    assertConsumerPartitions()
    partitions.set('apps/acme-api', 2)
    writeShard('apps/acme-api')
    for (const count of [undefined, 3]) {
      writeFileSync(
        declarations,
        `${count === undefined ? '' : `apps/example-api ${count}\n`}apps/acme-api 2\n`,
      )
      if (count === undefined) partitions.delete('apps/example-api')
      else partitions.set('apps/example-api', count)
      writeShard('apps/example-api')
      for (const result of [invoke('--coverage-parts-plan'), joinGate()]) {
        assert.notEqual(result.status, 0)
        assert.match(
          result.stderr,
          /ADR-0023 D10 requires apps\/example-api partitioned into 2 parts/,
        )
      }
    }
  })
}

function partitionVitest() {
  withFixture('bash scripts/kit/test-coverage.sh', (fixture, env) => {
    const kit = command(join(kitScripts, '../..'), { ...env, COVERAGE_LIST_KIT: '1' }, 'bash', [
      join(kitScripts, 'test-coverage.sh'),
    ])
    requireSuccess(kit)
    copyFileSync(
      join(kitScripts, 'test-coverage.sh'),
      join(fixture, 'scripts/kit/test-coverage.sh'),
    )
    const pkgPath = join(fixture, 'package.json')
    const manifest = JSON.parse(readFileSync(pkgPath, 'utf8'))
    manifest.workspaces = ['apps/*', 'packages/*']
    writeFileSync(pkgPath, JSON.stringify(manifest))
    for (const ws of kit.stdout.trim().split('\n')) {
      mkdirSync(join(fixture, ws), { recursive: true })
      writeFileSync(
        join(fixture, ws, 'package.json'),
        JSON.stringify({
          name: ws.replace('/', '-'),
          scripts: { 'test:coverage': 'vitest run --coverage' },
        }),
      )
    }
    symlinkSync(join(kitScripts, '../../node_modules'), join(fixture, 'node_modules'), 'dir')
    const app = join(fixture, 'apps/example-api')
    mkdirSync(join(app, 'src'))
    symlinkSync(
      join(kitScripts, '../../apps/example-api/node_modules'),
      join(app, 'node_modules'),
      'dir',
    )
    writeFileSync(
      join(app, 'vitest.config.ts'),
      `import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { coverage: { provider: 'v8', include: ['src/*.ts'], exclude: ['src/*.test.ts'], reportsDirectory: '../../coverage/example-api', reporter: ['json-summary'], reportOnFailure: true, thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 } } } })\n`,
    )
    for (const name of ['one', 'two']) {
      writeFileSync(join(app, `src/${name}.ts`), `export function ${name}() { return '${name}' }\n`)
      writeFileSync(
        join(app, `src/${name}.test.ts`),
        `import { test, expect } from 'vitest'\nimport { ${name} } from './${name}'\ntest('${name}', () => expect(${name}()).toBe('${name}'))\n`,
      )
    }
    const invoke = (...args: string[]) =>
      command(fixture, env, process.execPath, ['run', 'validate:full', '--', ...args])
    function assertInvalidDeclarations(partitionFile: string) {
      for (const invalid of ['apps/acme-two 1', 'apps/missing 2', 'apps/example-api 2']) {
        writeFileSync(partitionFile, invalid)
        for (const options of [
          [],
          ['--coverage-plan'],
          ['--coverage-parts-plan'],
          ['--ci-join', fixture, '--producers-result', 'success'],
        ]) {
          const result = invoke(...options)
          assert.notEqual(result.status, 0, `invalid declaration accepted: ${invalid}`)
          assert.match(result.stderr, /invalid, duplicate, or stale partition/)
          assert.equal(existsSync(join(fixture, 'effects.txt')), false)
        }
      }
    }
    function assertProductPlans() {
      const productConfig = join(fixture, 'config/product')
      mkdirSync(productConfig, { recursive: true })
      const productApps = ['apps/acme-two', 'apps/acme-three', 'apps/acme-four']
      for (const ws of productApps) {
        mkdirSync(join(fixture, ws), { recursive: true })
        writeFileSync(
          join(fixture, ws, 'package.json'),
          JSON.stringify({
            name: ws.replace('/', '-'),
            scripts: { 'test:coverage': 'vitest run --coverage' },
          }),
        )
      }
      writeFileSync(
        join(productConfig, 'coverage-order.txt'),
        productApps.map((ws) => `high ${ws}`).join('\n'),
      )
      const partitionFile = join(productConfig, 'coverage-partitions.txt')
      writeFileSync(partitionFile, productApps.map((ws, i) => `${ws} ${i + 2}`).join('\n'))
      const extendedParts = invoke('--coverage-parts-plan')
      const extendedGroups = invoke('--coverage-plan')
      requireSuccess(extendedParts)
      requireSuccess(extendedGroups)
      const descriptors = JSON.parse(extendedParts.stdout) as {
        id: string
        workspace: string
        indices: number[]
        count: number
      }[]
      const grouped = (JSON.parse(extendedGroups.stdout) as { workspaces: string[] }[]).flatMap(
        (g) => g.workspaces,
      )
      const declared = new Map([
        ['apps/example-api', 2] as [string, number],
        ...productApps.map((ws, i) => [ws, i + 2] as [string, number]),
      ])
      for (const [ws, count] of declared) {
        const matching = descriptors.filter((item) => item.workspace === ws)
        assert.equal(matching.length, 1)
        assert.equal(matching[0].id, ws.replace('/', '__'))
        assert.deepEqual(
          matching[0].indices,
          Array.from({ length: count }, (_, i) => i + 1),
        )
        assert.equal(matching[0].count, count)
        assert.ok(!grouped.includes(ws))
      }
      const bar = [...kit.stdout.trim().split('\n'), ...productApps]
      assert.deepEqual([...grouped, ...declared.keys()].sort(), bar.sort())
      assert.equal(new Set(grouped).size, grouped.length)
      assertInvalidDeclarations(partitionFile)
      rmSync(join(fixture, 'config'), { recursive: true })
      for (const ws of productApps) rmSync(join(fixture, ws), { recursive: true })
    }
    assertProductPlans()
    const plan = invoke('--coverage-parts-plan')
    requireSuccess(plan)
    assert.deepEqual(JSON.parse(plan.stdout), [
      { id: 'apps__example-api', workspace: 'apps/example-api', count: 2, indices: [1, 2] },
    ])
    const groups = invoke('--coverage-plan')
    requireSuccess(groups)
    assert.ok(
      !JSON.parse(groups.stdout).some((group: { workspaces: string[] }) =>
        group.workspaces.includes('apps/example-api'),
      ),
    )
    const raw = join(fixture, 'raw')
    mkdirSync(raw)
    assert.notEqual(
      invoke(
        '--ci-coverage-shard',
        'apps/example-api',
        '--receipt',
        join(fixture, 'root-coverage-apps__example-api.json'),
      ).status,
      0,
    )
    assert.notEqual(
      invoke('--ci-coverage-part', 'apps/example-api', '3/2', '--raw', join(fixture, 'invalid'))
        .status,
      0,
    )
    assert.notEqual(
      invoke('--ci-coverage-part', 'apps/example-api', '1/3', '--raw', join(fixture, 'invalid'))
        .status,
      0,
    )
    const part = (i: number) => join(raw, `coverage-raw-12345-1-apps__example-api-${i}-of-2`)
    for (const i of [1, 2]) {
      requireSuccess(invoke('--ci-coverage-part', 'apps/example-api', `${i}/2`, '--raw', part(i)))
      if (i === 1) {
        const summary = JSON.parse(
          readFileSync(join(fixture, 'coverage/example-api/coverage-summary.json'), 'utf8'),
        )
        assert.ok(summary.total.lines.pct < 90, 'a real partial report is below the full floor')
      }
    }
    assert.notEqual(
      invoke('--ci-coverage-part', 'apps/example-api', '1/2', '--raw', part(1)).status,
      0,
      'existing raw staging cannot be reused',
    )
    const receipt = join(fixture, 'root-coverage-apps__example-api.json')
    const merge = () =>
      invoke('--ci-coverage-merge', 'apps/example-api', '--raw', raw, '--receipt', receipt)
    requireSuccess(merge())
    assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).partition.count, 2)
    rmSync(receipt)
    const tools = join(fixture, 'recording-bin')
    const calls = join(fixture, 'native-calls')
    mkdirSync(tools)
    writeFileSync(
      join(tools, 'bunx'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec '${process.execPath}' x "$@"\n`,
    )
    chmodSync(join(tools, 'bunx'), 0o755)
    env.PATH = `${tools}:${env.PATH}`
    const refuseBeforeNative = (label: string) => {
      rmSync(calls, { force: true })
      const result = merge()
      assert.notEqual(result.status, 0, label)
      assert.equal(existsSync(calls), false, `${label} ran native Vitest`)
      assert.equal(existsSync(receipt), false)
    }
    const file = join(part(1), 'part-1-2.json')
    const original = readFileSync(file, 'utf8')
    function assertArtifactAdmission() {
      for (const [key, value] of Object.entries({
        version: 2,
        kind: 'other',
        workspace: 'apps/foreign',
        complete: false,
        exitCode: 1,
        count: 3,
        index: 2,
        repository: 'foreign/repo',
        checkoutSha: 'f'.repeat(40),
        runId: '999',
        runAttempt: '2',
        recipeHash: 'f'.repeat(64),
        runnerHash: 'f'.repeat(64),
        vitestVersion: '0.0.0',
        blobSha256: 'a'.repeat(64),
      })) {
        const changed = JSON.parse(original)
        changed[key] = value
        writeFileSync(file, JSON.stringify(changed))
        refuseBeforeNative(`reject ${key}`)
      }
      writeFileSync(file, original)
      const blobOne = join(part(1), 'blob-1-2.json')
      const originalBlob = readFileSync(blobOne)
      writeFileSync(blobOne, Buffer.concat([originalBlob, Buffer.from(' ')]))
      refuseBeforeNative('blob bytes changed without updating manifest')
      writeFileSync(blobOne, originalBlob)
      const helper = join(fixture, 'scripts/kit/root-gate-parts.ts')
      const helperOriginal = readFileSync(helper, 'utf8')
      writeFileSync(helper, `${helperOriginal}\n// changed runner fixture\n`)
      refuseBeforeNative('runner helper changed after part production')
      writeFileSync(helper, helperOriginal)
    }
    assertArtifactAdmission()
    const omitted = join(app, 'src/omitted.test.ts')
    writeFileSync(omitted, "import { test } from 'vitest'\ntest('omitted', () => {})\n")
    const omittedResult = merge()
    assert.notEqual(omittedResult.status, 0)
    assert.match(omittedResult.stderr, /merged test file inventory mismatch/)
    assert.equal(existsSync(receipt), false)
    rmSync(omitted)
    const configPath = join(app, 'vitest.config.ts')
    const config = readFileSync(configPath, 'utf8')
    writeFileSync(
      configPath,
      config.replace(
        'test: { coverage:',
        "plugins: [{ name: 'warning-fixture', configResolved() { if (process.argv.includes('--merge-reports')) console.error('Excluding it from coverage.') } }], test: { coverage:",
      ),
    )
    const warning = merge()
    assert.notEqual(warning.status, 0)
    assert.match(warning.stderr, /native Vitest silently excluded a file from coverage/)
    assert.equal(existsSync(receipt), false)
    writeFileSync(configPath, config)
    writeFileSync(join(part(1), 'extra'), 'x')
    refuseBeforeNative('extra raw entry')
    rmSync(join(part(1), 'extra'))
    const extra = `${part(2)}.extra`
    cpSync(part(2), extra, { recursive: true })
    refuseBeforeNative('extra artifact')
    rmSync(extra, { recursive: true })
    rmSync(part(2), { recursive: true })
    refuseBeforeNative('missing part')
    assert.equal(existsSync(receipt), false)
    cpSync(part(1), part(2), { recursive: true })
    const blob = readFileSync(join(part(2), 'blob-1-2.json'))
    rmSync(join(part(2), 'blob-1-2.json'))
    writeFileSync(join(part(2), 'blob-2-2.json'), blob)
    const second = JSON.parse(original)
    second.index = 2
    second.blobSha256 = createHash('sha256').update(blob).digest('hex')
    rmSync(join(part(2), 'part-1-2.json'))
    writeFileSync(join(part(2), 'part-2-2.json'), JSON.stringify(second))
    assert.notEqual(merge().status, 0, 'duplicate replay must not hide an omitted file')
    assert.equal(existsSync(receipt), false)
    rmSync(part(1), { recursive: true })
    rmSync(part(2), { recursive: true })
    writeFileSync(join(app, 'src/uncovered.ts'), 'export function uncovered() { return 42 }\n')
    for (const i of [1, 2])
      requireSuccess(invoke('--ci-coverage-part', 'apps/example-api', `${i}/2`, '--raw', part(i)))
    assert.notEqual(merge().status, 0, 'full merged coverage must enforce original floors')
    assert.equal(existsSync(receipt), false)
    rmSync(join(app, 'src/uncovered.ts'))
    for (const i of [1, 2]) {
      rmSync(part(i), { recursive: true })
      requireSuccess(invoke('--ci-coverage-part', 'apps/example-api', `${i}/2`, '--raw', part(i)))
    }
    const testPath = join(app, 'src/one.test.ts')
    const goodTest = readFileSync(testPath, 'utf8')
    function assertReplayFloors(summaryPath: string, label: string) {
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
      for (const metric of ['statements', 'branches', 'functions', 'lines']) {
        assert.ok(summary.total[metric].pct >= 90, `${label}: ${metric} must pass its floor`)
      }
    }
    function assertFailedReplay() {
      for (const [label, source] of [
        [
          'failing test',
          "import { test, expect } from 'vitest'\nimport { one } from './one'\ntest('failure', () => { expect(one()).toBe('one'); expect(1).toBe(2) })\n",
        ],
        [
          'unhandled error',
          "import { test, expect } from 'vitest'\nimport { one } from './one'\ntest('error', () => { expect(one()).toBe('one'); queueMicrotask(() => { throw new Error('unhandled') }) })\n",
        ],
        [
          'silent exclusion',
          "import { test } from 'vitest'\ntest('warning', () => { console.error('Excluding it from coverage.') })\n",
        ],
      ]) {
        writeFileSync(testPath, source)
        const results = [1, 2].map((i) => {
          const target = join(fixture, `${label.replace(' ', '-')}-${i}`)
          const result = invoke('--ci-coverage-part', 'apps/example-api', `${i}/2`, '--raw', target)
          if (result.status !== 0) assert.equal(existsSync(join(target, `part-${i}-2.json`)), false)
          return { i, target, result }
        })
        const failed = results.find(({ result }) => result.status !== 0)
        assert.ok(failed, `${label} must refuse a part`)
        if (label !== 'silent exclusion') {
          const path = join(part(failed.i), `blob-${failed.i}-2.json`)
          const manifestPath = join(part(failed.i), `part-${failed.i}-2.json`)
          const savedBlob = readFileSync(path)
          const savedManifest = readFileSync(manifestPath, 'utf8')
          const failingBlob = readFileSync(join(failed.target, `blob-${failed.i}-2.json`))
          writeFileSync(path, failingBlob)
          const changed = JSON.parse(savedManifest)
          changed.blobSha256 = createHash('sha256').update(failingBlob).digest('hex')
          writeFileSync(manifestPath, JSON.stringify(changed))
          const summaryPath = join(fixture, 'coverage/example-api/coverage-summary.json')
          rmSync(summaryPath, { force: true })
          const replay = merge()
          assert.notEqual(replay.status, 0)
          assert.match(replay.stderr, /native Vitest command failed/)
          assert.match(replay.stdout, label === 'failing test' ? /failure/ : /unhandled/i)
          assert.doesNotMatch(`${replay.stdout}\n${replay.stderr}`, /ERROR:\s*Coverage for/i)
          assertReplayFloors(summaryPath, label)
          assert.equal(existsSync(receipt), false)
          writeFileSync(path, savedBlob)
          writeFileSync(manifestPath, savedManifest)
        }
      }
    }
    assertFailedReplay()
    writeFileSync(testPath, goodTest)
    writeFileSync(join(fixture, 'foreign.ts'), "export function foreign() { return 'foreign' }\n")
    writeFileSync(
      testPath,
      `${goodTest}\nimport { foreign } from '../../../foreign'\ntest('foreign', () => expect(foreign()).toBe('foreign'))\n`,
    )
    writeFileSync(
      configPath,
      config.replace(
        "include: ['src/*.ts']",
        "allowExternal: true, include: ['src/*.ts', '../../foreign.ts']",
      ),
    )
    for (const i of [1, 2]) {
      rmSync(part(i), { recursive: true })
      requireSuccess(invoke('--ci-coverage-part', 'apps/example-api', `${i}/2`, '--raw', part(i)))
    }
    const foreign = merge()
    assert.notEqual(foreign.status, 0)
    assert.match(foreign.stderr, /foreign coverage path/)
    assert.equal(existsSync(receipt), false)
    function assertForeignTestRefused() {
      writeFileSync(testPath, goodTest)
      const foreignDir = join(fixture, 'foreign-tests')
      mkdirSync(foreignDir)
      writeFileSync(join(foreignDir, 'outside.test.ts'), "test('outside', () => {})\n")
      writeFileSync(
        configPath,
        config.replace(
          'test: { coverage:',
          "test: { globals: true, include: ['src/*.test.ts', '../../foreign-tests/*.test.ts'], coverage:",
        ),
      )
      for (const i of [1, 2]) {
        rmSync(part(i), { recursive: true })
        requireSuccess(invoke('--ci-coverage-part', 'apps/example-api', `${i}/2`, '--raw', part(i)))
      }
      const result = merge()
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /foreign test path/)
      assert.equal(existsSync(receipt), false)
      const summaryPath = join(fixture, 'coverage/example-api/coverage-summary.json')
      assertReplayFloors(summaryPath, 'foreign test')
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
      for (const path of Object.keys(summary)) {
        assert.ok(path === 'total' || path.startsWith(`${app}/`), `foreign coverage: ${path}`)
      }
    }
    assertForeignTestRefused()
    function assertMissingSummaryRefused() {
      writeFileSync(configPath, config.replace("reporter: ['json-summary']", "reporter: ['text']"))
      for (const i of [1, 2]) {
        rmSync(part(i), { recursive: true })
        requireSuccess(invoke('--ci-coverage-part', 'apps/example-api', `${i}/2`, '--raw', part(i)))
      }
      const result = merge()
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /missing coverage-summary\.json for apps\/example-api/)
      assert.equal(existsSync(receipt), false)
    }
    assertMissingSummaryRefused()
  })
}

sameRunJoin()
console.log('PASS same-run Core and Coverage join; missing Coverage refused')
refuseCoverageListing()
coverageShard()
liveCoverageShardJoin()
consumerCoverageShardJoin()
fullAndPlan()
toolingAndPlan()
toolingShards()
coveragePlan()
joinAdmission()
emptyPartitionJoin()
requiredKitPartition()
partitionVitest()
console.log('PASS full execution, plan, fail-fast and join admission guards')
console.log('PASS coverage listing modes refused in full and Coverage group')
