import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [workspace, ...args] = process.argv.slice(2)
// Vitest is installed by each App, not declared as a Root dependency.
const fromApp = createRequire(join(process.cwd(), 'package.json'))
const moduleUrl = pathToFileURL(fromApp.resolve('vitest/node')).href
const { parseCLI, startVitest } = await import(moduleUrl)

// Read the configuration of the very run that earns the receipt, not a second
// config load that could resolve differently. Preserve the native run verdict.
const { filter, options } = parseCLI(['vitest', 'run', '--coverage', ...args])
const vitest = await startVitest(filter, options)
const coverage = vitest.config.coverage
const thresholds = coverage?.thresholds
const hasFloor =
  thresholds?.[100] === true ||
  ['statements', 'branches', 'functions', 'lines'].some((metric) => {
    const threshold: unknown = thresholds?.[metric]
    return typeof threshold === 'number' && Number.isFinite(threshold) && threshold > 0
  })
if (!(coverage?.enabled && hasFloor)) {
  console.error(`${workspace}: Vitest requires a positive global coverage floor`)
  process.exitCode ||= 1
}
await vitest.exit()
