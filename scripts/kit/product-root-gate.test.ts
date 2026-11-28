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
import { dirname, join } from 'node:path'
import { recipeTasks, rootGateLaunch } from './root-gate-recipe'

const repo = join(import.meta.dirname, '../..')
const app = 'apps/product-fixture'
const kitApp = 'apps/example-api'
const typecheck = 'tsc --noEmit'
const coverage = 'vitest run --coverage'
const { scripts: rootScripts } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
const thinTasks = recipeTasks(rootScripts['validate:full']).filter(
  (task) => task === 'typecheck' || task === 'test:coverage',
)
const thinRecipe = `${rootGateLaunch} ${thinTasks.join(' ')}`

function checked(result: SpawnSyncReturns<string>): string {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return result.stdout.trim()
}

function failed(result: SpawnSyncReturns<string>, cause: RegExp) {
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(`${result.stdout}\n${result.stderr}`, cause)
}

function setup(root: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(GIT_|GITHUB_|COVERAGE_|TURBO_)/.test(key)),
  )
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Root fixture',
    GIT_AUTHOR_EMAIL: 'root-fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Root fixture',
    GIT_COMMITTER_EMAIL: 'root-fixture@example.invalid',
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'kit/root-fixture',
    GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '1',
    TURBO_TELEMETRY_DISABLED: '1',
  })

  function command(executable: string, args: string[], extraEnv?: NodeJS.ProcessEnv) {
    const result = spawnSync(executable, args, {
      cwd: root,
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
    })
    if (result.error) throw result.error
    return result
  }
  const bun = (...args: string[]) => command(process.execPath, args)
  const gate = (...args: string[]) => bun('run', 'validate:full', '--', ...args)
  const git = (...args: string[]) => checked(command('git', args))

  function put(path: string, text: string) {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
  }
  function json(path: string, value: unknown) {
    put(path, `${JSON.stringify(value, null, 2)}\n`)
  }
  function copy(path: string) {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(repo, path), target)
  }
  function manifest(workspaces = ['apps/*', 'packages/*']) {
    json('package.json', {
      name: 'root-gate-fixture',
      private: true,
      packageManager: `bun@${Bun.version}`,
      workspaces,
      scripts: {
        'validate:full': thinRecipe,
        typecheck: rootScripts.typecheck,
        'test:coverage': rootScripts['test:coverage'],
      },
    })
  }
  function workspace(path: string, scripts: Record<string, string>) {
    json(`${path}/package.json`, { name: path.replace('/', '-'), private: true, scripts })
  }
  function source(path: string, text: string) {
    put(`${path}/src/value.ts`, text)
    json(`${path}/tsconfig.json`, {
      compilerOptions: { strict: true, types: [] },
      files: ['src/value.ts'],
    })
  }
  function commit(message: string) {
    git('add', '--all')
    git('commit', '-qm', message)
    env.GITHUB_SHA = git('rev-parse', 'HEAD')
    return env.GITHUB_SHA
  }

  for (const name of readdirSync(join(repo, 'scripts/kit'))) {
    if (/^root-gate(?:-.*)?\.ts$/.test(name) && !name.endsWith('.test.ts'))
      copy(`scripts/kit/${name}`)
  }
  for (const path of [
    'scripts/kit/select-tooling.ts',
    'scripts/kit/test-coverage.sh',
    'scripts/kit/print-coverage-summary.mjs',
    'config/kit/zero-edit-zones.json',
    'config/kit/bunfig.gates.toml',
    'packages/config/vitest-coverage.mts',
  ]) {
    copy(path)
  }
  manifest()
  json('turbo.json', { tasks: { typecheck: { cache: false } } })
  put('.gitignore', 'node_modules/\n/.turbo/\n/coverage/\n/receipts/\n/event.json\n')
  const listed = checked(
    command('bash', ['scripts/kit/test-coverage.sh'], { COVERAGE_LIST_KIT: '1' }),
  )
  for (const path of listed.split('\n')) workspace(path, { 'test:coverage': coverage })
  workspace(kitApp, { typecheck, 'test:coverage': coverage })
  source(kitApp, 'export const value: number = 1\n')
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir')
  mkdirSync(join(root, 'receipts'))
  git('init', '-q', '-b', 'main')

  return { root, manifest, workspace, source, put, json, commit, bun, gate, git, env }
}

