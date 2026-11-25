import { auditEvents, baMember, impersonationSessions } from '@kit/auth/schema'
import { countD1RoundTrips } from '@kit/db/testing'
import { kitTaskStages, kitTasks } from '@kit/tasks/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { authorization } from '../../middleware/authorization'
import { onError } from '../../middleware/error-handler'
import { TENANCY_PASSWORD } from '../../seed/tenancy-data'
import { createSeededDemoApi, loginCookie, sessionHeaders } from '../api-fixture'

async function setup() {
  const ctx = await createSeededDemoApi({ seed: { environment: 'test', notes: false } })
  const admin = await loginCookie(ctx.app, ctx.env, 'super@kit.local', TENANCY_PASSWORD)
  const actor = await loginCookie(ctx.app, ctx.env, 'staff@kit.local', TENANCY_PASSWORD)
  const request = (cookie: string, path: string, method = 'GET', body?: object, fence?: string) =>
    ctx.app.request(
      path,
      {
        method,
        headers: {
          ...sessionHeaders(cookie, 'org_acme'),
          ...(fence === undefined ? {} : { 'X-Impersonation-Id': fence }),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      ctx.env,
    )
  expect(
    (
      await request(
        admin,
        '/api/admin/impersonation/permissions',
        'PATCH',
        { role: 'staff', read: true, write: true },
        'none',
      )
    ).status,
  ).toBe(200)
  const start = (mode: 'read' | 'write') =>
    request(
      actor,
      '/api/impersonation/start',
      'POST',
      { organizationId: 'org_acme', subjectUserId: 'user_team_owner', mode },
      'none',
    )
  const stop = (id: string) =>
    request(actor, '/api/impersonation/stop', 'POST', { impersonationId: id }, id)
  return { ...ctx, actor, request, start, stop }
}

const task = { title: 'Delegated action', boardKey: 'main', visibility: 'shared' }

describe('impersonation audit and request fencing', () => {
  it('records a write attempt with real actor, target, organization, path and request id', async () => {
    const { db, actor, request, start } = await setup()
    const started = await start('write')
    expect(started.status).toBe(200)
    const { impersonation } = (await started.json()) as { impersonation: { id: string } }
    const created = await request(actor, '/api/tasks', 'POST', task, impersonation.id)
    expect(created.status).toBe(201)
    const body = (await created.json()) as { task: { id: string }; requestId: string }
    const rows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'impersonation.request.attempt'))
    const audit = rows.find((row) => JSON.parse(row.metaJson ?? '{}').requestId === body.requestId)
    expect(audit).toMatchObject({
      actorUserId: 'user_staff',
      orgId: 'org_acme',
      targetType: 'impersonation_session',
      targetId: impersonation.id,
    })
    expect(JSON.parse(audit!.metaJson!)).toMatchObject({
      actorUserId: 'user_staff',
      subjectUserId: 'user_team_owner',
      organizationId: 'org_acme',
      method: 'POST',
      path: '/api/tasks',
      requestId: body.requestId,
    })
    const stored = await db.select().from(kitTasks).where(eq(kitTasks.id, body.task.id))
    expect(stored[0]).toMatchObject({ createdBy: 'user_team_owner', orgId: 'org_acme' })
  })

  it('audits a failed business action as an attempt, not a success', async () => {
    const { db, actor, request, start } = await setup()
    const started = await start('write')
    expect(started.status).toBe(200)
    const { impersonation } = (await started.json()) as { impersonation: { id: string } }
    const response = await request(
      actor,
      '/api/tasks/nonexistent',
      'DELETE',
      undefined,
      impersonation.id,
    )
    expect(response.status).toBe(404)
    const { requestId } = (await response.json()) as { requestId: string }
    const rows = await db.select().from(auditEvents)
    const recorded = rows.filter((row) => JSON.parse(row.metaJson ?? '{}').requestId === requestId)
    expect(recorded.some((row) => row.action === 'impersonation.request.attempt')).toBe(true)
    expect(recorded.some((row) => row.action === 'impersonation.request.success')).toBe(false)
  })

  it('does not expire a delegation based on its start time', async () => {
    const { db, actor, request, start } = await setup()
    const started = await start('read')
    expect(started.status).toBe(200)
    const { impersonation } = (await started.json()) as { impersonation: { id: string } }
    await db
      .update(impersonationSessions)
      .set({ createdAt: 1 })
      .where(eq(impersonationSessions.id, impersonation.id))
    expect((await request(actor, '/api/tasks', 'GET', undefined, impersonation.id)).status).toBe(
      200,
    )
    const me = await request(actor, '/api/me')
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ impersonation: { id: impersonation.id, startedAt: 1 } })
  })

  it('rolls back start when its mandatory audit insert fails', async () => {
    const { env, db, actor, request, start } = await setup()
    await env.DB.prepare(
      "CREATE TRIGGER reject_impersonation_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'impersonation.started' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    ).run()
    expect((await start('write')).status).toBeGreaterThanOrEqual(500)
    expect(await db.select().from(impersonationSessions)).toEqual([])
    const me = (await (await request(actor, '/api/me')).json()) as {
      subject: string
      impersonation: unknown
    }
    expect(me).toMatchObject({ subject: 'user_staff', impersonation: null })
  })

  it('fails closed before a business mutation but permits stop while audit is unavailable', async () => {
    const { app, env, db, actor, request, start, stop } = await setup()
    const observed = vi.fn()
    app.onError((err, c) => {
      observed(authorization.view(c), c.get('subject'), c.get('orgId'))
      return onError(err, c)
    })
    const started = await start('write')
    expect(started.status).toBe(200)
    const { impersonation } = (await started.json()) as { impersonation: { id: string } }
    await env.DB.prepare(
      "CREATE TRIGGER reject_impersonation_audit BEFORE INSERT ON audit_events WHEN NEW.action LIKE 'impersonation.%' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    ).run()
    const binding = env.DB
    const measured = countD1RoundTrips(binding)
    env.DB = measured.db
    try {
      const response = await request(actor, '/api/tasks', 'POST', task, impersonation.id)
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({
        error: { code: 'INTERNAL_ERROR', message: 'Internal error' },
      })
      expect(observed.mock.calls).toEqual([[{}, undefined, undefined]])
      // One Kit load + the failed audit write. No business handler read or write.
      expect(measured.count).toBe(2)
    } finally {
      env.DB = binding
    }
    expect(await db.select().from(kitTasks).where(eq(kitTasks.title, task.title))).toEqual([])
    expect((await stop(impersonation.id)).status).toBe(200)
    expect(await db.select().from(impersonationSessions)).toEqual([])
  })

  it.each(['read', 'write'] as const)(
    'does not lazily create board rows during delegated reads in %s mode',
    async (mode) => {
      const { db, actor, request, start } = await setup()
      await db
        .update(baMember)
        .set({ role: 'reader' })
        .where(eq(baMember.id, 'mem_org_acme_user_team_owner'))
      const started = await start(mode)
      expect(started.status).toBe(200)
      const { impersonation } = (await started.json()) as { impersonation: { id: string } }
      const before = await db.select().from(kitTaskStages)
      expect(
        (
          await request(
            actor,
            '/api/tasks/stages?boardKey=uninitialized',
            'GET',
            undefined,
            impersonation.id,
          )
        ).status,
      ).toBe(200)
      expect(await db.select().from(kitTaskStages)).toEqual(before)
    },
  )

  it('rejects missing, none and stale fences, including stale stop against a newer delegation', async () => {
    const { actor, request, start, stop } = await setup()
    const first = await start('write')
    expect(first.status).toBe(200)
    const { impersonation: old } = (await first.json()) as { impersonation: { id: string } }
    for (const fence of [undefined, 'none', 'old-id']) {
      expect((await request(actor, '/api/tasks', 'POST', task, fence)).status).toBe(409)
    }
    expect((await stop(old.id)).status).toBe(200)
    expect((await request(actor, '/api/tasks', 'POST', task, old.id)).status).toBe(409)
    const second = await start('write')
    expect(second.status).toBe(200)
    const { impersonation: current } = (await second.json()) as { impersonation: { id: string } }
    expect(current.id).not.toBe(old.id)
    expect((await stop(old.id)).status).toBe(409)
    expect((await request(actor, '/api/tasks', 'GET', undefined, current.id)).status).toBe(200)
  })
})
