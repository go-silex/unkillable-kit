import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseLock } from './deps-guard/lock'
import { recipeTasks, rootGateLaunch } from './root-gate-recipe'

const repo = resolve(import.meta.dirname, '../..')
const app = 'apps/product-fixture'
const wrapper = 'src/better-auth.ts'
const kitManifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const inheritedTasks = recipeTasks(kitManifest.scripts['validate:full']).filter(
  (task) => task === 'better-auth:check' || task === 'test:coverage',
)
const inherited = `${rootGateLaunch} ${inheritedTasks.join(' ')}`
const locked = parseLock(readFileSync(join(repo, 'bun.lock'), 'utf8')).find(
  (pkg) => pkg.key === 'better-auth',
)
assert.ok(locked)
const resolution = [`better-auth@${locked.version}`, '']
const otherVersion = '0.0.1'
const scripts = { typecheck: 'true', 'test:coverage': 'true' }
// Each group runs as its own tooling task, so CI can place the groups on separate shards.
const scenarios = {
  enrollment: enrollmentScenarios,
  cookies: cookieScenarios,
  issuers: issuerScenarios,
  resolution: resolutionScenarios,
}
const group = process.argv[2] ?? ''
if (process.argv.length !== 3 || !Object.hasOwn(scenarios, group))
  throw new Error(
    `usage: bun run scripts/kit/root-gate-better-auth.test.ts <${Object.keys(scenarios).join('|')}>`,
  )
const toolingTasks = recipeTasks(kitManifest.scripts['validate:tooling'])
for (const name of Object.keys(scenarios)) {
  const task = `test:root-gate-better-auth:${name}`
  assert.ok(toolingTasks.includes(task), `validate:tooling must run ${task}`)
  assert.equal(
    kitManifest.scripts[task],
    `bun run scripts/kit/root-gate-better-auth.test.ts ${name}`,
  )
}
const database = 'binding = "DB"\ndatabase_name = "product-fixture"\ndatabase_id = "fixture-db"\n'
const workerConfig = `name = "product-fixture"
main = "src/worker.ts"
compatibility_date = "2026-07-01"
compatibility_flags = ["nodejs_compat"]
[[d1_databases]]
${database}
[assets]
directory = "./public"
`
const withRelease = `${workerConfig}\n[[env.release.d1_databases]]\n${database}
[env.release.assets]
directory = "../web/dist"
`
const productManifest = { name: 'product-fixture', scripts }
const enrolledManifest = {
  ...productManifest,
  dependencies: { 'better-auth': '*' },
  kitBetterAuth: wrapper,
}
const projectedManifest = {
  ...enrolledManifest,
  kitBetterAuthDisableUser: 'INSERT INTO account_disabled (user_id) VALUES (?)',
}
const workspaces = {
  '': { name: 'product-root-fixture' },
  [app]: { name: 'product-fixture', dependencies: { 'better-auth': '*' } },
}
const packages = { 'better-auth': resolution }
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

const passed = /apps\/product-fixture differential fixtures passed/
// A Core run keeps about one CPU busy, running Bun, Node, Wrangler and workerd in turn. Up to four
// workspaces, one per CPU like the hosted Kit runner, replay every step of the group in parallel;
// each Core run executes once, in the first workspace that reaches it.
const workspaceCount = Math.min(availableParallelism(), 4)
const claimed = new Set<number>()
let stopped = false
let verified = 0
/** Ends a workspace's replay after another workspace failed. */
class Stopped extends Error {}
type Expectation = {
  refuses?: RegExp
  name?: string
  prints?: RegExp
  omits?: RegExp
  after?: () => void
}
/** A Core run's exit status, receipt and output, then the scenario's own follow-up check. */
function verifyCore(
  root: string,
  status: number,
  output: string,
  { refuses, name, prints, omits, after }: Expectation,
) {
  const context = name ? `${name}\n${output}` : output
  assert.equal(status, refuses ? 1 : 0, context)
  if (refuses) assert.match(output, refuses, name ?? 'expected core failure')
  const receipt = JSON.parse(readFileSync(join(root, 'root-core.json'), 'utf8'))
  assert.deepEqual(receipt.tasks, ['better-auth:check'])
  assert.equal(receipt.complete, !refuses)
  rmSync(join(root, 'root-core.json'))
  if (prints) assert.match(output, prints, context)
  if (omits) assert.doesNotMatch(output, omits, context)
  after?.()
}
type Workspace = {
  root: string
  put(file: string, contents: string): void
  json(file: string, value: unknown): void
  core(expected?: RegExp | Expectation): Promise<void>
  enroll(): void
  alternateIssuerPackage(): void
  reached(): number
}

