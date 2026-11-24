import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { WorkerTarget } from './root-gate-better-auth-worker'

export type CredentialWrites = [sql: string, values: (string | number)[]][]
export type MountedProbe = {
  target: WorkerTarget
  dir: string
  wrangler: string
  wranglerCli: string
  kitFactory: string
  factoryPath: string
  snapshotPath: string
  scratch: string
  userId: string
  email: string
  password: string
  writes: CredentialWrites
  secret: string
}

type ProbeWorker = {
  applyD1Migrations(binding: 'DB'): Promise<void>
  getEnv(): Promise<{ DB: D1Database; BETTER_AUTH_URL?: string; CORS_ORIGINS?: string }>
}
type CreateTestHarness = (options: {
  workers: {
    configPath: string
    env?: string
    prebuiltWorkerDir: string
    vars: Record<string, string>
    secrets: Record<string, string>
  }[]
}) => {
  listen(): Promise<unknown>
  getWorker(): ProbeWorker
  fetch(url: string, init: RequestInit): Promise<Response>
  close(): Promise<void>
}

const proofHeader = 'x-root-fixture-issuer'
const fixtureClientOrigin = 'https://root-client.example.invalid'
const fixtureOrigin = 'https://root-fixture.example.invalid'

// This module exists in the disposable local build only. The existing factory, auth options,
// handler, routing and bindings remain real. Attest the exact cookie that the wrapped handler
// issued and resolved, not that a factory was imported, called, or otherwise reachable.
function proofModule(probe: MountedProbe, challenge: string) {
  const factory = JSON.stringify(probe.factoryPath)
  return `
import { createBetterAuth as realFactory } from ${factory}
import { resolveRequestSession } from ${JSON.stringify(probe.snapshotPath)}
export * from ${factory}
export function createBetterAuth(options) {
  const auth = realFactory(options)
  const handle = auth.handler
  auth.fetch = auth.handler = async (request) => {
    const response = await handle(request)
    if (!response.ok || request.method !== 'POST' || new URL(request.url).pathname !== '/api/auth/sign-in/email') return response
    const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(';', 1)[0])
    const headers = new Headers({ cookie: cookies.join('; ') })
    const resolved = await resolveRequestSession({ db: options.database, auth, headers })
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
`
}

async function run(probe: MountedProbe) {
  const challenge = crypto.randomUUID()
  const alias = join(probe.scratch, 'issuer.ts')
  const build = join(probe.scratch, 'build')
  mkdirSync(build)
  writeFileSync(alias, proofModule(probe, challenge))
  const { target } = probe
  const bundled = spawnSync(
    process.execPath,
    [
      probe.wranglerCli,
      'deploy',
      '--dry-run',
      '--no-autoconfig',
      '--config',
      target.config,
      ...(target.env ? ['--env', target.env] : []),
      '--outdir',
      build,
      '--alias',
      `${probe.kitFactory}:${alias}`,
    ],
    { cwd: probe.dir, encoding: 'utf8', timeout: 60_000 },
  )
  if (bundled.error) throw bundled.error
  assert.equal(
    bundled.status,
    0,
    `Wrangler could not build the release entrypoint:\n${bundled.stdout}${bundled.stderr}`,
  )

  const { createTestHarness }: { createTestHarness: CreateTestHarness } = createRequire(
    probe.wrangler,
  )(probe.wrangler)
  const harness = createTestHarness({
    workers: [
      {
        configPath: target.config,
        env: target.env,
        prebuiltWorkerDir: build,
        // Credentials belong only to this in-memory local Worker.
        vars: { BETTER_AUTH_URL: fixtureOrigin, CORS_ORIGINS: fixtureClientOrigin },
        secrets: { BETTER_AUTH_SECRET: probe.secret },
      },
    ],
  })
  try {
    await harness.listen()
    const worker = harness.getWorker()
    await worker.applyD1Migrations('DB')
    const { DB, CORS_ORIGINS } = await worker.getEnv()
    assert.ok(
      CORS_ORIGINS === fixtureClientOrigin,
      'Wrangler did not install the fixture CORS_ORIGINS',
    )
    await DB.batch(probe.writes.map(([sql, values]) => DB.prepare(sql).bind(...values)))
    const response = await harness.fetch(`${fixtureOrigin}/api/auth/sign-in/email`, {
      method: 'POST',
      // Wrangler rewrites same-host URL headers when proxying to the local Workerd.
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
    const sessions = await DB.prepare('SELECT id, user_id, token FROM session').all<{
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
    await harness.close()
  }
}

// Wrangler's harness requires Node's Undici dispatcher for Worker HTTP; Root itself runs on Bun.
run(JSON.parse(readFileSync(0, 'utf8'))).catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
