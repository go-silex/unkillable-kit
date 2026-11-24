import { deleteGrant, findRoleByKey } from '@kit/auth/repos/org-roles'
import { upsertOrgModule, upsertPlatformModule } from '@kit/auth/repos/platform-modules'
import { countD1RoundTrips } from '@kit/db/testing'
import { TASKS_MODULE_ID } from '@kit/tasks'
import { expect, it, vi } from 'vitest'
import { requireModule, requireOrgContext } from '../middleware/org-context'
import { requireAuth } from '../middleware/require-auth'
import { TENANCY_PASSWORD } from '../seed/tenancy-data'
import { createSeededDemoApi, loginCookie, sessionHeaders } from './api-fixture'

it('batches Module admission and checks availability even for audited support', async () => {
  const { app, env, db } = await createSeededDemoApi({
    seed: { notes: false, environment: 'test' },
  })
  const stages = '/api/tasks/stages?boardKey=main'
  const supportPath = '/test/support/:orgId'
  const updatedAt = Date.now()
  await upsertOrgModule(db, {
    organizationId: 'org_solo',
    moduleId: TASKS_MODULE_ID,
    enabled: true,
    updatedAt,
  })
  app.get(
    supportPath,
    requireAuth,
    requireOrgContext({ allowSuperAdmin: true }),
    requireModule(TASKS_MODULE_ID),
    (c) => c.json({ bypass: c.get('orgBypass'), role: c.get('orgRole') ?? null }),
  )
  const staff = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD)
  const support = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD)

  const get = async (path: string, headers: HeadersInit, status: number, total: number) => {
    const measured = countD1RoundTrips(env.DB)
    const batch = vi.fn(measured.db.batch)
    const instrumented = new Proxy(measured.db, {
      get(target, key, receiver) {
        return key === 'batch' ? batch : Reflect.get(target, key, receiver)
      },
    })
    const response = await app.request(path, { headers }, { ...env, DB: instrumented })
    expect(response.status).toBe(status)
    expect(batch).toHaveBeenCalledTimes(1)
    expect(measured.count).toBe(total)
    return response
  }

  const staffHeaders = sessionHeaders(staff, 'org_acme')
  const supportHeaders = sessionHeaders(support)
  const response = await get(stages, staffHeaders, 200, 3)
  expect(await response.json()).toMatchObject({ stages: expect.any(Array) })
  const supportResponse = await get('/test/support/org_solo', supportHeaders, 200, 1)
  expect(await supportResponse.json()).toEqual({ bypass: true, role: null })

  const role = await findRoleByKey(db, 'org_acme', 'admin')
  expect(role).toBeDefined()
  expect(await deleteGrant(db, 'org_acme', role!.id, TASKS_MODULE_ID)).toBe(true)
  await get(stages, staffHeaders, 403, 1)

  await upsertPlatformModule(db, { moduleId: TASKS_MODULE_ID, available: false, updatedAt })
  await get(stages, staffHeaders, 404, 1)
  await get('/test/support/org_solo', supportHeaders, 404, 1)
})
