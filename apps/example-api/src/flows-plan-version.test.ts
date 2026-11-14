import { digestPlan, loadPlanFromYaml } from '@kit/flows'
import * as flowsRepo from '@kit/flows/repos'
import { INVOKE_ONLY_PLAN_YAML } from '@kit/flows/run'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ApiApp, type ApiEnv, sessionHeaders } from './test/api-fixture'
import {
  BOTH_ORGS,
  enableFlowsForOrgs,
  expectError,
  login,
  MEMBER_EMAIL,
  ORG_ACME,
  ORG_TEAM,
  STAFF_EMAIL,
  seedFlowsApp,
} from './test/flows-fixture'

afterEach(() => {
  vi.restoreAllMocks()
})

type PlanJson = {
  plan: {
    id: string
    orgId: string
    planKey: string
    version: number
    enabled: boolean
    digest: string
  }
}

async function postYaml(app: ApiApp, env: ApiEnv, headers: Record<string, string>, yaml: string) {
  return app.request(
    '/api/flows/plans',
    { method: 'POST', headers, body: JSON.stringify({ yaml }) },
    env,
  )
}

async function listPlans(app: ApiApp, env: ApiEnv, headers: Record<string, string>) {
  const res = await app.request('/api/flows/plans', { headers }, env)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { plans: PlanJson['plan'][] }
  return body.plans
}

/** Seed a row under the posted plan key; `yamlSource` may differ or be null. */
function seededPlanRow(planKeyYaml: string, yamlSource: string | null, id = 'plan_seeded') {
  const parsed = loadPlanFromYaml(planKeyYaml)
  const now = Date.now()
  return {
    id,
    orgId: ORG_ACME,
    planKey: parsed.plan.id,
    version: 1,
    enabled: true,
    yamlSource,
    planJson: JSON.stringify(parsed),
    planDigest: digestPlan(parsed),
    createdBy: 'user_staff',
    createdAt: now,
    updatedAt: now,
  }
}

