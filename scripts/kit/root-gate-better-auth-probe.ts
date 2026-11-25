import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { BetterAuthApp } from './root-gate-better-auth-apps'
import { type BundleInputs, bundleWorker } from './root-gate-better-auth-build.ts'
import { inspectStagedModules, inspectWranglerInputs } from './root-gate-better-auth-inventory.ts'
import type { WorkerTarget } from './root-gate-better-auth-worker'

export type CredentialWrites = [sql: string, values: (string | number)[]][]
export type MountedProbe = {
  target: WorkerTarget
  dir: string
  wrangler: string
  kitFactory: string
  installation: BetterAuthApp['installation']
  composition: string
  workspaceRoots: readonly string[]
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
const issuerCookiesHeader = 'x-root-fixture-issuer-cookies'
const replayCookiesHeader = 'x-root-fixture-replay-cookies'
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
    async function attest(cookies, cookieHeader) {
      const headers = new Headers({ cookie: cookieHeader })
      const resolved = await ${wrapper}_resolve({ db: options.database, auth, headers })
      if (!resolved) return
      const reference = await auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } })
      if (reference?.session.id !== resolved.sessionId || reference?.user.id !== resolved.subject || reference?.user.email !== resolved.email) return
      const payload = JSON.stringify([${JSON.stringify(challenge)}, cookies, resolved.subject, resolved.sessionId, resolved.email])
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload)))
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
    }
    auth.fetch = auth.handler = async (request) => {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/auth/sign-in/email') return handle(request)
      // Replay only inside the disposable fixture, without signing in a second time.
      const replay = request.headers.get(${JSON.stringify(replayCookiesHeader)})
      if (replay !== null && request.headers.get(${JSON.stringify(proofHeader)}) === ${JSON.stringify(challenge)}) {
        const digest = await attest(replay, replay)
        return digest ? new Response(null, { headers: { [${JSON.stringify(proofHeader)}]: digest } }) : new Response(null, { status: 401 })
      }
      const response = await handle(request)
      if (!response.ok) return response
      const cookies = response.headers.getSetCookie()
      const digest = await attest(cookies, cookies.map((cookie) => cookie.split(';', 1)[0]).join('; '))
      if (!digest) return response
      const proved = new Response(response.body, response)
      proved.headers.set(${JSON.stringify(issuerCookiesHeader)}, encodeURIComponent(JSON.stringify(cookies)))
      proved.headers.set(${JSON.stringify(proofHeader)}, digest)
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

function isBelow(root: string, file: string) {
  const path = relative(root, file)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function verifyBetterAuthResolution(probe: MountedProbe, inputs: BundleInputs, entrypoint: string) {
  const { kitRoot, betterAuthRoot } = probe.installation
  const pending = new Set([entrypoint])
  let foundServer = false
  for (const module of pending) {
    for (const entry of inputs[module]?.imports ?? []) {
      const specifier = entry.original ?? entry.path
      const file =
        !entry.external && inputs[entry.path] && realpathSync(resolve(probe.dir, entry.path))
      if (specifier === 'better-auth' || specifier.startsWith('better-auth/')) {
        assert.ok(
          file && isBelow(betterAuthRoot, file),
          `Wrangler build resolved ${specifier} outside the installed Better Auth package`,
        )
        foundServer ||= specifier === 'better-auth'
      } else if (file && isBelow(kitRoot, file)) {
        pending.add(entry.path)
      }
    }
  }
  assert.ok(
    foundServer,
    'Wrangler build did not include the Kit factory’s Better Auth server import',
  )
}

function verifyFactoryResolution(probe: MountedProbe, inputs: BundleInputs) {
  const enrolled = inputs[relative(probe.dir, probe.composition)]
  const factory = enrolled?.imports.find((entry) => entry.original === probe.kitFactory)
  assert.ok(
    factory &&
      !factory.external &&
      realpathSync(resolve(probe.dir, factory.path)) ===
        realpathSync(probe.installation.factoryPath),
    'Wrangler build did not resolve the enrolled composition to the installed Kit factory',
  )
  verifyBetterAuthResolution(probe, inputs, factory.path)
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

function cookiePair(field: string) {
  const trimOWS = (text: string) => text.replace(/^[ \t]+|[ \t]+$/g, '')
  const index = field.indexOf('=')
  return [
    trimOWS(index < 0 ? field : field.slice(0, index)),
    index < 0 ? null : trimOWS(field.slice(index + 1)),
  ] as const
}

function parseSetCookie(field: string) {
  const [pair, ...attributes] = field.split(';')
  const [name, value] = cookiePair(pair)
  assert.ok(
    value !== null && name.length > 0,
    'mounted Better Auth sent an invalid Set-Cookie field',
  )
  // Distinct attributes can be reordered. Preserve the order of repeated attributes (last wins).
  const attrs = new Map<string, (string | null)[]>()
  for (const part of attributes) {
    const [key, value] = cookiePair(part)
    if (!key) continue
    const attribute = key.toLowerCase()
    const values = attrs.get(attribute)
    if (values) values.push(value)
    else attrs.set(attribute, [value])
  }
  return { name, value, attrs }
}

function lookupName(name: string) {
  return name.replace(/^(?:__Secure-|__Host-)+/, '')
}

function chunkParent(name: string) {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return name
  const suffix = name.slice(dot + 1)
  const index = Number(suffix)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === suffix
    ? name.slice(0, dot)
    : name
}

function checkedMountedCookies(issuerFields: string[], mountedFields: string[]) {
  const issuer = new Map(
    issuerFields.map((field) => {
      const cookie = parseSetCookie(field)
      return [cookie.name, cookie] as const
    }),
  )
  assert.ok(issuer.size === issuerFields.length, 'enrolled Better Auth issued duplicate cookies')
  const families = new Set(
    [...issuer.keys()].flatMap((name) => {
      const logical = lookupName(name)
      return [logical, chunkParent(logical)]
    }),
  )
  const seen = new Set<string>()
  const mounted = mountedFields.map((field) => {
    const { name, value, attrs } = parseSetCookie(field)
    const expected = issuer.get(name)
    if (expected) {
      assert.ok(!seen.has(name), 'mounted Better Auth duplicated an issuer cookie')
      seen.add(name)
      assert.ok(
        value === expected.value &&
          attrs.size === expected.attrs.size &&
          [...attrs].every(([key, values]) => {
            const original = expected.attrs.get(key)
            return (
              original?.length === values.length &&
              values.every((value, i) => value === original[i])
            )
          }),
        'mounted Better Auth rewrote an issuer cookie',
      )
    } else {
      const logical = lookupName(name)
      assert.ok(
        !(families.has(logical) || families.has(chunkParent(logical))),
        'mounted Better Auth added a cookie in an issuer cookie family',
      )
    }
    return `${name}=${value}`
  })
  assert.ok(seen.size === issuer.size, 'mounted Better Auth omitted an issuer cookie')
  return mounted.join('; ')
}

async function run(probe: MountedProbe) {
  const challenge = crypto.randomUUID()
  const { target } = probe
  const { build, upload, emptyEnv, inputs, outputs } = bundleWorker(
    process.execPath,
    probe.wrangler,
    probe.dir,
    target,
    probe.scratch,
    installBuildHook(probe, challenge),
  )
  assert.ok(inputs && outputs, 'The enrolled issuer requires a Wrangler release input graph')
  verifyFactoryResolution(probe, inputs)
  const stagedIssuer = await inspectStagedModules(upload, build, probe.dir, target, outputs)
  const graphIssuer = inspectWranglerInputs(probe.dir, probe.workspaceRoots, inputs, outputs, {
    file: probe.composition,
    callee: probe.factoryCallee,
  })
  const extraIssuer = graphIssuer ?? stagedIssuer
  const requireFromWrangler = createRequire(probe.wrangler)
  const wrangler: Wrangler = requireFromWrangler(probe.wrangler)
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
    const signIn = (fixtureHeaders?: Record<string, string>) =>
      worker.fetch(`${fixtureOrigin}/api/auth/sign-in/email`, {
        method: 'POST',
        // Exercise the cross-origin HTTP path used by the Worker Apps.
        headers: {
          origin: fixtureClientOrigin,
          'content-type': 'application/json',
          ...fixtureHeaders,
        },
        body: JSON.stringify({ email: probe.email, password: probe.password, rememberMe: true }),
      })
    const response = await signIn()
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string }
      } | null
      const reason = body?.error?.message === 'Origin not allowed' ? ' (Origin not allowed)' : ''
      throw new Error(`mounted Better Auth sign-in failed: HTTP ${response.status}${reason}`)
    }
    await response.arrayBuffer()
    const sessions = await db.prepare('SELECT id, user_id, token FROM session').all<{
      id: string
      user_id: string
      token: string
    }>()
    assert.equal(sessions.results.length, 1, 'mounted Better Auth must create exactly one session')
    const [{ id, user_id, token }] = sessions.results
    assert.equal(user_id, probe.userId, 'mounted Better Auth signed in a different User')
    const digestFor = (cookies: string[] | string) =>
      createHash('sha256')
        .update(JSON.stringify([challenge, cookies, probe.userId, id, probe.email]))
        .digest('hex')
    const issuerProof = response.headers.get(issuerCookiesHeader)
    const issuerFields: unknown = issuerProof && JSON.parse(decodeURIComponent(issuerProof))
    assert.ok(
      Array.isArray(issuerFields) &&
        issuerFields.length > 0 &&
        issuerFields.every((field) => typeof field === 'string') &&
        response.headers.get(proofHeader) === digestFor(issuerFields),
      'mounted Better Auth cookie lacks provenance from the enrolled Kit issuer or did not resolve to the same session',
    )
    assert.ok(
      issuerFields.some((field) => {
        const { value } = parseSetCookie(field)
        return decodeURIComponent(value).startsWith(`${token}.`)
      }),
      'mounted Better Auth cookie must carry the persisted session token',
    )
    const mountedCookies = checkedMountedCookies(issuerFields, response.headers.getSetCookie())
    const replay = await signIn({ [proofHeader]: challenge, [replayCookiesHeader]: mountedCookies })
    await replay.arrayBuffer()
    assert.ok(
      replay.ok && replay.headers.get(proofHeader) === digestFor(mountedCookies),
      'mounted Better Auth cookies did not resolve to the same User and session through both readers',
    )
  } finally {
    await worker.dispose()
  }
  // A successful sign-in proves this request's issuer, not the absence of other issuers.
  if (extraIssuer)
    throw new Error(`Wrangler release includes an extra Better Auth issuer: ${extraIssuer}`)
}

// Miniflare needs Node's Undici dispatcher for Worker HTTP; Root itself runs on Bun.
run(JSON.parse(readFileSync(0, 'utf8'))).catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
