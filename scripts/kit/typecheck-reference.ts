#!/usr/bin/env bun
/**
 * Compare tsc and bun check on the Kit tree during the bun check trial (go-silex/unkillable-kit#236).
 * Read the type gate's project list from its live scripts so the two checkers stay in sync.
 */
import { execFileSync } from 'node:child_process'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

const ROOT = realpathSync(resolve(import.meta.dirname, '../..'))
const TSC = join(ROOT, 'node_modules/.bin/tsc')

function isProduct(): boolean {
  // Use the shared resolver's CLI, as select-tooling does. Keep its child Bun launch hermetic too.
  const identity = execFileSync(
    process.execPath,
    [
      '--no-env-file',
      `--config=${join(ROOT, 'config/kit/bunfig.gates.toml')}`,
      'run',
      join(ROOT, 'scripts/kit/resolve-tree-identity.mjs'),
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ROOT, EXTRACT_MODE: '', EXTRACT_HARNESS_SENTINEL: '' },
    },
  ).trim()
  if (!/^mode=(?:product|kit) identity=[^\r\n]+$/.test(identity)) {
    throw new Error(`unknown tree identity: ${identity}`)
  }
  return identity.startsWith('mode=product ')
}

function fail(message: string): never {
  console.error(`typecheck-reference: ${message}`)
  process.exit(2)
}

function literalPath(operand: string | undefined): operand is string {
  return operand !== undefined && /^(?!-)[\w./-]+$/.test(operand)
}

function projectOperand(flags: string[], invalid: () => never): string {
  let project: string | undefined
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]
    if (flag === '--no-script' || flag === '--no-pretty') continue
    const operand =
      flag === '-p' || flag === '--project'
        ? flags[++i]
        : flag?.startsWith('--project=')
          ? flag.slice('--project='.length)
          : undefined
    if (project !== undefined || !literalPath(operand)) invalid()
    project = operand
  }
  return project ?? 'tsconfig.json'
}

type Manifest = { scripts?: Record<string, unknown>; workspaces?: unknown }

function readManifest(path: string): Manifest {
  const manifest: unknown = JSON.parse(readFileSync(join(ROOT, path), 'utf8'))
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail(`${path}: expected a package manifest object`)
  }
  return manifest
}

function scriptProjects(manifest: string, task: string, { scripts }: Manifest): string[] {
  const script = scripts?.[task]
  if (script === undefined && task === 'typecheck') return []
  if (typeof script !== 'string' || /[\r\n]/.test(script)) {
    fail(`${manifest} scripts.${task}: expected a single-line type-check script`)
  }

  // Recognize only direct commands joined with && and literal paths. A new shell form or
  // compiler option needs an explicit mapping rather than silently reducing reference coverage.
  const projects: string[] = []
  for (const segment of script.split('&&')) {
    const words = segment.trim().split(/[ \t]+/)
    if (
      task === 'typecheck' &&
      words.length === 5 &&
      words[0] === 'wrangler' &&
      words[1] === 'types' &&
      literalPath(words[2]) &&
      words[3] === '--include-env=false' &&
      words[4] === '--check'
    ) {
      continue
    }
    const invalid = () =>
      fail(`${manifest} scripts.${task}: cannot map command to a tsc project: ${segment.trim()}`)
    if (words[0] !== 'bun' || words[1] !== 'check') invalid()
    const operand = resolve(ROOT, dirname(manifest), projectOperand(words.slice(2), invalid))
    const directory = statSync(operand, { throwIfNoEntry: false })?.isDirectory()
    projects.push(directory ? join(operand, 'tsconfig.json') : operand)
  }
  if (projects.length === 0) fail(`${manifest} scripts.${task}: no bun check project found`)
  return projects
}

function discoverProjects(): string[] {
  const rootManifest = readManifest('package.json')
  const { workspaces } = rootManifest
  if (!Array.isArray(workspaces) || workspaces.some((pattern) => typeof pattern !== 'string')) {
    fail('package.json workspaces must be an array of strings')
  }
  const projects = new Set(scriptProjects('package.json', 'typecheck:tooling', rootManifest))
  const manifests = new Set<string>()
  for (const pattern of workspaces) {
    for (const manifest of new Bun.Glob(join(pattern, 'package.json')).scanSync(ROOT)) {
      manifests.add(manifest)
    }
  }
  for (const manifest of manifests) {
    for (const project of scriptProjects(manifest, 'typecheck', readManifest(manifest))) {
      projects.add(project)
    }
  }
  return [...projects].sort()
}

type CheckResult = { code: number; stdout: string; stderr: string }

async function check(command: string[], cwd: string): Promise<CheckResult> {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

async function checkPhase(projects: string[], run: (project: string) => Promise<CheckResult>) {
  const started = performance.now()
  const results: CheckResult[] = new Array(projects.length)
  const pending = projects.entries()
  const worker = async () => {
    for (const [i, project] of pending) {
      results[i] = await run(project)
    }
  }
  const concurrency = Math.min(availableParallelism(), projects.length)
  await Promise.all(Array.from({ length: concurrency }, worker))
  return { results, elapsedMs: Math.round(performance.now() - started) }
}

function printResult(checker: string, result: CheckResult) {
  console.error(`  ${checker} output (exit ${result.code}):`)
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
}

function compareProject(project: string, tsc: CheckResult, bun: CheckResult) {
  const label = relative(ROOT, project)
  const diverged = tsc.code !== bun.code
  if (diverged) {
    console.error(`DIVERGENCE ${label}: tsc exit ${tsc.code}, bun check exit ${bun.code}`)
  } else if (tsc.code !== 0) {
    console.error(`typecheck-reference: ${label} failed (exit ${tsc.code})`)
  }
  const failed = tsc.code !== 0 || diverged
  if (failed) {
    printResult('tsc', tsc)
    printResult('bun check', bun)
  }
  return { failed, diverged }
}

async function main(): Promise<void> {
  try {
    if (isProduct()) {
      console.log(
        'typecheck-reference: skipped (Product tree; the tsc reference runs on the Kit tree only, go-silex/unkillable-kit#236)',
      )
      return
    }
  } catch (error) {
    console.error(`typecheck-reference: tree classification failed; running reference: ${error}`)
  }

  let projects: string[]
  try {
    projects = discoverProjects()
  } catch (error) {
    fail(`cannot discover type-check projects: ${error}`)
  }
  if (projects.length === 0) fail('no type-check projects found')
  try {
    accessSync(TSC, constants.X_OK)
  } catch {
    fail(`cannot execute ${TSC}\nFix: bun install`)
  }

  const tsc = await checkPhase(projects, (project) =>
    check([TSC, '--noEmit', '--pretty', 'false', '-p', project], ROOT),
  )
  const bun = await checkPhase(projects, (project) =>
    check(
      [process.execPath, 'check', '--no-script', '--no-pretty', '-p', basename(project)],
      dirname(project),
    ),
  )
  let failed = 0
  let divergences = 0
  for (const [i, project] of projects.entries()) {
    const tscResult = tsc.results[i]
    const bunResult = bun.results[i]
    if (!(tscResult && bunResult)) fail(`missing result for ${project}`)
    const outcome = compareProject(project, tscResult, bunResult)
    if (outcome.failed) failed++
    if (outcome.diverged) divergences++
  }
  console.log(
    `typecheck-reference: ${projects.length} project(s); tsc ${tsc.elapsedMs}ms, bun check ${bun.elapsedMs}ms; ${failed} failed, ${divergences} divergence(s)`,
  )
  process.exitCode = failed === 0 ? 0 : 1
}

await main()
