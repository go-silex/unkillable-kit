#!/usr/bin/env bun
/**
 * tsconfig-orphans — every tracked TypeScript file belongs to a TS project,
 * and every workspace that owns src/ has a project a typecheck script invokes.
 *
 * Root `tsconfig.json` is not repo-wide: it lists the tooling files no
 * workspace owns (kit scripts, vite/vitest configs, app scripts).
 * Workspace sources are owned by `{apps,packages}/<ws>/tsconfig.json`.
 *
 * The gap that creates: a new `.ts` outside any workspace `src/` and outside
 * the root `include` globs is checked by nobody and lands in no editor
 * project — silently. That is how `packages/ui/vite.config.ts` stayed
 * unchecked.
 *
 * COVERAGE invariant:
 *   tracked {ts,tsx,mts,cts} MINUS <ws>/src/** for every {apps,packages}/<ws>
 *   that has a package.json
 *   is a subset of the files opened by the root project or a runnable,
 *   cited workspace project (`tsc --listFilesOnly`). Coverage requires a
 *   literal `&&` chain of direct checkers and supported setup commands.
 *
 * The manifest is what makes that subtraction legitimate: a directory under
 * apps|packages without one is not a workspace, nothing runs a project for it,
 * and subtracting its src/ would hide the file from both invariants at once.
 *
 * Coverage counts the whole program, not just roots: a file pulled in by an
 * import is really typechecked. Drop that import and the file leaves the
 * program — the gate then flags it, which is the point.
 *
 * That subtraction of `{apps,packages}/<ws>/src/**` is a hole of its own: it
 * trusts a workspace to run its own project(s), and nothing ran that trust.
 * `apps/example-web` now ships TWO programs (browser `tsconfig.json`,
 * Node `tsconfig.test.json`) and `turbo typecheck` only executes the
 * workspace's `typecheck` script — delete half that script and 22 test files
 * stop being typechecked with nothing going red.
 *
 * CITATION invariant:
 *   for each {apps,packages}/<ws>: tracked files under <ws>/src/ imply at
 *   least one runnable tsconfig*.json at the workspace root (otherwise the
 *   coverage subtraction has nothing to assume); every such project is named
 *   by the workspace's own `typecheck` script, and every named project exists.
 *   `bun check` cites projects only through that same strict chain, with
 *   `--no-script`, optional `--no-pretty`, and at most one project operand.
 *   Root `typecheck:tooling` also requires `--no-script` for `bun check`.
 *   The legacy `tsc`/`tsgo`/`vue-tsc` citation path supports project and build
 *   operands; it ignores comments and commands directly following `||`.
 *   A checker with no project operand cites its cwd's tsconfig.json.
 *   `|| true` and `|` discard the checker's status and do not count.
 *
 * Does NOT prove the covering project uses the right compilerOptions, does
 * NOT check coverage of workspace src/ files (a workspace `exclude` can still
 * orphan its own sources), does NOT audit projects nested below a workspace root,
 * and does not audit `.mjs`/`.js`/`.cjs` files. The root program checks three
 * named CJS files, but this orphan invariant remains TypeScript-only.
 * Semantic type checking belongs to `typecheck` / `typecheck:tooling`.
 *
 * Exit 0 clean · 1 orphans and/or citation breaks · 2 cannot read the tree,
 * the project, or a tsconfig/package manifest.
 * Override: TSCONFIG_ORPHANS_ROOT (throwaway trees in the self-test).
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

const ROOT = realpathSync(
  resolve(process.env.TSCONFIG_ORPHANS_ROOT ?? join(import.meta.dirname, '../..')),
)

/**
 * The kit checkout that owns this script. `tsc` is always taken from here, so
 * the self-test can point ROOT at a temp tree with no node_modules.
 */
const KIT_ROOT = realpathSync(resolve(join(import.meta.dirname, '../..')))

/** git pathspecs for the file kinds a TS project can own. */
const TS_PATHSPECS = ['*.ts', '*.tsx', '*.mts', '*.cts']

/** Files under a workspace `src/` are owned by that workspace's project. */
const WORKSPACE_SRC = /^((?:apps|packages)\/[^/]+)\/src\//

const ROOT_PROJECT_REL = 'tsconfig.json'

