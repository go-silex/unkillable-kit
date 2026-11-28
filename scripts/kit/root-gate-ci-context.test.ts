import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { rootGateLaunch } from './root-gate-recipe'

type BaseMove = 'none' | 'advanced' | 'unrelated'
type Change = (paths: string[], removals?: string[], baseMove?: BaseMove) => void

function fixture(exercise: (repo: string, env: NodeJS.ProcessEnv, change: Change) => void) {
  const repo = mkdtempSync(join(tmpdir(), 'root-coverage-context-'))
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(GIT_|GITHUB_|COVERAGE_)/.test(key)),
  )
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'root-gate@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'root-gate@example.invalid',
  })
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  function write(path: string, text: string) {
    const target = join(repo, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
  }
  try {
    git('init', '-q')
    write(
      'package.json',
      JSON.stringify({
        workspaces: ['apps/*', 'packages/*'],
        scripts: {
          'validate:full': `${rootGateLaunch} test:coverage`,
          'test:coverage': 'bash scripts/kit/test-coverage.sh',
        },
      }),
    )
    write(
      'config/kit/zero-edit-zones.json',
      '{"protected_prefixes":["apps/example-api/","apps/example-web/","packages/"]}\n',
    )
    write(
      'config/kit/bunfig.gates.toml',
      readFileSync(join(import.meta.dirname, '../../config/kit/bunfig.gates.toml'), 'utf8'),
    )
    for (const app of ['fixture-web', 'fixture-api']) {
      write(
        `apps/${app}/package.json`,
        JSON.stringify({
          name: app,
          scripts: { typecheck: 'tsc', 'test:coverage': 'vitest run --coverage' },
        }),
      )
    }
    write(
      'scripts/kit/test-coverage.sh',
      `#!/bin/bash
if [[ "\${COVERAGE_LIST_PARTS:-}" == 1 ]]; then
  printf '%s\\n' 'apps/example-api 2' 'apps/fixture-api 3'
else
  printf '%s\\n' apps/example-api packages/core apps/example-web apps/fixture-api
  if [[ -f apps/fixture-web/package.json ]]; then echo apps/fixture-web; fi
fi
`,
    )
    for (const name of readdirSync(import.meta.dirname)) {
      if (/^(?:root-gate(?:-.+)?|select-tooling)\.ts$/.test(name) && !name.endsWith('.test.ts')) {
        copyFileSync(join(import.meta.dirname, name), join(repo, 'scripts/kit', name))
      }
    }
    git('add', '--all')
    git('commit', '-qm', 'base')
    const base = git('rev-parse', 'HEAD')
    const event = join(repo, '.git/event.json')
    function change(paths: string[], removals: string[] = [], baseMove: BaseMove = 'none') {
      git('checkout', '-q', '--detach', base)
      for (const path of paths) write(path, 'change\n')
      for (const path of removals) rmSync(join(repo, path))
      git('add', '--all')
      git('commit', '-qm', 'head', '--allow-empty')
      const head = git('rev-parse', 'HEAD')
      const parent =
        baseMove === 'none'
          ? base
          : git(
              'commit-tree',
              `${base}^{tree}`,
              ...(baseMove === 'advanced' ? ['-p', base] : []),
              '-m',
              'new main',
            )
      const merge = git('commit-tree', `${head}^{tree}`, '-p', parent, '-p', head, '-m', 'merge')
      git('checkout', '-q', '--detach', merge)
      writeFileSync(
        event,
        JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }),
      )
      Object.assign(env, {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: event,
        GITHUB_SHA: merge,
      })
    }
    exercise(repo, env, change)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

function list(repo: string, env: NodeJS.ProcessEnv, mode: string) {
  return spawnSync(process.execPath, ['run', 'validate:full', '--', mode], {
    cwd: repo,
    env,
    encoding: 'utf8',
  })
}

