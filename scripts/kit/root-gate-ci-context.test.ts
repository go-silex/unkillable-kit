import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

type Change = (path?: string) => void

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
          'validate:full': 'bun run scripts/kit/root-gate.ts test:coverage',
          'test:coverage': 'bash scripts/kit/test-coverage.sh',
        },
      }),
    )
    write(
      'config/kit/zero-edit-zones.json',
      '{"protected_prefixes":["apps/example-api/","apps/example-web/","packages/"]}\n',
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
  printf '%s\\n' apps/example-api packages/core apps/example-web apps/fixture-api apps/fixture-web
fi
`,
    )
    for (const name of readdirSync(import.meta.dirname)) {
      if (/^root-gate(?:-.+)?\.ts$/.test(name) && !name.endsWith('.test.ts')) {
        copyFileSync(join(import.meta.dirname, name), join(repo, 'scripts/kit', name))
      }
    }
    git('add', '--all')
    git('commit', '-qm', 'base')
    const base = git('rev-parse', 'HEAD')
    const event = join(repo, '.git/event.json')
    function change(path?: string) {
      git('checkout', '-q', '--detach', base)
      if (path) write(path, 'change\n')
      git('add', '--all')
      git('commit', '-qm', 'head', '--allow-empty')
      const head = git('rev-parse', 'HEAD')
      const merge = git('commit-tree', `${head}^{tree}`, '-p', base, '-p', head, '-m', 'merge')
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
    change(path)
    assert.deepEqual(plan(repo, env, '--coverage-plan'), productGroups, path)
    assert.deepEqual(plan(repo, env, '--coverage-parts-plan'), [productPart], path)
  }

  for (const path of [undefined, 'apps/example-web/src/main.ts', 'bun.lock', '.dev/stack.yml']) {
    change(path)
    const description = path ?? 'empty diff'
    assert.deepEqual(plan(repo, env, '--coverage-plan'), fullGroups, description)
    assert.deepEqual(plan(repo, env, '--coverage-parts-plan'), fullParts, description)
  }

  change('apps/fixture-web/src/main.ts')
  env.GITHUB_EVENT_NAME = 'push'
  assert.deepEqual(plan(repo, env, '--coverage-plan'), fullGroups)
  assert.deepEqual(plan(repo, env, '--coverage-parts-plan'), fullParts)

  env.GITHUB_EVENT_NAME = 'pull_request'
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
