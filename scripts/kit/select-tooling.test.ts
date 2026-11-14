import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const root = mkdtempSync(join(tmpdir(), 'tooling-selector-'))
const env: NodeJS.ProcessEnv = {
  ...process.env,
  GITHUB_REPOSITORY: '',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_DIR: '',
  GIT_WORK_TREE: '',
}
delete env.GIT_DIR
delete env.GIT_WORK_TREE
function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
function put(path: string, content: string) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}
function commit(message: string): string {
  git('add', '-A')
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    message,
  )
  return git('rev-parse', 'HEAD')
}
function select(...args: string[]): number | null {
  const child = spawnSync(
    process.execPath,
    [join(root, 'scripts/kit/select-tooling.ts'), ...args],
    {
      cwd: root,
      env,
      encoding: 'utf8',
    },
  )
  assert.equal(child.signal, null, child.stderr)
  return child.status
}
try {
  mkdirSync(join(root, 'scripts/kit'), { recursive: true })
  for (const name of ['select-tooling.ts', 'resolve-tree-identity.mjs'])
    cpSync(join(source, 'scripts/kit', name), join(root, 'scripts/kit', name))
  put(
    'config/kit/zero-edit-zones.json',
    JSON.stringify({
      version: 1,
      kit_origin_allowlist: ['kit'],
      exceptions_file: 'config/product/zero-edit-exceptions.json',
    }),
  )
  git('init', '-q')
  git('remote', 'add', 'origin', 'kit')
  put('packages/core/src/value.ts', 'initial')
  const base = commit('base')
  put('packages/core/src/value.ts', 'changed')
  let head = commit('source')
  assert.equal(select('--base', base, '--head', head), 1, 'unrelated source skips')
  assert.equal(select('--base', head, '--head', base), 0, 'head mismatch runs')
  put('apps/example-web/src/page.ts', 'app change')
  head = commit('app only')
  assert.equal(select('--base', base, '--head', head), 1, 'app-only change skips')
  const tree = git('rev-parse', `${head}^{tree}`)
  const unrelated = execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit-tree',
      tree,
      '-m',
      'unrelated',
    ],
    { cwd: root, env, encoding: 'utf8' },
  ).trim()
  assert.equal(select('--base', unrelated, '--head', head), 0, 'no merge base runs')
  writeFileSync(join(root, '.git/shallow'), `${base}\n`)
  assert.equal(select('--base', base, '--head', head), 0, 'shallow clone runs')
  rmSync(join(root, '.git/shallow'))
  const branch = git('symbolic-ref', '--short', 'HEAD')
  git('checkout', '-q', '--detach')
  assert.equal(select(), 0, 'detached local checkout runs')
  assert.equal(select('--base', base, '--head', head), 1, 'explicit detached checkout selects')
  git('checkout', '-q', branch)
  assert.equal(select('--kit-main-push'), 0, 'kit main runs')
  assert.equal(select('--base', 'missing', '--head', head), 0, 'invalid git ref runs')
  assert.equal(select(), 0, 'missing default remote branch runs')
  put('untracked', 'dirty')
  assert.equal(select('--base', base, '--head', head), 1, 'unrelated untracked file skips')
  rmSync(join(root, 'untracked'))
  put('scripts/kit/untracked.sh', 'dirty')
  assert.equal(select('--base', base, '--head', head), 0, 'untracked tooling input runs')
  rmSync(join(root, 'scripts/kit/untracked.sh'))
  for (const path of [
    'scripts/kit/helper.sh',
    'config/kit/settings.json',
    '.github/workflows/example.yml',
    'lefthook.yml',
    'package.json',
    'bun.lock',
    'tooling/a',
    'biome.json',
  ]) {
    const previous = head
    put(path, 'changed')
    head = commit(path)
    assert.equal(select('--base', previous, '--head', head), 0, path)
  }
  const selectorPath = join(root, 'scripts/kit/select-tooling.ts')
  const selector = readFileSync(selectorPath, 'utf8')
  writeFileSync(selectorPath, `${selector}\n// selector mutation\n`)
  let previous = head
  head = commit('selector change')
  assert.equal(select('--base', previous, '--head', head), 0, 'selector change runs')
  writeFileSync(selectorPath, selector.replace("'tooling/',", "'tooling/', 'extra-input/',"))
  previous = head
  head = commit('input list change')
  assert.equal(select('--base', previous, '--head', head), 0, 'input list change runs')
  previous = head
  put('extra-input/new-file', 'new input')
  head = commit('new input')
  assert.equal(select('--base', previous, '--head', head), 0, 'new input class runs')
  put('scripts/kit/test-custom.sh', `cat "\${ROOT}/packages/core/src/value.ts"\n`)
  const beforeInput = commit('test input declaration')
  put('packages/core/src/value.ts', 'changed again')
  head = commit('test input')
  assert.equal(select('--base', beforeInput, '--head', head), 0, 'uncovered test input runs')
  git('remote', 'set-url', 'origin', 'product')
  put('config/product/inheritance.json', JSON.stringify({ upstreamCommit: base }))
  commit('product')
  assert.equal(select('--kit-main-push'), 1, 'product main skips')
  put(
    'config/product/zero-edit-exceptions.json',
    JSON.stringify({ version: 1, exceptions: [{ path: 'packages/core/src/unrelated.ts' }] }),
  )
  assert.equal(select(), 1, 'unrelated product exception skips')
  put(
    'config/product/zero-edit-exceptions.json',
    JSON.stringify({ version: 1, exceptions: [{ path: 'scripts/kit/helper.sh' }] }),
  )
  assert.equal(select(), 0, 'tooling exception runs')
  put(
    'config/product/zero-edit-exceptions.json',
    JSON.stringify({ version: 1, exceptions: [{ path: 'scripts' }] }),
  )
  assert.equal(select(), 0, 'ancestor exception runs')
  put('config/product/zero-edit-exceptions.json', '{')
  assert.equal(select(), 0, 'malformed exception runs')
  put('config/product/inheritance.json', '{')
  assert.equal(select(), 0, 'unknown identity runs')
  console.log('tooling selector self-tests passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
