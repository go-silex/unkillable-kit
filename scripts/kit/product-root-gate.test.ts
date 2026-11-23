import assert from 'node:assert/strict'
import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import {
  copyFileSync,
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

const repo = join(import.meta.dirname, '../..')
const app = 'apps/product-fixture'
const kitApp = 'apps/example-api'
const typecheck = 'tsc --noEmit'
const coverage = 'vitest run --coverage'
const { scripts: rootScripts } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
const thinRecipe = rootScripts['validate:full']
  .split(' ')
  .filter((task, index) => index < 3 || task === 'typecheck' || task === 'test:coverage')
  .join(' ')

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
  const joinReceipts = () =>
    gate(
      '--ci-join',
      join(root, 'receipts'),
      '--producers-result',
      'success',
      '--coverage-result',
      'success',
      '--parts-result',
      'skipped',
    )

  // Bare Kit core succeeds with only protected App manifests.
  checked(bun('install', '--lockfile-only', '--offline'))
  commit('Bare Kit')
  assert.match(checked(core()), /apps-example-api:typecheck/)
  rmSync(coreReceipt)

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
  const base = env.GITHUB_SHA
  git('switch', '-qc', 'product-change')
  put(`${app}/src/value.ts`, 'export const value: number = 2\n')
  const head = commit('Fix Product suite')
  git('switch', '-q', 'main')
  git('merge', '-q', '--no-ff', '-m', 'Synthetic PR merge', head)
  env.GITHUB_SHA = git('rev-parse', 'HEAD')
  env.GITHUB_EVENT_NAME = 'pull_request'
  env.GITHUB_EVENT_PATH = join(root, 'event.json')
  json('event.json', { pull_request: { base: { sha: base }, head: { sha: head } } })

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
  rmSync(coverageReceipt)
  failed(joinReceipts(), /coverage receipts missing.*apps\/product-fixture/)
  console.log('product-root-gate: Kit and Product App coverage and enrollment fixtures passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
