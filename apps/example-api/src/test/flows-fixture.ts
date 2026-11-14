import * as orgRolesRepo from '@kit/auth/repos/org-roles'
import { baMember } from '@kit/auth/schema'
import { FLOWS_MODULE_ID } from '@kit/flows'
import { and, eq } from 'drizzle-orm'
import { expect } from 'vitest'
import { flowPlans, flowRuns } from '../db/schema'
import type { KitDb } from '../lib/db-type'
import { TENANCY_PASSWORD } from '../seed/tenancy-data'
import { setOrgModuleEnabled, setPlatformAvailable } from '../services/platform-modules'
import {
  type ApiApp,
  type ApiEnv,
  createApiTestContext,
  createSeededDemoApi,
  loginCookie,
  sessionHeaders,
} from './api-fixture'

export const ORIGIN = 'http://localhost:5173'
export const ORG_ACME = 'org_acme'
export const ORG_TEAM = 'org_team'
export const STAFF_EMAIL = 'staff@kit.local'
export const MEMBER_EMAIL = 'team-owner@kit.local'
export const SUPER_EMAIL = 'super@kit.local'
export const BOTH_ORGS = [ORG_ACME, ORG_TEAM] as const
/** Custom org role key — write grant, not owner/admin (T18). */
const operator = 'operator'

/** T2 — platform available then org-enable. Seed does not enable flows. */
export async function enableFlowsForOrgs(db: KitDb, orgIds: readonly string[]) {
  await setPlatformAvailable(db, FLOWS_MODULE_ID, true)
  for (const orgId of orgIds) {
    await setOrgModuleEnabled(db, orgId, FLOWS_MODULE_ID, true)
  }
}

export function freshApp() {
  const { app, env } = createApiTestContext()
  return { app, env }
}

export async function seedFlowsApp() {
  return createSeededDemoApi({ seed: { notes: true, environment: 'test' } })
}

export async function login(app: ApiApp, env: ApiEnv, email: string) {
  return loginCookie(app, env, email, TENANCY_PASSWORD, ORIGIN)
}

/** Insert a plan then a run in org_team (composite FK). snapshot_json is '{}' for RED. */
export async function insertTeamPlanAndRun(db: KitDb, ids: { planId: string; runId: string }) {
  const now = Date.now()
  await db
    .insert(flowPlans)
    .values({
      id: ids.planId,
      orgId: ORG_TEAM,
      planKey: 'stolen-plan',
      version: 1,
      enabled: true,
      planJson: '{}',
      planDigest: 'digest',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  await db
    .insert(flowRuns)
    .values({
      id: ids.runId,
      orgId: ORG_TEAM,
      planId: ids.planId,
      planKey: 'stolen-plan',
      status: 'queued',
      actorId: 'user_team_owner',
      snapshotJson: '{}',
      planDigest: 'digest',
      createdAt: now,
      updatedAt: now,
    })
    .run()
}

export async function expectError(res: Response, status: number, code: string, message?: string) {
  expect(res.status).toBe(status)
  const body = (await res.json()) as {
    error: { code: string; message?: string }
    requestId: string
  }
  expect(body.error.code).toBe(code)
  expect(body.requestId).toMatch(/^req_/)
  if (message !== undefined) {
    expect(body.error.message).toBe(message)
  }
}

/** Creates the role through the route under test, then assigns its seeded member directly. */
export async function provisionOperatorWriteOnAcmeOverHttp(
  app: ApiApp,
  env: ApiEnv,
  db: KitDb,
  staffCookie: string,
) {
  const created = await app.request(
    `/api/orgs/${ORG_ACME}/roles`,
    {
      method: 'POST',
      headers: sessionHeaders(staffCookie, ORG_ACME),
      body: JSON.stringify({
        key: operator,
        name: 'Operator',
        grants: [{ moduleId: FLOWS_MODULE_ID, access: 'write' }],
      }),
    },
    env,
  )
  expect(created.status, 'operator role provisioning').toBe(201)
  await db
    .update(baMember)
    .set({ role: operator })
    .where(and(eq(baMember.userId, 'user_team_owner'), eq(baMember.organizationId, ORG_ACME)))
    .run()
}

/** Direct DB precondition for authorization tests that do not exercise role provisioning. */
export async function seedOperatorWriteOnAcme(db: KitDb) {
  const roleId = 'role_operator_acme'
  await orgRolesRepo.insertRole(db, {
    id: roleId,
    organizationId: ORG_ACME,
    key: operator,
    name: 'Operator',
    isSystem: false,
    createdAt: Date.now(),
  })
  await orgRolesRepo.upsertGrant(db, {
    organizationId: ORG_ACME,
    roleId,
    moduleId: FLOWS_MODULE_ID,
    access: 'write',
  })
  await db
    .update(baMember)
    .set({ role: operator })
    .where(and(eq(baMember.userId, 'user_team_owner'), eq(baMember.organizationId, ORG_ACME)))
    .run()
}
