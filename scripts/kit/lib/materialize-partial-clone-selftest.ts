#!/usr/bin/env bun
/**
 * Prove the check fails closed on a blob:none clone without fetching the lock.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rootDir = process.argv[2]
const scanner = process.argv[3]
if (!(rootDir && scanner)) {
  console.error('usage: materialize-partial-clone-selftest.ts <kit-root> <check-lock-ranges.ts>')
  process.exit(2)
}

const tmp = mkdtempSync(join(tmpdir(), 'partial-'))
const src = join(tmp, 'src')
const clone = join(tmp, 'clone')

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return spawnSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@e',
      ...env,
    },
    encoding: 'utf8',
  })
}

try {
  // Minimal source with a real lock + packageManager pin.
  cpSync(join(rootDir, 'package.json'), join(tmp, 'pkg.json'))
  const pkg = JSON.parse(await Bun.file(join(tmp, 'pkg.json')).text()) as {
    packageManager?: string
  }
  rmSync(src, { recursive: true, force: true })
  spawnSync('mkdir', ['-p', src])
  writeFileSync(
    join(src, 'package.json'),
    `${JSON.stringify({
      name: 'partial',
      private: true,
      packageManager: pkg.packageManager ?? `bun@${Bun.version}`,
    })}\n`,
  )
  writeFileSync(
    join(src, 'bun.lock'),
    '{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "partial", "dependencies": { "left-pad": "^1.0.0" } } },\n  "packages": { "left-pad": ["left-pad@1.0.0", "", {}, "sha512-aaaaaaaa"] }\n}\n',
  )
  writeFileSync(join(src, '.gitignore'), 'node_modules/\n')
  let r = git(['init', '-q'], src)
  if (r.status !== 0) throw new Error(r.stderr)
  r = git(['add', '.'], src)
  if (r.status !== 0) throw new Error(r.stderr)
  r = git(['commit', '-qm', 'src'], src)
  if (r.status !== 0) throw new Error(r.stderr)
  r = git(['config', 'uploadpack.allowFilter', 'true'], src)
  if (r.status !== 0) throw new Error(r.stderr)

  r = git(['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${src}`, clone], tmp)
  if (r.status !== 0) throw new Error(r.stderr)

  // Install the checker into the clone (not checked out yet).
  spawnSync('mkdir', ['-p', join(clone, 'scripts/kit/lib')])
  cpSync(scanner, join(clone, 'scripts/kit/check-lock-ranges.ts'))
  cpSync(
    join(rootDir, 'scripts/kit/lib/jsonc-strict.ts'),
    join(clone, 'scripts/kit/lib/jsonc-strict.ts'),
  )
  cpSync(
    join(rootDir, 'scripts/kit/lib/materialize-tree.ts'),
    join(clone, 'scripts/kit/lib/materialize-tree.ts'),
  )
  // Working tree needs a lock for the range scan (outside a merge it reads the
  // working copy). Copy bytes into the worktree without resolving the Git blob.
  cpSync(join(src, 'package.json'), join(clone, 'package.json'))
  cpSync(join(src, 'bun.lock'), join(clone, 'bun.lock'))
  writeFileSync(join(clone, '.gitignore'), 'node_modules/\n')
  // HEAD points at the commit whose lock blob is still missing from the object store.
  r = git(['reset', '-q', 'HEAD'], clone)

  // Confirm lock blob is missing offline.
  const before = git(['cat-file', '-e', 'HEAD:bun.lock'], clone, {
    GIT_NO_LAZY_FETCH: '1',
  })
  if (before.status === 0) {
    console.error('setup failed: lock blob already present')
    process.exit(1)
  }

  const check = spawnSync(process.execPath, ['scripts/kit/check-lock-ranges.ts'], {
    cwd: clone,
    env: {
      ...process.env,
      PATH: process.env.PATH,
      HOME: join(tmp, 'home'),
      XDG_CONFIG_HOME: join(tmp, 'home'),
    },
    encoding: 'utf8',
  })
  const after = git(['cat-file', '-e', 'HEAD:bun.lock'], clone, { GIT_NO_LAZY_FETCH: '1' })
  const out = `${check.stdout || ''}${check.stderr || ''}`
  const failed = check.status !== 0
  const stillMissing = after.status !== 0
  const mentions =
    /partial clone|without fetching|missing candidate bun.lock|cannot read candidate bun.lock|cannot materialize/i.test(
      out,
    )
  if (failed && stillMissing && mentions) {
    console.log('PASS: partial clone fails closed without fetching lock blob')
    process.exit(0)
  }
  console.error(
    JSON.stringify({
      status: check.status,
      stillMissing,
      out: out.slice(0, 500),
    }),
  )
  process.exit(1)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