/** A synthetic Product that inherits the Root gate's Better Auth Core. */
function createWorkspace(roots: string[]): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'product-root-better-auth-'))
  roots.push(root)
  const modules = join(root, app, 'node_modules')
  const env: NodeJS.ProcessEnv = { ...release }
  let reached = 0

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
  function git(...args: string[]) {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' })
    if (result.error) throw result.error
    const output = `${result.stdout}${result.stderr}`
    assert.equal(result.status, 0, output)
    return output.trim()
  }
  /** One Core run, `validate:full -- --ci-group core`, unless another workspace ran it. */
  async function core(expected?: RegExp | Expectation) {
    const run = reached++
    if (stopped) throw new Stopped()
    if (claimed.has(run)) return
    claimed.add(run)
    const child = Bun.spawn(
      [
        process.execPath,
        'run',
        'validate:full',
        '--',
        '--ci-group',
        'core',
        '--receipt',
        'root-core.json',
      ],
      { cwd: root, env, stdout: 'pipe', stderr: 'pipe' },
    )
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    verifyCore(
      root,
      status,
      `${stdout}${stderr}`,
      expected instanceof RegExp ? { refuses: expected } : (expected ?? {}),
    )
    verified++
  }

  /** The enrolled App that passes the differential; `enrollment` proves it, the other groups start from it. */
  function enroll() {
    put(
      `${app}/src/worker.ts`,
      `import { fetch } from './edge'
export default {
  fetch(req, env) {
    if ('ROOT_GATE_LOCAL_ONLY' in env) return new Response(null, { status: 418 })
    return fetch(req, env)
  },
}
`,
    )
    put(`${app}/src/edge.ts`, `export { fetch } from './auth-consumer'\n`)
    put(`${app}/wrangler.toml`, withRelease)
    for (const localFile of ['.dev.vars', '.dev.vars.release', '.env']) {
      put(`${app}/${localFile}`, 'ROOT_GATE_LOCAL_ONLY=fixture-canary\n')
    }
    put(
      `${app}/migrations/9999_account_disabled.sql`,
      `CREATE TABLE account_disabled (user_id TEXT PRIMARY KEY REFERENCES "user"(id));
CREATE TRIGGER guard_disabled_insert BEFORE INSERT ON "user"
WHEN NEW.disabled IS NOT 0
BEGIN
  SELECT RAISE(ABORT, 'projected');
END;
CREATE TRIGGER guard_disabled_update BEFORE UPDATE OF disabled ON "user"
WHEN NEW.disabled IS NOT EXISTS (SELECT 1 FROM account_disabled WHERE user_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'projected');
END;
CREATE TRIGGER project_disabled AFTER INSERT ON account_disabled
BEGIN
  UPDATE "user" SET disabled = 1 WHERE id = NEW.user_id;
END;
`,
    )
    json(`${app}/package.json`, projectedManifest)
  }

  /** A workspace package that issues through the Kit factory. */
  function alternateIssuerPackage() {
    put(
      'packages/alternate-issuer/issuer.ts',
      `import { createBetterAuth } from '@kit/auth/factory'
export function alternateIssuer(options) { return createBetterAuth(options) }
`,
    )
    symlinkSync(
      // The real installed Kit dependencies resolve outside this synthetic workspace.
      join(repo, 'apps/starter-api/node_modules'),
      join(root, 'packages/alternate-issuer/node_modules'),
      'dir',
    )
    json('packages/alternate-issuer/package.json', {
      name: '@fixture/alternate-issuer',
      exports: { '.': './issuer.ts', './ordinary': './ordinary.ts' },
      dependencies: { '@kit/auth': 'workspace:*' },
    })
    symlinkSync(
      join(root, 'packages/alternate-issuer'),
      join(modules, '@fixture/alternate-issuer'),
      'dir',
    )
  }

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
  mkdirSync(join(modules, '@fixture'), { recursive: true })
  for (const name of ['@kit', 'better-auth', 'wrangler']) {
    symlinkSync(join(repo, 'apps/starter-api/node_modules', name), join(modules, name), 'dir')
  }
  cpSync(join(repo, 'apps/starter-api/migrations'), join(root, app, 'migrations'), {
    recursive: true,
  })
  put(`${app}/wrangler.toml`, workerConfig)
  put(
    `${app}/${wrapper}`,
    `import { createBetterAuth as createKitBetterAuth } from '@kit/auth/factory'
export function createBetterAuth(env, baseURL) {
  return createKitBetterAuth({
    database: env.DB, secret: env.BETTER_AUTH_SECRET, baseURL,
    allowPublicSignup: false, trustedOrigins: [env.CORS_ORIGINS ?? baseURL],
    cookieName: env.SESSION_COOKIE_NAME, useSecureCookies: env.ENVIRONMENT === 'production',
  })
}
`,
  )
  put(
    `${app}/src/auth-consumer.ts`,
    `import { createBetterAuth as issueAuth } from './better-auth'
export function fetch(req, env) { return issueAuth(env, env.BETTER_AUTH_URL).handler(req) }
`,
  )
  put(
    `${app}/src/worker.ts`,
    'export default { fetch: () => new Response(null, { status: 503 }) }\n',
  )
  put(`${app}/src/separate.test.ts`, readFileSync(join(root, app, wrapper), 'utf8'))
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
  env.GITHUB_SHA = git('rev-parse', 'HEAD')
  return { root, put, json, core, enroll, alternateIssuerPackage, reached: () => reached }
}

