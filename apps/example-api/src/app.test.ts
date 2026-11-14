import type { BetterAuthEnvSlice } from '@kit/auth'
import { assertRateLimit } from '@kit/auth/repos/rate-limit'
import { AppError } from '@kit/core'
import { createDb } from '@kit/db'
import { describe, expect, it } from 'vitest'
import { createApp } from './app'
import { schema } from './db/schema'
import { useSecureCookie } from './lib/session-env'
import { DEMO_EMAIL, DEMO_EMAIL_B, DEMO_PASSWORD, DEMO_PASSWORD_B } from './services/auth'
import { loginCookie, seedDemoEnv, sessionHeaders } from './test/api-fixture'
import { hashFixtureCredential } from './test/fixture-credential'
import { createMemoryEnv } from './test/memory-env'

const ORIGIN = 'http://localhost:5173'
/** Non-loopback SPA origin for staging/production env tests. */
const SPA_ORIGIN = 'https://app.example.com'

async function loginAs(
  app: ReturnType<typeof createApp>,
  env: ReturnType<typeof createMemoryEnv>,
  email: string,
  password: string,
) {
  await seedDemoEnv(env, { notes: true, environment: 'test' })
  return loginCookie(app, env, email, password, ORIGIN)
}

describe('createApp shipped entry — health & errors', () => {
  it('GET /health returns 200 with requestId', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const res = await app.request('/health', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      requestId: string
      environment: string
      allowPublicSignup?: boolean
      demoLogin?: { email: string; password: string; role: string }
    }
    expect(body.ok).toBe(true)
    expect(body.environment).toBe('test')
    expect(body.allowPublicSignup).toBe(false)
    expect(body.demoLogin).toEqual({
      email: 'staff@kit.local',
      password: 'demo-password-change-me',
      role: 'staff',
    })
    expect(body.requestId).toMatch(/^req_/)
    expect(res.headers.get('x-request-id')).toBe(body.requestId)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('GET /health exposes demoLogin only in development|test', async () => {
    const app = createApp()
    const staging = createMemoryEnv({
      ENVIRONMENT: 'staging',
      CORS_ORIGINS: SPA_ORIGIN,
    })
    const stagingRes = await app.request('/health', {}, staging)
    const stagingBody = (await stagingRes.json()) as {
      environment: string
      demoLogin?: unknown
    }
    expect(stagingBody.environment).toBe('staging')
    expect(stagingBody.demoLogin).toBeUndefined()

    const prod = createMemoryEnv({
      ENVIRONMENT: 'production',
      CORS_ORIGINS: SPA_ORIGIN,
    })
    const prodRes = await app.request('/health', {}, prod)
    const prodBody = (await prodRes.json()) as {
      environment: string
      demoLogin?: unknown
    }
    expect(prodBody.environment).toBe('production')
    expect(prodBody.demoLogin).toBeUndefined()
  })

  it('unknown route returns nested NOT_FOUND envelope', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const res = await app.request('/nope', {}, env)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string }; requestId: string }
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.requestId).toMatch(/^req_/)
    expect(res.headers.get('x-request-id')).toBe(body.requestId)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('ignores oversized or non-allowlisted client x-request-id', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const res = await app.request(
      '/health',
      { headers: { 'x-request-id': 'not-a-valid-id<script>' } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { requestId: string }
    expect(body.requestId).toMatch(/^req_/)
    expect(body.requestId).not.toContain('<')
  })

  it('POST /api/notes without auth returns nested UNAUTHORIZED', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const res = await app.request(
      '/api/notes',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      env,
    )
    expect(res.status).toBe(401)
    const body = (await res.json()) as {
      error: { code: string; message: string }
      requestId: string
    }
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(body.requestId).toMatch(/^req_/)
    expect(JSON.stringify(body)).not.toMatch(/stack/i)
  })

  it('POST /api/auth/sign-in/email with invalid body fails', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const res = await app.request(
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ email: 'not-an-email', password: 'x' }),
      },
      env,
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

