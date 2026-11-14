import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const prefixes = [
  'scripts/kit/',
  'config/kit/',
  '.github/',
  'tooling/',
  'docs/kit/',
  'packages/auth/',
  'apps/example-api/migrations/',
]
const files = [
  'lefthook.yml',
  'package.json',
  'bun.lock',
  'bunfig.toml',
  'biome.json',
  'knip.ts',
  'tsconfig.json',
  'turbo.jsonc',
  'commitlint.config.cjs',
  'commitlint.config.js',
  'commitlint.config.mjs',
  'commitlint.config.ts',
  '.node-version',
  '.license-policy.json',
  '.editorconfig',
]
export function isToolingInput(path: string): boolean {
  return files.includes(path) || prefixes.some((p) => path === p.slice(0, -1) || path.startsWith(p))
}

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

// A new self-test can introduce a source input outside the declared classes. Treat
// literal references (including references to a parent directory) as inputs too.
function testReferences(path: string): boolean {
  const dir = join(root, 'scripts/kit')
  const tests = readdirSync(dir).filter(
    (name) => /^test-.*\.(sh|ts|mjs|cjs)$/.test(name) || /\.test\.(ts|mjs|cjs)$/.test(name),
  )
  return tests.some((name) => {
    const text = readFileSync(join(dir, name), 'utf8')
    if (text.includes(path)) return true
    const refs = text.matchAll(
      /(?:\$\{(?:ROOT|REPO_ROOT)\}|\$(?:ROOT|REPO_ROOT))\/([A-Za-z0-9_.@/-]+)/g,
    )
    for (const match of refs) {
      const ref = match[1].replace(/\/$/, '')
      if (path === ref || path.startsWith(`${ref}/`)) return true
    }
    return false
  })
}

function productNeedsLane(): boolean {
  const zones = JSON.parse(readFileSync(join(root, 'config/kit/zero-edit-zones.json'), 'utf8'))
  const path = join(root, zones.exceptions_file || 'config/product/zero-edit-exceptions.json')
  if (!existsSync(path)) return false
  const doc = JSON.parse(readFileSync(path, 'utf8'))
  if (doc.version !== 1 || !Array.isArray(doc.exceptions))
    throw new Error('invalid product exceptions')
  let selected = false
  for (const entry of doc.exceptions as unknown[]) {
    if (!entry || typeof entry !== 'object' || !('path' in entry) || typeof entry.path !== 'string')
      throw new Error('invalid product exception path')
    const value = entry.path
    if (
      !value ||
      value.startsWith('/') ||
      value.split('/').some((p) => !p || p === '.' || p === '..')
    )
      throw new Error('invalid product exception path')
    if (
      isToolingInput(value) ||
      prefixes.some((p) => p.startsWith(`${value}/`)) ||
      files.some((p) => p.startsWith(`${value}/`)) ||
      testReferences(value)
    )
      selected = true
  }
  return selected
}

function parseArgs(args: string[]) {
  let base = ''
  let head = ''
  let mainPush = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--kit-main-push' && !mainPush) mainPush = true
    else if (args[i] === '--base' && !base && args[i + 1]) base = args[++i]
    else if (args[i] === '--head' && !head && args[i + 1]) head = args[++i]
    else throw new Error('invalid arguments')
  }
  return { base, head, mainPush }
}

function select(args: string[]): boolean {
  const parsed = parseArgs(args)
  let { base, head } = parsed
  const { mainPush } = parsed
  git(['rev-parse', '--git-dir'])
  const identity = execFileSync(
    process.execPath,
    [join(root, 'scripts/kit/resolve-tree-identity.mjs')],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ROOT: root, EXTRACT_MODE: '', EXTRACT_HARNESS_SENTINEL: '' },
    },
  ).trim()
  const product = /^mode=product identity=/.test(identity)
  if (!/^mode=(?:product|kit) identity=/.test(identity)) throw new Error('unknown tree identity')
  if (mainPush && !product) return true
  if (Boolean(base) !== Boolean(head)) throw new Error('base and head must be supplied together')
  if (base && !(/^[0-9a-f]{40}$/.test(base) && /^[0-9a-f]{40}$/.test(head)))
    throw new Error('explicit revisions must be full commit SHAs')
  if (git(['rev-parse', '--is-shallow-repository']).trim() !== 'false')
    throw new Error('shallow repository')
  if (!base) git(['symbolic-ref', '--quiet', 'HEAD'])
  base ||= git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).trim()
  head ||= 'HEAD'
  const baseSha = git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim()
  const headSha = git(['rev-parse', '--verify', '--end-of-options', `${head}^{commit}`]).trim()
  if (headSha !== git(['rev-parse', '--verify', 'HEAD^{commit}']).trim())
    throw new Error('head does not match checkout')
  const mergeBase = git(['merge-base', baseSha, headSha]).trim()
  if (!mergeBase) throw new Error('missing merge base')
  const paths = [
    ...git(['diff', '--no-renames', '--name-only', '-z', mergeBase, headSha, '--']).split('\0'),
    ...git(['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--']).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean)
  if (product) return paths.includes('bun.lock') || productNeedsLane()
  return paths.some((path) => isToolingInput(path) || testReferences(path))
}

class NonHeadPush extends Error {}

function parsePushUpdates(input: string): string[][] {
  const lines = input.trim().split('\n').filter(Boolean)
  if (lines.length === 0) throw new Error('missing push updates')
  const updates: string[][] = []
  const checkout = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim()
  for (const line of lines) {
    const parts = line.split(' ')
    if (
      parts.length !== 4 ||
      !parts[0] ||
      !parts[2].startsWith('refs/') ||
      !/^[0-9a-f]{40}$/.test(parts[1]) ||
      !/^[0-9a-f]{40}$/.test(parts[3])
    )
      throw new Error('malformed push update')
    const local = parts[1]
    if (!/^0{40}$/.test(local) && local !== checkout)
      throw new NonHeadPush('pushed commit is not the checked-out HEAD')
    updates.push(parts)
  }
  return updates
}

function selectPush(input: string): boolean {
  const updates = parsePushUpdates(input)
  const bases = ['refs/remotes/origin/main', 'refs/remotes/origin/staging'].map((ref) =>
    git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim(),
  )
  let run = false
  for (const [, local, destination, remote] of updates) {
    if (/^0{40}$/.test(local) || /^0{40}$/.test(remote)) {
      run = true
      continue
    }
    for (const base of [remote, ...bases]) {
      git(['merge-base', '--is-ancestor', base, local])
      const args = ['--base', base, '--head', local]
      if (destination === 'refs/heads/main') args.push('--kit-main-push')
      if (select(args)) run = true
    }
  }
  return run
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const run =
      args.length === 1 && args[0] === '--pre-push'
        ? selectPush(readFileSync(0, 'utf8'))
        : select(args)
    console.log(`tooling lane: ${run ? 'run' : 'skip'}`)
    process.exitCode = run ? 0 : 1
  } catch (error) {
    if (error instanceof NonHeadPush) {
      console.error(`tooling lane: refusing push (${error.message})`)
      process.exitCode = 2
    } else {
      console.error(
        `tooling lane: run (selection failed: ${error instanceof Error ? error.message : String(error)})`,
      )
      process.exitCode = 0
    }
  }
}
