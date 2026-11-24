import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseLock } from './deps-guard/lock'

const repo = resolve(import.meta.dirname, '../..')
const root = mkdtempSync(join(tmpdir(), 'product-root-better-auth-'))
const app = 'apps/product-fixture'
const wrapper = 'src/better-auth.ts'
const kitManifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const inherited = kitManifest.scripts['validate:full']
  .split(' ')
  .filter(
    (task: string, index: number) =>
      index < 3 || task === 'better-auth:check' || task === 'test:coverage',
  )
  .join(' ')
const locked = parseLock(readFileSync(join(repo, 'bun.lock'), 'utf8')).find(
  (pkg) => pkg.key === 'better-auth',
)
assert.ok(locked)
const resolution = [`better-auth@${locked.version}`, '']
const otherVersion = '0.0.1'
const scripts = { typecheck: 'true', 'test:coverage': 'true' }
const release: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(GIT_|GITHUB_|COVERAGE_)/.test(name)),
  ),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GITHUB_REPOSITORY: 'kit/product-fixture',
  GITHUB_RUN_ID: '1',
  GITHUB_RUN_ATTEMPT: '1',
  COVERAGE_ONLY: 'apps/other',
}

function put(file: string, contents: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), contents)
}
function json(file: string, value: unknown) {
  put(file, JSON.stringify(value))
}
function copy(file: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  copyFileSync(join(repo, file), join(root, file))
}
function command(bin: string, ...args: string[]) {
  const result = spawnSync(bin, args, { cwd: root, env: release, encoding: 'utf8' })
  if (result.error) throw result.error
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}
function git(...args: string[]) {
  const result = command('git', ...args)
  assert.equal(result.status, 0, result.output)
  return result.output.trim()
}
function runCore(expectedFailure?: RegExp) {
  const result = command(
    process.execPath,
    'run',
    'validate:full',
    '--',
    '--ci-group',
    'core',
    '--receipt',
    'root-core.json',
  )
  assert.equal(result.status, expectedFailure ? 1 : 0, result.output)
  if (expectedFailure) assert.match(result.output, expectedFailure)
  const receipt = JSON.parse(readFileSync(join(root, 'root-core.json'), 'utf8'))
  assert.deepEqual(receipt.tasks, ['better-auth:check'])
  assert.equal(receipt.complete, !expectedFailure)
  rmSync(join(root, 'root-core.json'))
  return result.output
}