const root = mkdtempSync(join(tmpdir(), 'product-root-gate-'))
try {
  const { manifest, workspace, source, put, json, commit, bun, gate, git, env } = setup(root)
  const coreReceipt = join(root, 'receipts/root-core.json')
  const coverageReceipt = join(root, 'receipts/root-coverage-apps__product-fixture.json')
  const core = () => gate('--ci-group', 'core', '--receipt', coreReceipt)
  const shard = () => gate('--ci-coverage-shard', app, '--receipt', coverageReceipt)
  const joinReceipts = (coverageResult = 'success', partsResult = 'skipped') =>
    gate(
      '--ci-join',
      join(root, 'receipts'),
      '--producers-result',
      'success',
      '--coverage-result',
      coverageResult,
      '--parts-result',
      partsResult,
    )

  function mergePullRequest(branch: string, change: () => void) {
    const base = git('rev-parse', 'HEAD')
    git('switch', '-qc', branch)
    change()
    const head = commit(`PR head: ${branch}`)
    git('switch', '-q', 'main')
    git('merge', '-q', '--no-ff', '-m', `Synthetic PR merge: ${branch}`, head)
    env.GITHUB_SHA = git('rev-parse', 'HEAD')
    env.GITHUB_EVENT_NAME = 'pull_request'
    env.GITHUB_EVENT_PATH = join(root, 'event.json')
    json('event.json', { pull_request: { base: { sha: base }, head: { sha: head } } })
  }

  function configureCoverage(floor: string, options = '') {
    put(
      `${app}/vitest.config.mts`,
      `import { makeCoverage } from '../../packages/config/vitest-coverage.mts'
export default { test: {
  maxWorkers: 1,
  coverage: { ...makeCoverage('product-fixture'${floor}), ${options} },
} }
`,
    )
  }

  // Bare Kit core succeeds with only protected App manifests.
  checked(bun('install', '--lockfile-only', '--offline'))
  commit('Bare Kit')
  assert.match(checked(core()), /apps-example-api:typecheck/)
  rmSync(coreReceipt)

  // With no Product Apps, a Product-docs-only PR selects neither Coverage producer.
  mergePullRequest('product-docs', () => put('docs/product/notes.txt', 'Product notes.\n'))
  assert.deepEqual(JSON.parse(checked(gate('--coverage-plan'))), [])
  assert.deepEqual(JSON.parse(checked(gate('--coverage-parts-plan'))), [])
  assert.match(checked(core()), /apps-example-api:typecheck/)
  assert.match(checked(joinReceipts('skipped', 'skipped')), /full Root passed by current-run join/)
  for (const result of ['failure', 'cancelled']) {
    failed(joinReceipts(result, 'skipped'), /coverage producer did not succeed/)
    failed(joinReceipts('skipped', result), /coverage partitions producer did not succeed/)
  }
  rmSync(coreReceipt)
  delete env.GITHUB_EVENT_NAME
  delete env.GITHUB_EVENT_PATH

  // Enrollment is independent of script-driven task and coverage discovery.
  put('apps/notes/README.txt', 'A directory without a manifest is not an App.\n')
  put('config/product/coverage-order.txt', `lower ${app}\n`)
  workspace(app, { 'test:coverage': coverage })
  commit('Product without typecheck')
  failed(core(), /apps\/product-fixture.*non-empty typecheck script/)
  workspace(app, { typecheck })
  failed(gate(), /apps\/product-fixture.*non-empty test:coverage script/)
  workspace(app, { typecheck, 'test:coverage': '   ' })
  failed(gate('--coverage-plan'), /apps\/product-fixture.*non-empty test:coverage script/)
  workspace(app, { typecheck, 'test:coverage': coverage })
  manifest(['packages/*'])
  failed(gate('--coverage-plan'), /apps\/product-fixture.*outside root workspace discovery/)
  manifest()

  // The full bar still validates tiers in the actual Coverage runner.
  put('config/product/coverage-order.txt', '')
  failed(gate('--coverage-plan'), /apps\/product-fixture.*no risk tier/)
  put('config/product/coverage-order.txt', `lower ${app}\n`)

  // Root core really invokes TypeScript for the enrolled App.
  source(app, 'export const value: number = "wrong type"\n')
  checked(bun('install', '--lockfile-only', '--offline'))
  commit('Product with a compile error')
  failed(core(), /apps-product-fixture:typecheck[\s\S]*error TS2322/)
  rmSync(coreReceipt)

  // Root Coverage runs the App's real Vitest suite and collects reports.
  source(app, 'export const value: number = 1\n')
  put(
    `${app}/vitest.config.mts`,
    `import { makeCoverage } from '../../packages/config/vitest-coverage.mts'
export default { test: { maxWorkers: 1, coverage: makeCoverage('product-fixture', { lines: 100 }) } }
`,
  )
  symlinkSync(join(repo, kitApp, 'node_modules'), join(root, app, 'node_modules'), 'dir')
  put(
    `${app}/src/value.test.ts`,
    `import { expect, test } from 'vitest'
import { value } from './value'
test('fixture value', () => expect(value).toBe(2))
`,
  )
  commit('Product with a failing suite')
  failed(
    shard(),
    /coverage: product-fixture \(apps\/product-fixture\)[\s\S]*AssertionError: expected 1 to be 2/,
  )
  rmSync(coverageReceipt)

  // The PR checkout is a merge with trusted base/head as parents, changing only the App.
  mergePullRequest('product-change', () => {
    put(`${app}/src/value.ts`, 'export const value: number = 2\n')
  })

  assert.deepEqual(JSON.parse(checked(gate('--coverage-plan'))), [
    { id: 'apps__product-fixture', workspaces: [app] },
  ])
  assert.deepEqual(JSON.parse(checked(gate('--coverage-parts-plan'))), [])
  assert.match(checked(core()), /apps-product-fixture:typecheck/)
  assert.match(
    checked(shard()),
    /coverage: product-fixture \(apps\/product-fixture\)[\s\S]*✓ product-fixture/,
  )
  const summary = JSON.parse(
    readFileSync(join(root, 'coverage/product-fixture/coverage-summary.json'), 'utf8'),
  )
  assert.equal(summary.total.lines.pct, 100)
  assert.match(checked(joinReceipts()), /full Root passed by current-run join/)
  failed(joinReceipts('skipped'), /coverage producer did not succeed: skipped/)
  rmSync(coverageReceipt)
  failed(joinReceipts(), /coverage receipts missing.*apps\/product-fixture/)

  // A configured floor is still enforced by native Vitest, not just discovered by Root.
  put(`${app}/src/uncovered.ts`, 'export const uncovered = 1\n')
  commit('Product misses the configured floor')
  failed(shard(), /Coverage for lines .* does not meet global threshold \(100%\)/)
  rmSync(coverageReceipt)
  rmSync(join(root, app, 'src/uncovered.ts'))

  // listTags reports success without running this deliberately failing test.
  put(
    `${app}/vitest.config.mts`,
    `import { makeCoverage } from '../../packages/config/vitest-coverage.mts'
export default { test: {
  listTags: true,
  tags: [{ name: 'fixture' }],
  coverage: makeCoverage('product-fixture', { lines: 100 }),
} }
`,
  )
  source(app, 'export const value: number = 1\n')
  commit('Product config lists tags instead of running suites')
  const listedTags = shard()
  const tagsReceipt = JSON.parse(readFileSync(coverageReceipt, 'utf8'))
  rmSync(coverageReceipt)
  source(app, 'export const value: number = 2\n')

  // A branch floor with zero branches does not measure this straight-line App.
  configureCoverage(', { branches: 100 }')
  commit('Product floor measures no branches')
  const ordinaryVacuous = shard()
  const ordinaryReceipt = JSON.parse(readFileSync(coverageReceipt, 'utf8'))
  rmSync(coverageReceipt)

  // A passing suite cannot earn a complete receipt with absent or zero floors.
  for (const floor of ['', ', { lines: 0, branches: 0, functions: 0, statements: 0 }']) {
    configureCoverage(floor)
    commit('Product lacks a positive floor')
    failed(shard(), /apps\/product-fixture.*coverage floor/)
    const receipt = JSON.parse(readFileSync(coverageReceipt, 'utf8'))
    assert.equal(receipt.complete, false)
    rmSync(coverageReceipt)
  }

  configureCoverage(', { branches: 100 }')

  // Short parts still produce native blobs; the final merge enforces the floor.
  delete env.GITHUB_EVENT_NAME
  delete env.GITHUB_EVENT_PATH
  put('config/product/coverage-partitions.txt', `${app} 2\n`)
  put(
    `${app}/src/another.test.ts`,
    `import { expect, test } from 'vitest'
import { value } from './value'
test('second fixture value', () => expect(value).toBe(2))
`,
  )
  const summaryFile = 'coverage/product-fixture/coverage-summary.json'
  function partitionedCoverage(message: string, priorSummary?: string) {
    commit(message)
    const raw = join(root, 'raw')
    mkdirSync(raw)
    try {
      for (const index of [1, 2]) {
        const part = join(raw, `coverage-raw-12345-1-apps__product-fixture-${index}-of-2`)
        checked(gate('--ci-coverage-part', app, `${index}/2`, '--raw', part))
      }
      if (priorSummary) put(summaryFile, priorSummary)
      return gate('--ci-coverage-merge', app, '--raw', raw, '--receipt', coverageReceipt)
    } finally {
      rmSync(raw, { recursive: true, force: true })
    }
  }
  const mergedVacuous = partitionedCoverage(
    'Partition Product with a floor that measures no branches',
  )
  assert.deepEqual(
    [listedTags.status, ordinaryVacuous.status, mergedVacuous.status],
    [1, 1, 1],
    `${listedTags.stdout}\n${ordinaryVacuous.stdout}\n${mergedVacuous.stdout}`,
  )
  failed(listedTags, /AssertionError: expected 1 to be 2/)
  assert.equal(tagsReceipt.complete, false)
  failed(ordinaryVacuous, /apps\/product-fixture.*coverage floor.*measured/)
  assert.equal(ordinaryReceipt.complete, false)
  failed(mergedVacuous, /apps\/product-fixture.*coverage floor.*measured/)
  assert.equal(existsSync(coverageReceipt), false)

  configureCoverage(', { lines: 100 }')
  checked(partitionedCoverage('Partition Product under a measured line floor'))
  assert.equal(JSON.parse(readFileSync(coverageReceipt, 'utf8')).complete, true)
  rmSync(coverageReceipt)

  // Seed the native summary from the previous successful merge, not a fresh report.
  const priorSummary = readFileSync(join(root, summaryFile), 'utf8')
  configureCoverage(', { lines: 100 }', "clean: false, reporter: ['text']")
  failed(
    partitionedCoverage('Partition Product without a fresh json summary', priorSummary),
    /apps\/product-fixture.*did not produce a native coverage summary/,
  )
  assert.equal(existsSync(coverageReceipt), false)

  // Blob replay may prove a declared partition merge, never an ordinary current-head run.
  put('config/product/coverage-partitions.txt', '')
  configureCoverage(', { lines: 100 }')
  const replay = join(root, 'receipts/prior-blob')
  mkdirSync(replay)
  checked(
    spawnSync(
      'bunx',
      ['vitest', 'run', '--coverage', '--reporter=blob', `--outputFile.blob=${replay}/passed.json`],
      { cwd: join(root, app), env, encoding: 'utf8' },
    ),
  )
  source(app, 'export const value: number = 1\n')
  put(
    `${app}/vitest.config.mts`,
    `import { makeCoverage } from '../../packages/config/vitest-coverage.mts'
export default { test: {
  maxWorkers: 1,
  mergeReports: ${JSON.stringify(replay)},
  coverage: makeCoverage('product-fixture', { lines: 100 }),
} }
`,
  )
  commit('Product tries to replay successful tests instead of running current tests')
  failed(shard(), /AssertionError: expected 1 to be 2/)
  assert.equal(JSON.parse(readFileSync(coverageReceipt, 'utf8')).complete, false)
  console.log('product-root-gate: Kit and Product App coverage and enrollment fixtures passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
