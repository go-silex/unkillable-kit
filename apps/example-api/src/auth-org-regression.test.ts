import { apiKeys, baMember, baOrganization, userPlatformRoles } from '@kit/auth/schema'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { requireOrgContext } from './middleware/org-context'
import { requireAuth } from './middleware/require-auth'
import { TENANCY_PASSWORD } from './seed/tenancy-data'
import { mintApiKey } from './services/auth'
import {
  bearerHeaders,
  createApiTestContext,
  createSeededDemoApi,
  loginCookie,
  seedDemoEnv,
  sessionHeaders,
} from './test/api-fixture'

async function setup() {
  return createSeededDemoApi({ seed: { notes: false, environment: 'test' } })
}

describe('organization authorization HTTP regressions', () => {
  it('isolates alternating users and organizations in the same app', async () => {
    const { app, env } = await setup()
    const staff = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD)
    const solo = await loginCookie(app, env, 'solo@kit.local', TENANCY_PASSWORD)
    for (const [cookie, subject, orgId, role] of [
      [staff, 'user_staff', 'org_acme', 'admin'],
      [solo, 'user_solo', 'org_solo', 'owner'],
      [staff, 'user_staff', 'org_beta', 'member'],
      [solo, 'user_solo', 'org_solo', 'owner'],
    ]) {
      const me = await app.request('/api/me', { headers: sessionHeaders(cookie!) }, env)
      expect(me.status).toBe(200)
      expect(await me.json()).toMatchObject({ subject })
      const org = await app.request(
        `/api/orgs/${orgId}`,
        { headers: sessionHeaders(cookie!, orgId) },
        env,
      )
      expect(org.status).toBe(200)
      expect(await org.json()).toMatchObject({ org: { id: orgId, role } })
    }
    expect(
      (await app.request('/api/orgs/org_acme', { headers: sessionHeaders(solo) }, env)).status,
    ).toBe(404)
    expect(
      (await app.request('/api/orgs/org_solo', { headers: sessionHeaders(staff) }, env)).status,
    ).toBe(404)
  })

  it('does not distinguish a nonmember’s active, suspended or missing organization', async () => {
    const { app, env, db } = await setup()
    const staff = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD)
    const solo = await loginCookie(app, env, 'solo@kit.local', TENANCY_PASSWORD)
    const get = (cookie: string, id: string) =>
      app.request(`/api/orgs/${id}`, { headers: sessionHeaders(cookie) }, env)
    const active = await get(staff, 'org_solo')
    const missing = await get(staff, 'org_missing')
    expect(active.status).toBe(404)
    expect(missing.status).toBe(404)
    await db
      .update(baOrganization)
      .set({ status: 'suspended' })
      .where(eq(baOrganization.id, 'org_solo'))
    const suspended = await get(staff, 'org_solo')
    expect(suspended.status).toBe(404)
    const activeBody = (await active.json()) as { error: unknown }
    const missingBody = (await missing.json()) as { error: unknown }
    const suspendedBody = (await suspended.json()) as { error: unknown }
    expect(suspendedBody.error).toEqual(activeBody.error)
    expect(missingBody.error).toEqual(activeBody.error)
    expect((await get(solo, 'org_solo')).status).toBe(403)
  })

  it('observes membership, organization status and platform-role changes on the next request', async () => {
    const { app, env, db } = await setup()
    const staff = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD)
    const superAdmin = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD)
    const get = (cookie: string, id: string) =>
      app.request(`/api/orgs/${id}`, { headers: sessionHeaders(cookie) }, env)

    expect((await get(staff, 'org_acme')).status).toBe(200)
    await db
      .update(baOrganization)
      .set({ status: 'suspended' })
      .where(eq(baOrganization.id, 'org_acme'))
    expect((await get(staff, 'org_acme')).status).toBe(403)
    await db
      .update(baOrganization)
      .set({ status: 'active' })
      .where(eq(baOrganization.id, 'org_acme'))
    expect((await get(staff, 'org_acme')).status).toBe(200)
    await db.delete(baMember).where(eq(baMember.id, 'mem_org_acme_user_staff'))
    expect((await get(staff, 'org_acme')).status).toBe(404)

    expect((await get(superAdmin, 'org_solo')).status).toBe(200)
    await db.delete(userPlatformRoles).where(eq(userPlatformRoles.userId, 'user_super'))
    expect((await get(superAdmin, 'org_solo')).status).toBe(404)
  })

  it('rejects a real legacy unbound key after it previously authenticated', async () => {
    const { app, env, db } = createApiTestContext({
      through: '0014_better_auth_1_7_additive.sql',
    })
    await env.DB.exec('ALTER TABLE "user" ADD COLUMN "disabled" integer NOT NULL DEFAULT 0')
    await seedDemoEnv(env, { notes: false, environment: 'test' })
    const minted = await mintApiKey(db, 'user_staff', { organizationId: 'org_acme' })
    const headers = bearerHeaders(minted.key)
    expect((await app.request('/api/orgs/org_acme', { headers }, env)).status).toBe(200)
    await db.update(apiKeys).set({ organizationId: sql`NULL` }).where(eq(apiKeys.id, minted.id))
    expect((await app.request('/api/orgs/org_acme', { headers }, env)).status).toBe(401)
  })

  it('records a super-admin read bypass with actor and organization', async () => {
    const { app, env } = await setup()
    const cookie = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD)
    const log = vi.spyOn(console, 'info')
    try {
      const response = await app.request(
        '/api/orgs/org_solo',
        { headers: { ...sessionHeaders(cookie), 'x-request-id': 'req_auth532_read_bypass' } },
        env,
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as { requestId: string }
      expect(body.requestId).toBe('req_auth532_read_bypass')
      const records = log.mock.calls.map(([value]) => {
        try {
          return JSON.parse(String(value))
        } catch {
          return null
        }
      })
      expect(records).toContainEqual(
        expect.objectContaining({
          msg: 'super_admin_org_bypass',
          action: 'read',
          actor: 'user_super',
          orgId: 'org_solo',
          requestId: 'req_auth532_read_bypass',
        }),
      )
    } finally {
      log.mockRestore()
    }
  })

  it('requires explicit write opt-in and audits a break-glass write', async () => {
    const { app, env } = await setup()
    app.get('/test/read-opt-in', requireAuth, requireOrgContext({ allowSuperAdmin: true }), (c) =>
      c.json({ bypass: c.get('orgBypass') }),
    )
    app.post('/test/read-opt-in', requireAuth, requireOrgContext({ allowSuperAdmin: true }), (c) =>
      c.json({ bypass: c.get('orgBypass') }),
    )
    app.post(
      '/test/write-opt-in',
      requireAuth,
      requireOrgContext({ allowSuperAdminWrite: true }),
      (c) =>
        c.json({
          bypass: c.get('orgBypass'),
          orgId: c.get('orgId'),
          requestId: c.get('requestId'),
        }),
    )
    const superAdmin = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD)
    const staff = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD)
    const headers = sessionHeaders(superAdmin, 'org_solo')
    const read = await app.request('/test/read-opt-in', { headers }, env)
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ bypass: true })
    expect((await app.request('/test/read-opt-in', { method: 'POST', headers }, env)).status).toBe(
      403,
    )
    expect(
      (
        await app.request(
          '/test/write-opt-in',
          {
            method: 'POST',
            headers: sessionHeaders(staff, 'org_solo'),
          },
          env,
        )
      ).status,
    ).toBe(404)

    const log = vi.spyOn(console, 'info')
    try {
      const write = await app.request(
        '/test/write-opt-in',
        { method: 'POST', headers: { ...headers, 'x-request-id': 'req_auth532_write_bypass' } },
        env,
      )
      expect(write.status).toBe(200)
      const body = (await write.json()) as { bypass: boolean; orgId: string; requestId: string }
      expect(body).toMatchObject({ bypass: true, orgId: 'org_solo' })
      expect(body.requestId).toBe('req_auth532_write_bypass')
      const records = log.mock.calls.map(([value]) => {
        try {
          return JSON.parse(String(value))
        } catch {
          return null
        }
      })
      expect(records).toContainEqual(
        expect.objectContaining({
          msg: 'super_admin_org_bypass',
          action: 'write',
          actor: 'user_super',
          orgId: 'org_solo',
          requestId: 'req_auth532_write_bypass',
        }),
      )
    } finally {
      log.mockRestore()
    }
  })
})