describe('createApp dual auth + D1 + R2 (happy path)', () => {
  it('login → cookie session → GET /api/me succeeds', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookie = await loginAs(app, env, DEMO_EMAIL, DEMO_PASSWORD)

    const me = await app.request('/api/me', { headers: { cookie } }, env)
    expect(me.status).toBe(200)
    const meBody = (await me.json()) as {
      subject: string
      email?: string
      authMethod: string
      platformRole: string | null
      orgs: unknown[]
      requestId: string
    }
    expect(meBody.subject).toBe('user_demo')
    expect(meBody.authMethod).toBe('session')
    // seed-db maps kit demo admin → platform super_admin for catalogue ops
    expect(meBody.platformRole).toBe('super_admin')
    expect(Array.isArray(meBody.orgs)).toBe(true)
    expect(meBody.email).toBe(DEMO_EMAIL)
    expect(meBody.requestId).toMatch(/^req_/)
  })

  it('GET /api/me — staff has platformRole + membership orgs only', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookie = await loginAs(app, env, 'staff@kit.local', 'demo-password-change-me')

    const me = await app.request('/api/me', { headers: { cookie } }, env)
    expect(me.status).toBe(200)
    const body = (await me.json()) as {
      subject: string
      email?: string
      platformRole: string | null
      orgs: { id: string; slug: string; role: string }[]
    }
    expect(body.subject).toBe('user_staff')
    expect(body.email).toBe('staff@kit.local')
    expect(body.platformRole).toBe('staff')
    const slugs = body.orgs.map((o) => o.slug).sort()
    expect(slugs).toEqual(['acme', 'beta'])
    expect(body.orgs.find((o) => o.slug === 'acme')?.role).toBe('admin')
    expect(body.orgs.some((o) => o.slug === 'solo')).toBe(false)
  })

  it('GET /api/me — solo has null platformRole + org_solo only', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookie = await loginAs(app, env, 'solo@kit.local', 'demo-password-change-me')

    const me = await app.request('/api/me', { headers: { cookie } }, env)
    expect(me.status).toBe(200)
    const body = (await me.json()) as {
      subject: string
      platformRole: string | null
      orgs: { id: string; slug: string; role: string }[]
    }
    expect(body.subject).toBe('user_solo')
    expect(body.platformRole).toBeNull()
    expect(body.orgs).toHaveLength(1)
    expect(body.orgs[0]).toMatchObject({ id: 'org_solo', slug: 'solo', role: 'owner' })
  })

  it('GET /api/me — super_admin platformRole; me.orgs memberships only (not catalogue)', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookie = await loginAs(app, env, 'super@kit.local', 'demo-password-change-me')

    const me = await app.request('/api/me', { headers: { cookie } }, env)
    expect(me.status).toBe(200)
    const body = (await me.json()) as {
      subject: string
      platformRole: string | null
      orgs: { id: string }[]
    }
    expect(body.subject).toBe('user_super')
    expect(body.platformRole).toBe('super_admin')
    // super has no memberships in seed — orgs must not dump catalogue
    expect(body.orgs).toEqual([])

    const list = await app.request('/api/orgs', { headers: { cookie } }, env)
    expect(list.status).toBe(200)
    const listBody = (await list.json()) as { orgs: { id: string }[] }
    expect(listBody.orgs.length).toBeGreaterThan(0)
  })

  it('login with wrong password returns UNAUTHORIZED kit anti-enum envelope', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    await loginAs(app, env, DEMO_EMAIL, DEMO_PASSWORD)
    const bad = await app.request(
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ email: DEMO_EMAIL, password: 'wrong-password' }),
      },
      env,
    )
    expect(bad.status).toBe(401)
    const body = (await bad.json()) as {
      error: { code: string; message: string }
      requestId: string
    }
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(body.error.message).toBe('Invalid email or password')
    expect(body.requestId).toMatch(/^req_/)
    expect(bad.headers.get('set-cookie')).toBeNull()
  })

  it('login unknown email matches wrong-password wire envelope (anti-enum)', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    // Seed demo so wrong-password hits INVALID_PASSWORD (not USER_NOT_FOUND) at BA layer.
    await loginAs(app, env, DEMO_EMAIL, DEMO_PASSWORD)
    const unknown = await app.request(
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({
          email: 'nobody-anti-enum@kit.local',
          password: 'any-password-here',
        }),
      },
      env,
    )
    const wrong = await app.request(
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ email: DEMO_EMAIL, password: 'wrong-password' }),
      },
      env,
    )
    expect(unknown.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(unknown.headers.get('set-cookie')).toBeNull()
    expect(wrong.headers.get('set-cookie')).toBeNull()
    const u = (await unknown.json()) as {
      error: { code: string; message: string }
      requestId: string
    }
    const w = (await wrong.json()) as {
      error: { code: string; message: string }
      requestId: string
    }
    expect(u.error).toEqual(w.error)
    expect(u.error).toEqual({ code: 'UNAUTHORIZED', message: 'Invalid email or password' })
    expect(u.requestId).toMatch(/^req_/)
    expect(w.requestId).toMatch(/^req_/)
  })

  it('mint sk_ → Bearer GET /api/me succeeds; bad key 401; revoke works', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookie = await loginAs(app, env, DEMO_EMAIL, DEMO_PASSWORD)

    // BA-only: API keys are org-bound
    const orgRes = await app.request(
      '/api/orgs',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({
          name: 'Mint Org',
          slug: `mint-org-${crypto.randomUUID().slice(0, 8)}`,
        }),
      },
      env,
    )
    expect(orgRes.status).toBe(201)
    const { org } = (await orgRes.json()) as { org: { id: string } }

    const mint = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ organizationId: org.id, scopes: ['read', 'write', 'admin'] }),
      },
      env,
    )
    expect(mint.status).toBe(200)
    const minted = (await mint.json()) as { id: string; key: string; keyPrefix?: string }
    expect(minted.key.startsWith('sk_')).toBe(true)

    const me = await app.request(
      '/api/me',
      { headers: { authorization: `Bearer ${minted.key}` } },
      env,
    )
    expect(me.status).toBe(200)
    const meBody = (await me.json()) as { subject: string; authMethod: string }
    expect(meBody.subject).toBe('user_demo')
    expect(meBody.authMethod).toBe('api_key')

    // Cannot mint a new key with sk_ (session only)
    const chain = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${minted.key}`,
          'content-type': 'application/json',
        },
        body: '{}',
      },
      env,
    )
    expect(chain.status).toBe(403)

    const list = await app.request('/api/keys', { headers: { cookie } }, env)
    expect(list.status).toBe(200)
    const listed = (await list.json()) as {
      keys: { id: string; keyPrefix: string; revokedAt: number | null }[]
    }
    const meta = listed.keys.find((k) => k.id === minted.id)
    expect(meta?.revokedAt).toBeNull()
    expect(meta?.keyPrefix).toBe(minted.key.slice(0, 12))

    // Wrong hash same prefix → 401
    const fakeSamePrefix = `${minted.key.slice(0, 12)}${'0'.repeat(40)}`
    const wrongHash = await app.request(
      '/api/me',
      { headers: { authorization: `Bearer ${fakeSamePrefix}` } },
      env,
    )
    expect(wrongHash.status).toBe(401)

    const rev = await app.request(
      `/api/keys/${minted.id}`,
      { method: 'DELETE', headers: sessionHeaders(cookie, undefined, ORIGIN) },
      env,
    )
    expect(rev.status).toBe(200)

    const meAfter = await app.request(
      '/api/me',
      { headers: { authorization: `Bearer ${minted.key}` } },
      env,
    )
    expect(meAfter.status).toBe(401)

    const bad = await app.request(
      '/api/me',
      { headers: { authorization: 'Bearer sk_not_a_real_key_000000000000' } },
      env,
    )
    expect(bad.status).toBe(401)
    const badBody = (await bad.json()) as { error: { code: string }; requestId: string }
    expect(badBody.error.code).toBe('UNAUTHORIZED')
    expect(badBody.requestId).toMatch(/^req_/)
  })

  /**
   * The key must be **org-bound and otherwise valid**, so that the 401 can only come from
   * expiry. Minting without an organization used to be possible and this test did exactly
   * that — once `findKeyRecord` started denying NULL-org rows, the assertion still passed but
   * for the wrong reason and the expiry path stopped being exercised at all. Tenancy is seeded
   * so the org/membership re-check succeeds and expiry is the single remaining variable.
   */
  it('rejects expired API keys', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const { createDb } = await import('@kit/db')
    const { schema } = await import('./db/schema')
    const { mintApiKey } = await import('./services/auth')
    const { seedTenancyDemo } = await import('./seed/seed-tenancy')
    const db = createDb(env.DB, schema)
    await seedTenancyDemo(db, { environment: 'test', force: true }, hashFixtureCredential)

    // positive control: the same key, unexpired, authenticates
    const live = await mintApiKey(db, 'user_staff', {
      organizationId: 'org_acme',
      name: 'live',
      scopes: ['read', 'write', 'admin'],
    })
    const okRes = await app.request(
      '/api/me',
      { headers: { authorization: `Bearer ${live.key}` } },
      env,
    )
    expect(okRes.status, 'org-bound key must authenticate before expiry is tested').toBe(200)

    const minted = await mintApiKey(db, 'user_staff', {
      organizationId: 'org_acme',
      expiresAt: Date.now() - 1000,
      name: 'old',
      scopes: ['read', 'write', 'admin'],
    })
    const res = await app.request(
      '/api/me',
      { headers: { authorization: `Bearer ${minted.key}` } },
      env,
    )
    expect(res.status, 'expired key must be rejected').toBe(401)
  })

  it('mint refuses a missing organization (ADR-0003 D11, fail-closed)', async () => {
    const env = createMemoryEnv()
    const { createDb } = await import('@kit/db')
    const { schema } = await import('./db/schema')
    const { mintApiKey } = await import('./services/auth')
    const { seedTenancyDemo } = await import('./seed/seed-tenancy')
    const db = createDb(env.DB, schema)
    await seedTenancyDemo(db, { environment: 'test', force: true }, hashFixtureCredential)

    // No opt-in flag: omitting the organization is refused by the service itself, so a new
    // call site cannot recreate the subject-global key state D11 forbids.
    await expect(
      mintApiKey(db, 'user_staff', { name: 'no-org', scopes: ['read', 'write', 'admin'] }),
    ).rejects.toThrow(/organizationId is required/i)
  })

  it('cookie mutations require trusted Origin', async () => {
    const app = createApp()
    const env = createMemoryEnv({
      ENVIRONMENT: 'staging',
      CORS_ORIGINS: SPA_ORIGIN,
    })
    const db = createDb(env.DB as unknown as D1Database, schema)
    const { seedDemoDatabase } = await import('./seed/seed-db')
    await seedDemoDatabase(db, { notes: false, environment: 'test' }, hashFixtureCredential)
    const login = await app.request(
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: SPA_ORIGIN },
        body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
      },
      env,
    )
    expect(login.status).toBeLessThan(400)
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    expect(cookie).toMatch(/^__Secure-kit_session=/)

    const me = await app.request('/api/me', { headers: { cookie, Origin: SPA_ORIGIN } }, env)
    expect(me.status).toBe(200)

    const missing = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: '{}',
      },
      env,
    )
    expect(missing.status).toBe(403)
    const missingBody = (await missing.json()) as { error: { code: string; message: string } }
    expect(missingBody.error.code).toBe('FORBIDDEN')
    expect(missingBody.error.message).toMatch(/Origin required/)

    const evil = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          Origin: 'https://evil.example',
        },
        body: '{}',
      },
      env,
    )
    expect(evil.status).toBe(403)
  })

  it('Better Auth fails closed without secret in production', async () => {
    const app = createApp()
    const env = createMemoryEnv({
      ENVIRONMENT: 'production',
      CORS_ORIGINS: SPA_ORIGIN,
      BETTER_AUTH_SECRET: undefined,
    })
    delete (env as { BETTER_AUTH_SECRET?: string }).BETTER_AUTH_SECRET
    const res = await app.request('/health', {}, env)
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error?: { code?: string }; requestId?: string }
    expect(body.error?.code).toMatch(/INTERNAL/)
    expect(body.requestId).toBeTruthy()
  })

  it('health reports better-auth; legacy HMAC login path is not kit-owned', async () => {
    const app = createApp()
    const env = createMemoryEnv({ ALLOW_PUBLIC_SIGNUP: 'false' })
    const health = await app.request('/health', {}, env)
    expect(health.status).toBe(200)
    const h = (await health.json()) as {
      authAdapter?: string
      allowPublicSignup?: boolean
      demoLogin?: { email: string }
    }
    expect(h.authAdapter).toBe('better-auth')
    expect(h.allowPublicSignup).toBe(false)
    expect(h.demoLogin?.email).toMatch(/@kit\.local/)
  })

  it('GET /health allowPublicSignup follows ALLOW_PUBLIC_SIGNUP (default off)', async () => {
    const app = createApp()
    const off = await app.request('/health', {}, createMemoryEnv())
    expect(((await off.json()) as { allowPublicSignup: boolean }).allowPublicSignup).toBe(false)

    const on = await app.request(
      '/health',
      {},
      createMemoryEnv({
        ALLOW_PUBLIC_SIGNUP: 'true',
        ENVIRONMENT: 'production',
        CORS_ORIGINS: SPA_ORIGIN,
      }),
    )
    const onBody = (await on.json()) as { allowPublicSignup: boolean; demoLogin?: unknown }
    expect(onBody.allowPublicSignup).toBe(true)
    expect(onBody.demoLogin).toBeUndefined()
  })

  it('better-auth sign-up disabled by default; dual-path works after signup when allowed', async () => {
    const app = createApp()
    const baseEnv = {
      BETTER_AUTH_SECRET: 'test-better-auth-secret-at-least-32!!',
      BETTER_AUTH_URL: 'http://localhost:8787',
    }
    // Sign-up disabled
    const denied = await app.request(
      '/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({
          email: 'ba-new@kit.local',
          password: 'ba-password-change-me-1',
          name: 'BA User',
        }),
      },
      createMemoryEnv({ ...baseEnv, ALLOW_PUBLIC_SIGNUP: 'false' }),
    )
    expect(denied.status).toBe(403)
    const deniedBody = (await denied.json()) as { error?: { code?: string } }
    expect(deniedBody.error?.code).toBe('FORBIDDEN')

    // Sign-up allowed — exercise BA handler + session cookie + dual-path sk_
    const env = createMemoryEnv({ ...baseEnv, ALLOW_PUBLIC_SIGNUP: 'true' })
    const email = `ba-${crypto.randomUUID().slice(0, 8)}@kit.local`
    const password = 'ba-password-change-me-1'
    const signup = await app.request(
      '/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({ email, password, name: 'BA User' }),
      },
      env,
    )
    expect(signup.status, await signup.clone().text()).toBeLessThan(400)
    let cookie = signup.headers.get('set-cookie') ?? ''
    if (!(cookie.includes('kit_session') || cookie.toLowerCase().includes('session'))) {
      const signin = await app.request(
        '/api/auth/sign-in/email',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', Origin: 'http://localhost:5173' },
          body: JSON.stringify({ email, password }),
        },
        env,
      )
      expect(signin.status).toBeLessThan(400)
      cookie = signin.headers.get('set-cookie') ?? ''
    }
    expect(cookie.toLowerCase()).toMatch(/httponly/)
    expect(cookie).toMatch(/Path=\//i)

    const me = await app.request(
      '/api/me',
      { headers: { cookie, Origin: 'http://localhost:5173' } },
      env,
    )
    expect(me.status).toBe(200)
    const meBody = (await me.json()) as { subject?: string }
    expect(meBody.subject).toBeTruthy()

    // Multi-tenant: mint requires organizationId under BA adapter
    const orgRes = await app.request(
      '/api/orgs',
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({
          name: 'Key Org',
          slug: `key-org-${crypto.randomUUID().slice(0, 6)}`,
        }),
      },
      env,
    )
    expect(orgRes.status).toBe(201)
    const { org } = (await orgRes.json()) as { org: { id: string } }

    const mint = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({ organizationId: org.id, scopes: ['read', 'write', 'admin'] }),
      },
      env,
    )
    expect(mint.status).toBe(200)
    const { key } = (await mint.json()) as { key: string }
    const skMe = await app.request('/api/me', { headers: { authorization: `Bearer ${key}` } }, env)
    expect(skMe.status).toBe(200)
  })

  it('D1 notes CRUD + R2 attachment under demo/ prefix', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookie = await loginAs(app, env, DEMO_EMAIL, DEMO_PASSWORD)
    const auth = sessionHeaders(cookie, undefined, ORIGIN)

    const create = await app.request(
      '/api/notes',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          title: 'Kit note',
          body: 'hello d1',
          attachmentText: 'r2-payload-demo',
        }),
      },
      env,
    )
    expect(create.status).toBe(201)
    const created = (await create.json()) as {
      note: { id: string; title: string; body: string }
      requestId: string
    }
    expect(created.note.title).toBe('Kit note')
    expect(created.note.body).toBe('hello d1')
    expect(created.note.id).toBeTruthy()

    const list = await app.request('/api/notes', { headers: { cookie } }, env)
    expect(list.status).toBe(200)
    const listed = (await list.json()) as { notes: { id: string }[] }
    expect(listed.notes.some((n) => n.id === created.note.id)).toBe(true)

    const get = await app.request(`/api/notes/${created.note.id}`, { headers: { cookie } }, env)
    expect(get.status).toBe(200)
    const one = (await get.json()) as {
      note: { id: string; attachment: string | null }
    }
    expect(one.note.attachment).toBe('r2-payload-demo')

    const keys = env.BUCKET._keys?.() ?? []
    expect(keys.some((k) => k.startsWith(`demo/${created.note.id}/`))).toBe(true)
    expect(keys.every((k) => !k.startsWith('share/'))).toBe(true)

    const del = await app.request(
      `/api/notes/${created.note.id}`,
      {
        method: 'DELETE',
        headers: auth,
      },
      env,
    )
    expect(del.status).toBe(200)

    const listAfter = await app.request('/api/notes', { headers: { cookie } }, env)
    const after = (await listAfter.json()) as { notes: { id: string }[] }
    expect(after.notes.some((n) => n.id === created.note.id)).toBe(false)

    const missing = await app.request(
      '/api/notes/00000000-0000-4000-8000-000000000099',
      {
        headers: { cookie },
      },
      env,
    )
    expect(missing.status).toBe(404)
    const missingBody = (await missing.json()) as { error: { code: string } }
    expect(missingBody.error.code).toBe('NOT_FOUND')
  })

  it('useSecureCookie is false only for development|test', () => {
    const base: BetterAuthEnvSlice = {}
    expect(useSecureCookie({ ...base, ENVIRONMENT: 'development' })).toBe(false)
    expect(useSecureCookie({ ...base, ENVIRONMENT: 'test' })).toBe(false)
    expect(useSecureCookie({ ...base, ENVIRONMENT: 'production' })).toBe(true)
    expect(useSecureCookie({ ...base, ENVIRONMENT: 'staging' })).toBe(true)
    expect(useSecureCookie({ ...base })).toBe(true)
  })

  it('login sets Secure cookie outside development|test', async () => {
    const app = createApp()
    const env = createMemoryEnv({
      ENVIRONMENT: 'staging',
      CORS_ORIGINS: SPA_ORIGIN,
    })
    const { createDb } = await import('@kit/db')
    const { schema } = await import('./db/schema')
    const { seedDemoDatabase } = await import('./seed/seed-db')
    await seedDemoDatabase(createDb(env.DB, schema), { notes: false }, hashFixtureCredential)

    const login = await app.request(
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: SPA_ORIGIN },
        body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
      },
      env,
    )
    expect(login.status).toBe(200)
    const setCookie = login.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(/Secure/i)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/SameSite=Lax/i)
    expect(login.headers.get('strict-transport-security')).toMatch(/max-age/i)
    const cookie = setCookie.split(';')[0]!
    expect(cookie).toMatch(/^__Secure-kit_session=/)
  })

  it('logout via Better Auth sign-out clears session cookie', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookie = await loginAs(app, env, DEMO_EMAIL, DEMO_PASSWORD)
    const logout = await app.request(
      '/api/auth/sign-out',
      { method: 'POST', headers: sessionHeaders(cookie, undefined, ORIGIN) },
      env,
    )
    expect(logout.status).toBeLessThan(500)
    const clear = logout.headers.get('set-cookie') ?? ''
    // BA clears session cookie (Max-Age=0 or empty token)
    expect(clear.length + cookie.length).toBeGreaterThan(0)
    // After sign-out, re-using the old cookie must not authenticate
    const me = await app.request('/api/me', { headers: { cookie } }, env)
    expect(me.status).toBe(401)
  })

  it('CP-AUTH-DUAL: invalid Bearer wins over valid session cookie', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookie = await loginAs(app, env, DEMO_EMAIL, DEMO_PASSWORD)
    const res = await app.request(
      '/api/me',
      {
        headers: {
          cookie,
          authorization: 'Bearer sk_deadbeef0001dead',
        },
      },
      env,
    )
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('assertRateLimit throws AppError RATE_LIMITED with retryAfterSeconds', async () => {
    const env = createMemoryEnv()
    const db = createDb(env.DB as unknown as D1Database, schema)
    await assertRateLimit(db, 'unit:test', 2, 60_000)
    await assertRateLimit(db, 'unit:test', 2, 60_000)
    try {
      await assertRateLimit(db, 'unit:test', 2, 60_000)
      expect.fail('expected rate limit throw')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      const err = e as AppError
      expect(err.code).toBe('RATE_LIMITED')
      expect(err.status).toBe(429)
      const ra = (err.details as { retryAfterSeconds?: number })?.retryAfterSeconds
      expect(ra).toBeGreaterThanOrEqual(1)
      expect(ra).toBeLessThanOrEqual(60)
    }
  })

  it('login returns 429 after rate limit exceeded', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const db = createDb(env.DB as unknown as D1Database, schema)
    // Pre-fill the kit BA throttle's address bucket (avoids 20× BA auth in CI).
    const windowMs = 15 * 60 * 1000
    for (let i = 0; i < 20; i++) {
      await assertRateLimit(db, 'ba-auth:203.0.113.9', 20, windowMs)
    }
    const blocked = await app.request(
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: ORIGIN,
          'cf-connecting-ip': '203.0.113.9',
        },
        body: JSON.stringify({ email: 'nobody@example.com', password: 'x' }),
      },
      env,
    )
    expect(blocked.status).toBe(429)
    const body = (await blocked.json()) as { error: { code: string } }
    expect(body.error.code).toBe('RATE_LIMITED')
    // Floor window → Retry-After is remaining seconds (≤ 900).
    const ra = Number(blocked.headers.get('retry-after'))
    expect(ra).toBeGreaterThanOrEqual(1)
    expect(ra).toBeLessThanOrEqual(900)
  })

  it('mint returns 429 after rate limit exceeded', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookie = await loginAs(app, env, DEMO_EMAIL, DEMO_PASSWORD)
    const me = await app.request('/api/me', { headers: { cookie } }, env)
    const subject = ((await me.json()) as { subject: string }).subject
    const db = createDb(env.DB as unknown as D1Database, schema)
    const windowMs = 60 * 60 * 1000
    for (let i = 0; i < 30; i++) {
      await assertRateLimit(db, `mint:${subject}`, 30, windowMs)
    }
    const blocked = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ scopes: ['read', 'write', 'admin'] }),
      },
      env,
    )
    expect(blocked.status).toBe(429)
    const body = (await blocked.json()) as { error: { code: string } }
    expect(body.error.code).toBe('RATE_LIMITED')
    const raMint = Number(blocked.headers.get('retry-after'))
    expect(raMint).toBeGreaterThanOrEqual(1)
    expect(raMint).toBeLessThanOrEqual(3600)
  })

  it('demo email returns 429 after rate limit exceeded', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookie = await loginAs(app, env, DEMO_EMAIL, DEMO_PASSWORD)
    const me = await app.request('/api/me', { headers: { cookie } }, env)
    const subject = ((await me.json()) as { subject: string }).subject
    const db = createDb(env.DB as unknown as D1Database, schema)
    const windowMs = 60 * 60 * 1000
    for (let i = 0; i < 10; i++) {
      await assertRateLimit(db, `email:${subject}`, 10, windowMs)
    }
    const blocked = await app.request(
      '/api/demo/email',
      { method: 'POST', headers: sessionHeaders(cookie, undefined, ORIGIN), body: '{}' },
      env,
    )
    expect(blocked.status).toBe(429)
    const body = (await blocked.json()) as { error: { code: string } }
    expect(body.error.code).toBe('RATE_LIMITED')
    const raEmail = Number(blocked.headers.get('retry-after'))
    expect(raEmail).toBeGreaterThanOrEqual(1)
    expect(raEmail).toBeLessThanOrEqual(3600)
  })

  it('login does not auto-seed demo users in production', async () => {
    const app = createApp()
    const env = createMemoryEnv({
      ENVIRONMENT: 'production',
      BETTER_AUTH_SECRET: 'prod-better-auth-secret-at-least-32chars!',
      BETTER_AUTH_URL: 'https://api.example.com',
      CORS_ORIGINS: SPA_ORIGIN,
    })
    const login = await app.request(
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: SPA_ORIGIN },
        body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
      },
      env,
    )
    // No seed in production → BA rejects credentials (no kit UNAUTHORIZED envelope required)
    expect(login.status).toBeGreaterThanOrEqual(400)
    const text = await login.text()
    expect(text).not.toMatch(/SESSION_SECRET/i)
    expect(text).not.toMatch(/BETTER_AUTH_SECRET/i)
  })

  it('protected routes reject unauthenticated without per-handler requireAuth calls', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cases: { method: string; path: string; body?: string }[] = [
      { method: 'GET', path: '/api/me' },
      { method: 'GET', path: '/api/notes' },
      { method: 'GET', path: '/api/notes/fake-id' },
      { method: 'DELETE', path: '/api/notes/fake-id' },
      { method: 'POST', path: '/api/keys', body: '{}' },
      { method: 'POST', path: '/api/demo/email', body: '{}' },
    ]
    for (const { method, path, body } of cases) {
      const res = await app.request(
        path,
        {
          method,
          headers: body ? { 'content-type': 'application/json' } : undefined,
          body,
        },
        env,
      )
      expect(res.status, `${method} ${path}`).toBe(401)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe('UNAUTHORIZED')
    }
  })

  it('authed note create rejects empty title with VALIDATION_ERROR', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookie = await loginAs(app, env, DEMO_EMAIL, DEMO_PASSWORD)
    const res = await app.request(
      '/api/notes',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ title: '' }),
      },
      env,
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('GET /health in production requires CORS_ORIGINS', async () => {
    const app = createApp()
    const env = createMemoryEnv({
      ENVIRONMENT: 'production',
      BETTER_AUTH_SECRET: 'prod-better-auth-secret-at-least-32chars!',
      BETTER_AUTH_URL: 'https://api.example.com',
    })
    const res = await app.request('/health', {}, env)
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toMatch(/INTERNAL/)
  })

  it('CORS rejects unknown Origin (no reflect)', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const res = await app.request(
      '/health',
      {
        headers: {
          Origin: 'https://evil.example',
        },
      },
      env,
    )
    expect(res.status).toBe(200)
    const acao = res.headers.get('access-control-allow-origin')
    expect(acao).not.toBe('https://evil.example')
    expect(acao).toBeNull()

    const ok = await app.request('/health', { headers: { Origin: 'http://localhost:5173' } }, env)
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  })

  it('GET /api/modules returns demo enabled after dogfood seed (configured without remote)', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookie = await loginAs(app, env, DEMO_EMAIL, DEMO_PASSWORD)
    const res = await app.request('/api/modules', { headers: { cookie } }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      modules: { demo: { enabled: boolean; configured: boolean; configPath: string } }
    }
    // /api/modules.enabled ← platform.available; N0 seed makes demo available.
    expect(body.modules.demo).toMatchObject({
      enabled: true,
      configured: true,
      configPath: '/admin/modules',
    })
  })

  it('GET /api/modules rejects a client session without a platform role', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookie = await loginAs(app, env, 'solo@kit.local', 'demo-password-change-me')
    const res = await app.request('/api/modules', { headers: { cookie } }, env)
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('GET /api/modules rejects an org-bound API key', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookie = await loginAs(app, env, 'staff@kit.local', 'demo-password-change-me')
    const mint = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ organizationId: 'org_acme', scopes: ['read', 'write', 'admin'] }),
      },
      env,
    )
    expect(mint.status).toBe(200)
    const { key } = (await mint.json()) as { key: string }

    const denied = await app.request(
      '/api/modules',
      { headers: { authorization: `Bearer ${key}` } },
      env,
    )
    expect(denied.status).toBe(403)
    const body = (await denied.json()) as { error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('PATCH /api/modules/demo enables without remote integration', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookie = await loginAs(app, env, DEMO_EMAIL, DEMO_PASSWORD)
    const res = await app.request(
      '/api/modules/demo',
      {
        method: 'PATCH',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ enabled: true }),
      },
      env,
    )
    expect(res.status).toBe(200)
  })

  it('PATCH /api/modules/:id requires admin', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookieB = await loginAs(app, env, DEMO_EMAIL_B, DEMO_PASSWORD_B)
    const res = await app.request(
      '/api/modules/demo',
      {
        method: 'PATCH',
        headers: sessionHeaders(cookieB, undefined, ORIGIN),
        body: JSON.stringify({ enabled: false }),
      },
      env,
    )
    expect(res.status).toBe(403)
  })

  it('notes are subject-scoped (IDOR: B cannot read A note)', async () => {
    const app = createApp()
    const env = createMemoryEnv()

    const cookieA = await loginAs(app, env, DEMO_EMAIL, DEMO_PASSWORD)

    const created = await app.request(
      '/api/notes',
      {
        method: 'POST',
        headers: sessionHeaders(cookieA, undefined, ORIGIN),
        body: JSON.stringify({ title: 'A private', body: 'secret-to-a' }),
      },
      env,
    )
    expect(created.status).toBe(201)
    const noteId = ((await created.json()) as { note: { id: string } }).note.id

    const cookieB = await loginAs(app, env, DEMO_EMAIL_B, DEMO_PASSWORD_B)

    const listB = await app.request('/api/notes', { headers: { cookie: cookieB } }, env)
    expect(listB.status).toBe(200)
    const notesB = ((await listB.json()) as { notes: { id: string }[] }).notes
    expect(notesB.some((n) => n.id === noteId)).toBe(false)

    const getB = await app.request(`/api/notes/${noteId}`, { headers: { cookie: cookieB } }, env)
    expect(getB.status).toBe(404)
    const body = (await getB.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')

    const delB = await app.request(
      `/api/notes/${noteId}`,
      { method: 'DELETE', headers: sessionHeaders(cookieB, undefined, ORIGIN) },
      env,
    )
    expect(delB.status).toBe(404)

    const getA = await app.request(`/api/notes/${noteId}`, { headers: { cookie: cookieA } }, env)
    expect(getA.status).toBe(200)
  })
})
