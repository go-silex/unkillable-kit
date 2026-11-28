#!/usr/bin/env bun
/**
 * Run the tsc reference on the Kit tree during the bun check trial (go-silex/unkillable-kit#236).
 * Read the type gate's project list from its live scripts so the two checkers stay in sync.
 */
import { execFileSync } from 'node:child_process'
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const ROOT = realpathSync(
  resolve(process.env.TYPECHECK_REFERENCE_ROOT ?? join(import.meta.dirname, '../..')),
)
// Fixtures override ROOT but use the compiler installed in the Kit checkout.
const KIT_ROOT = realpathSync(resolve(join(import.meta.dirname, '../..')))
const TSC = join(KIT_ROOT, 'node_modules/.bin/tsc')

function isProduct(): boolean {
  // Use the shared resolver's CLI, as select-tooling does. Keep its child Bun launch hermetic too.
  const identity = execFileSync(
    process.execPath,
    [
      '--no-env-file',
      `--config=${join(KIT_ROOT, 'config/kit/bunfig.gates.toml')}`,
      'run',
      join(KIT_ROOT, 'scripts/kit/resolve-tree-identity.mjs'),
    ],
    {
      cwd: KIT_ROOT,
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

function scriptProjects(manifest: string, task: string): string[] {
  const path = join(ROOT, manifest)
  const { scripts } = JSON.parse(readFileSync(path, 'utf8')) as {
    scripts?: Record<string, unknown>
  }
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
    projects.push(resolve(dirname(path), projectOperand(words.slice(2), invalid)))
  }
  if (projects.length === 0) fail(`${manifest} scripts.${task}: no bun check project found`)
  return projects
}

function discoverProjects(): string[] {
  const projects = new Set(scriptProjects('package.json', 'typecheck:tooling'))
  for (const manifest of new Bun.Glob('{apps,packages}/*/package.json').scanSync(ROOT)) {
    for (const project of scriptProjects(manifest, 'typecheck')) projects.add(project)
  }
  return [...projects].sort()
}

async function checkProject(project: string): Promise<boolean> {
  const child = Bun.spawn([TSC, '--noEmit', '--pretty', 'false', '-p', project], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code === 0) return true
  console.error(`typecheck-reference: ${project} failed (exit ${code})`)
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  return false
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

  const started = performance.now()
  let next = 0
  let failed = 0
  const worker = async () => {
    for (let project = projects[next++]; project !== undefined; project = projects[next++]) {
      if (!(await checkProject(project))) failed++
    }
  }
  const concurrency = Math.min(availableParallelism(), projects.length)
  await Promise.all(Array.from({ length: concurrency }, worker))
  console.log(
    `typecheck-reference: ${projects.length} project(s) checked by tsc, ${failed} failed (${Math.round(performance.now() - started)}ms)`,
  )
  process.exitCode = failed === 0 ? 0 : 1
}

await main()
