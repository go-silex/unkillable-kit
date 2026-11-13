import { isBaOrganizationRoute } from '@kit/auth'
import {
  BA_EMAIL_BUDGET_PATHS,
  BA_SESSION_ENDING_PATHS,
  BA_THROTTLE_LIMIT,
  BA_THROTTLE_WINDOW_MS,
  isBaThrottleExempt,
} from '@kit/auth/repos/ba-throttle'
import { assertRateLimit } from '@kit/auth/repos/rate-limit'
import { baSession, baUser, rateLimitBuckets } from '@kit/auth/schema'
import { createDb } from '@kit/db'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app'
import { schema } from './db/schema'
import type { Env } from './env'
import { createBetterAuth } from './lib/better-auth'
import type { KitDb } from './lib/db-type'
import { seedDemoDatabase } from './seed/seed-db'
import { DEMO_EMAIL, DEMO_PASSWORD } from './services/auth'
import { hashFixtureCredential } from './test/fixture-credential'
import { createMemoryEnv, type EnvLike } from './test/memory-env'

const ORIGIN = 'http://localhost:5173'

/** Secret, base URL and ENVIRONMENT come from `createMemoryEnv` defaults. */
const BA_OVERRIDES = {
  ALLOW_PUBLIC_SIGNUP: 'false',
  CORS_ORIGINS: ORIGIN,
  EMAIL_TRANSPORT: 'log',
}

/**
 * Better Auth endpoints whose body may name an e-mail but spend no e-mail budget, and why.
 * A new e-mail-bearing endpoint fails the enumeration until it is budgeted or listed here.
 */
const EMAIL_BODY_NOT_BUDGETED: Record<string, string> = {
  '/api/auth/sign-up/email': 'creates an account: no existing account budget to protect',
  '/api/auth/change-email': 'needs a session, so the session bucket binds; e-mail change is off',
  '/api/auth/update-user': 'needs a session, so the session bucket binds; it refuses an email key',
  '/api/auth/update-session': 'needs a session, so the session bucket binds',
}

/** Endpoints that name a sign-out or a revocation but still spend the session bucket, and why. */
const REVOKING_NOT_SESSION_ENDING: Record<string, string> = {
  '/api/auth/change-password': 'checks the current password first; revocation is an option of it',
}

type Endpoint = { path: string; methods: string[]; body: unknown }

/** Routed Better Auth endpoints, read off the instance (`auth.api`), never a hand list. */
function endpoints(env: EnvLike): Endpoint[] {
  // EnvLike is the in-memory stand-in for the Worker Env this factory reads.
  const workerEnv = env as unknown as Env
  const auth = createBetterAuth(workerEnv, 'http://localhost:8787')
  const out: Endpoint[] = []
  for (const e of Object.values<unknown>(auth.api)) {
    if (typeof e !== 'function' || !('path' in e) || typeof e.path !== 'string') continue
    if (!('options' in e) || typeof e.options !== 'object' || e.options === null) continue
    const method = 'method' in e.options ? e.options.method : undefined
    const methods = (Array.isArray(method) ? method : [method]).filter(
      (m): m is string => typeof m === 'string',
    )
    out.push({ path: e.path, methods, body: 'body' in e.options ? e.options.body : undefined })
  }
  return out
}

/** Body fields a schema kind is read through: wrappers, intersections and pipe inputs. */
const WRAPPER_FIELDS: Record<string, true> = { innerType: true, left: true, right: true, in: true }

type BodyKeys = { keys: string[]; opaque: boolean }

/**
 * Top-level keys of a zod body schema, read through optional, intersection, union and pipe.
 * `opaque` when a part has no fixed keys (a record, or a kind this walker does not read).
 */