const roots: string[] = []
try {
  const replicas = Array.from({ length: workspaceCount }, () => createWorkspace(roots))
  const results = await Promise.allSettled(
    replicas.map(async (workspace) => {
      try {
        await scenarios[group as keyof typeof scenarios](workspace)
      } catch (error) {
        stopped = true
        throw error
      }
    }),
  )
  const failure = results.find(
    (result): result is PromiseRejectedResult =>
      result.status === 'rejected' && !(result.reason instanceof Stopped),
  )
  if (failure) throw failure.reason
  const runs = replicas[0].reached()
  assert.ok(
    replicas.every((workspace) => workspace.reached() === runs) && verified === runs,
    'every workspace must reach the same Core runs, and each run must be verified once',
  )
  console.log(
    `product-root-gate: inherited Better Auth Core ${group} fixtures passed (${runs} Core runs, ${replicas.length} workspaces)`,
  )
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}

async function enrollmentScenarios({ put, json, core, enroll }: Workspace) {
  // Inventory does not derive from the dependency declaration or the test registration.
  json(`${app}/package.json`, productManifest)
  await core(
    /apps\/product-fixture: shipping Better Auth composition must declare better-auth directly/,
  )
  json(`${app}/package.json`, { ...productManifest, dependencies: { 'better-auth': '*' } })
  await core(/kitBetterAuth must name the sole shipping createBetterAuth export/)
  json(`${app}/package.json`, {
    ...productManifest,
    dependencies: { 'better-auth': '*' },
    kitBetterAuth: 'src/separate.test.ts',
  })
  await core(
    /kitBetterAuth must name the sole shipping createBetterAuth export.*src\/better-auth\.ts/,
  )
  json(`${app}/package.json`, enrolledManifest)
  const unwired = /Wrangler main src\/worker\.ts does not reach a runtime call to createBetterAuth/
  await core(unwired) // The only call is in an orphan source file.
  put(
    `${app}/src/worker.ts`,
    `import { createBetterAuth } from './better-auth'
export default { fetch: () => new Response(null, { status: 503 }) }
`,
  )
  await core(unwired) // The reachable module imports the adapter but does not call it.
  enroll()
  await core({ prints: passed })

  put(`${app}/wrangler.toml`, withRelease.replace('directory = "../web/dist"', 'directory = ""'))
  await core(/wrangler\.toml --env release: assets\.directory must be a non-empty string/)
  put(
    `${app}/wrangler.toml`,
    withRelease.replace('directory = "../web/dist"', 'directory = "./src/auth-consumer.ts"'),
  )
  await core(
    /wrangler\.toml --env release: assets\.directory points to a non-directory path: .*auth-consumer\.ts/,
  )

  // Only the default target is needed to prove the disabled-User failures.
  put(`${app}/wrangler.toml`, workerConfig)
  json(`${app}/package.json`, enrolledManifest)
  await core(/disabled User: declare kitBetterAuthDisableUser .*projected/)
  json(`${app}/package.json`, {
    ...enrolledManifest,
    kitBetterAuthDisableUser: 'DELETE FROM account_disabled WHERE user_id = ?',
  })
  await core(/disabled User: kitBetterAuthDisableUser must disable the User/)
  json(`${app}/package.json`, {
    ...projectedManifest,
    kitBetterAuthDisableUser: `${projectedManifest.kitBetterAuthDisableUser}; SELECT 1;`,
  })
  await core(/disabled User: kitBetterAuthDisableUser must be one SQL statement/)
  json(`${app}/package.json`, projectedManifest)
  const expiresSession = `${app}/migrations/9999_expire_disabled_session.sql`
  put(
    expiresSession,
    `CREATE TRIGGER expire_disabled_session AFTER INSERT ON account_disabled
BEGIN
  UPDATE session SET expires_at = 0 WHERE user_id = NEW.user_id;
END;
`,
  )
  await core(/disabled User: kitBetterAuthDisableUser must keep the session and leave its token/)
}

