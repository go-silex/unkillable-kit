import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const fail = (message: string): never => {
  throw new Error(message)
}
type Group = 'core' | 'coverage'
type Result = { task: string; exitCode: number }
type Identity = {
  repository: string
  checkoutSha: string
  runId: string
  runAttempt: string
  recipeHash: string
  runnerHash: string
}

function recipe(args: string[]) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, unknown>
  }
  const scripts = manifest.scripts ?? {}
  const candidates = ['validate:full', 'validate:tooling'].flatMap((name) => {
    const source = scripts[name]
    if (typeof source !== 'string') return []
    const tasks = source.split(' ').slice(3)
    return JSON.stringify(args.slice(0, tasks.length)) === JSON.stringify(tasks)
      ? [{ name, source }]
      : []
  })
  if (candidates.length !== 1) fail('arguments differ from canonical recipe')
  const { name, source } = candidates[0]
  if (
    typeof source !== 'string' ||
    !/^bun run scripts\/kit\/root-gate\.ts(?: [A-Za-z0-9_:-]+)+$/.test(source)
  )
    fail('malformed canonical recipe')
  const tasks = (source as string).split(' ').slice(3)
  if (
    new Set(tasks).size !== tasks.length ||
    tasks.filter((task) => task === 'test:coverage').length !==
      (name === 'validate:full' ? 1 : 0) ||
    tasks.includes('validate:full') ||
    tasks.includes('validate:tooling')
  )
    fail('duplicate tasks or invalid coverage')
  for (const task of tasks)
    if (typeof scripts[task] !== 'string' || !scripts[task]) fail(`missing script: ${task}`)
  return {
    tasks,
    recipeHash: hash(source as string),
    runnerHash: hash(readFileSync(import.meta.path)),
  }
}

function identity(recipeHash: string, runnerHash: string): Identity {
  const repository = process.env.GITHUB_REPOSITORY ?? ''
  const runId = process.env.GITHUB_RUN_ID ?? ''
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? ''
  if (
    !(
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) &&
      /^[1-9][0-9]*$/.test(runId) &&
      /^[1-9][0-9]*$/.test(runAttempt)
    )
  )
    fail('missing or malformed CI identity')
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  const checkoutSha = git.stdout?.trim() ?? ''
  if (
    git.status !== 0 ||
    !/^[a-f0-9]{40}$/.test(checkoutSha) ||
    process.env.GITHUB_SHA !== checkoutSha
  )
    fail('checkout SHA does not match CI identity')
  return { repository, checkoutSha, runId, runAttempt, recipeHash, runnerHash }
}

function selection(tasks: string[], group: Group) {
  return tasks.filter((task) => (task === 'test:coverage') === (group === 'coverage'))
}

function bindCoverage(tasks: string[], shard?: string) {
  if (!tasks.includes('test:coverage')) return
  if (process.env.COVERAGE_LIST_ONLY === '1' || process.env.COVERAGE_LIST_KIT === '1') {
    fail('coverage listing mode cannot execute the Root gate')
  }
  if (process.env.COVERAGE_CHANGED_BASE) {
    fail('changed-only coverage cannot execute the Root gate')
  }
  if (shard) {
    if (process.env.COVERAGE_ONLY && process.env.COVERAGE_ONLY !== shard) {
      fail('COVERAGE_ONLY does not match the coverage shard')
    }
    process.env.COVERAGE_ONLY = shard
    return
  }
  if (process.env.COVERAGE_ONLY) fail('narrowed coverage cannot execute the Root gate')
}

function run(tasks: string[], shard?: string): { results: Result[]; code: number } {
  bindCoverage(tasks, shard)
  const results: Result[] = []
  for (const task of tasks) {
    console.log(`root-gate: running ${task}`)
    const child = spawnSync(process.execPath, ['run', task], { cwd: root, stdio: 'inherit' })
    const exitCode = child.status ?? 1
    results.push({ task, exitCode })
    if (exitCode !== 0 || child.error || child.signal) return { results, code: exitCode || 1 }
  }
  return { results, code: 0 }
}