describe('plan version identity (Roxabi/roxabi-boilerplate-cf#228)', () => {
  it('POST same YAML twice is 200 with the same id and version and no new row', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const headers = sessionHeaders(cookie, ORG_ACME)
    const first = await postYaml(app, env, headers, INVOKE_ONLY_PLAN_YAML)
    expect(first.status).toBe(201)
    const created = (await first.json()) as PlanJson
    expect(created.plan.version).toBe(1)
    expect(created.plan.digest).toBe(digestPlan(loadPlanFromYaml(INVOKE_ONLY_PLAN_YAML)))

    const again = await postYaml(app, env, headers, INVOKE_ONLY_PLAN_YAML)
    expect(again.status).toBe(200)
    const hit = (await again.json()) as PlanJson
    expect(hit.plan.id).toBe(created.plan.id)
    expect(hit.plan.version).toBe(1)
    expect(hit.plan.digest).toBe(created.plan.digest)

    const plans = await listPlans(app, env, headers)
    expect(plans).toHaveLength(1)
    expect(plans[0]?.id).toBe(created.plan.id)
  })

  it('POST whitespace-different YAML that parses equal is 201 version 2', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const headers = sessionHeaders(cookie, ORG_ACME)
    const spaced = INVOKE_ONLY_PLAN_YAML.replace('flows: v0', 'flows:  v0')
    expect(spaced).not.toBe(INVOKE_ONLY_PLAN_YAML)
    expect(digestPlan(loadPlanFromYaml(spaced))).toBe(
      digestPlan(loadPlanFromYaml(INVOKE_ONLY_PLAN_YAML)),
    )

    const first = await postYaml(app, env, headers, INVOKE_ONLY_PLAN_YAML)
    expect(first.status).toBe(201)
    const created = (await first.json()) as PlanJson

    const second = await postYaml(app, env, headers, spaced)
    expect(second.status).toBe(201)
    const next = (await second.json()) as PlanJson
    expect(next.plan.version).toBe(2)
    expect(next.plan.id).not.toBe(created.plan.id)
    expect(next.plan.digest).toBe(created.plan.digest)

    const plans = await listPlans(app, env, headers)
    expect(plans).toHaveLength(2)
  })

  it('seeded unequal yaml_source under the same plan key is version n+1', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const headers = sessionHeaders(cookie, ORG_ACME)
    const posted = INVOKE_ONLY_PLAN_YAML.replace('text: hello-flows', 'text: other-bytes')
    const inserted = await flowsRepo.insertPlan(
      db,
      seededPlanRow(posted, INVOKE_ONLY_PLAN_YAML, 'plan_unequal_bytes'),
    )
    expect(inserted).toEqual({ ok: true })

    const res = await postYaml(app, env, headers, posted)
    expect(res.status).toBe(201)
    const body = (await res.json()) as PlanJson
    expect(body.plan.version).toBe(2)
    expect(body.plan.id).not.toBe('plan_unequal_bytes')

    const plans = await listPlans(app, env, headers)
    expect(plans.map((plan) => plan.version).sort()).toEqual([1, 2])
  })

  it('a row with null yaml_source is not a byte match', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const headers = sessionHeaders(cookie, ORG_ACME)
    const inserted = await flowsRepo.insertPlan(
      db,
      seededPlanRow(INVOKE_ONLY_PLAN_YAML, null, 'plan_null_source'),
    )
    expect(inserted).toEqual({ ok: true })

    const res = await postYaml(app, env, headers, INVOKE_ONLY_PLAN_YAML)
    expect(res.status).toBe(201)
    const body = (await res.json()) as PlanJson
    expect(body.plan.id).not.toBe('plan_null_source')
    expect(body.plan.version).toBe(2)

    const plans = await listPlans(app, env, headers)
    expect(plans).toHaveLength(2)
  })

  it('same YAML in org B does not return org A id', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const staff = await login(app, env, STAFF_EMAIL)
    const owner = await login(app, env, MEMBER_EMAIL)
    const acme = sessionHeaders(staff, ORG_ACME)
    const team = sessionHeaders(owner, ORG_TEAM)

    const first = await postYaml(app, env, acme, INVOKE_ONLY_PLAN_YAML)
    expect(first.status).toBe(201)
    const orgA = (await first.json()) as PlanJson

    const second = await postYaml(app, env, team, INVOKE_ONLY_PLAN_YAML)
    expect(second.status).toBe(201)
    const orgB = (await second.json()) as PlanJson
    expect(orgB.plan.id).not.toBe(orgA.plan.id)
    expect(orgB.plan.orgId).toBe(ORG_TEAM)
    expect(orgB.plan.version).toBe(1)

    const acmePlans = await listPlans(app, env, acme)
    expect(acmePlans.map((plan) => plan.id)).toEqual([orgA.plan.id])
  })

  it('invalid YAML is 400 and does not bump version', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const headers = sessionHeaders(cookie, ORG_ACME)
    const first = await postYaml(app, env, headers, INVOKE_ONLY_PLAN_YAML)
    expect(first.status).toBe(201)

    const bad = await postYaml(app, env, headers, ':\n: not yaml [[[')
    await expectError(bad, 400, 'VALIDATION_ERROR')

    const plans = await listPlans(app, env, headers)
    expect(plans).toHaveLength(1)
    expect(plans[0]?.version).toBe(1)
  })

  it('staggered overlapping publishes of the same bytes leave one row and one id', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const headers = sessionHeaders(await login(app, env, STAFF_EMAIL), ORG_ACME)
    const realInsert = flowsRepo.insertPlanVersionIfNewBytes
    const realRead = flowsRepo.getLowestPlanVersionByBytes
    let inserts = 0
    let bothInserted!: () => void
    const insertBarrier = new Promise<void>((resolve) => {
      bothInserted = resolve
    })
    let entered = 0
    let bothEntered!: () => void
    const entryBarrier = new Promise<void>((resolve) => {
      bothEntered = resolve
    })
    vi.spyOn(flowsRepo, 'insertPlanVersionIfNewBytes').mockImplementation(async (...args) => {
      entered += 1
      if (entered === 2) bothEntered()
      await entryBarrier
      const result = await realInsert(...args)
      inserts += 1
      if (inserts === 2) bothInserted()
      return result
    })
    vi.spyOn(flowsRepo, 'getLowestPlanVersionByBytes').mockImplementation(async (...args) => {
      await insertBarrier
      return realRead(...args)
    })

    const [a, b] = await Promise.all([
      postYaml(app, env, headers, INVOKE_ONLY_PLAN_YAML),
      postYaml(app, env, headers, INVOKE_ONLY_PLAN_YAML),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 201])
    const bodyA = (await a.json()) as PlanJson
    const bodyB = (await b.json()) as PlanJson
    expect(bodyA.plan.id).toBe(bodyB.plan.id)
    expect(bodyA.plan.version).toBe(1)
    expect(bodyB.plan.version).toBe(1)
    vi.restoreAllMocks()
    const plans = await listPlans(app, env, headers)
    expect(plans.map((plan) => plan.id)).toEqual([bodyA.plan.id])
  })

  it('overlapping publishes of different bytes each get their own version', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const headers = sessionHeaders(await login(app, env, STAFF_EMAIL), ORG_ACME)
    const other = INVOKE_ONLY_PLAN_YAML.replace('text: hello-flows', 'text: other')
    const [a, b] = await Promise.all([
      postYaml(app, env, headers, INVOKE_ONLY_PLAN_YAML),
      postYaml(app, env, headers, other),
    ])
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    const versions = [
      ((await a.json()) as PlanJson).plan.version,
      ((await b.json()) as PlanJson).plan.version,
    ].sort()
    expect(versions).toEqual([1, 2])
  })

  it('byte match is scoped to the org even when another org stores a lower version', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const staff = sessionHeaders(await login(app, env, STAFF_EMAIL), ORG_ACME)
    const owner = sessionHeaders(await login(app, env, MEMBER_EMAIL), ORG_TEAM)
    const other = INVOKE_ONLY_PLAN_YAML.replace('text: hello-flows', 'text: other')
    const teamV1 = await postYaml(app, env, owner, INVOKE_ONLY_PLAN_YAML)
    expect(teamV1.status).toBe(201)
    const team = (await teamV1.json()) as PlanJson
    expect((await postYaml(app, env, staff, other)).status).toBe(201)

    const acme = await postYaml(app, env, staff, INVOKE_ONLY_PLAN_YAML)
    expect(acme.status).toBe(201)
    const body = (await acme.json()) as PlanJson
    expect(body.plan.id).not.toBe(team.plan.id)
    expect(body.plan.orgId).toBe(ORG_ACME)
    expect(body.plan.version).toBe(2)
  })

  it('unique race loser with identical bytes re-reads once and is 200', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const headers = sessionHeaders(await login(app, env, STAFF_EMAIL), ORG_ACME)
    const now = Date.now()
    const winner = {
      id: 'plan_winner',
      orgId: ORG_ACME,
      planKey: 'echo-only',
      version: 1,
      enabled: false,
      yamlSource: INVOKE_ONLY_PLAN_YAML,
      planJson: '{}',
      planDigest: digestPlan(loadPlanFromYaml(INVOKE_ONLY_PLAN_YAML)),
      createdBy: 'user_staff',
      createdAt: now,
      updatedAt: now,
    }
    expect(await flowsRepo.insertPlan(db, winner)).toEqual({ ok: true })
    vi.spyOn(flowsRepo, 'insertPlanVersionIfNewBytes').mockResolvedValue({
      ok: false,
      reason: 'conflict',
    })

    const res = await postYaml(app, env, headers, INVOKE_ONLY_PLAN_YAML)
    expect(res.status).toBe(200)
    const body = (await res.json()) as PlanJson
    expect(body.plan.id).toBe('plan_winner')
    expect(body.plan.version).toBe(1)
    expect(body.plan.enabled).toBe(false)
  })

  it('unique race loser with different bytes is retryable PLAN_VERSION_RACE', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const headers = sessionHeaders(await login(app, env, STAFF_EMAIL), ORG_ACME)
    const other = INVOKE_ONLY_PLAN_YAML.replace('text: hello-flows', 'text: winner')
    const now = Date.now()
    expect(
      await flowsRepo.insertPlan(db, {
        id: 'plan_winner',
        orgId: ORG_ACME,
        planKey: 'echo-only',
        version: 1,
        enabled: true,
        yamlSource: other,
        planJson: '{}',
        planDigest: 'idx',
        createdBy: 'user_staff',
        createdAt: now,
        updatedAt: now,
      }),
    ).toEqual({ ok: true })
    vi.spyOn(flowsRepo, 'insertPlanVersionIfNewBytes').mockResolvedValue({
      ok: false,
      reason: 'conflict',
    })

    const res = await postYaml(app, env, headers, INVOKE_ONLY_PLAN_YAML)
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: { reason?: string; retryable?: boolean } }
    }
    expect(body.error.code).toBe('CONFLICT')
    expect(body.error.message).not.toMatch(/already exists/i)
    expect(body.error.details).toEqual({ reason: 'PLAN_VERSION_RACE', retryable: true })
  })
})