/** Workspace roots, as git pathspecs plus the exact shape they must have. */
const WORKSPACE_MANIFEST_PATHSPECS = ['apps/*/package.json', 'packages/*/package.json']
const WORKSPACE_MANIFEST = /^(?:apps|packages)\/[^/]+\/package\.json$/
const WORKSPACE_TSCONFIG_PATHSPECS = ['apps/*/tsconfig*.json', 'packages/*/tsconfig*.json']
const WORKSPACE_TSCONFIG = /^(?:apps|packages)\/[^/]+\/tsconfig[^/]*\.json$/

/**
 * A `tsconfig*.json` is a runnable PROJECT once it declares its own inputs.
 * Declaring none makes it a base meant for `extends` only — `tsc -p` on it
 * would sweep every file under its directory, which is never what a base is
 * for (`packages/config/tsconfig.base.json`). Structural on purpose: renaming
 * that base changes nothing here, and the day a base grows an `include` it
 * becomes executable and starts being audited.
 */
const PROJECT_INPUT_KEYS = ['files', 'include', 'references']

/** `tsc`, `tsgo`, `vue-tsc`, or any of them reached through a path. */
const TSC_BINARY = /(?:^|\/)(?:[\w.]+-)?ts(?:c|go)$/
const BUN_BINARY = /(?:^|\/)bun$/

/** Preserve each command's preceding operator for the citation audit. */
const SCRIPT_SEPARATORS = /(&&|\|\||;|\|)/

/**
 * `|| true`, `|| exit 0`, or a pipe: the script's status is not the checker's.
 * Not a shell parser — these two spellings are the ones that turn a red
 * typecheck green without deleting the command.
 */
function swallowsExit(script: string): boolean {
  if (/\|\|\s*(?:true|exit\s+0)\b/.test(script)) return true
  // A lone `|` (pipe), not part of `||`.
  if (/(?:^|[^|])\|(?:[^|]|$)/.test(script)) return true
  return false
}

function fail(message: string, hint?: string): never {
  console.error(`tsconfig-orphans: ${message}`)
  if (hint) console.error(hint)
  process.exit(2)
}

/**
 * `git ls-files` inside ROOT, as posix ROOT-relative paths.
 *
 * `untracked` adds non-ignored files git does not track yet. The coverage
 * audit stays tracked-only — a scratch `.ts` is nobody's debt. The citation
 * audit opts in: a `tsconfig*.json` sitting in the checkout is already the
 * project vite, vitest and tsserver load, so it must be cited before it is
 * staged, not one commit later.
 */
function gitFiles(pathspecs: string[], untracked: boolean): string[] {
  const args = ['git', 'ls-files', '-z', '--cached']
  if (untracked) args.push('--others', '--exclude-standard')
  const git = Bun.spawnSync([...args, '--', ...pathspecs], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (git.exitCode !== 0) {
    fail(
      `git ls-files failed in ${ROOT} (exit ${git.exitCode})`,
      git.stderr.toString().trim() || 'Fix: run this gate inside a git checkout',
    )
  }
  return git.stdout
    .toString()
    .split('\0')
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.split(sep).join('/'))
    .sort()
}

/** Workspace roots that own their sources: the ones carrying a manifest. */
function manifestWorkspaces(): Set<string> {
  return new Set(
    gitFiles(WORKSPACE_MANIFEST_PATHSPECS, true)
      .filter((path) => WORKSPACE_MANIFEST.test(path))
      .map((path) => path.slice(0, -'/package.json'.length)),
  )
}

/** Tracked TS files, sources owned by a real workspace removed. */
function candidates(): string[] {
  const owned = manifestWorkspaces()
  return gitFiles(TS_PATHSPECS, false).filter((path) => {
    const workspace = WORKSPACE_SRC.exec(path)?.[1]
    return workspace === undefined || !owned.has(workspace)
  })
}

/**
 * Files a project actually opens, as ROOT-relative posix paths.
 * List compiler inputs without repeating the separate semantic typecheck.
 * An unloadable workspace project cannot contribute coverage.
 */