function validateTaskResults(receipt: Record<string, unknown>, selected: string[]) {
  if (
    !Array.isArray(receipt.tasks) ||
    JSON.stringify(receipt.tasks) !== JSON.stringify(selected) ||
    !Array.isArray(receipt.results) ||
    receipt.results.length !== selected.length
  )
    fail('receipt task inventory mismatch')
  for (let i = 0; i < selected.length; i++) {
    const result = (receipt.results as unknown[])[i]
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      (result as Result).task !== selected[i] ||
      (result as Result).exitCode !== 0
    )
      fail('receipt result mismatch')
  }
}

function validateReceiptFile(path: string, group: Group, tasks: string[], expected: Identity) {
  if (!lstatSync(path).isFile()) fail('receipt must be a regular file')
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('malformed receipt')
  const receipt = value as Record<string, unknown>
  if (receipt.version !== 1 || receipt.group !== group || receipt.complete !== true)
    fail('invalid receipt status or group')
  for (const [key, item] of Object.entries(expected))
    if (receipt[key] !== item) fail(`receipt identity mismatch: ${key}`)
  validateTaskResults(receipt, selection(tasks, group))
}

function coverageReceiptName(workspace: string): string {
  if (!/^(apps|packages)\/[A-Za-z0-9._-]+$/.test(workspace) || /\/\.{1,2}$/.test(workspace))
    fail('invalid coverage shard')
  return `root-coverage-${workspace.replace('/', '__')}.json`
}

function listedCoverage(): string[] {
  const env: NodeJS.ProcessEnv = { ...process.env, COVERAGE_LIST_ONLY: '1' }
  delete env.COVERAGE_LIST_KIT
  delete env.COVERAGE_CHANGED_BASE
  delete env.COVERAGE_ONLY
  const listed = spawnSync('bash', ['scripts/kit/test-coverage.sh'], {
    cwd: root,
    env,
    encoding: 'utf8',
  })
  if (listed.status !== 0) fail('cannot list coverage workspaces')
  const output = listed.stdout ?? ''
  const workspaces = (output.endsWith('\n') ? output.slice(0, -1) : output).split('\n')
  for (const workspace of workspaces) coverageReceiptName(workspace)
  if (new Set(workspaces).size !== workspaces.length) fail('duplicate coverage workspace')
  return workspaces
}

function coveragePlan() {
  const workspaces = listedCoverage()
  const packages = workspaces.filter((workspace) => workspace.startsWith('packages/'))
  const count = Math.ceil(packages.length / 4)
  const groups = Array.from({ length: count }, (_, index) => ({
    id: `packages-${index + 1}`,
    workspaces: [] as string[],
  }))
  for (let index = 0; index < packages.length; index++)
    groups[index % count].workspaces.push(packages[index])
  for (const workspace of workspaces)
    if (workspace.startsWith('apps/'))
      groups.push({ id: workspace.replace('/', '__'), workspaces: [workspace] })
  return groups
}

function shardWorkspace(dir: string, file: string): string {
  const value: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'shard' in value &&
    typeof value.shard === 'string' &&
    coverageReceiptName(value.shard) === file
  ) {
    return value.shard
  }
  return fail('malformed coverage shard')
}

function sameShards(left: string[], right: string[]) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

function joinMonolithic(
  dir: string,
  entries: string[],
  shards: string[],
  tasks: string[],
  expected: Identity,
) {
  if (shards.length !== 0 || entries.length !== 2 || !entries.includes('root-core.json')) {
    fail('expected exactly two receipt files')
  }
  for (const group of ['core', 'coverage'] as const)
    validateReceiptFile(join(dir, `root-${group}.json`), group, tasks, expected)
}

