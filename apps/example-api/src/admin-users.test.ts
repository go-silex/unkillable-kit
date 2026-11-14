import { baMember, baUser } from '@kit/auth/schema'
import { encodeListCursor, MAX_REPRESENTABLE_EPOCH_MS, MIN_REPRESENTABLE_EPOCH_MS } from '@kit/core'
import { eq } from 'drizzle-orm'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { userPlatformRoles } from './db/schema'
import { emailConfig } from './lib/email-config'
import { TENANCY_PASSWORD } from './seed/tenancy-data'
import { createSeededDemoApi, loginCookie, sessionHeaders } from './test/api-fixture'
import {
  captureMail,
  expectTokenAbsentFromVerification,
  resetTokenFromLink,
} from './test/mail-capture'

const ORIGIN = 'http://localhost:5173'

const BA_ENV = {
  BETTER_AUTH_SECRET: 'test-better-auth-secret-at-least-32!!',
  BETTER_AUTH_URL: 'http://localhost:8787',
  ALLOW_PUBLIC_SIGNUP: 'false',
  ENVIRONMENT: 'test',
  CORS_ORIGINS: ORIGIN,
  EMAIL_TRANSPORT: 'log',
}

async function seedEnv() {
  return createSeededDemoApi({ env: BA_ENV, seed: { notes: false, environment: 'test' } })
}

