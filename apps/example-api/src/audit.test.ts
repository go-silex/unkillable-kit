import * as orgsRepo from '@kit/auth/repos/orgs'
import { encodeListCursor, MAX_REPRESENTABLE_EPOCH_MS, MIN_REPRESENTABLE_EPOCH_MS } from '@kit/core'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { auditEvents } from './db/schema'
import { TENANCY_PASSWORD } from './seed/tenancy-data'
import * as auditService from './services/audit'
import { createSeededDemoApi, loginCookie } from './test/api-fixture'

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

describe('audit (B-auth-harden go-silex/silex-boilerplate#61)', () => {
  it('sanitizeAuditMeta strips secrets and token URLs', () => {
    const clean = auditService.sanitizeAuditMeta('user.created', {
      emailDomain: 'example.com',
      password: 'secret',
      token: 'abc',
      setPasswordUrl: 'https://x/reset?token=evil',
      random: 'drop',
    })
    expect(clean).toEqual({ emailDomain: 'example.com' })
  })

  it('create user emits user.created + membership + optional platform_role', async () => {
    const { app, env, db } = await seedEnv()
    const cookie = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN)
    const email = `audit-user-${Date.now()}@example.com`
    const res = await app.request(
      '/api/admin/users',
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          Origin: ORIGIN,
        },
        body: JSON.stringify({
          email,
          platformRole: 'staff',
          memberships: [{ orgId: 'org_team', role: 'member' }],
        }),
      },
      env,
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { user: { id: string } }
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.targetId, body.user.id))
    const actions = rows.map((r) => r.action).sort()
    expect(actions).toContain('user.created')
    expect(actions).toContain('platform_role.set')
    expect(actions).toContain('membership.add')
    for (const r of rows) {
      if (r.metaJson) {
        expect(r.metaJson).not.toMatch(/password|token=/i)
      }
    }
  })

  it('first_login is idempotent across two sessions', async () => {
    const { app, env, db } = await seedEnv()
    await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN)
    await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN)
    const me = await app.request(
      '/api/me',
      {
        headers: {
          cookie: await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN),
        },
      },
      env,
    )
    const subject = ((await me.json()) as { subject: string }).subject
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.action, 'first_login'))
    const forUser = rows.filter((r) => r.targetId === subject)
    expect(forUser.length).toBe(1)
  })

  it('GET /api/admin/audit-events super_admin only', async () => {
    const { app, env } = await seedEnv()
    const superCookie = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN)
    const staffCookie = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD, ORIGIN)

    const ok = await app.request(
      '/api/admin/audit-events?limit=10',
      { headers: { cookie: superCookie } },
      env,
    )
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { items: unknown[]; requestId: string }
    expect(Array.isArray(body.items)).toBe(true)
    expect(body.requestId).toMatch(/^req_/)

    const forbidden = await app.request(
      '/api/admin/audit-events',
      { headers: { cookie: staffCookie } },
      env,
    )
    expect(forbidden.status).toBe(403)

    const unauth = await app.request('/api/admin/audit-events', {}, env)
    expect(unauth.status).toBe(401)
  })

  it('GET /api/admin/audit-events rejects an org-bound super_admin API key', async () => {
    const { app, env, db } = await seedEnv()
    const superCookie = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN)
    await orgsRepo.insertMember(db, {
      id: 'mem_super_acme_audit',
      organizationId: 'org_acme',
      userId: 'user_super',
      role: 'owner',
      createdAt: new Date(),
    })

    const mint = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: {
          cookie: superCookie,
          'content-type': 'application/json',
          Origin: ORIGIN,
        },
        body: JSON.stringify({ organizationId: 'org_acme', scopes: ['read', 'write', 'admin'] }),
      },
      env,
    )
    expect(mint.status).toBe(200)
    const { key } = (await mint.json()) as { key: string }

    const denied = await app.request(
      '/api/admin/audit-events',
      { headers: { authorization: `Bearer ${key}` } },
      env,
    )
    expect(denied.status).toBe(403)
    const body = (await denied.json()) as { error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')

    const ok = await app.request(
      '/api/admin/audit-events?limit=10',
      { headers: { cookie: superCookie } },
      env,
    )
    expect(ok.status).toBe(200)
  })

  it('GET /api/admin/audit-events returns an opaque two-page envelope without duplicate ids', async () => {
    const { app, env, db } = await seedEnv()
    const cookie = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN)
    const limit = 2
    await db.insert(auditEvents).values(
      Array.from({ length: limit + 1 }, (_, index) => ({
        id: `evt_cursor_${index}`,
        createdAt: 4_000_000_000_000 - index,
        actorUserId: 'user_super',
        action: 'user.updated',
        targetType: 'user',
        targetId: `user_cursor_${index}`,
      })),
    )

    const first = await app.request(
      `/api/admin/audit-events?limit=${limit}`,
      { headers: { cookie } },
      env,
    )
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as {
      items: { id: string }[]
      nextCursor: string | null
      requestId: string
    }
    expect(firstBody).toMatchObject({
      items: expect.any(Array),
      nextCursor: expect.any(String),
      requestId: expect.stringMatching(/^req_/),
    })
    expect(firstBody.items).toHaveLength(limit)
    expect(firstBody.nextCursor).not.toContain(':')

    const second = await app.request(
      `/api/admin/audit-events?limit=${limit}&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      { headers: { cookie } },
      env,
    )
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as {
      items: { id: string }[]
      nextCursor: string | null
      requestId: string
    }
    expect(secondBody.items.length).toBeGreaterThan(0)
    expect(secondBody.requestId).toMatch(/^req_/)
    const firstIds = new Set(firstBody.items.map((item) => item.id))
    expect(secondBody.items.every((item) => !firstIds.has(item.id))).toBe(true)
  })

  it('GET /api/admin/audit-events rejects a legacy createdAt:id cursor', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN)
    const res = await app.request(
      '/api/admin/audit-events?cursor=123456%3Aevt_x',
      { headers: { cookie } },
      env,
    )

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string }; requestId: string }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.requestId).toMatch(/^req_/)
  })

  it('GET /api/admin/audit-events rejects out-of-range and fractional cursor createdAt values', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN)
    const invalidCursors = [
      encodeListCursor({ createdAt: 1e300, id: 'evt_x' }),
      encodeListCursor({ createdAt: -1e300, id: 'evt_x' }),
      encodeListCursor({ createdAt: 1_754_000_000_123.5, id: 'evt_x' }),
      encodeListCursor({ createdAt: MIN_REPRESENTABLE_EPOCH_MS - 1, id: 'evt_x' }),
      encodeListCursor({ createdAt: MAX_REPRESENTABLE_EPOCH_MS + 1, id: 'evt_x' }),
    ]

    for (const cursor of invalidCursors) {
      const res = await app.request(
        `/api/admin/audit-events?cursor=${encodeURIComponent(cursor)}`,
        { headers: { cookie } },
        env,
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { code: string; message: string } }
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.message).not.toContain('createdAt')
    }
  })

  it('GET /api/admin/audit-events accepts representable boundary cursor createdAt values', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN)

    const minCursor = encodeListCursor({
      createdAt: MIN_REPRESENTABLE_EPOCH_MS,
      id: 'evt_boundary',
    })
    const minRes = await app.request(
      `/api/admin/audit-events?cursor=${encodeURIComponent(minCursor)}`,
      { headers: { cookie } },
      env,
    )
    expect(minRes.status).toBe(200)
    const minBody = (await minRes.json()) as { items: unknown[]; nextCursor: string | null }
    expect(minBody.items).toEqual([])
    expect(minBody.nextCursor).toBeNull()

    const maxCursor = encodeListCursor({
      createdAt: MAX_REPRESENTABLE_EPOCH_MS,
      id: 'evt_boundary',
    })
    const maxRes = await app.request(
      `/api/admin/audit-events?cursor=${encodeURIComponent(maxCursor)}`,
      { headers: { cookie } },
      env,
    )
    expect(maxRes.status).toBe(200)
    const maxBody = (await maxRes.json()) as { items: unknown[]; nextCursor: string | null }
    expect(maxBody.items.length).toBeGreaterThan(0)
  })

  it('appendAudit failure logs action+requestId and returns false', async () => {
    const { db } = await seedEnv()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const insertSpy = vi
      .spyOn(await import('@kit/auth/repos/audit'), 'insertAuditEvent')
      .mockRejectedValue(new Error('insert fail'))
    const ok = await auditService.appendAudit(db, {
      action: 'user.created',
      actorUserId: 'u1',
      targetId: 'u2',
      requestId: 'req_test_audit_fail',
    })
    expect(insertSpy).toHaveBeenCalledOnce()
    expect(ok).toBe(false)
    expect(spy).toHaveBeenCalled()
    const logged = String(spy.mock.calls[0]?.[0] ?? '')
    expect(logged).toContain('audit_append_failed')
    expect(logged).toContain('user.created')
    expect(logged).toContain('req_test_audit_fail')
    insertSpy.mockRestore()
    spy.mockRestore()
  })
})