async function cookieScenarios({ put, core, enroll }: Workspace) {
  enroll()

  const consumer = `${app}/src/auth-consumer.ts`
  // Test response changes through the shipping sign-in mount, not against a standalone parser.
  put(`${app}/wrangler.toml`, workerConfig)
  for (const [name, modify, failure, secure] of [
    [
      'allows unrelated App cookies (including a near-match name and Expires with a comma)',
      `mounted.headers.append('Set-Cookie', 'app_locale=fr; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/')
       mounted.headers.append('Set-Cookie', name + '.display=compact; Path=/')`,
    ],
    [
      'allows reordering issuer attributes without changing their meaning',
      `replaceCookies(original.map((field) => {
         const [pair, ...attrs] = field.split(';')
         return [pair, ...attrs.reverse()].join(';')
       }).reverse())`,
    ],
    [
      'refuses removal of a non-session issuer cookie while keeping the session cookie',
      `replaceCookies(original.filter((field) => !/^(?:__Secure-)?better-auth\\.dont_remember=/.test(field)))`,
      /mounted Better Auth omitted an issuer cookie/,
    ],
    [
      'refuses rewriting an issuer cookie attribute while retaining its name and value',
      `replaceCookies([original[0].replace(/;\\s*Path=\\/(?=;|$)/i, '; Path=/elsewhere'), ...original.slice(1)])`,
      /mounted Better Auth rewrote an issuer cookie/,
    ],
    [
      'refuses rewriting an issuer cookie value',
      `replaceCookies([original[0].replace(/=[^;]*/, '=rewritten'), ...original.slice(1)])`,
      /mounted Better Auth rewrote an issuer cookie/,
    ],
    [
      'refuses duplicating an issuer cookie',
      `mounted.headers.append('Set-Cookie', original[0])`,
      /mounted Better Auth duplicated an issuer cookie/,
    ],
    ...[
      ['a prefixed spelling', `"__Secure-" + logical`],
      ['an unprefixed spelling', 'logical', true],
      ['an unprefixed chunk', 'logical + ".0"'],
      ['a prefixed chunk', '"__Host-" + logical + ".1"'],
    ].map(
      ([kind, alias, secure]) =>
        [
          `refuses ${kind} in an issuer cookie family`,
          `mounted.headers.append('Set-Cookie', ${alias} + '=other; Path=/')`,
          /mounted Better Auth added a cookie in an issuer cookie family/,
          secure,
        ] as const,
    ),
  ] as const) {
    put(
      consumer,
      `import { createBetterAuth as issueAuth } from './better-auth'
export async function fetch(req, env) {
  const auth = issueAuth({ ...env, ENVIRONMENT: ${JSON.stringify(secure ? 'production' : '')} }, env.BETTER_AUTH_URL)
  req = new Request(req, { body: JSON.stringify({ ...await req.json(), rememberMe: false }) })
  const response = await auth.handler(req)
  const original = response.headers.getSetCookie()
  if (original.length === 0) return response
  const mounted = new Response(response.body, response)
  const replaceCookies = (fields) => {
    mounted.headers.delete('Set-Cookie')
    for (const field of fields) mounted.headers.append('Set-Cookie', field)
  }
  const name = original[0].slice(0, original[0].indexOf('='))
  const logical = name.replace(/^__(?:Secure|Host)-/, '')
  ${modify}
  return mounted
}
`,
    )
    await core({ refuses: failure, name, prints: failure ? undefined : passed })
  }
}

