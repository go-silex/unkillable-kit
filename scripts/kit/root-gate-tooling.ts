import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const count = 3
// Slowest passing CI duration of each tooling task, in whole seconds, measured on Kit and Product
// runners at unkillable-kit/v0.9.0. The four Better Auth groups were re-measured on the hosted Kit
// runner, which runs four workspaces per group (go-silex/unkillable-kit#200); a two-CPU Product
// runner runs two workspaces and takes longer.
// Re-measure when a task changes cost: CI logs carry one `root-gate:task` record per task.
export const toolingSeconds: ReadonlyMap<string, number> = new Map([
  ['test:root-gate', 66],
  ['test:create-product-preflight', 41],
  ['test:release-prepare', 38],
  ['test:root-gate-better-auth:resolution', 32],
  ['test:kit-schema-sync', 29],
  ['test:root-gate-better-auth:cookies', 27],
  ['test:dogfood-zero-edit', 24],
  ['test:root-gate-better-auth:issuers', 23],
  ['test:promote-deploy', 19],
  ['test:kit-upgrade', 19],
  ['test:root-gate-better-auth:enrollment', 18],
  ['test:tsconfig-orphans', 18],
  ['test:doc-hygiene', 16],
  ['test:bar-ssot', 14],
  ['test:coverage-order', 9],
  ['test:lock-ranges', 8],
  ['test:trufflehog-pin', 7],
  ['test:stack-contract', 6],
  ['test:knip-config', 6],
  ['test:tooling-selector', 5],
  ['test:typecheck-gate', 5],
  ['test:extract-dry-run', 5],
  ['test:migrations-contract', 5],
  ['test:import-boundary', 3],
  ['test:deny-upstream', 3],
  ['test:file-length', 3],
  ['test:falsify', 3],
  ['test:ts-major', 2],
  ['test:debt', 2],
  ['test:folder-size', 2],
  ['test:wrangler-migrations', 2],
  ['test:cf-builds', 2],
  ['test:deploy-verify', 2],
  ['test:release-age-excludes', 1],
  ['test:actions-pin', 1],
  ['test:biome-strict', 1],
  ['test:merge-gate', 1],
  ['test:lefthook-deletes', 1],
  ['test:hermetic-git', 1],
  ['test:deps-guard', 1],
  ['test:bun-version', 1],
])
const unmeasuredSeconds = 10
const fail = (message: string): never => {
  throw new Error(message)
}
type Result = { task: string; exitCode: number }
type Identity = {
  repository: string
  checkoutSha: string
  runId: string
  runAttempt: string
  recipeHash: string
  runnerHash: string
}

export function toolingPlan(tasks: string[]) {
  return toolingShardTasks(tasks).map((selected, offset) => {
    if (selected.length === 0) fail('empty tooling shard')
    const index = offset + 1
    return { index, count, id: `tooling-${index}` }
  })
}

/**
 * Longest task first onto the least-loaded shard (lowest index on ties), so shards finish
 * together whatever the recipe order. Each shard keeps recipe order.
 */
export function toolingShardTasks(tasks: string[], seconds = toolingSeconds): string[][] {
  const shards = Array.from({ length: count }, () => ({ load: 0, tasks: new Set<string>() }))
  const weighed = tasks.map((task, position) => ({
    task,
    position,
    weight: seconds.get(task) ?? unmeasuredSeconds,
  }))
  weighed.sort((a, b) => b.weight - a.weight || a.position - b.position)
  for (const { task, weight } of weighed) {
    const lightest = shards.reduce((best, shard) => (shard.load < best.load ? shard : best))
    lightest.load += weight
    lightest.tasks.add(task)
  }
  return shards.map((shard) => tasks.filter((task) => shard.tasks.has(task)))
}

function toolingTasks(tasks: string[], index: number) {
  return toolingShardTasks(tasks)[index - 1]
}

export function runToolingShard(
  spec: string,
  path: string,
  tasks: string[],
  identity: Identity,
  run: (tasks: string[]) => { results: Result[]; code: number },
) {
  const match = /^([1-3])\/3$/.exec(spec)
  if (!match) return fail('invalid tooling shard')
  const index = Number(match[1])
  toolingPlan(tasks)
  if (basename(path) !== `tooling-${index}.json`) fail('incorrect tooling receipt filename')
  const selected = toolingTasks(tasks, index)
  const outcome = run(selected)
  writeFileSync(
    path,
    `${JSON.stringify({ version: 1, group: 'tooling', index, count, ...identity, tasks: selected, results: outcome.results, complete: outcome.code === 0 })}\n`,
    { flag: 'wx' },
  )
  return outcome.code
}

export function joinTooling(dir: string, status: string, tasks: string[], identity: Identity) {
  if (status !== 'success') fail('producer matrix did not succeed')
  const plan = toolingPlan(tasks)
  const entries = readdirSync(dir).sort()
  const expected = plan
    .map(({ index }) => `tooling-${identity.runId}-${identity.runAttempt}-${index}`)
    .sort()
  if (JSON.stringify(entries) !== JSON.stringify(expected))
    fail('tooling receipt inventory mismatch')
  for (const { index } of plan) {
    const folder = join(dir, `tooling-${identity.runId}-${identity.runAttempt}-${index}`)
    validateToolingReceipt(folder, index, tasks, identity)
  }
}

function validateToolingReceipt(
  folder: string,
  index: number,
  tasks: string[],
  identity: Identity,
) {
  if (!lstatSync(folder).isDirectory()) fail('tooling artifact must be a directory')
  const filename = `tooling-${index}.json`
  if (JSON.stringify(readdirSync(folder)) !== JSON.stringify([filename]))
    fail('tooling artifact inventory mismatch')
  const path = join(folder, filename)
  if (!lstatSync(path).isFile()) fail('tooling receipt must be a regular file')
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail('malformed tooling receipt')
  const entries = Object.entries(value)
  const expected = { ...identity, version: 1, group: 'tooling', index, count, complete: true }
  for (const [key, item] of Object.entries(expected)) {
    if (!entries.some(([actualKey, actual]) => actualKey === key && actual === item))
      fail(`tooling receipt mismatch: ${key}`)
  }
  validateToolingResults(value, toolingTasks(tasks, index))
}

function validateToolingResults(receipt: object, selected: string[]) {
  if (!('tasks' in receipt && 'results' in receipt))
    return fail('tooling receipt task inventory mismatch')
  const results = receipt.results
  if (
    JSON.stringify(receipt.tasks) !== JSON.stringify(selected) ||
    !Array.isArray(results) ||
    results.length !== selected.length
  )
    return fail('tooling receipt task inventory mismatch')
  for (let i = 0; i < selected.length; i++) {
    const result: unknown = results[i]
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      !('task' in result) ||
      !('exitCode' in result) ||
      result.task !== selected[i] ||
      result.exitCode !== 0
    )
      fail('tooling receipt result mismatch')
  }
}
