import { MODULE_DENIAL } from '@kit/auth/hono'
import * as orgRolesRepo from '@kit/auth/repos/org-roles'
import { AppError } from '@kit/core'
import { FLOWS_MODULE_ID } from '@kit/flows'
import { INVOKE_ONLY_PLAN_YAML } from '@kit/flows/run'
import { describe, expect, it } from 'vitest'
import { BOTH_ORGS, enableFlowsForOrgs, ORG_ACME, seedFlowsApp } from '../test/flows-fixture'
import { checkPlanYaml, createPlan, createRun, listPlansForOrg } from './flows'
import { ensureSystemRoles } from './org-roles'
import { setOrgModuleEnabled } from './platform-modules'

const STAFF_ADMIN = {
  orgId: ORG_ACME,
  subject: 'user_staff',
  orgRole: 'admin',
  platformRole: 'staff',
} as const

/**
 * A mint denial must answer exactly as `requireModule`: module not effective →
 * 404, role without the grant → 403. The backstop must not invent a third
 * answer.
 *
 * The message is asserted against the SHARED `MODULE_DENIAL` literal the mint
 * backstop uses, so this test fails if the mint layer stops using that
 * constant. The constant's own value is pinned in
 * `packages/auth/src/hono.test.ts`. A 400 would additionally claim the caller
 * sent a malformed request.
 */
const MINT_DENIALS = {
  MODULE_NOT_EFFECTIVE: {
    code: 'NOT_FOUND',
    status: 404,
    message: MODULE_DENIAL.notAvailable,
  },
  MODULE_ACCESS_DENIED: {
    code: 'FORBIDDEN',
    status: 403,
    message: MODULE_DENIAL.insufficientGrant,
  },
} as const

function expectMintDenial(err: unknown, mintCode: keyof typeof MINT_DENIALS) {
  expect(err).toBeInstanceOf(AppError)
  if (!(err instanceof AppError)) return
  const expected = MINT_DENIALS[mintCode]
  expect(err.code).toBe(expected.code)
  expect(err.status).toBe(expected.status)
  expect(err.message).toBe(expected.message)
  expect(err.details).toBeUndefined()
}

describe('flows service org-policy mint', () => {
  it('createPlan and createRun succeed when flows is effective and role can write', async () => {
    const { env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const { plan } = await createPlan(db, env, {
      ...STAFF_ADMIN,
      body: { yaml: INVOKE_ONLY_PLAN_YAML },
    })
    expect(plan.orgId).toBe(ORG_ACME)
    expect(plan.planKey).toBe('echo-only')
    expect(plan.enabled).toBe(true)

    const run = await createRun(db, env, {
      ...STAFF_ADMIN,
      planId: plan.id,
      authMethod: 'session',
      body: {},
    })
    expect(run.status).toBe('queued')
    expect(run.id).toMatch(/^run_/)
  })

  it('createPlan fails closed when flows module is not effective', async () => {
    const { env, db } = await seedFlowsApp()
    try {
      await createPlan(db, env, {
        ...STAFF_ADMIN,
        body: { yaml: INVOKE_ONLY_PLAN_YAML },
      })
      expect.unreachable('mint should deny')
    } catch (err) {
      expectMintDenial(err, 'MODULE_NOT_EFFECTIVE')
    }
  })

  it('createRun fails closed when flows module is disabled after publish', async () => {
    const { env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const { plan } = await createPlan(db, env, {
      ...STAFF_ADMIN,
      body: { yaml: INVOKE_ONLY_PLAN_YAML },
    })
    await setOrgModuleEnabled(db, ORG_ACME, FLOWS_MODULE_ID, false)
    try {
      await createRun(db, env, {
        ...STAFF_ADMIN,
        planId: plan.id,
        authMethod: 'session',
        body: {},
      })
      expect.unreachable('mint should deny')
    } catch (err) {
      expectMintDenial(err, 'MODULE_NOT_EFFECTIVE')
    }
  })

  it('createPlan fails closed when role module access is disabled', async () => {
    const { env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    await ensureSystemRoles(db, ORG_ACME)
    const adminRole = await orgRolesRepo.findRoleByKey(db, ORG_ACME, 'admin')
    expect(adminRole).toBeTruthy()
    if (!adminRole) return
    await orgRolesRepo.upsertGrant(db, {
      organizationId: ORG_ACME,
      roleId: adminRole.id,
      moduleId: FLOWS_MODULE_ID,
      access: 'disabled',
    })
    try {
      await createPlan(db, env, {
        ...STAFF_ADMIN,
        body: { yaml: INVOKE_ONLY_PLAN_YAML },
      })
      expect.unreachable('mint should deny')
    } catch (err) {
      expectMintDenial(err, 'MODULE_ACCESS_DENIED')
    }
  })

  it('createPlan rejects extra body keys (grant is server-minted)', async () => {
    const { env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    try {
      await createPlan(db, env, {
        ...STAFF_ADMIN,
        body: { yaml: INVOKE_ONLY_PLAN_YAML, grant: { orgId: ORG_ACME } },
      })
      expect.unreachable('extra keys should fail closed')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      if (!(err instanceof AppError)) return
      expect(err.code).toBe('VALIDATION_ERROR')
      expect(err.status).toBe(400)
    }
  })
})

describe('flows service plan check', () => {
  it('checkPlanYaml rejects extra body keys (grant is server-minted)', async () => {
    const { env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    try {
      await checkPlanYaml(db, env, {
        ...STAFF_ADMIN,
        body: { yaml: INVOKE_ONLY_PLAN_YAML, grant: { orgId: ORG_ACME } },
      })
      expect.unreachable('extra keys should fail closed')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      if (!(err instanceof AppError)) return
      expect(err.code).toBe('VALIDATION_ERROR')
      expect(err.status).toBe(400)
    }
  })

  it('checkPlanYaml success does not insert', async () => {
    const { env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    await checkPlanYaml(db, env, {
      ...STAFF_ADMIN,
      body: { yaml: INVOKE_ONLY_PLAN_YAML },
    })
    const plans = await listPlansForOrg(db, ORG_ACME)
    expect(plans).toEqual([])
  })
})
