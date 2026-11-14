import * as flowsRepo from '@kit/flows/repos'
import { INVOKE_ONLY_PLAN_YAML } from '@kit/flows/run'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mintApiKey } from './services/auth'
import { bearerHeaders, sessionHeaders } from './test/api-fixture'
import {
  BOTH_ORGS,
  enableFlowsForOrgs,
  expectError,
  login,
  MEMBER_EMAIL,
  ORG_ACME,
  STAFF_EMAIL,
  seedFlowsApp,
} from './test/flows-fixture'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('V2 publish + enable', () => {
  it('POST /api/flows/plans with allowedTools net is 400 VALIDATION_ERROR', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const res = await app.request(
      '/api/flows/plans',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, ORG_ACME),
        body: JSON.stringify({ yaml: INVOKE_ONLY_PLAN_YAML, allowedTools: ['net'] }),
      },
      env,
    )
    await expectError(res, 400, 'VALIDATION_ERROR')
  })

  it('POST /api/flows/plans with empty yaml is 400 VALIDATION_ERROR', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const res = await app.request(
      '/api/flows/plans',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, ORG_ACME),
        body: JSON.stringify({ yaml: '' }),
      },
      env,
    )
    await expectError(res, 400, 'VALIDATION_ERROR')
  })

  it('POST /api/flows/plans with net tool is 400 checkPlan issues', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const yaml = `flows: v0
plan:
  id: net-only
permits:
  tools:
    - net
tasks:
  call_net:
    invoke:
      tool: net
`
    const res = await app.request(
      '/api/flows/plans',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, ORG_ACME),
        body: JSON.stringify({ yaml }),
      },
      env,
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: unknown[] } }
    }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(Array.isArray(body.error.details?.issues)).toBe(true)
    expect(body.error.details?.issues?.length).toBeGreaterThan(0)
  })

  it('POST /api/flows/plans with extra grant key is 400', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const res = await app.request(
      '/api/flows/plans',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, ORG_ACME),
        body: JSON.stringify({ yaml: INVOKE_ONLY_PLAN_YAML, grant: {} }),
      },
      env,
    )
    await expectError(res, 400, 'VALIDATION_ERROR')
  })

  it('POST /api/flows/plans with plan_key unique_plan and a non-unique D1 error is 500', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    vi.spyOn(flowsRepo, 'insertPlanVersionIfNewBytes').mockRejectedValue(
      Object.assign(new Error('Failed query: insert into flow_plans\nparams: unique_plan'), {
        params: ['unique_plan'],
        cause: new Error(
          'D1_ERROR: NOT NULL constraint failed: flow_plans.unique_key: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_NOTNULL)',
          { cause: new Error('NOT NULL constraint failed: flow_plans.unique_key') },
        ),
      }),
    )
    const res = await app.request(
      '/api/flows/plans',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, ORG_ACME),
        body: JSON.stringify({
          yaml: INVOKE_ONLY_PLAN_YAML.replace('id: echo-only', 'id: unique_plan'),
        }),
      },
      env,
    )
    await expectError(res, 500, 'INTERNAL_ERROR')
  })

  it('POST /api/flows/plans identical YAML is 200 with the same id', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const headers = sessionHeaders(cookie, ORG_ACME)
    const body = JSON.stringify({ yaml: INVOKE_ONLY_PLAN_YAML })
    const first = await app.request('/api/flows/plans', { method: 'POST', headers, body }, env)
    expect(first.status).toBe(201)
    const created = (await first.json()) as { plan: { id: string; version: number } }
    const dup = await app.request('/api/flows/plans', { method: 'POST', headers, body }, env)
    expect(dup.status).toBe(200)
    const again = (await dup.json()) as { plan: { id: string; version: number } }
    expect(again.plan.id).toBe(created.plan.id)
    expect(again.plan.version).toBe(created.plan.version)
  })

  it('POST /api/flows/plans different bytes after the first publish is 201 version 2', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const headers = sessionHeaders(cookie, ORG_ACME)
    const yamlA = INVOKE_ONLY_PLAN_YAML.replace('id: echo-only', 'id: unique_plan')
    const yamlB = yamlA.replace('text: hello-flows', 'text: other')
    const first = await app.request(
      '/api/flows/plans',
      { method: 'POST', headers, body: JSON.stringify({ yaml: yamlA }) },
      env,
    )
    expect(first.status).toBe(201)
    const next = await app.request(
      '/api/flows/plans',
      { method: 'POST', headers, body: JSON.stringify({ yaml: yamlB }) },
      env,
    )
    expect(next.status).toBe(201)
    const body = (await next.json()) as { plan: { version: number } }
    expect(body.plan.version).toBe(2)
  })

  it('PATCH /api/flows/plans/:planId enabled false then GET shows enabled false', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const headers = sessionHeaders(cookie, ORG_ACME)
    const created = await app.request(
      '/api/flows/plans',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ yaml: INVOKE_ONLY_PLAN_YAML }),
      },
      env,
    )
    expect(created.status).toBe(201)
    const { plan } = (await created.json()) as { plan: { id: string } }
    const patch = await app.request(
      `/api/flows/plans/${plan.id}`,
      { method: 'PATCH', headers, body: JSON.stringify({ enabled: false }) },
      env,
    )
    expect(patch.ok).toBe(true)
    const get = await app.request(`/api/flows/plans/${plan.id}`, { headers }, env)
    expect(get.status).toBe(200)
    const got = (await get.json()) as { plan: { enabled: boolean } }
    expect(got.plan.enabled).toBe(false)
  })

  it('POST /api/flows/plans is 403 for org-bound sk_ Bearer', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const minted = await mintApiKey(db, 'user_staff', {
      organizationId: ORG_ACME,
      name: 'flows-sk-post',
    })
    const res = await app.request(
      '/api/flows/plans',
      {
        method: 'POST',
        headers: bearerHeaders(minted.key),
        body: JSON.stringify({ yaml: INVOKE_ONLY_PLAN_YAML }),
      },
      env,
    )
    await expectError(res, 403, 'FORBIDDEN')
  })

  it('POST /api/flows/plans is 403 for seed member on org_acme', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, MEMBER_EMAIL)
    const res = await app.request(
      '/api/flows/plans',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, ORG_ACME),
        body: JSON.stringify({ yaml: INVOKE_ONLY_PLAN_YAML }),
      },
      env,
    )
    await expectError(res, 403, 'FORBIDDEN')
  })

  // T13: in-flight queued-after-disable lives in flows-v3.test.ts (POST 202 then PATCH)
})

