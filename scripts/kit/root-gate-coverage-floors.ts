import { lstatSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [workspace, ...args] = process.argv.slice(2)
// Vitest is installed by each App, not declared as a Root dependency.
const fromApp = createRequire(join(process.cwd(), 'package.json'))
const moduleUrl = pathToFileURL(fromApp.resolve('vitest/node')).href
const { createVitest, parseCLI } = await import(moduleUrl)

// Both native run and replay produce makeCoverage's canonical json-summary.
// Remove stale evidence even if Product has configured the reporters not to clean.
const reportsDir = resolve('..', '..', 'coverage')
const appReportsDir = join(reportsDir, basename(workspace))
for (const dir of [reportsDir, appReportsDir]) {
  const existing = lstatSync(dir, { throwIfNoEntry: false })
  if (existing && !existing.isDirectory())
    throw new Error(`${workspace}: expected a real coverage report directory at ${dir}`)
}
const summaryPath = join(appReportsDir, 'coverage-summary.json')
rmSync(summaryPath, { force: true })

// Root owns the operation: an App config may configure the run, but cannot turn
// it into report replay, tag listing, cache clearing, or standalone mode.
const { filter, options } = parseCLI(['vitest', 'run', '--coverage', ...args])
const replay: string | undefined = options.mergeReports
options.watch = false
// Match native Vitest CLI startup before resolving the App's config.
process.env.TEST = 'true'
process.env.VITEST = 'true'
process.env.NODE_ENV ??= 'test'
const vitest = await createVitest(options)
try {
  if (replay) await vitest.mergeReports(replay)
  else await vitest.start(filter)
  if (!process.exitCode) {
    const failure = coverageFailure()
    if (failure) {
      console.error(`${workspace}: ${failure}`)
      process.exitCode = 1
    }
  }
} finally {
  await vitest.exit()
}

function coverageFailure(): string | undefined {
  const coverage = vitest.config.coverage
  const thresholds = coverage?.thresholds
  const metrics = ['statements', 'branches', 'functions', 'lines'] as const
  const floored = metrics.filter((metric) => {
    const value: unknown = thresholds?.[metric]
    return (
      thresholds?.[100] === true ||
      (typeof value === 'number' && Number.isFinite(value) && value > 0)
    )
  })
  if (!coverage?.enabled || floored.length === 0)
    return 'Vitest requires a positive global coverage floor'

  let completed = false
  for (const run of vitest.state.getTestModules()) {
    if (run.children.allTests('passed').next().done === false) {
      completed = true
      break
    }
  }
  if (!completed) return 'Vitest supplied no completed tests'
  if (!lstatSync(summaryPath, { throwIfNoEntry: false })?.isFile())
    return `Vitest did not produce a native coverage summary at ${summaryPath}`

  const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
    total?: Partial<Record<(typeof metrics)[number], { total?: unknown }>>
  }
  if (
    !floored.some((metric) => {
      const total = summary?.total?.[metric]?.total
      return typeof total === 'number' && Number.isSafeInteger(total) && total > 0
    })
  )
    return 'Vitest requires a positive global coverage floor on a measured metric'
}