function plan(repo: string, env: NodeJS.ProcessEnv, mode: string) {
  const result = list(repo, env, mode)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

fixture((repo, env, change) => {
  const productGroups = [{ id: 'apps__fixture-web', workspaces: ['apps/fixture-web'] }]
  const productPart = {
    id: 'apps__fixture-api',
    workspace: 'apps/fixture-api',
    count: 3,
    indices: [1, 2, 3],
  }
  const fullGroups = [
    { id: 'packages-1', workspaces: ['packages/core'] },
    { id: 'apps__example-web', workspaces: ['apps/example-web'] },
    ...productGroups,
  ]
  const fullParts = [
    { id: 'apps__example-api', workspace: 'apps/example-api', count: 2, indices: [1, 2] },
    productPart,
  ]
  for (const path of [
    'apps/fixture-web/src/main.ts',
    'config/product/rules.json',
    'docs/product/README.md',
    'scripts/product/check.sh',
    '.github/workflows/product-check.yaml',
  ]) {
    change([path])
    assert.deepEqual(plan(repo, env, '--coverage-plan'), productGroups, path)
    assert.deepEqual(plan(repo, env, '--coverage-parts-plan'), [productPart], path)
  }

  for (const paths of [
    [],
    ['apps/example-web/src/main.ts'],
    ['apps/notes/README.md'],
    ['bun.lock'],
    ['.dev/stack.yml'],
    ['apps/fixture-web/src/main.ts', 'bun.lock'],
  ]) {
    change(paths)
    const description = paths.join(', ') || 'empty diff'
    assert.deepEqual(plan(repo, env, '--coverage-plan'), fullGroups, description)
    assert.deepEqual(plan(repo, env, '--coverage-parts-plan'), fullParts, description)
  }

  change([], ['apps/fixture-web/package.json'])
  assert.deepEqual(plan(repo, env, '--coverage-plan'), [])
  assert.deepEqual(plan(repo, env, '--coverage-parts-plan'), [productPart])

  change(['apps/fixture-web/src/main.ts'])
  env.GITHUB_EVENT_NAME = 'push'
  assert.deepEqual(plan(repo, env, '--coverage-plan'), fullGroups)
  assert.deepEqual(plan(repo, env, '--coverage-parts-plan'), fullParts)

  change(['apps/fixture-web/src/main.ts'], [], 'advanced')
  assert.deepEqual(plan(repo, env, '--coverage-plan'), fullGroups)
  assert.deepEqual(plan(repo, env, '--coverage-parts-plan'), fullParts)
  const delivered = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8'))
  const tooling = spawnSync(
    'bun',
    [
      join(repo, 'scripts/kit', 'select-tooling.ts'),
      '--base',
      delivered.pull_request.base.sha,
      '--head',
      env.GITHUB_SHA ?? '',
    ],
    { cwd: repo, env, encoding: 'utf8' },
  )
  assert.equal(tooling.status, 0, tooling.stderr)
  assert.equal(tooling.stderr, '', 'base advancement selects tooling without fallback')

  change(['apps/fixture-web/src/main.ts'], [], 'unrelated')
  const unrelated = list(repo, env, '--coverage-plan')
  assert.notEqual(unrelated.status, 0)
  assert.match(unrelated.stderr, /pull-request payload does not match checkout and merge parents/)

  change(['apps/fixture-web/src/main.ts'])

  env.GITHUB_EVENT_NAME = 'pull_request'
  const eventPath = env.GITHUB_EVENT_PATH
  assert.ok(eventPath)
  const originalEvent = readFileSync(eventPath, 'utf8')
  const { base, head } = JSON.parse(originalEvent).pull_request
  writeFileSync(eventPath, JSON.stringify({ pull_request: { base: head, head: base } }))
  const swapped = list(repo, env, '--coverage-plan')
  assert.notEqual(swapped.status, 0)
  assert.match(swapped.stderr, /pull-request payload does not match checkout and merge parents/)
  writeFileSync(eventPath, originalEvent)

  env.GITHUB_SHA = 'a'.repeat(40)
  const mismatched = list(repo, env, '--coverage-plan')
  assert.notEqual(mismatched.status, 0)
  assert.match(mismatched.stderr, /pull-request payload does not match checkout/)
  delete env.GITHUB_EVENT_PATH
  const missing = list(repo, env, '--coverage-parts-plan')
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /missing pull-request event payload/)
})
console.log('PR coverage selection fixtures passed')
