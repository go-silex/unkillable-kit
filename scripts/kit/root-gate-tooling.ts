import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const count = 3
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
  return Array.from({ length: count }, (_, offset) => {
    const index = offset + 1
    if (toolingTasks(tasks, index).length === 0) fail('empty tooling shard')
    return { index, count, id: `tooling-${index}` }
  })
}

function toolingTasks(tasks: string[], index: number) {
  return tasks.filter((_, offset) => offset % count === index - 1)
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