describe('V2 plan check', () => {
  it('POST /api/flows/plans/check with invoke-only yaml is 200 and does not insert', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const headers = sessionHeaders(cookie, ORG_ACME)
    const res = await app.request(
      '/api/flows/plans/check',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ yaml: INVOKE_ONLY_PLAN_YAML }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; requestId: string }
    expect(body).toEqual({ ok: true, requestId: body.requestId })
    expect(body.requestId).toMatch(/^req_/)
    expect(body).not.toHaveProperty('grant')
    const list = await app.request('/api/flows/plans', { headers }, env)
    expect(list.status).toBe(200)
    const listed = (await list.json()) as { plans: unknown[] }
    expect(listed.plans).toEqual([])
  })

  it('POST /api/flows/plans/check after createPlan is 200 not 409', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const headers = sessionHeaders(cookie, ORG_ACME)
    const body = JSON.stringify({ yaml: INVOKE_ONLY_PLAN_YAML })
    const created = await app.request('/api/flows/plans', { method: 'POST', headers, body }, env)
    expect(created.status).toBe(201)
    const res = await app.request('/api/flows/plans/check', { method: 'POST', headers, body }, env)
    expect(res.status).toBe(200)
    const checked = (await res.json()) as { ok: boolean }
    expect(checked.ok).toBe(true)
  })

  it('POST /api/flows/plans/check with extra grant key is 400', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const res = await app.request(
      '/api/flows/plans/check',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, ORG_ACME),
        body: JSON.stringify({ yaml: INVOKE_ONLY_PLAN_YAML, grant: {} }),
      },
      env,
    )
    await expectError(res, 400, 'VALIDATION_ERROR')
  })

  it('POST /api/flows/plans/check with allowedTools is 400 VALIDATION_ERROR', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const res = await app.request(
      '/api/flows/plans/check',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, ORG_ACME),
        body: JSON.stringify({ yaml: INVOKE_ONLY_PLAN_YAML, allowedTools: ['net'] }),
      },
      env,
    )
    await expectError(res, 400, 'VALIDATION_ERROR')
  })

  it('POST /api/flows/plans/check with empty yaml is 400 VALIDATION_ERROR', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const res = await app.request(
      '/api/flows/plans/check',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, ORG_ACME),
        body: JSON.stringify({ yaml: '' }),
      },
      env,
    )
    await expectError(res, 400, 'VALIDATION_ERROR')
  })

  it('POST /api/flows/plans/check with net tool is 400 checkPlan issues', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, STAFF_EMAIL)
    const yaml = `flows: v0
plan:
  id: net-only
permits:
  tools:
    - net
tasks:
  call_net:
    invoke:
      tool: net
`
    const res = await app.request(
      '/api/flows/plans/check',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, ORG_ACME),
        body: JSON.stringify({ yaml }),
      },
      env,
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: unknown[] } }
    }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(Array.isArray(body.error.details?.issues)).toBe(true)
    expect(body.error.details?.issues?.length).toBeGreaterThan(0)
  })

  it('POST /api/flows/plans/check is 403 for org-bound sk_ Bearer', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const minted = await mintApiKey(db, 'user_staff', {
      organizationId: ORG_ACME,
      name: 'flows-sk-check',
    })
    const res = await app.request(
      '/api/flows/plans/check',
      {
        method: 'POST',
        headers: bearerHeaders(minted.key),
        body: JSON.stringify({ yaml: INVOKE_ONLY_PLAN_YAML }),
      },
      env,
    )
    await expectError(res, 403, 'FORBIDDEN')
  })

  it('POST /api/flows/plans/check is 403 for seed member on org_acme', async () => {
    const { app, env, db } = await seedFlowsApp()
    await enableFlowsForOrgs(db, BOTH_ORGS)
    const cookie = await login(app, env, MEMBER_EMAIL)
    const res = await app.request(
      '/api/flows/plans/check',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, ORG_ACME),
        body: JSON.stringify({ yaml: INVOKE_ONLY_PLAN_YAML }),
      },
      env,
    )
    await expectError(res, 403, 'FORBIDDEN')
  })
})