try {
  for (const file of readdirSync(join(repo, 'scripts/kit'))) {
    if (/^root-gate(?:-.*)?\.ts$/.test(file) && !file.endsWith('.test.ts'))
      copy(`scripts/kit/${file}`)
  }
  for (const file of [
    'config/kit/bunfig.gates.toml',
    'scripts/kit/deps-guard/lock.ts',
    'scripts/kit/deps-guard/json.ts',
    'scripts/kit/lib/wrangler-d1.ts',
  ])
    copy(file)
  put(
    'scripts/kit/test-coverage.sh',
    'if [[ "$COVERAGE_LIST_ONLY" == 1 ]]; then echo apps/product-fixture; fi\n',
  )
  json('config/kit/zero-edit-zones.json', { protected_prefixes: [] })
  json('package.json', {
    name: 'product-root-fixture',
    workspaces: ['apps/*', 'packages/*'],
    scripts: {
      ...scripts,
      'validate:full': inherited,
      'better-auth:check': kitManifest.scripts['better-auth:check'],
    },
  })
  mkdirSync(join(root, app), { recursive: true })
  mkdirSync(join(root, 'packages'), { recursive: true })
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir')
  symlinkSync(join(repo, 'packages/db'), join(root, 'packages/db'), 'dir')
  symlinkSync(join(repo, 'apps/starter-api/node_modules'), join(root, app, 'node_modules'), 'dir')
  cpSync(join(repo, 'apps/starter-api/migrations'), join(root, app, 'migrations'), {
    recursive: true,
  })
  put(`${app}/wrangler.toml`, 'name = "product-fixture"\nmain = "src/worker.ts"\n')
  put(
    `${app}/${wrapper}`,
    `import { createBetterAuth as createKitBetterAuth } from '@kit/auth/factory'
export function createBetterAuth(env, baseURL) {
  return createKitBetterAuth({
    database: env.DB, secret: env.BETTER_AUTH_SECRET, baseURL,
    allowPublicSignup: false, trustedOrigins: [baseURL],
    cookieName: env.SESSION_COOKIE_NAME, useSecureCookies: env.ENVIRONMENT === 'production',
  })
}
`,
  )
  put(
    `${app}/src/auth-consumer.ts`,
    `import { createBetterAuth as issueAuth } from './better-auth'
export function fetch(req, env) { return issueAuth(env, new URL(req.url).origin).handler(req) }
`,
  )
  put(
    `${app}/src/worker.ts`,
    'export default { fetch: () => new Response(null, { status: 503 }) }\n',
  )
  put(`${app}/src/separate.test.ts`, readFileSync(join(root, app, wrapper), 'utf8'))
  const productManifest = { name: 'product-fixture', scripts }
  const workspaces = {
    '': { name: 'product-root-fixture' },
    [app]: { name: 'product-fixture', dependencies: { 'better-auth': '*' } },
  }
  const packages = { 'better-auth': resolution }
  json('bun.lock', { workspaces, packages })
  git('init', '-q')
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'Synthetic Product',
  )
  release.GITHUB_SHA = git('rev-parse', 'HEAD')

  // Inventory does not derive from the dependency declaration or the test registration.
  json(`${app}/package.json`, productManifest)
  runCore(
    /apps\/product-fixture: shipping Better Auth composition must declare better-auth directly/,
  )
  json(`${app}/package.json`, { ...productManifest, dependencies: { 'better-auth': '*' } })
  runCore(/kitBetterAuth must name the sole shipping createBetterAuth export/)
  json(`${app}/package.json`, {
    ...productManifest,
    dependencies: { 'better-auth': '*' },
    kitBetterAuth: 'src/separate.test.ts',
  })
  runCore(/kitBetterAuth must name the sole shipping createBetterAuth export.*src\/better-auth\.ts/)
  json(`${app}/package.json`, {
    ...productManifest,
    dependencies: { 'better-auth': '*' },
    kitBetterAuth: wrapper,
  })
  const unwired = /Wrangler main src\/worker\.ts does not reach a runtime call to createBetterAuth/
  runCore(unwired) // The only call is in an orphan source file.
  put(
    `${app}/src/worker.ts`,
    `import { createBetterAuth } from './better-auth'
export default { fetch: () => new Response(null, { status: 503 }) }
`,
  )
  runCore(unwired) // The reachable module imports the adapter but does not call it.
  put(`${app}/src/worker.ts`, `import { fetch } from './edge'\nexport default { fetch }\n`)
  put(`${app}/src/edge.ts`, `export { fetch } from './auth-consumer'\n`)
  assert.match(runCore(), /apps\/product-fixture differential fixtures passed/)

  json('packages/nested-consumer/package.json', {
    name: 'nested-consumer',
    dependencies: { bridge: '*' },
  })
  json('bun.lock', {
    workspaces: {
      ...workspaces,
      'packages/nested-consumer': { name: 'nested-consumer', dependencies: { bridge: '*' } },
    },
    packages: {
      ...packages,
      bridge: ['bridge@1.0.0', '', { dependencies: { 'better-auth': otherVersion } }],
      'bridge/better-auth': [`better-auth@${otherVersion}`, ''],
    },
  })
  runCore(
    /multiple effective better-auth versions in bun.lock:\n0\.0\.1: packages\/nested-consumer\n\S+: apps\/product-fixture/,
  )
  console.log(
    'product-root-gate: inherited Better Auth Core inventory and differential fixtures passed',
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
