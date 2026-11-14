import * as orgRolesRepo from '@kit/auth/repos/org-roles'
import { baMember } from '@kit/auth/schema'
import { FLOWS_MODULE_ID } from '@kit/flows'
import { INVOKE_ONLY_PLAN_YAML } from '@kit/flows/run'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { sessionHeaders } from './test/api-fixture'
import {
  BOTH_ORGS,
  enableFlowsForOrgs,
  expectError,
  login,
  MEMBER_EMAIL,
  ORG_ACME,
  ORG_TEAM,
  STAFF_EMAIL,
  SUPER_EMAIL,
  seedFlowsApp,
  seedOperatorWriteOnAcme,
} from './test/flows-fixture'

async function listCaps(
  app: Awaited<ReturnType<typeof seedFlowsApp>>['app'],
  env: Awaited<ReturnType<typeof seedFlowsApp>>['env'],
  cookie: string,
  orgId: string,
) {
  const res = await app.request('/api/flows/plans', { headers: sessionHeaders(cookie, orgId) }, env)
  const body = (await res.json()) as {
    allowedOperations?: { setPlanEnabled: boolean; createPlan: boolean; createRun: boolean }
  }
  return { status: res.status, allowedOperations: body.allowedOperations }
}

function patchEnabled(
  app: Awaited<ReturnType<typeof seedFlowsApp>>['app'],
  env: Awaited<ReturnType<typeof seedFlowsApp>>['env'],
  cookie: string,
  orgId: string,
  planId: string,
  enabled: boolean,
) {
  return app.request(
    `/api/flows/plans/${planId}`,
    {
      method: 'PATCH',
      headers: sessionHeaders(cookie, orgId),
      body: JSON.stringify({ enabled }),
    },
    env,
  )
}

describe('GET /api/flows/plans allowedOperations', () => {
  it('matches PATCH and POST-run for admin; operator, read role, and super_admin operator stay denied', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const staffCookie = await login(app, env, STAFF_EMAIL)
    const created = await app.request(
      '/api/flows/plans',
      {
        method: 'POST',
        headers: sessionHeaders(staffCookie, ORG_ACME),
        body: JSON.stringify({ yaml: INVOKE_ONLY_PLAN_YAML }),
      },
      env,
    )
    expect(created.status).toBe(201)
    const planId = ((await created.json()) as { plan: { id: string } }).plan.id

    const admin = await listCaps(app, env, staffCookie, ORG_ACME)
    expect(admin.allowedOperations).toEqual({
      setPlanEnabled: true,
      createPlan: true,
      createRun: true,
    })
    expect(
      (
        await app.request(
          `/api/flows/plans/${planId}/runs`,
          { method: 'POST', headers: sessionHeaders(staffCookie, ORG_ACME), body: '{}' },
          env,
        )
      ).status,
    ).toBe(202)
    expect((await patchEnabled(app, env, staffCookie, ORG_ACME, planId, false)).status).toBe(200)

    await seedOperatorWriteOnAcme(db)
    const operatorCookie = await login(app, env, MEMBER_EMAIL)
    expect((await listCaps(app, env, operatorCookie, ORG_ACME)).allowedOperations).toEqual({
      setPlanEnabled: false,
      createPlan: false,
      createRun: false,
    })
    await expectError(
      await patchEnabled(app, env, operatorCookie, ORG_ACME, planId, true),
      403,
      'FORBIDDEN',
    )

    const auditorId = 'role_auditor_team'
    await orgRolesRepo.insertRole(db, {
      id: auditorId,
      organizationId: ORG_TEAM,
      key: 'auditor',
      name: 'Auditor',
      isSystem: false,
      createdAt: Date.now(),
    })
    await orgRolesRepo.upsertGrant(db, {
      organizationId: ORG_TEAM,
      roleId: auditorId,
      moduleId: FLOWS_MODULE_ID,
      access: 'read',
    })
    await db
      .update(baMember)
      .set({ role: 'auditor' })
      .where(eq(baMember.userId, 'user_team_reader'))
      .run()
    const readerCookie = await login(app, env, 'team-reader@kit.local')
    const reader = await listCaps(app, env, readerCookie, ORG_TEAM)
    expect(reader.status).toBe(200)
    expect(reader.allowedOperations).toEqual({
      setPlanEnabled: false,
      createPlan: false,
      createRun: false,
    })

    await db
      .insert(baMember)
      .values({
        id: 'mem_super_op',
        organizationId: ORG_ACME,
        userId: 'user_super',
        role: 'operator',
        createdAt: new Date(),
      })
      .run()
    const superCookie = await login(app, env, SUPER_EMAIL)
    expect((await listCaps(app, env, superCookie, ORG_ACME)).allowedOperations).toEqual({
      setPlanEnabled: false,
      createPlan: false,
      createRun: false,
    })
    await expectError(
      await patchEnabled(app, env, superCookie, ORG_ACME, planId, true),
      403,
      'FORBIDDEN',
    )
    await expectError(
      await app.request(
        `/api/flows/plans/${planId}/runs`,
        { method: 'POST', headers: sessionHeaders(superCookie, ORG_ACME), body: '{}' },
        env,
      ),
      403,
      'FORBIDDEN',
    )
    await expectError(
      await app.request(
        '/api/flows/plans',
        {
          method: 'POST',
          headers: sessionHeaders(superCookie, ORG_ACME),
          body: JSON.stringify({ yaml: INVOKE_ONLY_PLAN_YAML }),
        },
        env,
      ),
      403,
      'FORBIDDEN',
    )
  })

  it('super_admin with a flows read-only custom role gets no write operations', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const staffCookie = await login(app, env, STAFF_EMAIL)
    const created = await app.request(
      '/api/flows/plans',
      {
        method: 'POST',
        headers: sessionHeaders(staffCookie, ORG_ACME),
        body: JSON.stringify({ yaml: INVOKE_ONLY_PLAN_YAML }),
      },
      env,
    )
    expect(created.status).toBe(201)
    const planId = ((await created.json()) as { plan: { id: string } }).plan.id
    const roleId = 'role_auditor_acme'
    await orgRolesRepo.insertRole(db, {
      id: roleId,
      organizationId: ORG_ACME,
      key: 'auditor',
      name: 'Auditor',
      isSystem: false,
      createdAt: Date.now(),
    })
    await orgRolesRepo.upsertGrant(db, {
      organizationId: ORG_ACME,
      roleId,
      moduleId: FLOWS_MODULE_ID,
      access: 'read',
    })
    await db
      .insert(baMember)
      .values({
        id: 'mem_super_read',
        organizationId: ORG_ACME,
        userId: 'user_super',
        role: 'auditor',
        createdAt: new Date(),
      })
      .run()
    const superCookie = await login(app, env, SUPER_EMAIL)
    expect((await listCaps(app, env, superCookie, ORG_ACME)).allowedOperations).toEqual({
      setPlanEnabled: false,
      createPlan: false,
      createRun: false,
    })
    await expectError(
      await patchEnabled(app, env, superCookie, ORG_ACME, planId, false),
      403,
      'FORBIDDEN',
    )
  })
})