async function issuerScenarios({ root, put, core, enroll, alternateIssuerPackage }: Workspace) {
  enroll()

  // The attestation exempts only the proven Kit call, not more issuer code in that file.
  const enrolledSource = readFileSync(join(root, app, wrapper), 'utf8')
  const extraIssuerInComposition =
    /Wrangler release includes an extra Better Auth issuer: .*src\/better-auth\.ts/
  put(
    `${app}/${wrapper}`,
    `import { betterAuth as anotherIssuer } from 'better-auth'\n${enrolledSource.replace(
      '  return createKitBetterAuth({',
      '  if (env.USE_ALTERNATE) anotherIssuer({ baseURL })\n  return createKitBetterAuth({',
    )}`,
  )
  await core(extraIssuerInComposition)
  put(
    `${app}/${wrapper}`,
    enrolledSource.replace(
      '  return createKitBetterAuth({',
      '  if (env.USE_ALTERNATE) { const alias = createKitBetterAuth; alias({ baseURL }) }\n  return createKitBetterAuth({',
    ),
  )
  await core(extraIssuerInComposition)
  put(`${app}/${wrapper}`, enrolledSource)

  // Wrangler independently stages matching modules, even when the entry never imports them.
  const withStaged = `${workerConfig.replace(
    '[[d1_databases]]',
    'find_additional_modules = true\nbase_dir = "src"\n[[d1_databases]]',
  )}\n[[rules]]\ntype = "ESModule"\nglobs = ["**/*.part"]\nfallthrough = true\n[[rules]]\ntype = "Text"\nglobs = ["**/staged-data.js"]\nfallthrough = true\n`
  put(`${app}/wrangler.toml`, withStaged)
  put(`${app}/src/__fixtures__/dist/staged-data.js`, 'not executable source\n')
  await core()
  put(`${app}/src/__fixtures__/staged-issuer.part`, "export { betterAuth } from 'better-auth'\n")
  await core(/Wrangler release includes an extra Better Auth issuer: .*staged-issuer\.part/)
  rmSync(join(root, app, 'src/__fixtures__/staged-issuer.part'))
  put(`${app}/src/__fixtures__/dist/staged-generated.part`, 'export const embedded = true\n')
  await core(/Cannot inventory opaque Worker inputs.*staged-generated\.part/)

  // Enrolled Workers also fail before executing an unsupported build command.
  put(`${app}/wrangler.toml`, `${withRelease}\n[build]\ncommand = "touch enrolled-build-ran"\n`)
  await core({
    refuses: /Cannot inventory opaque Worker inputs.*without build\.command/,
    after: () => assert.equal(existsSync(join(root, app, 'enrolled-build-ran')), false),
  })
  put('packages/opaque-enrolled/package.json', '{"name":"opaque-enrolled"}')
  put(
    'packages/opaque-enrolled/dist/index.js',
    'export function enabled(req) { return req.method !== "CONNECT" }\n',
  )
  const edge = `${app}/src/edge.ts`
  put(
    edge,
    `import { enabled } from '../../../packages/opaque-enrolled/dist/index.js'
import { fetch as handle } from './auth-consumer'
export function fetch(req, env) { return enabled(req) ? handle(req, env) : new Response(null) }
`,
  )
  put(`${app}/wrangler.toml`, withRelease)
  await core(/Cannot inventory opaque Worker inputs: .*opaque-enrolled\/dist\/index\.js/)

  // Fixture-looking paths are ignored during source discovery, but not when Wrangler ships them.
  put(
    `${app}/src/__fixtures__/retained-issuer.test.ts`,
    `import { betterAuth } from 'better-auth'
export function issue(req) { return betterAuth({}).handler(req) }
`,
  )
  put(
    edge,
    `import { issue } from './__fixtures__/retained-issuer.test'
import { fetch as handle } from './auth-consumer'
export function fetch(req, env) { return env.USE_FIXTURE_ISSUER ? issue(req) : handle(req, env) }
`,
  )
  await core(
    /Wrangler release includes an extra Better Auth issuer: .*__fixtures__\/retained-issuer\.test\.ts/,
  )
  put(edge, `export { fetch } from './auth-consumer'\n`)

  // This release environment calls the enrolled composition, but sends a genuine, compatible
  // cookie from a different instance. Neither call reachability nor successful sign-in is proof.
  const releaseWithAlternate = withRelease.replace(
    '[[env.release.d1_databases]]',
    '[env.release]\nmain = "src/alternate-worker.ts"\n[[env.release.d1_databases]]',
  )
  const alternateFlag = (value: string) =>
    releaseWithAlternate.replace(
      '[[env.release.d1_databases]]',
      `[env.release.vars]\nWRONG_ISSUER = ${JSON.stringify(value)}\n[[env.release.d1_databases]]`,
    )
  put(`${app}/wrangler.toml`, alternateFlag('true'))
  put(
    `${app}/src/alternate-worker.ts`,
    "import { fetch } from './alternate-consumer'\nexport default { fetch }\n",
  )
  alternateIssuerPackage()
  put(
    `${app}/src/alternate-consumer.ts`,
    `import { createBetterAuth as issueAuth } from './better-auth'
import { alternateIssuer } from '../../../packages/alternate-issuer/issuer'
export function fetch(req, env) {
  const baseURL = env.BETTER_AUTH_URL
  const enrolled = issueAuth(env, baseURL)
  if (!env.WRONG_ISSUER) return enrolled.handler(req)
  return alternateIssuer({
    database: env.DB, secret: env.BETTER_AUTH_SECRET, baseURL,
    allowPublicSignup: false, trustedOrigins: [env.CORS_ORIGINS],
  }).handler(req)
}
`,
  )
  await core({
    refuses: /--env release\) failed:[\s\S]*mounted Better Auth cookie lacks provenance/,
    name: 'refuses a compatible cookie from another issuer',
  })
  // Mounted sign-in now succeeds, but another live branch still provisions an extra issuer.
  put(`${app}/wrangler.toml`, alternateFlag(''))
  await core(
    /Wrangler release includes an extra Better Auth issuer: .*alternate-issuer\/issuer\.ts/,
  )

  put(
    `${app}/src/configured-issuer.ts`,
    "export function createBetterAuth() { throw new Error('wrong configured issuer') }\n",
  )
  put(
    `${app}/wrangler.toml`,
    `${workerConfig}\n[alias]\n"@kit/auth/factory" = "./src/configured-issuer.ts"\n`,
  )
  await core(/Wrangler build did not resolve the enrolled composition to the installed Kit factory/)

  put(
    `${app}/src/configured-better-auth.ts`,
    "export function betterAuth() { throw new Error('wrong configured Better Auth') }\n",
  )
  put(
    `${app}/wrangler.toml`,
    `${workerConfig}\n[alias]\n"better-auth/minimal" = "./src/configured-better-auth.ts"\n`,
  )
  await core(
    /Wrangler build resolved better-auth\/minimal outside the installed Better Auth package/,
  )
}