function projectFiles(project: string): Set<string> {
  const tsc = join(KIT_ROOT, 'node_modules', '.bin', 'tsc')
  if (!existsSync(tsc)) {
    fail(`missing ${relative(KIT_ROOT, tsc)}`, 'Fix: bun install')
  }
  const run = Bun.spawnSync(
    [tsc, '-p', join(ROOT, project), '--noEmit', '--listFilesOnly', '--pretty', 'false'],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
  )
  const stdout = run.stdout.toString()
  const covered = new Set<string>()
  for (const line of stdout.split('\n')) {
    const path = line.trim()
    // A listed file exists; a diagnostic line ("file.ts(1,2): error TS…") does not.
    if (!(isAbsolute(path) && existsSync(path))) continue
    const rel = relative(ROOT, path).split(sep).join('/')
    if (rel.length > 0 && !rel.startsWith('..')) covered.add(rel)
  }
  if (project !== ROOT_PROJECT_REL && run.exitCode !== 0) return new Set()
  if (project === ROOT_PROJECT_REL && covered.size === 0) {
    fail(
      `tsc listed no file for ${project} (exit ${run.exitCode})`,
      `${stdout.trim() || run.stderr.toString().trim()}\nFix: repair ${project} so the project loads`,
    )
  }
  return covered
}

