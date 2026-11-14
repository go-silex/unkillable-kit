import { meResponseSchema } from '@kit/api-client/me'
import {
  apiKeys,
  baMember,
  baOrganization,
  baSession,
  organizationRoleModuleGrants,
  organizationRoles,
  userPlatformRoles,
} from '@kit/auth/schema'
import { TASKS_MODULE_ID } from '@kit/tasks'
import { kitTasks } from '@kit/tasks/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { TENANCY_PASSWORD } from '../../seed/tenancy-data'
import { bearerHeaders, createSeededDemoApi, loginCookie, sessionHeaders } from '../api-fixture'

async function setup() {
  const ctx = await createSeededDemoApi({ seed: { environment: 'test', notes: false } })
  const admin = await loginCookie(ctx.app, ctx.env, 'super@kit.local', TENANCY_PASSWORD)
  const actor = await loginCookie(ctx.app, ctx.env, 'staff@kit.local', TENANCY_PASSWORD)
  const request = (
    cookie: string,
    path: string,
    method = 'GET',
    body?: object,
    fence = 'none',
    extra: Record<string, string> = {},
  ) =>
    ctx.app.request(
      path,
      {
        method,
        headers: { ...sessionHeaders(cookie, 'org_acme'), 'X-Impersonation-Id': fence, ...extra },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      ctx.env,
    )
  const grant = (read: boolean, write: boolean) =>
    request(admin, '/api/admin/impersonation/permissions', 'PATCH', { role: 'staff', read, write })
  expect((await grant(true, true)).status).toBe(200)
  const started = await request(actor, '/api/impersonation/start', 'POST', {
    organizationId: 'org_acme',
    subjectUserId: 'user_team_owner',
    mode: 'write',
  })
  expect(started.status).toBe(200)
  const { impersonation } = (await started.json()) as { impersonation: { id: string } }
  return { ...ctx, actor, request, grant, id: impersonation.id }
}

describe('impersonation security boundaries', () => {
  it('denies credential, security, durable flow and personal surfaces even with a valid fence', async () => {
    const { app, env, db, actor, request, id } = await setup()
    const other = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD)
    const minted = await request(other, '/api/keys', 'POST', {
      name: 'separate session key',
      scopes: ['read', 'write', 'admin'],
    })
    expect(minted.status).toBe(200)
    const { key } = (await minted.json()) as { key: string }
    const keysBefore = await db.select().from(apiKeys)
    const cases: Array<[string, string, object | undefined]> = [
      ['GET', '/api/keys', undefined],
      ['POST', '/api/keys', { name: 'must-not-exist' }],
      [
        'POST',
        '/api/auth/change-password',
        { currentPassword: TENANCY_PASSWORD, newPassword: TENANCY_PASSWORD },
      ],
      [
        'GET',
        '/api/mcp-identity/ticket?resume=http%3A%2F%2F127.0.0.1%3A3333%2Fauthorize',
        undefined,
      ],
      ['GET', '/api/flows/runs', undefined],
      ['GET', '/api/items', undefined],
      ['GET', '/api/notes', undefined],
      ['POST', '/api/uploads/presign', { filename: 'x.txt', contentType: 'text/plain', size: 1 }],
      ['GET', '/api/orgs/org_acme/roles', undefined],
    ]
    for (const [method, path, body] of cases) {
      const response = await request(actor, path, method, body, id)
      expect(response.status, `${method} ${path}`).toBe(403)
      expect(response.headers.get('location') ?? '').not.toContain('mcp_identity_ticket')
    }
    expect(await db.select().from(apiKeys)).toEqual(keysBefore)
    const mixed = { authorization: ['Bearer', key].join(' ') }
    expect((await request(actor, '/api/tasks', 'GET', undefined, id, mixed)).status).toBe(403)
    expect(
      (await request(actor, '/api/auth/get-session', 'GET', undefined, id, mixed)).status,
    ).toBe(403)
  })

  it('rejects a retired context fence even with a valid bearer and no valid cookie', async () => {
    const { app, env, db, actor, request, id } = await setup()
    const other = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD)
    const minted = await request(other, '/api/keys', 'POST', {
      name: 'fence regression',
      scopes: ['read', 'write', 'admin'],
    })
    expect(minted.status).toBe(200)
    const { key } = (await minted.json()) as { key: string }
    expect(
      (await request(actor, '/api/impersonation/stop', 'POST', { impersonationId: id }, id)).status,
    ).toBe(200)
    const headers = bearerHeaders(key, 'org_acme')
    const baseline = await app.request('/api/me', { headers }, env)
    expect(baseline.status).toBe(200)
    expect(((await baseline.json()) as { subject: string }).subject).toBe('user_staff')
    const title = 'Retired context must not write'
    for (const cookie of [undefined, `${other}invalid`]) {
      const response = await app.request(
        '/api/tasks',
        {
          method: 'POST',
          headers: { ...headers, 'X-Impersonation-Id': id, ...(cookie ? { cookie } : {}) },
          body: JSON.stringify({ title, boardKey: 'main', visibility: 'shared' }),
        },
        env,
      )
      expect(response.status).toBe(409)
    }
    expect(await db.select().from(kitTasks).where(eq(kitTasks.title, title))).toEqual([])
  })

  it.each([
    'grant',
    'actor membership',
    'subject membership',
    'subject platform role',
    'organization status',
  ] as const)('keeps a revoked %s delegation in recovery until stop', async (reason) => {
    const { db, actor, request, grant, id } = await setup()
    if (reason === 'grant') expect((await grant(true, false)).status).toBe(200)
    if (reason === 'actor membership')
      await db
        .delete(baMember)
        .where(and(eq(baMember.organizationId, 'org_acme'), eq(baMember.userId, 'user_staff')))
    if (reason === 'subject membership')
      await db
        .delete(baMember)
        .where(and(eq(baMember.organizationId, 'org_acme'), eq(baMember.userId, 'user_team_owner')))
    if (reason === 'subject platform role')
      await db
        .insert(userPlatformRoles)
        .values({ userId: 'user_team_owner', role: 'staff', updatedAt: Date.now() })
    if (reason === 'organization status')
      await db
        .update(baOrganization)
        .set({ status: 'suspended' })
        .where(eq(baOrganization.id, 'org_acme'))
    const response = await request(actor, '/api/me')
    expect(response.status).toBe(200)
    const me = meResponseSchema.parse(await response.json())
    expect(me.subject).toBe('user_team_owner')
    expect(me.platformRole).toBeNull()
    expect(me.orgs).toEqual([])
    expect(me.impersonation).toMatchObject({
      id,
      active: false,
      subject: { id: 'user_team_owner' },
    })
    expect(me.impersonation?.subject.name).toBeUndefined()
    expect(me.impersonation?.subject.email).toBeUndefined()
    expect((await request(actor, '/api/tasks', 'GET', undefined, id)).status).toBe(403)
    expect(
      (await request(actor, '/api/impersonation/stop', 'POST', { impersonationId: id }, id)).status,
    ).toBe(200)
    const restored = meResponseSchema.parse(await (await request(actor, '/api/me')).json())
    expect(restored.subject).toBe('user_staff')
    expect(restored.impersonation).toBeNull()
  })
  it('uses the target role, visibility and live module grant rather than the actor privileges', async () => {
    const { app, env, db, actor, request, id } = await setup()
    const other = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD)
    const created = await request(other, '/api/tasks', 'POST', {
      title: 'Internal staff task',
      boardKey: 'main',
      visibility: 'internal',
    })
    expect(created.status).toBe(201)
    const { task } = (await created.json()) as { task: { id: string } }
    await db
      .update(baMember)
      .set({ role: 'reader' })
      .where(and(eq(baMember.organizationId, 'org_acme'), eq(baMember.userId, 'user_team_owner')))
    const me = meResponseSchema.parse(await (await request(actor, '/api/me')).json())
    expect(me.orgs[0]?.role).toBe('reader')
    const list = await request(actor, '/api/tasks', 'GET', undefined, id)
    expect(list.status).toBe(200)
    const body = (await list.json()) as { tasks: Array<{ id: string }> }
    expect(body.tasks.map((item) => item.id)).not.toContain(task.id)
    expect(
      (
        await request(
          actor,
          '/api/tasks',
          'POST',
          {
            title: 'Reader write',
            boardKey: 'main',
            visibility: 'shared',
          },
          id,
        )
      ).status,
    ).toBe(403)
    const roles = await db
      .select()
      .from(organizationRoles)
      .where(
        and(eq(organizationRoles.organizationId, 'org_acme'), eq(organizationRoles.key, 'reader')),
      )
    expect(roles).toHaveLength(1)
    await db
      .update(organizationRoleModuleGrants)
      .set({ access: 'disabled' })
      .where(
        and(
          eq(organizationRoleModuleGrants.roleId, roles[0]!.id),
          eq(organizationRoleModuleGrants.moduleId, TASKS_MODULE_ID),
        ),
      )
    expect((await request(actor, '/api/tasks', 'GET', undefined, id)).status).toBe(403)
  })

  it('returns 401 when the actual Better Auth session is invalid', async () => {
    const { db, actor, request, id } = await setup()
    await db.delete(baSession).where(eq(baSession.userId, 'user_staff'))
    expect((await request(actor, '/api/me')).status).toBe(401)
    expect((await request(actor, '/api/tasks', 'GET', undefined, id)).status).toBe(409)
    expect((await request(actor, '/api/tasks')).status).toBe(401)
  })
})