function joinShards(
  dir: string,
  entries: string[],
  shards: string[],
  tasks: string[],
  expected: Identity,
) {
  if (
    !entries.includes('root-core.json') ||
    entries.length !== shards.length + 1 ||
    shards.length === 0
  ) {
    fail('expected Core plus one receipt per coverage workspace')
  }
  validateReceiptFile(join(dir, 'root-core.json'), 'core', tasks, expected)
  const seen = shards.map((file) => {
    const workspace = shardWorkspace(dir, file)
    validateReceiptFile(join(dir, file), 'coverage', tasks, expected)
    return workspace
  })
  if (!sameShards(seen, listedCoverage())) {
    fail('coverage shards do not match the discovered workspace bar')
  }
}

function joinReceipts(dir: string, status: string, tasks: string[], expected: Identity) {
  if (status !== 'success') fail('producer matrix did not succeed')
  const entries = readdirSync(dir).filter((entry) => !entry.startsWith('.'))
  const shards = entries.filter((entry) => /^root-coverage-.+\.json$/.test(entry))
  if (entries.includes('root-coverage.json')) {
    joinMonolithic(dir, entries, shards, tasks, expected)
    return
  }
  joinShards(dir, entries, shards, tasks, expected)
}

try {
  const args = process.argv.slice(2)
  const current = recipe(args)
  const provided = args.slice(0, current.tasks.length)
  if (JSON.stringify(provided) !== JSON.stringify(current.tasks))
    fail('arguments differ from canonical recipe')
  const options = args
    .slice(current.tasks.length)
    .filter((arg, index) => !(arg === '--' && index === 0))
  if (options.length === 1 && options[0] === '--plan') {
    console.log(
      JSON.stringify({
        tasks: current.tasks,
        core: selection(current.tasks, 'core'),
        coverage: selection(current.tasks, 'coverage'),
        recipeHash: current.recipeHash,
        runnerHash: current.runnerHash,
      }),
    )
  } else if (options.length === 1 && options[0] === '--coverage-plan') {
    console.log(JSON.stringify(coveragePlan()))
  } else if (options.length === 0) {
    const outcome = run(current.tasks)
    if (outcome.code === 0) console.log('root-gate: full Root passed')
    process.exitCode = outcome.code
  } else if (
    options.length === 4 &&
    options[0] === '--ci-group' &&
    (options[1] === 'core' || options[1] === 'coverage') &&
    options[2] === '--receipt' &&
    options[3]
  ) {
    const group = options[1] as Group
    if (basename(options[3]) !== `root-${group}.json`) fail('incorrect receipt filename')
    const bound = identity(current.recipeHash, current.runnerHash)
    const tasks = selection(current.tasks, group)
    console.log(`root-gate: partial ${group} execution`)
    const outcome = run(tasks)
    writeFileSync(
      options[3],
      `${JSON.stringify({
        version: 1,
        group,
        ...bound,
        tasks,
        results: outcome.results,
        complete: outcome.code === 0,
      })}\n`,
      { flag: 'wx' },
    )
    process.exitCode = outcome.code
  } else if (
    options.length === 4 &&
    options[0] === '--ci-coverage-shard' &&
    options[1] &&
    options[2] === '--receipt' &&
    options[3]
  ) {
    const workspace = options[1]
    if (basename(options[3]) !== coverageReceiptName(workspace)) fail('incorrect receipt filename')
    const bound = identity(current.recipeHash, current.runnerHash)
    console.log(`root-gate: coverage shard ${workspace}`)
    const outcome = run(['test:coverage'], workspace)
    writeFileSync(
      options[3],
      `${JSON.stringify({
        version: 1,
        group: 'coverage',
        shard: workspace,
        ...bound,
        tasks: ['test:coverage'],
        results: outcome.results,
        complete: outcome.code === 0,
      })}\n`,
      { flag: 'wx' },
    )
    process.exitCode = outcome.code
  } else if (
    options.length === 4 &&
    options[0] === '--ci-join' &&
    options[1] &&
    options[2] === '--producers-result' &&
    options[3]
  ) {
    joinReceipts(
      options[1],
      options[3],
      current.tasks,
      identity(current.recipeHash, current.runnerHash),
    )
    console.log('root-gate: full Root passed by current-run join')
  } else fail('invalid or ambiguous options')
} catch (error) {
  console.error(`root-gate: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