/** An effective noCheck, including one inherited through extends, is not typechecking. */
function checksTypes(project: string): boolean {
  const tsc = join(KIT_ROOT, 'node_modules', '.bin', 'tsc')
  const run = Bun.spawnSync([tsc, '-p', join(ROOT, project), '--showConfig'], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (run.exitCode !== 0) return false
  try {
    const config: unknown = JSON.parse(run.stdout.toString())
    if (config === null || typeof config !== 'object' || Array.isArray(config)) return false
    const options = (config as Record<string, unknown>).compilerOptions
    if (options === undefined) return true
    if (options === null || typeof options !== 'object' || Array.isArray(options)) return false
    return (options as Record<string, unknown>).noCheck !== true
  } catch {
    return false
  }
}

/**
 * JSONC → object. tsconfig files carry comments (this repo's root project does)
 * and `JSON.parse` refuses them; nothing under scripts/kit exposes a JSONC
 * reader, so strip comments and trailing commas here. String-aware: a `//`
 * inside a path string survives. Unparseable → exit 2, never "no project".
 */
function skipLineComment(text: string, i: number): number {
  while (i < text.length && text[i] !== '\n') i++
  return i
}

function skipBlockComment(text: string, i: number): number {
  const end = text.indexOf('*/', i + 2)
  return end === -1 ? text.length : end + 2
}

function pushJsoncChar(out: string[], char: string, lastSignificant: number): number {
  // Trailing comma: legal in a tsconfig, fatal for JSON.parse.
  if ((char === '}' || char === ']') && out[lastSignificant] === ',') {
    out[lastSignificant] = ''
  }
  out.push(char)
  return char.trim().length > 0 ? out.length - 1 : lastSignificant
}

function stripJsonc(text: string): string {
  const out: string[] = []
  let lastSignificant = -1
  let i = 0
  while (i < text.length) {
    const char = text[i] as string
    if (char === '"') {
      i = copyJsonString(text, i, out)
      lastSignificant = out.length - 1
      continue
    }
    if (char === '/' && text[i + 1] === '/') {
      i = skipLineComment(text, i)
      continue
    }
    if (char === '/' && text[i + 1] === '*') {
      i = skipBlockComment(text, i)
      continue
    }
    lastSignificant = pushJsoncChar(out, char, lastSignificant)
    i++
  }
  return out.join('')
}

function copyJsonString(text: string, start: number, out: string[]): number {
  let end = start + 1
  while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
  out.push(text.slice(start, Math.min(end + 1, text.length)))
  return end + 1
}

function parseJsonc(rel: string): Record<string, unknown> {
  const cleaned = stripJsonc(readFileSync(resolve(ROOT, rel), 'utf8'))
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (error) {
    fail(`cannot parse ${rel}`, `${String(error)}\nFix: repair ${rel} so tools can read it`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${rel} is not a JSON object`, `Fix: repair ${rel}`)
  }
  return parsed as Record<string, unknown>
}

/**
 * Projects a workspace script runs, as ROOT-relative posix paths.
 *
 * Bun citations come from the strict chain. Legacy checker commands take
 * `-p` / `--project[=]` / `-b` operands. `echo … -p tsconfig.json` is not
 * a citation. Without an operand a checker cites `<cwd>/tsconfig.json`.
 */
function citeProject(cited: Set<string>, wsDir: string, operand: string): void {
  const value = operand.replace(/^\.\//, '')
  const project = value.endsWith('.json') ? value : `${value}/${ROOT_PROJECT_REL}`
  cited.add(join(wsDir, project).split(sep).join('/'))
}

function citeProjectFlag(
  token: string,
  next: string | undefined,
  wsDir: string,
  cited: Set<string>,
): number {
  if (token.startsWith('--project=')) {
    citeProject(cited, wsDir, token.slice('--project='.length))
    return 1
  }
  if ((token === '-p' || token === '--project') && next !== undefined && !next.startsWith('-')) {
    citeProject(cited, wsDir, next)
    return 1
  }
  return 0
}

function citeBuildOperands(
  tokens: string[],
  start: number,
  wsDir: string,
  cited: Set<string>,
): number {
  let operands = 0
  for (const operand of tokens.slice(start + 1)) {
    if (operand.startsWith('-')) break
    citeProject(cited, wsDir, operand)
    operands++
  }
  return operands
}

function citeFromTokens(tokens: string[], wsDir: string, cited: Set<string>): number {
  let operands = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string
    const fromFlag = citeProjectFlag(token, tokens[i + 1], wsDir, cited)
    if (fromFlag > 0) {
      operands += fromFlag
      continue
    }
    if (token === '-b' || token === '--build') {
      operands += citeBuildOperands(tokens, i, wsDir, cited)
    }
  }
  return operands
}

function isBunCheck(tokens: string[]): boolean {
  return BUN_BINARY.test(tokens[0] ?? '') && tokens[1] === 'check'
}

function legacyCitedProjects(commands: string[][], wsDir: string): Set<string> {
  const cited = new Set<string>()
  for (const tokens of commands) {
    if (isBunCheck(tokens)) continue
    if (!tokens.some((token) => TSC_BINARY.test(token))) continue
    if (citeFromTokens(tokens, wsDir, cited) === 0) {
      citeProject(cited, wsDir, ROOT_PROJECT_REL)
    }
  }
  return cited
}

function bunProjectOperand(flag: string, next: string | undefined): string | undefined {
  if (flag === '-p' || flag === '--project') return next
  return flag.startsWith('--project=') ? flag.slice('--project='.length) : undefined
}

/** No shell syntax, no positional inputs, and at most one project operand. */
function strictBunProject(command: string): string | undefined {
  const tokens = command.split(/[ \t]+/)
  if (!isBunCheck(tokens)) return undefined
  let noScript = false
  let project: string | undefined
  for (let i = 2; i < tokens.length; i++) {
    const token = tokens[i] as string
    if (token === '--no-script') {
      noScript = true
      continue
    }
    if (token === '--no-pretty') continue
    const operand = bunProjectOperand(token, tokens[i + 1])
    if (
      project !== undefined ||
      operand === undefined ||
      !/^(?!-)[A-Za-z0-9_./-]+$/.test(operand)
    ) {
      return undefined
    }
    project = operand
    if (!token.startsWith('--project=')) i++
  }
  return noScript ? (project ?? ROOT_PROJECT_REL) : undefined
}

/** A whole literal && chain proves both Bun citation and workspace coverage. */
function strictChainProjects(script: string | undefined, wsDir: string): Set<string> | undefined {
  if (script === undefined || /[^A-Za-z0-9_./= \t&-]/.test(script)) return undefined
  const projects = new Set<string>()
  for (const segment of script.split('&&')) {
    if (segment.includes('&')) return undefined
    const command = segment.trim()
    // Worker type generation and its output directory are setup, not citations.
    if (
      /^mkdir[ \t]+-p[ \t]+(?!-)[A-Za-z0-9_./-]+$/.test(command) ||
      /^wrangler[ \t]+types[ \t]+(?!-)[A-Za-z0-9_./-]+(?:[ \t]+--include-env=false(?:[ \t]+--check)?|[ \t]+--check(?:[ \t]+--include-env=false)?)?$/.test(
        command,
      )
    ) {
      continue
    }
    const tsc = /^tsc(?:[ \t]+--noEmit)?(?:[ \t]+(?:-p|--project)[ \t]+([A-Za-z0-9_./-]+))?$/.exec(
      command,
    )
    const project = tsc ? (tsc[1] ?? ROOT_PROJECT_REL) : strictBunProject(command)
    if (project === undefined) return undefined
    citeProject(projects, wsDir, project)
  }
  return projects
}

/** Remove a shell comment before its operators can be mistaken for commands. */
function stripScriptComment(script: string): string {
  let quote = ''
  let startsWord = true
  for (let i = 0; i < script.length; i++) {
    const char = script[i] as string
    if (char === '\\' && quote !== "'") {
      i++
      startsWord = false
      continue
    }
    if (quote !== '') {
      if (char === quote) quote = ''
      continue
    }
    if (char === '#' && startsWord) return script.slice(0, i)
    if (/['"]/.test(char)) quote = char
    startsWord = /[\s&|;()<>]/.test(char)
  }
  return script
}

/** argv of one command, honouring the quotes a package script may use. */
function tokenize(segment: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote = ''
  for (const char of segment) {
    if (quote !== '') {
      if (char === quote) quote = ''
      else current += char
    } else if (/['"]/.test(char)) {
      quote = char
    } else if (char.trim().length === 0) {
      if (current.length > 0) tokens.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

/**
 * Every runnable project at a workspace root must be named by that workspace's
 * `typecheck` script, and every project that script names must exist.
 *
 * This is the invariant the `{apps,packages}/<ws>/src/**` subtraction above
 * assumes. `turbo typecheck` executes only that script, so it is the sole place
 * the workspace declares which projects `bun check` or a legacy checker checks
 * in CI. A workspace with src/ and no project violates that assumption.
 * Root `typecheck:tooling` is inspected only for Bun's `--no-script` requirement.
 */
function manifestScript(manifest: string, name: string): string | undefined {
  const scripts = parseJsonc(manifest).scripts
  if (scripts === null || typeof scripts !== 'object') return undefined
  const script = (scripts as Record<string, unknown>)[name]
  return typeof script === 'string' ? script : undefined
}

function auditScriptCommands(
  script: string | undefined,
  manifest: string,
  name: string,
  location: string,
  problems: { report: string; fix: string }[],
): string[][] {
  if (script === undefined) return []
  const segments = stripScriptComment(script).split(SCRIPT_SEPARATORS)
  const cited: string[][] = []
  let scripted = false
  for (let i = 0; i < segments.length; i += 2) {
    const tokens = tokenize(segments[i] as string)
    if (segments[i - 1] !== '||') cited.push(tokens)
    if (!isBunCheck(tokens)) continue
    const noScript = tokens.indexOf('--no-script', 2)
    const endOfFlags = tokens.indexOf('--', 2)
    if (noScript === -1 || (endOfFlags !== -1 && endOfFlags < noScript)) scripted = true
  }
  if (scripted) {
    problems.push({
      report: `SCRIPTED ${location} — "bun check" without --no-script can run the manifest's "check" script instead of the type checker`,
      fix: `add --no-script to each "bun check" in "${name}" in ${manifest}`,
    })
  }
  return cited
}

function auditWorkspaceProjects(
  wsDir: string,
  manifest: string,
  script: unknown,
  swallowed: boolean,
  runs: Set<string>,
  tsconfigs: string[],
): {
  audited: number
  runnableHere: number
  projects: string[]
  problems: { report: string; fix: string }[]
} {
  const problems: { report: string; fix: string }[] = []
  const projects: string[] = []
  let audited = 0
  let runnableHere = 0
  for (const rel of tsconfigs.filter((path) => path.startsWith(`${wsDir}/`))) {
    const config = parseJsonc(rel)
    if (!PROJECT_INPUT_KEYS.some((key) => config[key] !== undefined)) continue
    runnableHere++
    audited++
    // SWALLOWED already reported for the workspace; don't pile UNCITED.
    if (swallowed) continue
    if (runs.has(rel)) {
      projects.push(rel)
      continue
    }
    problems.push({
      report: `UNCITED ${rel} — ${
        typeof script === 'string'
          ? `the "typecheck" script of ${wsDir} never runs this project`
          : `${wsDir} has no "typecheck" script, so nothing runs this project`
      }`,
      fix: `use \`bun check --no-script --no-pretty -p ${basename(rel)}\` in "${manifest}" (literal commands joined by &&; one project per checker), or delete ${rel}`,
    })
  }
  return { audited, runnableHere, projects, problems }
}

function auditMissingProjects(
  wsDir: string,
  manifest: string,
  runs: Set<string>,
  runnableHere: number,
  trackedTs: string[],
  problems: { report: string; fix: string }[],
): void {
  if (runnableHere === 0 && trackedTs.some((path) => path.startsWith(`${wsDir}/src/`))) {
    problems.push({
      report: `NO PROJECT ${wsDir} — src/ is subtracted from coverage but no project owns it`,
      fix: `add ${wsDir}/tsconfig.json covering src/ and set "typecheck" to \`bun check --no-script --no-pretty -p tsconfig.json\``,
    })
  }
  for (const rel of runs) {
    if (existsSync(resolve(ROOT, rel))) continue
    problems.push({
      report: `PHANTOM ${rel} — the "typecheck" script of ${wsDir} cites a missing project`,
      fix: `create ${rel}, or drop it from "typecheck" in ${manifest}`,
    })
  }
}

function auditCitations(): {
  audited: number
  projects: Map<string, string>
  problems: { report: string; fix: string }[]
} {
  const manifests = gitFiles(WORKSPACE_MANIFEST_PATHSPECS, true).filter((path) =>
    WORKSPACE_MANIFEST.test(path),
  )
  const tsconfigs = gitFiles(WORKSPACE_TSCONFIG_PATHSPECS, true).filter((path) =>
    WORKSPACE_TSCONFIG.test(path),
  )
  const problems: { report: string; fix: string }[] = []
  let audited = 0
  const projects = new Map<string, string>()
  const trackedTs = gitFiles(TS_PATHSPECS, false)

  const rootManifest = 'package.json'
  if (existsSync(resolve(ROOT, rootManifest))) {
    const name = 'typecheck:tooling'
    auditScriptCommands(manifestScript(rootManifest, name), rootManifest, name, 'root', problems)
  }

  for (const manifest of manifests) {
    const wsDir = manifest.slice(0, -'/package.json'.length)
    const script = manifestScript(manifest, 'typecheck')
    const commands = auditScriptCommands(script, manifest, 'typecheck', wsDir, problems)
    const swallowed = script !== undefined && swallowsExit(stripScriptComment(script))
    const eligible = strictChainProjects(script, wsDir)
    const runs = eligible ?? (swallowed ? new Set<string>() : legacyCitedProjects(commands, wsDir))

    if (swallowed) {
      problems.push({
        report: `SWALLOWED ${wsDir} — the "typecheck" script discards the checker's exit status (\`|| true\` or a pipe)`,
        fix: `remove \`|| true\` / the pipe from "typecheck" in ${manifest} so a type error fails the script`,
      })
    }

    const local = auditWorkspaceProjects(wsDir, manifest, script, swallowed, runs, tsconfigs)
    audited += local.audited
    for (const project of local.projects) {
      if (eligible?.has(project)) projects.set(project, wsDir)
    }
    problems.push(...local.problems)

    auditMissingProjects(wsDir, manifest, runs, local.runnableHere, trackedTs, problems)
  }
  return { audited, projects, problems }
}

function main(): void {
  const started = performance.now()
  console.log(`tsconfig-orphans — root=${ROOT}`)

  const tracked = candidates()
  const citations = auditCitations()
  const covered = projectFiles(ROOT_PROJECT_REL)
  for (const [project, wsDir] of citations.projects) {
    if (!checksTypes(project)) continue
    for (const file of projectFiles(project)) {
      if (file.startsWith(`${wsDir}/`)) covered.add(file)
    }
  }
  const orphans = tracked.filter((path) => !covered.has(path))

  for (const problem of citations.problems) {
    console.error(problem.report)
    console.error(`  Fix: ${problem.fix}`)
  }
  for (const path of orphans) {
    console.error(`ORPHAN ${path} — no TS project opens this file`)
  }

  if (orphans.length > 0) {
    console.error(
      `\ntsconfig-orphans: ${orphans.length} orphan file(s) of ${tracked.length} outside workspace src`,
    )
    console.error(`Fix: include the path in the root project or a cited workspace project`)
  }
  if (citations.problems.length > 0) {
    console.error(
      `\ntsconfig-orphans: ${citations.problems.length} citation break(s); ${citations.audited} workspace project(s) audited`,
    )
  }
  if (orphans.length > 0 || citations.problems.length > 0) {
    process.exit(1)
  }

  const ms = Math.round(performance.now() - started)
  console.log(
    `tsconfig-orphans OK — ${tracked.length} file(s) outside workspace src, 0 orphan(s); ${citations.audited} workspace project(s) all cited by their "typecheck" script (${ms}ms)`,
  )
  process.exit(0)
}

if (import.meta.main) {
  main()
}