async function resolutionScenarios({ root, put, json, core, alternateIssuerPackage }: Workspace) {
  alternateIssuerPackage()

  // An unenrolled Worker may use the client and refer to the workspace issuer's types.
  put(`${app}/wrangler.toml`, workerConfig)
  put(`${app}/${wrapper}`, 'export {}\n')
  const unenrolled = {
    ...productManifest,
    dependencies: { '@fixture/alternate-issuer': 'workspace:*' },
  }
  json(`${app}/package.json`, unenrolled)
  put(
    `${app}/src/worker.ts`,
    `import type * as Issuer from '@fixture/alternate-issuer'
import { createAuthClient } from 'better-auth/client'
export default { fetch: () => Response.json(typeof createAuthClient) }
`,
  )
  await core({ omits: passed })

  // Only the named release entrypoint imports this key. Default package
  // resolution selects an inert module; Wrangler's configured alias selects the issuer.
  put(
    'packages/alternate-issuer/ordinary.ts',
    'export function alternateIssuer() { return { handler: () => new Response(null) } }\n',
  )
  put(
    `${app}/src/release.ts`,
    `import { alternateIssuer } from '@fixture/alternate-issuer/ordinary'
export default { fetch: (request, env) => alternateIssuer(env).handler(request) }
`,
  )
  const distinctRelease = `${workerConfig}\n[env.release]\nmain = "src/release.ts"\n[[env.release.d1_databases]]\n${database}`
  put(`${app}/wrangler.toml`, distinctRelease)
  await core({ omits: passed })
  put(
    `${app}/wrangler.toml`,
    `${distinctRelease}\n[alias]\n"@fixture/alternate-issuer/ordinary" = "../../packages/alternate-issuer/issuer.ts"\n`,
  )
  const missingDependency =
    /apps\/product-fixture: shipping Better Auth composition must declare better-auth directly/
  await core(missingDependency)

  // Resolution can also target a package export directly, with no shared wrapper.
  const aliasSource = '@fixture/alternate-issuer/ordinary'
  function useReleaseImport(source: string, name: string) {
    put(
      `${app}/src/release.ts`,
      `import { ${name} as selected } from ${JSON.stringify(source)}
export default { fetch: () => Response.json(typeof selected) }
`,
    )
  }
  function useReleaseAlias(entry: string) {
    put(
      `${app}/wrangler.toml`,
      `${distinctRelease}\n[alias]\n"${aliasSource}" = ${JSON.stringify(entry)}\n`,
    )
  }
  for (const [specifier, imported, error] of [
    ['better-auth/client', 'createAuthClient', undefined],
    ['better-auth', 'betterAuth', missingDependency],
    ['better-auth/minimal', 'betterAuth', missingDependency],
    ['@kit/auth/factory', 'createBetterAuth', missingDependency],
    ['better-auth', 'getBaseURL', undefined],
    ['@kit/auth/factory', 'hashVerificationIdentifier', undefined],
  ] as const) {
    useReleaseImport(aliasSource, imported)
    useReleaseAlias(Bun.resolveSync(specifier, join(root, app)))
    await core(error)
  }
  put(`${app}/wrangler.toml`, distinctRelease)
  for (const [specifier, helper] of [
    ['better-auth', 'getBaseURL'],
    ['@kit/auth/factory', 'hashVerificationIdentifier'],
  ] as const) {
    useReleaseImport(specifier, helper)
    await core()
  }

  function useNamespace(source: string, expression: string, helpers = '') {
    put(
      `${app}/src/release.ts`,
      `import * as sdk from ${JSON.stringify(source)}
type Namespace = typeof sdk
${helpers}
export default { fetch: () => Response.json(${expression}) }
`,
    )
  }
  for (const [specifier, helper] of [
    ['better-auth', 'getBaseURL'],
    ['@kit/auth/factory', 'hashVerificationIdentifier'],
  ] as const) {
    put(`${app}/wrangler.toml`, distinctRelease)
    useNamespace(specifier, `typeof sdk.${helper}`)
    await core()
    useReleaseAlias(Bun.resolveSync(specifier, join(root, app)))
    useNamespace(aliasSource, `typeof sdk[${JSON.stringify(helper)}]`)
    await core()
  }
  put(`${app}/wrangler.toml`, distinctRelease)
  useNamespace(
    'better-auth',
    'typeof sdk.getBaseURL + parameter({ betterAuth: 1 }) + local()',
    `function parameter(sdk) { return sdk.betterAuth }
function local() {
  { const { sdk } = { sdk: { betterAuth: 2 } }; return sdk.betterAuth }
}`,
  )
  await core()
  useReleaseAlias(Bun.resolveSync('@kit/auth/factory', join(root, app)))
  // With the Kit alias, statically reading the factory,
  // passing the namespace to another function or computing the key are all unsafe.
  for (const expression of [
    'typeof sdk.createBetterAuth',
    'Object.keys(sdk)',
    "sdk[new URL('https://example.invalid/get').pathname.slice(1)]",
  ]) {
    useNamespace(aliasSource, expression)
    await core(missingDependency)
  }

  // Transparent no_bundle source is emitted without an esbuild metafile.
  put(`${app}/src/plain-worker.mjs`, 'export default { fetch: () => new Response("unbundled") }\n')
  put(
    `${app}/wrangler.toml`,
    workerConfig.replace(
      'main = "src/worker.ts"',
      'main = "src/plain-worker.mjs"\nno_bundle = true',
    ),
  )
  await core({ omits: passed })

  // Prebuilding removes the dependency edge. An opaque input cannot certify no auth.
  const prebuiltSource = `${app}/build/inline-worker.ts`
  put(
    prebuiltSource,
    `import { betterAuth } from 'better-auth/minimal'
export default { fetch: (request) => betterAuth({}).handler(request) }
`,
  )
  const prebuilt = await Bun.build({
    entrypoints: [join(root, prebuiltSource)],
    outdir: join(root, app, 'dist'),
    naming: 'worker.mjs',
    target: 'node',
    minify: true,
  })
  assert.ok(prebuilt.success)
  assert.doesNotMatch(
    readFileSync(join(root, app, 'dist/worker.mjs'), 'utf8'),
    /\bfrom\s*['"]better-auth/,
  )
  const opaqueWorker =
    /Cannot inventory opaque Worker inputs.*outside dist\/build without build\.command/
  for (const noBundle of [false, true]) {
    put(
      `${app}/wrangler.toml`,
      workerConfig.replace(
        'main = "src/worker.ts"',
        `main = "dist/worker.mjs"\nno_bundle = ${noBundle}`,
      ),
    )
    await core(opaqueWorker)
  }
  const workspaceOutput = 'packages/alternate-issuer/dist/worker.mjs'
  mkdirSync(dirname(join(root, workspaceOutput)), { recursive: true })
  copyFileSync(join(root, app, 'dist/worker.mjs'), join(root, workspaceOutput))
  useReleaseImport(aliasSource, 'default')
  useReleaseAlias(join(root, workspaceOutput))
  await core(/Cannot inventory opaque Worker inputs: .* is a deployed workspace output/)
  put(`${app}/wrangler.toml`, `${workerConfig}\n[build]\ncommand = "touch build-ran"\n`)
  await core({
    refuses: opaqueWorker,
    after: () => assert.equal(existsSync(join(root, app, 'build-ran')), false),
  })
  put(`${app}/wrangler.toml`, workerConfig)

  // A runtime import of the same declared workspace cannot bypass enrollment.
  put(
    `${app}/src/worker.ts`,
    `import { alternateIssuer } from '@fixture/alternate-issuer'
export default { fetch: (request, env) => alternateIssuer(env).handler(request) }
`,
  )
  await core(missingDependency)
  json(`${app}/package.json`, {
    ...unenrolled,
    dependencies: { ...unenrolled.dependencies, 'better-auth': '*' },
  })
  await core(
    /kitBetterAuth must name the sole shipping createBetterAuth export.*runtime modules: none/,
  )

  // An installed wrapper's normal dist directory is not a first-party opaque build,
  // but a live edge from it to the server factory still requires enrollment.
  const installedWrapper = '@fixture/installed-issuer'
  const installedPath = `${app}/node_modules/${installedWrapper}`
  const installedDependencies = { [installedWrapper]: '1.0.0' }
  const wrapperDependencies = { 'better-auth': '*' }
  json(`${installedPath}/package.json`, {
    name: installedWrapper,
    exports: './dist/index.mjs',
    dependencies: wrapperDependencies,
  })
  json(`${app}/package.json`, { ...productManifest, dependencies: installedDependencies })
  json('bun.lock', {
    workspaces: {
      ...workspaces,
      [app]: { name: 'product-fixture', dependencies: installedDependencies },
    },
    packages: {
      ...packages,
      [installedWrapper]: [`${installedWrapper}@1.0.0`, '', { dependencies: wrapperDependencies }],
    },
  })
  put(
    `${installedPath}/dist/index.mjs`,
    `import { betterAuth } from 'better-auth'
export function issuer() { return betterAuth({}) }
`,
  )
  put(
    `${app}/src/worker.ts`,
    `import { issuer } from '${installedWrapper}'
export default { fetch: (request) => issuer().handler(request) }
`,
  )
  await core(missingDependency)

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
  await core(
    /multiple effective better-auth versions in bun.lock:\n0\.0\.1: packages\/nested-consumer\n\S+: apps\/product-fixture/,
  )
}