function bodyKeys(schema: unknown): BodyKeys {
  if (schema === undefined) return { keys: [], opaque: false }
  if (typeof schema !== 'object' || schema === null) return { keys: [], opaque: true }
  if ('shape' in schema && typeof schema.shape === 'object' && schema.shape !== null) {
    return { keys: Object.keys(schema.shape), opaque: false }
  }
  const def = 'def' in schema && typeof schema.def === 'object' ? schema.def : null
  if (def === null) return { keys: [], opaque: true }
  const parts = Object.entries(def)
    .filter(([field]) => WRAPPER_FIELDS[field] === true)
    .map(([, part]) => part)
  if ('options' in def && Array.isArray(def.options)) parts.push(...def.options)
  if (parts.length === 0) return { keys: [], opaque: true }
  const read = parts.map(bodyKeys)
  return { keys: read.flatMap((r) => r.keys), opaque: read.some((r) => r.opaque) }
}

async function bucketCounts(db: KitDb): Promise<Record<string, number>> {
  const rows = await db.select().from(rateLimitBuckets)
  return Object.fromEntries(rows.map((r) => [r.bucketKey, r.count]))
}

function setup() {
  const app = createApp()
  const env = createMemoryEnv(BA_OVERRIDES)
  const db = createDb(env.DB as unknown as D1Database, schema)
  return { app, env, db }
}

function post(path: string, ip: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    Origin: ORIGIN,
    'cf-connecting-ip': ip,
  }
  if (cookie) headers.cookie = cookie
  return { url: `/api/auth${path}`, init: { method: 'POST', headers, body: JSON.stringify(body) } }
}

type Outcome = 'denied' | 'exempt' | 'throttled'

async function expectOutcome(res: Response, outcome: Outcome, where: string): Promise<void> {
  if (outcome === 'denied') {
    expect(res.status, where).toBe(404)
    return
  }
  if (outcome === 'exempt') {
    expect(res.status, where).not.toBe(429)
    return
  }
  expect(res.status, where).toBe(429)
  const body = (await res.json()) as { error: { code: string } }
  expect(body.error.code, where).toBe('RATE_LIMITED')
}