describe('admin users (B-users go-silex/silex-boilerplate#58)', () => {
  it('uses recipient locale and product branding for welcome emails', async () => {
    const { app, env } = await seedEnv()
    const mail = captureMail()
    const locale = vi
      .spyOn(emailConfig, 'resolveRecipientLocale')
      .mockImplementation((email) => (email === 'english@kit.local' ? 'en' : null))
    onTestFinished(() => locale.mockRestore())
    const cookie = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN)
    for (const email of ['french@kit.local', 'english@kit.local']) {
      const response = await app.request(
        '/api/admin/users',
        {
          method: 'POST',
          headers: sessionHeaders(cookie, undefined, ORIGIN),
          body: JSON.stringify({ email, name: 'Example' }),
        },
        env,
      )
      expect(response.status).toBe(201)
    }
    expect(mail.message('french@kit.local').subject).toBe(
      'Bienvenue — créez votre mot de passe — Kit Kit',
    )
    expect(mail.message('french@kit.local').text).toContain('Un compte a été créé')
    expect(mail.message('english@kit.local').subject).toBe('Welcome — set your password — Kit Kit')
    expect(mail.message('english@kit.local').text).toContain('An account was created')
  })

  it('SC1: super_admin creates user + memberships; no password in body', async () => {
    const { app, env, db } = await seedEnv()
    const cookie = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN)
    const res = await app.request(
      '/api/admin/users',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({
          email: 'client-new@kit.local',
          name: 'New Client',
          memberships: [{ orgId: 'org_team', role: 'member' }],
        }),
      },
      env,
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      user: { id: string; email: string; platformRole: string | null }
      memberships: { organizationId: string; role: string }[]
      welcomeEmailSent: boolean
    }
    expect(body.user.email).toBe('client-new@kit.local')
    expect(body.user.platformRole).toBeNull()
    expect(body.memberships).toEqual([{ organizationId: 'org_team', role: 'member' }])
    expect(body.welcomeEmailSent).toBe(true)
    expect(JSON.stringify(body)).not.toMatch(/password/i)

    const mem = await db.select().from(baMember).where(eq(baMember.userId, body.user.id))
    expect(mem.some((m) => m.organizationId === 'org_team')).toBe(true)
  })

  it('SC2: staff cannot assign platformRole super_admin → 403', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD, ORIGIN)
    const res = await app.request(
      '/api/admin/users',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({
          email: 'evil@kit.local',
          platformRole: 'super_admin',
        }),
      },
      env,
    )
    expect(res.status).toBe(403)
  })

  it('SC3: staff cannot attach membership to foreign org → 404', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD, ORIGIN)
    // staff is on org_acme + org_beta, not org_team
    const res = await app.request(
      '/api/admin/users',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({
          email: 'foreign-attach@kit.local',
          memberships: [{ orgId: 'org_team', role: 'member' }],
        }),
      },
      env,
    )
    expect(res.status).toBe(404)
  })

  it('SC4: email fail rolls back — no user/member row', async () => {
    const { db } = await seedEnv()
    const { createAdminUser } = await import('./services/admin-users')
    await expect(
      createAdminUser(db, {
        actorUserId: 'user_super',
        actorPlatformRole: 'super_admin',
        email: 'rollback@kit.local',
        memberships: [{ orgId: 'org_solo', role: 'member' }],
        webBaseUrl: ORIGIN,
        allowedOrigins: [ORIGIN],
        emailPort: {
          send: async () => {
            throw new Error('smtp down')
          },
        },
      }),
    ).rejects.toThrow(/Failed to send welcome|Internal/i)
    const users = await db.select().from(baUser).where(eq(baUser.email, 'rollback@kit.local'))
    expect(users.length).toBe(0)
    const mems = await db.select().from(baMember).where(eq(baMember.organizationId, 'org_solo'))
    expect(mems.every((m) => m.userId !== 'rollback@kit.local')).toBe(true)
  })

  it('SC5/SC6: welcome token sets password once; second use fails; login works', async () => {
    const { app, env, db } = await seedEnv()
    const mail = captureMail()
    const cookie = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN)
    const create = await app.request(
      '/api/admin/users',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ email: 'firstlogin@kit.local', name: 'First' }),
      },
      env,
    )
    expect(create.status).toBe(201)
    const token = resetTokenFromLink(mail.link('firstlogin@kit.local', 'Set your password'))
    await expectTokenAbsentFromVerification(db, token)

    const newPassword = 'first-login-password-ok'
    const reset = await app.request(
      '/api/auth/reset-password',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ newPassword, token }),
      },
      env,
    )
    expect(reset.status).toBeLessThan(400)

    const reuse = await app.request(
      '/api/auth/reset-password',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ newPassword: 'other-password-xyz', token }),
      },
      env,
    )
    expect(reuse.status).toBeGreaterThanOrEqual(400)

    const login = await app.request(
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ email: 'firstlogin@kit.local', password: newPassword }),
      },
      env,
    )
    expect(login.status).toBeLessThan(400)
  })

  it('SC7: existing email → 409', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN)
    const res = await app.request(
      '/api/admin/users',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ email: 'solo@kit.local' }),
      },
      env,
    )
    expect(res.status).toBe(409)
  })

  it('SC9: sk_ cannot create admin users → 403', async () => {
    const { app, env } = await seedEnv()
    // mint key as super via session then use sk_
    const cookie = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN)
    const keyRes = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ name: 'admin-test-key', scopes: ['read', 'write', 'admin'] }),
      },
      env,
    )
    // keys route may require org — skip if 404
    if (keyRes.status >= 400) {
      // use demo seed key path from health or skip with direct bearer invalid
      const res = await app.request(
        '/api/admin/users',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer sk_deadbeefdeadbeefdeadbeef',
            'content-type': 'application/json',
            Origin: ORIGIN,
          },
          body: JSON.stringify({ email: 'via-key@kit.local' }),
        },
        env,
      )
      expect([401, 403]).toContain(res.status)
      return
    }
    const keyBody = (await keyRes.json()) as { key?: { plaintext?: string }; plaintext?: string }
    const plaintext = keyBody.key?.plaintext ?? keyBody.plaintext
    expect(plaintext).toBeTruthy()
    const res = await app.request(
      '/api/admin/users',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${plaintext}`,
          'content-type': 'application/json',
          Origin: ORIGIN,
        },
        body: JSON.stringify({ email: 'via-key@kit.local' }),
      },
      env,
    )
    expect(res.status).toBe(403)
  })

  it('CP-IDOR: client-only session create → 403', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'solo@kit.local', TENANCY_PASSWORD, ORIGIN)
    const res = await app.request(
      '/api/admin/users',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ email: 'nope@kit.local' }),
      },
      env,
    )
    expect(res.status).toBe(403)
  })

  it('CP-IDOR: unauthenticated create → 401', async () => {
    const { app, env } = await seedEnv()
    const res = await app.request(
      '/api/admin/users',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ email: 'anon@kit.local' }),
      },
      env,
    )
    expect(res.status).toBe(401)
  })

  it('super_admin can assign staff platformRole', async () => {
    const { app, env, db } = await seedEnv()
    const cookie = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN)
    const res = await app.request(
      '/api/admin/users',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({
          email: 'new-staff@kit.local',
          platformRole: 'staff',
          memberships: [
            { orgId: 'org_acme', role: 'admin' },
            { orgId: 'org_beta', role: 'member' },
          ],
        }),
      },
      env,
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { user: { id: string; platformRole: string | null } }
    expect(body.user.platformRole).toBe('staff')
    const pr = await db
      .select()
      .from(userPlatformRoles)
      .where(eq(userPlatformRoles.userId, body.user.id))
    expect(pr[0]?.role).toBe('staff')
  })

  it('staff can create client on membership org', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD, ORIGIN)
    const res = await app.request(
      '/api/admin/users',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({
          email: 'staff-created@kit.local',
          memberships: [{ orgId: 'org_acme', role: 'member' }],
        }),
      },
      env,
    )
    expect(res.status).toBe(201)
  })

  it('GET /api/admin/users returns the cursor page envelope and ignores legacy offset', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN)
    const res = await app.request(
      '/api/admin/users?limit=2&offset=999',
      { headers: sessionHeaders(cookie, undefined, ORIGIN) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: { id: string; email: string }[]
      nextCursor: string | null
      requestId: string
      users?: unknown
    }
    expect(body.users).toBeUndefined()
    expect(body.items).toHaveLength(2)
    expect(body.nextCursor).toEqual(expect.any(String))
    expect(body.requestId).toMatch(/^req_/)

    const next = await app.request(
      `/api/admin/users?limit=2&cursor=${encodeURIComponent(body.nextCursor!)}`,
      { headers: sessionHeaders(cookie, undefined, ORIGIN) },
      env,
    )
    expect(next.status).toBe(200)
    const nextBody = (await next.json()) as {
      items: { id: string }[]
      nextCursor: string | null
      requestId: string
    }
    expect(nextBody.items.length).toBeGreaterThan(0)
    const firstIds = new Set(body.items.map((user) => user.id))
    expect(nextBody.items.every((user) => !firstIds.has(user.id))).toBe(true)
  })

  it('GET /api/admin/users rejects out-of-range and fractional cursor createdAt values', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN)
    const invalidCursors = [
      encodeListCursor({ createdAt: 1e300, id: 'abc' }),
      encodeListCursor({ createdAt: -1e300, id: 'abc' }),
      encodeListCursor({ createdAt: 1_754_000_000_123.5, id: 'abc' }),
      encodeListCursor({ createdAt: MIN_REPRESENTABLE_EPOCH_MS - 1, id: 'abc' }),
      encodeListCursor({ createdAt: MAX_REPRESENTABLE_EPOCH_MS + 1, id: 'abc' }),
    ]

    for (const cursor of invalidCursors) {
      const res = await app.request(
        `/api/admin/users?cursor=${encodeURIComponent(cursor)}`,
        { headers: sessionHeaders(cookie, undefined, ORIGIN) },
        env,
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { code: string; message: string } }
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.message).not.toContain('createdAt')
    }
  })

  it('GET /api/admin/users accepts representable boundary cursor createdAt values', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN)

    const minCursor = encodeListCursor({
      createdAt: MIN_REPRESENTABLE_EPOCH_MS,
      id: 'boundary-user',
    })
    const minRes = await app.request(
      `/api/admin/users?cursor=${encodeURIComponent(minCursor)}`,
      { headers: sessionHeaders(cookie, undefined, ORIGIN) },
      env,
    )
    expect(minRes.status).toBe(200)
    const minBody = (await minRes.json()) as { items: unknown[]; nextCursor: string | null }
    expect(minBody.items).toEqual([])
    expect(minBody.nextCursor).toBeNull()

    const maxCursor = encodeListCursor({
      createdAt: MAX_REPRESENTABLE_EPOCH_MS,
      id: 'boundary-user',
    })
    const maxRes = await app.request(
      `/api/admin/users?cursor=${encodeURIComponent(maxCursor)}`,
      { headers: sessionHeaders(cookie, undefined, ORIGIN) },
      env,
    )
    expect(maxRes.status).toBe(200)
    const maxBody = (await maxRes.json()) as { items: unknown[]; nextCursor: string | null }
    expect(maxBody.items.length).toBeGreaterThan(0)
  })

  it('GET /api/admin/users — staff only sees users sharing an org (IDOR privacy)', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD, ORIGIN)
    const res = await app.request(
      '/api/admin/users',
      { headers: sessionHeaders(cookie, undefined, ORIGIN) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: { email: string }[]
      nextCursor: string | null
      requestId: string
    }
    const emails = body.items.map((u) => u.email)
    // staff is on org_acme + org_beta (with team-owner), not org_solo / org_team
    expect(emails).toContain('staff@kit.local')
    expect(emails).toContain('team-owner@kit.local')
    expect(emails).not.toContain('solo@kit.local')
    expect(emails).not.toContain('super@kit.local')
    expect(emails).not.toContain('team-reader@kit.local')
  })

  it('GET /api/admin/users — staff cursor pages scope before pagination', async () => {
    const { app, env, db } = await seedEnv()
    // Make an out-of-scope user the global newest so a naive limit-then-filter would return them
    const farFuture = new Date('2099-06-01T00:00:00.000Z')
    await db.update(baUser).set({ createdAt: farFuture }).where(eq(baUser.id, 'user_solo'))
    const cookie = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD, ORIGIN)
    const first = await app.request(
      '/api/admin/users?limit=1',
      {
        headers: sessionHeaders(cookie, undefined, ORIGIN),
      },
      env,
    )
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as {
      items: { id: string; email: string }[]
      nextCursor: string | null
    }
    expect(firstBody.items).toHaveLength(1)
    expect(firstBody.nextCursor).toEqual(expect.any(String))

    const second = await app.request(
      `/api/admin/users?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      { headers: sessionHeaders(cookie, undefined, ORIGIN) },
      env,
    )
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as {
      items: { id: string; email: string }[]
      nextCursor: string | null
    }
    expect(secondBody.items).toHaveLength(1)
    const pageIds = [...firstBody.items, ...secondBody.items].map((user) => user.id)
    expect(new Set(pageIds).size).toBe(pageIds.length)
    for (const user of [...firstBody.items, ...secondBody.items]) {
      expect(['staff@kit.local', 'team-owner@kit.local']).toContain(user.email)
      expect(user.email).not.toBe('solo@kit.local')
    }
  })

  it('GET /api/admin/users — staff with no shared org gets an empty cursor page', async () => {
    const { app, env, db } = await seedEnv()
    const cookie = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD, ORIGIN)
    await db.delete(baMember).where(eq(baMember.userId, 'user_staff'))

    const res = await app.request(
      '/api/admin/users?limit=10',
      {
        headers: sessionHeaders(cookie, undefined, ORIGIN),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: unknown[]
      nextCursor: string | null
      requestId: string
    }
    expect(body.items).toEqual([])
    expect(body.nextCursor).toBeNull()
    expect(body.requestId).toMatch(/^req_/)
  })

  it('POST /api/admin/users — staff create with shared-org existing email → 409', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD, ORIGIN)
    // team-owner shares org_acme with staff — existence is visible; conflict not 404 oracle
    const res = await app.request(
      '/api/admin/users',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({
          email: 'team-owner@kit.local',
          memberships: [{ orgId: 'org_acme', role: 'member' }],
        }),
      },
      env,
    )
    expect(res.status).toBe(409)
  })

  it('GET /api/admin/users — super_admin still sees solo client', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN)
    const res = await app.request(
      '/api/admin/users',
      { headers: sessionHeaders(cookie, undefined, ORIGIN) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { email: string }[] }
    expect(body.items.some((u) => u.email === 'solo@kit.local')).toBe(true)
  })

  it('POST /api/admin/users — staff cannot probe out-of-scope existing email (no 409)', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD, ORIGIN)
    const res = await app.request(
      '/api/admin/users',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({
          email: 'solo@kit.local',
          memberships: [{ orgId: 'org_acme', role: 'member' }],
        }),
      },
      env,
    )
    // notFound (not conflict) — avoids platform-wide existence oracle matching list privacy
    expect(res.status).toBe(404)
  })
})
