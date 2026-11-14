import { INVOKE_ONLY_PLAN_YAML } from '@kit/flows/run'
import { describe, expect, it } from 'vitest'
import { mintApiKey } from './services/auth'
import { bearerHeaders, sessionHeaders } from './test/api-fixture'
import {
  BOTH_ORGS,
  enableFlowsForOrgs,
  expectError,
  freshApp,
  insertTeamPlanAndRun,
  login,
  MEMBER_EMAIL,
  ORG_ACME,
  ORG_TEAM,
  ORIGIN,
  provisionOperatorWriteOnAcmeOverHttp,
  STAFF_EMAIL,
  SUPER_EMAIL,
  seedFlowsApp,
} from './test/flows-fixture'

describe('flows admin API (V1 gates + GET)', () => {
  it('GET /api/flows/plans is 401 without cookie', async () => {
    const { app, env } = freshApp()
    const res = await app.request('/api/flows/plans', {}, env)
    await expectError(res, 401, 'UNAUTHORIZED')
  })

  it('GET /api/flows/runs is 401 without cookie', async () => {
    const { app, env } = freshApp()
    const res = await app.request('/api/flows/runs', {}, env)
    await expectError(res, 401, 'UNAUTHORIZED')
  })

  it('GET /api/flows/plans is 400 when session is missing X-Org-Id', async () => {
    const { app, env } = await seedFlowsApp()
    const cookie = await login(app, env, STAFF_EMAIL)
    const res = await app.request(
      '/api/flows/plans',
      {
        headers: {
          cookie,
          'content-type': 'application/json',
          Origin: ORIGIN,
        },
      },
      env,
    )
    await expectError(res, 400, 'VALIDATION_ERROR')
  })

  it('GET plans and runs are 403 for org-bound sk_ Bearer (not 401)', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const minted = await mintApiKey(db, 'user_staff', {
      organizationId: ORG_ACME,
      name: 'flows-sk',
      scopes: ['read', 'write', 'admin'],
    })
    const headers = bearerHeaders(minted.key)
    const plans = await app.request('/api/flows/plans', { headers }, env)
    await expectError(plans, 403, 'FORBIDDEN')
    const runs = await app.request('/api/flows/runs', { headers }, env)
    await expectError(runs, 403, 'FORBIDDEN')
    const plan = await app.request('/api/flows/plans/plan_unknown', { headers }, env)
    await expectError(plan, 403, 'FORBIDDEN')
    const patch = await app.request(
      '/api/flows/plans/plan_unknown',
      { method: 'PATCH', headers, body: JSON.stringify({ enabled: false }) },
      env,
    )
    await expectError(patch, 403, 'FORBIDDEN')
  })

  it('GET /api/flows/plans is 404 when flows module is off', async () => {
    const { app, env } = await seedFlowsApp()
    const cookie = await login(app, env, STAFF_EMAIL)
    const res = await app.request(
      '/api/flows/plans',
      { headers: sessionHeaders(cookie, ORG_ACME) },
      env,
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as {
      error: { code: string; message: string }
      requestId: string
    }
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toBe('Module not available')
    expect(body.requestId).toMatch(/^req_/)
  })

  it('GET /api/flows/runs is 404 when flows module is off', async () => {
    const { app, env } = await seedFlowsApp()
    const cookie = await login(app, env, STAFF_EMAIL)
    const res = await app.request(
      '/api/flows/runs',
      { headers: sessionHeaders(cookie, ORG_ACME) },
      env,
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toBe('Module not available')
  })

  it('GET /api/flows/plans returns empty list after enableFlows', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const res = await app.request(
      '/api/flows/plans',
      { headers: sessionHeaders(cookie, ORG_ACME) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { plans: unknown[]; requestId: string }
    expect(body.plans).toEqual([])
    expect(body.requestId).toMatch(/^req_/)
  })

  it('GET /api/flows/runs returns empty list after enableFlows', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const res = await app.request(
      '/api/flows/runs',
      { headers: sessionHeaders(cookie, ORG_ACME) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runs: unknown[]; requestId: string }
    expect(body.runs).toEqual([])
    expect(body.requestId).toMatch(/^req_/)
  })

  it('stolen plan/run id with own X-Org-Id is 404 on GET, PATCH, and POST run', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const stolenPlanId = 'plan_stolen_team'
    const stolenRunId = 'run_stolen_team'
    await insertTeamPlanAndRun(db, { planId: stolenPlanId, runId: stolenRunId })
    const teamCookie = await login(app, env, MEMBER_EMAIL)
    const teamHeaders = sessionHeaders(teamCookie, ORG_TEAM)
    const teamPlans = await app.request('/api/flows/plans', { headers: teamHeaders }, env)
    expect(teamPlans.status).toBe(200)
    const teamPlanIds = ((await teamPlans.json()) as { plans: { id: string }[] }).plans.map(
      (p) => p.id,
    )
    expect(teamPlanIds).toContain(stolenPlanId)
    const teamRuns = await app.request('/api/flows/runs', { headers: teamHeaders }, env)
    expect(teamRuns.status).toBe(200)
    const teamRunIds = ((await teamRuns.json()) as { runs: { id: string }[] }).runs.map((r) => r.id)
    expect(teamRunIds).toContain(stolenRunId)

    const cookie = await login(app, env, STAFF_EMAIL)
    const headers = sessionHeaders(cookie, ORG_ACME)
    const acmePlans = await app.request('/api/flows/plans', { headers }, env)
    expect(acmePlans.status).toBe(200)
    const acmePlanIds = ((await acmePlans.json()) as { plans: { id: string }[] }).plans.map(
      (p) => p.id,
    )
    expect(acmePlanIds).not.toContain(stolenPlanId)
    const acmeRuns = await app.request('/api/flows/runs', { headers }, env)
    expect(acmeRuns.status).toBe(200)
    const acmeRunIds = ((await acmeRuns.json()) as { runs: { id: string }[] }).runs.map((r) => r.id)
    expect(acmeRunIds).not.toContain(stolenRunId)

    const plan = await app.request(`/api/flows/plans/${stolenPlanId}`, { headers }, env)
    await expectError(plan, 404, 'NOT_FOUND')
    const run = await app.request(`/api/flows/runs/${stolenRunId}`, { headers }, env)
    await expectError(run, 404, 'NOT_FOUND')

    const patch = await app.request(
      `/api/flows/plans/${stolenPlanId}`,
      { method: 'PATCH', headers, body: JSON.stringify({ enabled: false }) },
      env,
    )
    await expectError(patch, 404, 'NOT_FOUND')
    const teamPlan = await app.request(
      `/api/flows/plans/${stolenPlanId}`,
      { headers: teamHeaders },
      env,
    )
    expect(teamPlan.status).toBe(200)
    const stolenRun = await app.request(
      `/api/flows/plans/${stolenPlanId}/runs`,
      { method: 'POST', headers, body: '{}' },
      env,
    )
    await expectError(stolenRun, 404, 'NOT_FOUND')
  })

  it('GET unknown plan/run id on enabled org_acme is 404', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const headers = sessionHeaders(cookie, ORG_ACME)
    const plan = await app.request('/api/flows/plans/plan_unknown', { headers }, env)
    await expectError(plan, 404, 'NOT_FOUND')
    const run = await app.request('/api/flows/runs/run_unknown', { headers }, env)
    await expectError(run, 404, 'NOT_FOUND')
  })

  it('GET /api/flows/plans is 403 for seed member on org_acme', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, MEMBER_EMAIL)
    const res = await app.request(
      '/api/flows/plans',
      { headers: sessionHeaders(cookie, ORG_ACME) },
      env,
    )
    await expectError(res, 403, 'FORBIDDEN', 'Insufficient module grant')
  })
})

