import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const root = mkdtempSync(join(tmpdir(), 'tooling-selector-'))
const bin = mkdtempSync(join(tmpdir(), 'tooling-selector-bin-'))
const env: NodeJS.ProcessEnv = {
  ...process.env,
  GITHUB_REPOSITORY: 'kit',
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
function push(
  input: string,
  options: { fork?: boolean; unknown?: boolean; remoteError?: boolean; ghError?: boolean } = {},
): number | null {
  const lines = input.trim().split('\n').filter(Boolean)
  const heads = new Map<string, string>()
  for (const name of ['main', 'staging']) {
    try {
      heads.set(`refs/heads/${name}`, git('rev-parse', '--verify', `refs/remotes/origin/${name}`))
    } catch {}
  }
  for (const line of lines) {
    const [, , destination, remote] = line.split(' ')
    if (destination && remote && !/^0{40}$/.test(remote) && !heads.has(destination))
      heads.set(destination, remote)
  }
  const [, , destination, remote] = (lines[0] || '').split(' ')
  const branch = destination?.replace(/^refs\/heads\//, '')
  const repository = 'fixture/kit'
  const prs = options.unknown
    ? []
    : [
        {
          head: { sha: remote, ref: branch, repo: { full_name: repository } },
          base: {
            ref: 'main',
            sha: heads.get('refs/heads/main'),
            repo: { full_name: options.fork ? 'other/kit' : repository },
          },
        },
      ]
  const child = spawnSync(
    process.execPath,
    [join(root, 'scripts/kit/select-tooling.ts'), '--pre-push', 'origin'],
    {
      cwd: root,
      env: {
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
        TOOLING_TEST_HEADS: [...heads].map(([ref, sha]) => `${sha}\t${ref}\n`).join(''),
        TOOLING_TEST_PRS: JSON.stringify(prs),
        TOOLING_TEST_REMOTE_ERROR: options.remoteError ? '1' : '',
        TOOLING_TEST_GH_ERROR: options.ghError ? '1' : '',
      },
      encoding: 'utf8',
      input,
    },
  )
  assert.equal(child.signal, null, child.stderr)
  return child.status
}
try {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\nif [ "$1" = ls-remote ]; then [ -z "$TOOLING_TEST_REMOTE_ERROR" ] || exit 1; printf '%s' "$TOOLING_TEST_HEADS"; else exec "${realGit}" "$@"; fi\n`,
  )
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\n[ -z "$TOOLING_TEST_GH_ERROR" ] || exit 1\nprintf '%s' "$TOOLING_TEST_PRS"\n`,
  )
  chmodSync(join(bin, 'git'), 0o755)
  chmodSync(join(bin, 'gh'), 0o755)
  mkdirSync(join(root, 'scripts/kit'), { recursive: true })
  for (const name of ['select-tooling.ts', 'resolve-tree-identity.mjs'])
    cpSync(join(source, 'scripts/kit', name), join(root, 'scripts/kit', name))
  put(
    'config/kit/zero-edit-zones.json',
    JSON.stringify({
      version: 1,
      kit_origin_allowlist: ['kit'],
      protected_prefixes: ['packages/', 'apps/example-web/', 'scripts/kit/', 'config/kit/'],
      exceptions_file: 'config/product/zero-edit-exceptions.json',
    }),
  )
  git('init', '-q')
  git('remote', 'add', 'origin', 'https://github.com/fixture/kit.git')
  put('packages/core/src/value.ts', 'initial')
  const base = commit('base')
  put('packages/core/src/value.ts', 'changed')
  let head = commit('source')
  assert.equal(select('--base', base, '--head', head), 1, 'unrelated source skips')
  assert.equal(select('--base', head, '--head', base), 0, 'head mismatch runs')
  put('apps/example-web/src/page.ts', 'app change')
  head = commit('app only')
  assert.equal(select('--base', base, '--head', head), 1, 'app-only change skips')
  git('update-ref', 'refs/remotes/origin/main', base)
  const update = (local: string, destination: string, remote: string) =>
    `refs/heads/topic ${local} ${destination} ${remote}\n`
  assert.equal(push(update(head, 'refs/heads/topic', base)), 1, 'main-only app push skips')
  git('update-ref', 'refs/remotes/origin/staging', base)
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  assert.equal(push(update(head, 'refs/heads/topic', base)), 1, 'local app-only push skips')
  assert.equal(
    push(update(head, 'refs/heads/topic', base), { unknown: true }),
    0,
    'unknown PR runs',
  )
  assert.equal(push(update(head, 'refs/heads/topic', base), { fork: true }), 0, 'fork target runs')
  assert.equal(
    push(update(head, 'refs/heads/topic', base), { remoteError: true }),
    0,
    'remote error runs',
  )
  assert.equal(push(update(head, 'refs/heads/topic', base), { ghError: true }), 0, 'gh error runs')
  assert.equal(push(update(head, 'refs/heads/topic', '0'.repeat(40))), 0, 'new feature runs')
  assert.equal(push(update(head, 'refs/heads/main', base)), 0, 'local main push runs')
  assert.equal(push(update(base, 'refs/heads/main', head)), 2, 'non-HEAD push is refused')
  assert.equal(
    push(update(head, 'refs/heads/topic', base) + update(head, 'refs/heads/main', base)),
    0,
    'multiple updates include main',
  )
  assert.equal(
    push(update(head, 'refs/heads/topic', base) + update(head, 'refs/heads/new', '0'.repeat(40))),
    0,
    'mixed updates include initial branch',
  )
  assert.equal(push(''), 0, 'missing push context runs')
  git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
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
  git('update-ref', 'refs/remotes/origin/main', head)
  assert.equal(
    push(update(head, 'refs/heads/staging', base)),
    0,
    'staging destination detects changes already on main',
  )
  assert.equal(
    push(update(head, 'refs/heads/topic', head)),
    0,
    'non-default PR base detects tooling changes',
  )
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  assert.equal(
    push(update(head, 'refs/heads/topic', head)),
    0,
    'feature push compares against default, not destination',
  )
  git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
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
  env.GITHUB_REPOSITORY = 'product'
  put('config/product/inheritance.json', JSON.stringify({ upstreamCommit: base }))
  const productBase = head
  head = commit('product')
  assert.equal(
    select('--base', productBase, '--head', head, '--kit-main-push'),
    1,
    'product main skips',
  )
  assert.equal(push(update(productBase, 'refs/heads/topic', head)), 2, 'product non-HEAD refused')
  assert.equal(select('--base', 'invalid', '--head', head), 0, 'product invalid base runs')
  writeFileSync(join(root, '.git/shallow'), `${base}\n`)
  assert.equal(select('--base', productBase, '--head', head), 0, 'product shallow clone runs')
  rmSync(join(root, '.git/shallow'))
  put('bun.lock', 'dirty lock')
  assert.equal(select('--base', productBase, '--head', head), 0, 'product dirty lock runs')
  put('bun.lock', 'committed lock')
  const beforeLock = head
  head = commit('product lock')
  assert.equal(select('--base', beforeLock, '--head', head), 0, 'product committed lock runs')
  const productArgs = ['--base', head, '--head', head]
  put(
    'config/product/zero-edit-exceptions.json',
    JSON.stringify({ version: 1, exceptions: [{ path: 'packages/core/src/unrelated.ts' }] }),
  )
  assert.equal(select(...productArgs), 1, 'unrelated product exception skips')
  put('apps/widget-web/src/page.ts', 'product source')
  assert.equal(select(...productArgs), 1, 'product app source skips')
  put('apps/widget-web/package.json', '{}')
  assert.equal(select(...productArgs), 0, 'product manifest runs')
  rmSync(join(root, 'apps/widget-web/package.json'))
  put('config/product/custom.json', '{}')
  assert.equal(select(...productArgs), 0, 'product config runs')
  rmSync(join(root, 'config/product/custom.json'))
  put(
    'config/product/zero-edit-exceptions.json',
    JSON.stringify({ version: 1, exceptions: [{ path: 'scripts/kit/helper.sh' }] }),
  )
  assert.equal(select(...productArgs), 0, 'tooling exception runs')
  put(
    'config/product/zero-edit-exceptions.json',
    JSON.stringify({ version: 1, exceptions: [{ path: 'scripts' }] }),
  )
  assert.equal(select(...productArgs), 0, 'ancestor exception runs')
  put('config/product/zero-edit-exceptions.json', '{')
  assert.equal(select(...productArgs), 0, 'malformed exception runs')
  put('config/product/inheritance.json', '{')
  assert.equal(select(...productArgs), 0, 'unknown identity runs')
  console.log('tooling selector self-tests passed')
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(bin, { recursive: true, force: true })
}
