import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, parse, relative, resolve } from 'node:path'
import type { BetterAuthApp } from './root-gate-better-auth-apps'
import type { WorkerTarget } from './root-gate-better-auth-worker'

export type CredentialWrites = [sql: string, values: (string | number)[]][]
export type MountedProbe = {
  target: WorkerTarget
  dir: string
  wrangler: string
  kitFactory: string
  factoryPath: string
  composition: string
  factoryCallee: BetterAuthApp['factoryCallee']
  snapshotPath: string
  scratch: string
  userId: string
  email: string
  password: string
  writes: CredentialWrites
  secret: string
}

type LocalConfig = {
  build: Record<string, unknown>
  name: string
  d1_databases: { binding: string; migrations_dir?: string }[]
}
type Wrangler = {
  unstable_readConfig(options: { config: string; env?: string }): LocalConfig
  unstable_startWorker(options: {
    config: LocalConfig & {
      main: string
      base_dir: string
      no_bundle: true
      find_additional_modules: true
    }
    env?: string
    envFiles: string[]
    bindings: Record<string, { type: 'plain_text' | 'secret_text'; value: string }>
    dev: {
      server: { hostname: string; port: number }
      remote: false
      watch: false
      persist: false
      inspector: false
      inferOriginFromRoutes: false
      routeRequestsByRoutes: true
      outboundService: () => Response
    }
  }): Promise<LocalWorker>
  unstable_splitSqlQuery(sql: string): string[]
}
type LocalWorker = {
  ready: Promise<void>
  config: { name: string }
  raw: {
    runtimes: [{ mf?: { getD1Database(binding: string, worker: string): Promise<D1Database> } }]
  }
  fetch(url: string, init: RequestInit): Promise<Response>
  dispose(): Promise<void>
}

const proofHeader = 'x-root-fixture-issuer'
const fixtureClientOrigin = 'https://root-client.example.invalid'
const fixtureOrigin = 'https://root-fixture.example.invalid'

// Appended to the exact enrolled source in the disposable build. Only its original
// return call is wrapped; any other factory consumer still uses ordinary resolution.
function proofModule(probe: MountedProbe, challenge: string, wrapper: string) {
  return `
import { resolveRequestSession as ${wrapper}_resolve } from ${JSON.stringify(probe.snapshotPath)}
function ${wrapper}(factory) {
  return (options) => {
    const auth = factory(options)
    const handle = auth.handler
    auth.fetch = auth.handler = async (request) => {
      const response = await handle(request)
      if (!response.ok || request.method !== 'POST' || new URL(request.url).pathname !== '/api/auth/sign-in/email') return response
      const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(';', 1)[0])
      const headers = new Headers({ cookie: cookies.join('; ') })
      const resolved = await ${wrapper}_resolve({ db: options.database, auth, headers })
      if (!resolved) return response
      const reference = await auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } })
      if (reference?.session.id !== resolved.sessionId || reference?.user.id !== resolved.subject || reference?.user.email !== resolved.email) return response
      const payload = JSON.stringify([${JSON.stringify(challenge)}, cookies, resolved.subject, resolved.sessionId, resolved.email])
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload)))
      const proved = new Response(response.body, response)
      proved.headers.set(${JSON.stringify(proofHeader)}, Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''))
      return proved
    }
    return auth
  }
}
`
}

function installBuildHook(probe: MountedProbe, challenge: string) {
  const composition = JSON.stringify(probe.composition)
  const wrapper = `__root_gate_issuer_${challenge.replaceAll('-', '')}`
  const { start, end, hash } = probe.factoryCallee
  const hook = join(probe.scratch, 'instrument.cjs')
  // Patch only this CLI process's external esbuild module, before Wrangler requires it.
  // onLoad retains the source file's original directory and leaves all imports untouched.
  writeFileSync(
    hook,
    `
const { createHash } = require('node:crypto')
const { readFileSync, realpathSync } = require('node:fs')
const { createRequire } = require('node:module')
const { dirname, extname } = require('node:path')
const requireFromWrangler = createRequire(${JSON.stringify(probe.wrangler)})
const path = requireFromWrangler.resolve('esbuild')
const esbuild = requireFromWrangler(path)
const plugin = {
  name: 'root-gate-enrolled-issuer',
  setup(build) {
    build.onLoad({ filter: /\\.[cm]?[jt]sx?$/, namespace: 'file' }, ({ path }) => {
      if (realpathSync(path) !== ${composition}) return
      const source = readFileSync(path, 'utf8')
      if (createHash('sha256').update(source).digest('hex') !== ${JSON.stringify(hash)}) {
        throw new Error('Enrolled Better Auth source changed during the probe')
      }
      const callee = source.slice(${start}, ${end})
      const contents = source.slice(0, ${start}) + '${wrapper}(' + callee + ')' +
        source.slice(${end}) + ${JSON.stringify(proofModule(probe, challenge, wrapper))}
      const ext = extname(path)
      const loader = ext.endsWith('x') ? ext.slice(1) : ext.endsWith('ts') ? 'ts' : 'js'
      return { contents, loader, resolveDir: dirname(path) }
    })
  },
}
requireFromWrangler.cache[path].exports = {
  ...esbuild,
  build(options) {
    return esbuild.build({ ...options, plugins: [plugin, ...(options.plugins ?? [])] })
  },
}
`,
  )
  return hook
}

function verifyFactoryResolution(probe: MountedProbe, metafile: string) {
  const meta: {
    inputs: Record<string, { imports: { original?: string; path: string; external?: boolean }[] }>
  } = JSON.parse(readFileSync(metafile, 'utf8'))
  const enrolled = meta.inputs[relative(probe.dir, probe.composition)]
  const factory = enrolled?.imports.find((entry) => entry.original === probe.kitFactory)
  assert.ok(
    factory &&
      !factory.external &&
      realpathSync(resolve(probe.dir, factory.path)) === realpathSync(probe.factoryPath),
    'Wrangler build did not resolve the enrolled composition to the installed Kit factory',
  )
}