describe('Better Auth throttle — deny by default (Roxabi/roxabi-boilerplate-cf#394)', () => {
  it('a full address bucket 429s every Better Auth endpoint but the two session reads', async () => {
    const { app, env, db } = setup()
    const ip = '198.51.100.7'
    const all = endpoints(env)
    const routes = all.flatMap((e) => e.methods.map((m) => `${m} ${e.path}`))
    expect(routes).toContain('POST /verify-password')
    expect(routes).toContain('POST /sign-in/magic-link')
    expect(routes).toContain('GET /get-session')

    for (let i = 0; i < BA_THROTTLE_LIMIT; i++) {
      await assertRateLimit(db, `ba-auth:${ip}`, BA_THROTTLE_LIMIT, BA_THROTTLE_WINDOW_MS)
    }
    const cases = all.flatMap((e) =>
      e.methods.map((method) => {
        const pathname = `/api/auth${e.path.replace(/:[^/]+/g, 'x')}`
        let outcome: Outcome = 'throttled'
        if (e.path.startsWith('/organization/')) outcome = 'denied'
        else if (isBaThrottleExempt(method, pathname)) outcome = 'exempt'
        return { method, pathname, outcome }
      }),
    )
    for (const { method, pathname, outcome } of cases) {
      const hasBody = method !== 'GET' && method !== 'HEAD'
      const headers: Record<string, string> = { Origin: ORIGIN, 'cf-connecting-ip': ip }
      if (hasBody) headers['content-type'] = 'application/json'
      const init = { method, headers, body: hasBody ? '{}' : undefined }
      await expectOutcome(await app.request(pathname, init, env), outcome, `${method} ${pathname}`)
    }
    expect(cases.filter((c) => c.outcome === 'exempt')).toHaveLength(2)
    // Denied and exempt requests spent nothing; every throttled one spent exactly once.
    const throttled = cases.filter((c) => c.outcome === 'throttled').length
    expect((await bucketCounts(db))[`ba-auth:${ip}`]).toBe(BA_THROTTLE_LIMIT + throttled)
  })

  it('every endpoint whose body may name an e-mail spends the e-mail budget, or says why not', () => {
    const named = endpoints(createMemoryEnv(BA_OVERRIDES))
      .filter((e) => {
        const body = bodyKeys(e.body)
        return body.opaque || body.keys.some((k) => /email/i.test(k))
      })
      .map((e) => `/api/auth${e.path}`)
    // Both lists name only endpoints the walk finds: a stale entry, or a walk that stops reading
    // a body, fails here.
    expect(named).toEqual(expect.arrayContaining(Object.keys(BA_EMAIL_BUDGET_PATHS)))
    expect(named).toEqual(expect.arrayContaining(Object.keys(EMAIL_BODY_NOT_BUDGETED)))
    for (const path of named) {
      const covered =
        BA_EMAIL_BUDGET_PATHS[path] === true ||
        isBaOrganizationRoute(path) ||
        EMAIL_BODY_NOT_BUDGETED[path] !== undefined
      expect(covered, path).toBe(true)
    }
  })

  it('every endpoint that names a sign-out or a revocation skips the session bucket, or says why not', () => {
    const revoking = endpoints(createMemoryEnv(BA_OVERRIDES))
      .filter(
        (e) =>
          /sign-out|revoke/i.test(e.path) || bodyKeys(e.body).keys.some((k) => /revoke/i.test(k)),
      )
      .map((e) => `/api/auth${e.path}`)
    expect(revoking).toEqual(expect.arrayContaining(Object.keys(BA_SESSION_ENDING_PATHS)))
    expect(revoking).toEqual(expect.arrayContaining(Object.keys(REVOKING_NOT_SESSION_ENDING)))
    for (const path of revoking) {
      const covered =
        BA_SESSION_ENDING_PATHS[path] === true || REVOKING_NOT_SESSION_ENDING[path] !== undefined
      expect(covered, path).toBe(true)
    }
  })

  it('every Better Auth organization route answers the kit 404 and spends nothing', async () => {
    const { app, env, db } = setup()
    await seedDemoDatabase(db, { notes: false, environment: 'test' }, hashFixtureCredential)
    const signIn = post('/sign-in/email', '203.0.113.210', {
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
    })
    const cookie = (await app.request(signIn.url, signIn.init, env)).headers
      .get('set-cookie')
      ?.split(';')[0]
    expect(cookie).toBeTruthy()
    await db.delete(rateLimitBuckets)

    const org = endpoints(env).filter((e) => e.path.startsWith('/organization/'))
    // A verb list missed `set-active` and every read: the walk must see them.
    expect(org.map((e) => e.path)).toEqual(
      expect.arrayContaining([
        '/organization/create',
        '/organization/invite-member',
        '/organization/set-active',
        '/organization/list',
      ]),
    )
    const variants = [
      '/api/auth/ORGANIZATION/set-active',
      '/api/auth//organization/set-active',
      '/api/auth/organization',
    ]
    const targets = [
      ...org.flatMap((e) =>
        e.methods.map((method) => ({
          method,
          pathname: `/api/auth${e.path.replace(/:[^/]+/g, 'x')}`,
        })),
      ),
      ...variants.map((pathname) => ({ method: 'POST', pathname })),
    ]
    for (const { method, pathname } of targets) {
      const hasBody = method !== 'GET' && method !== 'HEAD'
      const headers: Record<string, string> = {
        Origin: ORIGIN,
        'cf-connecting-ip': '203.0.113.210',
        cookie: cookie!,
      }
      if (hasBody) headers['content-type'] = 'application/json'
      const res = await app.request(
        pathname,
        { method, headers, body: hasBody ? '{}' : undefined },
        env,
      )
      expect(res.status, `${method} ${pathname}`).toBe(404)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code, `${method} ${pathname}`).toBe('NOT_FOUND')
    }
    expect(await bucketCounts(db)).toEqual({})
  })

  it('one session from 21 addresses gets 429 on /verify-password, with Retry-After', async () => {
    const { app, env, db } = setup()
    await seedDemoDatabase(db, { notes: false, environment: 'test' }, hashFixtureCredential)
    const signIn = post('/sign-in/email', '203.0.113.200', {
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
    })
    const signed = await app.request(signIn.url, signIn.init, env)
    expect(signed.status).toBe(200)
    const cookie = signed.headers.get('set-cookie')?.split(';')[0]
    expect(cookie).toBeTruthy()

    const statuses: number[] = []
    let last: Response | undefined
    // Keep the freshly created session valid while all requests share one fixed window.
    const now = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(now)
      for (let n = 1; n <= BA_THROTTLE_LIMIT + 1; n++) {
        // Validation failures still spend the session budget before reaching Better Auth.
        const body = n === 1 || n === BA_THROTTLE_LIMIT + 1 ? { password: DEMO_PASSWORD } : {}
        const r = post('/verify-password', `198.51.100.${n}`, body, cookie)
        last = await app.request(r.url, r.init, env)
        statuses.push(last.status)
      }
    } finally {
      vi.useRealTimers()
    }
    expect(statuses).toEqual([200, ...Array(BA_THROTTLE_LIMIT - 1).fill(400), 429])
    expect(last?.status).toBe(429)
    const body = (await last?.json()) as { error: { code: string } }
    expect(body.error.code).toBe('RATE_LIMITED')
    const retryAfter = Number(last?.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(BA_THROTTLE_WINDOW_MS / 1000)

    const [user] = await db.select().from(baUser).where(eq(baUser.email, DEMO_EMAIL))
    const [session] = await db.select().from(baSession).where(eq(baSession.userId, user!.id))
    const counts = await bucketCounts(db)
    expect(counts[`ba-auth-session:${session!.id}`]).toBe(BA_THROTTLE_LIMIT + 1)
    expect(counts['ba-auth:198.51.100.21']).toBe(1)
  })

  it("the throttle's session lookup leaves the refresh, and its cookie, to Better Auth", async () => {
    const { app, env, db } = setup()
    await seedDemoDatabase(db, { notes: false, environment: 'test' }, hashFixtureCredential)
    const signIn = post('/sign-in/email', '203.0.113.201', {
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
    })
    const signed = await app.request(signIn.url, signIn.init, env)
    const cookie = signed.headers.get('set-cookie')?.split(';')[0] ?? ''
    const cookieName = cookie.split('=')[0]
    expect(cookieName).toBeTruthy()
    // Better Auth refreshes a session within `expiresIn - updateAge` (7 d - 1 d) of its expiry.
    const day = 24 * 60 * 60 * 1000
    await db.update(baSession).set({ expiresAt: new Date(Date.now() + 5 * day) })

    const res = await app.request(
      '/api/auth/list-sessions',
      { headers: { Origin: ORIGIN, 'cf-connecting-ip': '203.0.113.201', cookie } },
      env,
    )
    expect(res.status).toBe(200)
    // A refreshing lookup in the throttle would extend the row first and drop its cookie:
    // Better Auth would then see a fresh session and send none.
    expect(res.headers.get('set-cookie')).toContain(`${cookieName}=`)
    const [session] = await db.select().from(baSession)
    expect(session!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * day)
  })

  it('one e-mail budget across sign-in, magic link and reset, from rotating addresses', async () => {
    const { app, env, db } = setup()
    await seedDemoDatabase(db, { notes: false, environment: 'test' }, hashFixtureCredential)
    const victim = DEMO_EMAIL
    const sends = [
      (ip: string) => post('/sign-in/email', ip, { email: victim, password: 'x' }),
      (ip: string) => post('/sign-in/magic-link', ip, { email: victim.toUpperCase() }),
      (ip: string) =>
        post('/request-password-reset', ip, { email: victim, redirectTo: `${ORIGIN}/reset` }),
    ]
    for (let n = 1; n <= BA_THROTTLE_LIMIT; n++) {
      const r = sends[n % sends.length]!(`198.51.100.${n}`)
      const res = await app.request(r.url, r.init, env)
      expect(res.status, `attempt ${n}`).not.toBe(429)
    }
    const last = post('/sign-in/email', '198.51.100.99', { email: victim, password: 'x' })
    const blocked = await app.request(last.url, last.init, env)
    expect(blocked.status).toBe(429)

    const other = post('/sign-in/email', '198.51.100.100', {
      email: 'someone-else@example.com',
      password: 'x',
    })
    expect((await app.request(other.url, other.init, env)).status).not.toBe(429)
  })
})
