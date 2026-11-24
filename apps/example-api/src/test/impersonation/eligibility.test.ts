import { meResponseSchema } from '@kit/api-client/me'
import { describe, expect, it } from 'vitest'
import { TENANCY_PASSWORD } from '../../seed/tenancy-data'
import { createSeededDemoApi, loginCookie, sessionHeaders } from '../api-fixture'

const ORG = 'org_acme'
const PERMISSIONS = '/api/admin/impersonation/permissions'

async function setup() {
  const ctx = await createSeededDemoApi({ seed: { environment: 'test', notes: false } })
  const superCookie = await loginCookie(ctx.app, ctx.env, 'super@kit.local', TENANCY_PASSWORD)
  const staffCookie = await loginCookie(ctx.app, ctx.env, 'staff@kit.local', TENANCY_PASSWORD)
  const targetCookie = await loginCookie(ctx.app, ctx.env, 'team-owner@kit.local', TENANCY_PASSWORD)
  const request = (cookie: string, path: string, method = 'GET', body?: object, fence = 'none') =>
    ctx.app.request(
      path,
      {
        method,
        headers: { ...sessionHeaders(cookie, ORG), 'X-Impersonation-Id': fence },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      ctx.env,
    )
  const grant = (read: boolean, write: boolean, role = 'staff') =>
    request(superCookie, PERMISSIONS, 'PATCH', { role, read, write })
  const start = (
    cookie: string,
    subjectUserId = 'user_team_owner',
    mode = 'read',
    organizationId = ORG,
  ) => request(cookie, '/api/impersonation/start', 'POST', { organizationId, subjectUserId, mode })
  return { ...ctx, superCookie, staffCookie, targetCookie, request, grant, start }
}

describe('impersonation eligibility', () => {
  it('defaults both permissions off and only a super administrator can configure them', async () => {
    const { request, superCookie, staffCookie, targetCookie, start } = await setup()
    const list = await request(superCookie, PERMISSIONS)
    expect(list.status).toBe(200)
    expect(((await list.json()) as { permissions: unknown[] }).permissions).toEqual(
      expect.arrayContaining([
        { role: 'staff', read: false, write: false },
        { role: 'super_admin', read: false, write: false },
      ]),
    )
    expect((await start(staffCookie)).status).toBe(403)
    for (const cookie of [staffCookie, targetCookie]) {
      expect((await request(cookie, PERMISSIONS)).status).toBe(403)
      expect(
        (await request(cookie, PERMISSIONS, 'PATCH', { role: 'staff', read: true, write: true }))
          .status,
      ).toBe(403)
    }
  })

  it('enforces independent read and write grants', async () => {
    const { grant, start, staffCookie, request } = await setup()
    expect((await grant(true, false)).status).toBe(200)
    expect((await start(staffCookie, 'user_team_owner', 'write')).status).toBe(403)
    const read = await start(staffCookie)
    expect(read.status).toBe(200)
    const { impersonation } = (await read.json()) as { impersonation: { id: string } }
    expect(
      (
        await request(
          staffCookie,
          '/api/impersonation/stop',
          'POST',
          { impersonationId: impersonation.id },
          impersonation.id,
        )
      ).status,
    ).toBe(200)
    expect((await grant(false, true)).status).toBe(200)
    expect((await start(staffCookie)).status).toBe(403)
    expect((await start(staffCookie, 'user_team_owner', 'write')).status).toBe(200)
  })

  it('requires both memberships and rejects privileged, self, and chained subjects', async () => {
    const { grant, start, superCookie, staffCookie, request } = await setup()
    expect((await grant(true, true)).status).toBe(200)
    expect((await grant(true, true, 'super_admin')).status).toBe(200)
    expect((await start(superCookie)).status).toBe(403)
    expect((await start(staffCookie, 'user_team_reader')).status).toBe(403)
    expect((await start(staffCookie, 'user_staff')).status).toBeGreaterThanOrEqual(400)
    expect((await start(staffCookie, 'user_super')).status).toBeGreaterThanOrEqual(400)
    const started = await start(staffCookie)
    expect(started.status).toBe(200)
    const { impersonation } = (await started.json()) as { impersonation: { id: string } }
    expect(
      (
        await request(
          staffCookie,
          '/api/impersonation/start',
          'POST',
          {
            organizationId: ORG,
            subjectUserId: 'user_team_reader',
            mode: 'read',
          },
          impersonation.id,
        )
      ).status,
    ).toBeGreaterThanOrEqual(400)
    expect(
      (
        await request(
          staffCookie,
          PERMISSIONS,
          'PATCH',
          { role: 'staff', read: true, write: true },
          impersonation.id,
        )
      ).status,
    ).toBe(403)
  })

  it('projects the target in only the pinned organization without affecting another actor session', async () => {
    const { app, env, grant, start, staffCookie, request } = await setup()
    const other = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD)
    expect((await grant(true, false)).status).toBe(200)
    const before = meResponseSchema.parse(await (await request(staffCookie, '/api/me')).json())
    expect(before.platformRole).toBe('staff')
    expect(before.impersonationPermissions).toEqual({ read: true, write: false })
    const started = await start(staffCookie)
    expect(started.status).toBe(200)
    const { impersonation } = (await started.json()) as { impersonation: { id: string } }
    const me = meResponseSchema.parse(await (await request(staffCookie, '/api/me')).json())
    expect(me.subject).toBe('user_team_owner')
    expect(me.platformRole).toBeNull()
    expect(me.impersonationPermissions).toEqual({ read: true, write: false })
    expect(me.orgs.map((org) => org.id)).toEqual([ORG])
    expect(me.impersonation).toMatchObject({
      id: impersonation.id,
      active: true,
      mode: 'read',
      organizationId: ORG,
      actor: { id: 'user_staff' },
      subject: { id: 'user_team_owner' },
    })
    expect(JSON.stringify(me.impersonation)).not.toMatch(/sessionId|token/i)
    const otherMe = meResponseSchema.parse(await (await request(other, '/api/me')).json())
    expect(otherMe.subject).toBe('user_staff')
    expect(otherMe.impersonation).toBeNull()
    expect(
      (await request(staffCookie, '/api/tasks', 'GET', undefined, impersonation.id)).status,
    ).toBe(200)
    expect(
      (
        await request(
          staffCookie,
          '/api/tasks',
          'POST',
          { title: 'Forbidden', boardKey: 'main', visibility: 'shared' },
          impersonation.id,
        )
      ).status,
    ).toBe(403)
  })
})