function bundleWorker(probe: MountedProbe, challenge: string) {
  const build = join(probe.scratch, 'build')
  const metafile = join(probe.scratch, 'bundle.json')
  const emptyEnv = join(probe.scratch, 'empty.env')
  const hook = installBuildHook(probe, challenge)
  mkdirSync(build)
  writeFileSync(emptyEnv, '')
  const { target } = probe
  const bundled = spawnSync(
    process.execPath,
    [
      '--require',
      hook,
      probe.wrangler,
      'deploy',
      '--dry-run',
      '--no-autoconfig',
      '--config',
      target.config,
      '--env-file',
      emptyEnv,
      ...(target.env ? ['--env', target.env] : []),
      '--outdir',
      build,
      '--metafile',
      metafile,
    ],
    { cwd: probe.dir, encoding: 'utf8', timeout: 60_000 },
  )
  if (bundled.error) throw bundled.error
  assert.equal(
    bundled.status,
    0,
    `Wrangler could not build the release entrypoint:\n${bundled.stdout}${bundled.stderr}`,
  )
  verifyFactoryResolution(probe, metafile)
  return { build, emptyEnv }
}

async function migrateDatabase(
  db: D1Database,
  directory: string,
  splitSql: Wrangler['unstable_splitSqlQuery'],
) {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  for (const file of files) {
    const statements = splitSql(readFileSync(join(directory, file), 'utf8'))
    await db.batch(statements.map((sql) => db.prepare(sql)))
  }
}

async function run(probe: MountedProbe) {
  const challenge = crypto.randomUUID()
  const { build, emptyEnv } = bundleWorker(probe, challenge)
  const requireFromWrangler = createRequire(probe.wrangler)
  const wrangler: Wrangler = requireFromWrangler(probe.wrangler)
  const { target } = probe
  const config = wrangler.unstable_readConfig({ config: target.config, env: target.env })
  const d1 = config.d1_databases.find(({ binding }) => binding === 'DB')
  assert.ok(d1, 'Release config does not declare the DB binding')
  const worker = await wrangler.unstable_startWorker({
    config: {
      ...config,
      main: join(build, `${parse(target.entry).name}.js`),
      base_dir: build,
      no_bundle: true,
      find_additional_modules: true,
      build: { ...config.build, command: undefined },
    },
    env: target.env,
    // Wrangler skips .dev.vars, including the named environment file, when envFiles is explicit.
    envFiles: [emptyEnv],
    bindings: {
      BETTER_AUTH_URL: { type: 'plain_text', value: fixtureOrigin },
      CORS_ORIGINS: { type: 'plain_text', value: fixtureClientOrigin },
      BETTER_AUTH_SECRET: { type: 'secret_text', value: probe.secret },
    },
    dev: {
      server: { hostname: '127.0.0.1', port: 0 },
      remote: false,
      watch: false,
      persist: false,
      inspector: false,
      inferOriginFromRoutes: false,
      routeRequestsByRoutes: true,
      outboundService: () => new Response(null, { status: 502 }),
    },
  })
  try {
    await worker.ready
    // Same local-runtime binding seam Wrangler's own test harness uses, but with explicit envFiles.
    const local = worker.raw.runtimes[0].mf
    assert.ok(local, 'Wrangler did not start a local Worker')
    const db = await local.getD1Database('DB', worker.config.name)
    await migrateDatabase(
      db,
      resolve(probe.dir, d1.migrations_dir ?? 'migrations'),
      wrangler.unstable_splitSqlQuery,
    )
    await db.batch(probe.writes.map(([sql, values]) => db.prepare(sql).bind(...values)))
    const response = await worker.fetch(`${fixtureOrigin}/api/auth/sign-in/email`, {
      method: 'POST',
      // Exercise the cross-origin HTTP path used by the Worker Apps.
      headers: { origin: fixtureClientOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ email: probe.email, password: probe.password, rememberMe: true }),
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string }
      } | null
      const reason = body?.error?.message === 'Origin not allowed' ? ' (Origin not allowed)' : ''
      throw new Error(`mounted Better Auth sign-in failed: HTTP ${response.status}${reason}`)
    }
    await response.arrayBuffer()
    const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(';', 1)[0])
    assert.ok(cookies.length, 'mounted Better Auth sign-in did not emit a cookie')
    const sessions = await db.prepare('SELECT id, user_id, token FROM session').all<{
      id: string
      user_id: string
      token: string
    }>()
    assert.equal(sessions.results.length, 1, 'mounted Better Auth must create exactly one session')
    const [{ id, user_id, token }] = sessions.results
    assert.equal(user_id, probe.userId, 'mounted Better Auth signed in a different User')
    assert.ok(
      cookies.some((cookie) =>
        decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)).startsWith(`${token}.`),
      ),
      'mounted Better Auth cookie must carry the persisted session token',
    )
    const expected = createHash('sha256')
      .update(JSON.stringify([challenge, cookies, probe.userId, id, probe.email]))
      .digest('hex')
    assert.ok(
      response.headers.get(proofHeader) === expected,
      'mounted Better Auth cookie lacks provenance from the enrolled Kit issuer or did not resolve to the same session',
    )
  } finally {
    await worker.dispose()
  }
}

// Miniflare needs Node's Undici dispatcher for Worker HTTP; Root itself runs on Bun.
run(JSON.parse(readFileSync(0, 'utf8'))).catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