describe('V2 publish + enable', () => {
  it('POST /api/flows/plans as staff after enableFlows returns 201 invoke-only plan', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const res = await app.request(
      '/api/flows/plans',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, ORG_ACME),
        body: JSON.stringify({ yaml: INVOKE_ONLY_PLAN_YAML }),
      },
      env,
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      plan: {
        planKey: string
        version: number
        enabled: boolean
        digest: string
        id: string
        orgId: string
      }
      requestId: string
    }
    expect(body.plan.planKey).toBe('echo-only')
    expect(body.plan.version).toBe(1)
    expect(body.plan.enabled).toBe(true)
    expect(body.plan.digest).toBeTruthy()
    expect(body.plan.id).toBeTruthy()
    expect(body.plan.orgId).toBe(ORG_ACME)
    expect(body.requestId).toMatch(/^req_/)
  })
})

describe('V0 custom write non-admin (operator)', () => {
  it('POST/PATCH/run is 403 for operator with flows=write (not owner/admin)', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const staffCookie = await login(app, env, STAFF_EMAIL)
    const staffHeaders = sessionHeaders(staffCookie, ORG_ACME)
    await provisionOperatorWriteOnAcmeOverHttp(app, env, db, staffCookie)

    const published = await app.request(
      '/api/flows/plans',
      {
        method: 'POST',
        headers: staffHeaders,
        body: JSON.stringify({ yaml: INVOKE_ONLY_PLAN_YAML }),
      },
      env,
    )
    expect(published.status).toBe(201)
    const planId = ((await published.json()) as { plan: { id: string } }).plan.id

    const cookie = await login(app, env, MEMBER_EMAIL)
    const headers = sessionHeaders(cookie, ORG_ACME)

    const list = await app.request('/api/flows/plans', { headers }, env)
    expect(list.status).toBe(200)

    const post = await app.request(
      '/api/flows/plans',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ yaml: INVOKE_ONLY_PLAN_YAML }),
      },
      env,
    )
    await expectError(post, 403, 'FORBIDDEN')

    const patch = await app.request(
      `/api/flows/plans/${planId}`,
      { method: 'PATCH', headers, body: JSON.stringify({ enabled: false }) },
      env,
    )
    await expectError(patch, 403, 'FORBIDDEN')

    const run = await app.request(
      `/api/flows/plans/${planId}/runs`,
      { method: 'POST', headers, body: '{}' },
      env,
    )
    await expectError(run, 403, 'FORBIDDEN')
  })
})

describe('V0 super_admin without membership', () => {
  it('GET /api/flows/plans is 404 for super_admin not in org', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, SUPER_EMAIL)
    const res = await app.request(
      '/api/flows/plans',
      { headers: sessionHeaders(cookie, ORG_ACME) },
      env,
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toBe('Organization not found')
  })
})

// V3 create-run stubs env.FLOW_RUN.create — see src/flows-v3.test.ts
