import { baMember } from '@kit/auth/schema'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flowRuns } from './db/schema'
import { mintApiKey } from './services/auth'
import { bearerHeaders, sessionHeaders } from './test/api-fixture'
import {
  BOTH_ORGS,
  enableFlowsForOrgs,
  expectError,
  insertTeamPlanAndRun,
  login,
  MEMBER_EMAIL,
  ORG_ACME,
  STAFF_EMAIL,
  SUPER_EMAIL,
  seedFlowsApp,
  seedOperatorWriteOnAcme,
} from './test/flows-fixture'
import { workflowInstanceStub } from './test/memory-env'

afterEach(() => {
  vi.restoreAllMocks()
})

const INVOKE_YAML = `flows: v0
plan:
  id: cancel-echo
permits:
  tools:
    - echo
tasks:
  echo_hello:
    invoke:
      tool: echo
      args:
        text: hello
`

function cancelUrl(runId: string) {
  return `/api/flows/runs/${runId}/cancel`
}

async function publishQueued() {
  const { app, env, db } = await seedFlowsApp()
  await enableFlowsForOrgs(db, BOTH_ORGS)
  const cookie = await login(app, env, STAFF_EMAIL)
  const headers = sessionHeaders(cookie, ORG_ACME)
  const created = await app.request(
    '/api/flows/plans',
    { method: 'POST', headers, body: JSON.stringify({ yaml: INVOKE_YAML }) },
    env,
  )
  expect(created.status).toBe(201)
  const planId = ((await created.json()) as { plan: { id: string } }).plan.id
  let instance = workflowInstanceStub('pending')
  env.FLOW_RUN.create = vi.fn(async (opts?: { id?: string }) => {
    instance = workflowInstanceStub(opts?.id ?? 'wf_test')
    return instance
  })
  const queued = await app.request(
    `/api/flows/plans/${planId}/runs`,
    { method: 'POST', headers, body: '{}' },
    env,
  )
  expect(queued.status).toBe(202)
  const runId = ((await queued.json()) as { run: { id: string } }).run.id
  env.FLOW_RUN.get = vi.fn(async () => instance)
  return { app, env, db, headers, cookie, runId, getInstance: () => instance }
}

/** Assert cancel did not touch the Workflow instance (guards before terminate). */
function expectNoTerminate(
  env: { FLOW_RUN: { get: unknown } },
  getInstance: () => { terminated: number },
  terminatedBefore = 0,
) {
  expect(env.FLOW_RUN.get).not.toHaveBeenCalled()
  expect(getInstance().terminated).toBe(terminatedBefore)
}

type PrepStmt = {
  bind: (...args: unknown[]) => PrepStmt
  run: () => Promise<unknown>
}

/**
 * Flip the row to `terminal` just before the bound CAS UPDATE runs. `bind` returns
 * a fresh D1 statement, so the instrumentation must wrap that returned statement.
 */
function flipBeforeCancelCas(
  env: { DB: { prepare: (sql: string) => PrepStmt } },
  runId: string,
  terminal: 'succeeded' | 'failed',
) {
  const originalPrepare = env.DB.prepare.bind(env.DB) as (sql: string) => PrepStmt
  let flipped = false
  const wrap = (stmt: PrepStmt, binds: unknown[]): PrepStmt => {
    const wrapped = Object.create(stmt) as PrepStmt
    wrapped.bind = (...args: unknown[]) => wrap(stmt.bind(...args), args)
    wrapped.run = async () => {
      if (!flipped && binds[0] === 'cancelled') {
        flipped = true
        await originalPrepare(`UPDATE flow_runs SET status = ? WHERE id = ?`)
          .bind(terminal, runId)
          .run()
      }
      return stmt.run()
    }
    return wrapped
  }
  env.DB.prepare = ((sql: string) => {
    const stmt = originalPrepare(sql)
    return sql.startsWith('update "flow_runs" set "status" = ?') ? wrap(stmt, []) : stmt
  }) as typeof env.DB.prepare
}

describe('POST /api/flows/runs/:id/cancel', () => {
  it('session owner cancels queued → 200 cancelled and terminate once', async () => {
    const { app, env, db, headers, runId, getInstance } = await publishQueued()
    const res = await app.request(cancelUrl(runId), { method: 'POST', headers, body: '{}' }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { run: { id: string; status: string }; requestId: string }
    expect(body.run).toMatchObject({ id: runId, status: 'cancelled' })
    expect(body.requestId).toMatch(/^req_/)
    expect(getInstance().terminated).toBe(1)
    expect(env.FLOW_RUN.get).toHaveBeenCalledWith(runId)
    const row = await db.select().from(flowRuns).where(eq(flowRuns.id, runId)).all()
    expect(row[0]?.status).toBe('cancelled')
  })

  it('session member and sk_ are 403 with no row mutation and no terminate', async () => {
    const { app, env, db, runId, getInstance } = await publishQueued()
    const before = await db.select().from(flowRuns).where(eq(flowRuns.id, runId)).all()
    expect(before[0]?.status).toBe('queued')

    const memberCookie = await login(app, env, MEMBER_EMAIL)
    const member = await app.request(
      cancelUrl(runId),
      { method: 'POST', headers: sessionHeaders(memberCookie, ORG_ACME), body: '{}' },
      env,
    )
    await expectError(member, 403, 'FORBIDDEN')
    expectNoTerminate(env, getInstance)

    const minted = await mintApiKey(db, 'user_staff', {
      organizationId: ORG_ACME,
      name: 'flows-sk-cancel',
      scopes: ['read', 'write', 'admin'],
    })
    const sk = await app.request(
      cancelUrl(runId),
      { method: 'POST', headers: bearerHeaders(minted.key), body: '{}' },
      env,
    )
    await expectError(sk, 403, 'FORBIDDEN')
    expectNoTerminate(env, getInstance)

    const after = await db.select().from(flowRuns).where(eq(flowRuns.id, runId)).all()
    expect(after[0]?.status).toBe('queued')
  })

  it('other org run is 404, own run still cancels, no cross-tenant terminate', async () => {
    const { app, env, db, headers, runId, getInstance } = await publishQueued()
    await insertTeamPlanAndRun(db, { planId: 'plan_stolen_cancel', runId: 'run_stolen_cancel' })
    const stolen = await app.request(
      cancelUrl('run_stolen_cancel'),
      { method: 'POST', headers, body: '{}' },
      env,
    )
    await expectError(stolen, 404, 'NOT_FOUND')
    expectNoTerminate(env, getInstance)
    const stolenRow = await db
      .select()
      .from(flowRuns)
      .where(eq(flowRuns.id, 'run_stolen_cancel'))
      .all()
    expect(stolenRow[0]?.status).toBe('queued')

    // Positive control: same session cancels its own run → 200 (not a bare Hono 404).
    const own = await app.request(cancelUrl(runId), { method: 'POST', headers, body: '{}' }, env)
    expect(own.status).toBe(200)
    expect(getInstance().terminated).toBe(1)
    expect(env.FLOW_RUN.get).toHaveBeenCalledWith(runId)
  })

  it('succeeded → 409, status stays succeeded, no terminate', async () => {
    const { app, env, db, headers, runId, getInstance } = await publishQueued()
    await db
      .update(flowRuns)
      .set({ status: 'succeeded', updatedAt: Date.now() })
      .where(eq(flowRuns.id, runId))
      .run()
    const res = await app.request(cancelUrl(runId), { method: 'POST', headers, body: '{}' }, env)
    await expectError(res, 409, 'CONFLICT')
    expectNoTerminate(env, getInstance)
    const row = await db.select().from(flowRuns).where(eq(flowRuns.id, runId)).all()
    expect(row[0]?.status).toBe('succeeded')
  })

  it('failed → 409, status stays failed, no terminate', async () => {
    const { app, env, db, headers, runId, getInstance } = await publishQueued()
    await db
      .update(flowRuns)
      .set({ status: 'failed', updatedAt: Date.now() })
      .where(eq(flowRuns.id, runId))
      .run()
    const res = await app.request(cancelUrl(runId), { method: 'POST', headers, body: '{}' }, env)
    await expectError(res, 409, 'CONFLICT')
    expectNoTerminate(env, getInstance)
    const row = await db.select().from(flowRuns).where(eq(flowRuns.id, runId)).all()
    expect(row[0]?.status).toBe('failed')
  })

  it('CAS race to succeeded between read and update → 409 and no terminate', async () => {
    const { app, env, db, headers, runId, getInstance } = await publishQueued()
    flipBeforeCancelCas(env, runId, 'succeeded')
    const res = await app.request(cancelUrl(runId), { method: 'POST', headers, body: '{}' }, env)
    await expectError(res, 409, 'CONFLICT')
    expectNoTerminate(env, getInstance)
    const row = await db.select().from(flowRuns).where(eq(flowRuns.id, runId)).all()
    expect(row[0]?.status).toBe('succeeded')
  })

  it('second cancel is 200 idempotent and does not call get or terminate again', async () => {
    const { app, env, db, headers, runId, getInstance } = await publishQueued()
    const first = await app.request(cancelUrl(runId), { method: 'POST', headers, body: '{}' }, env)
    expect(first.status).toBe(200)
    expect(getInstance().terminated).toBe(1)
    expect(env.FLOW_RUN.get).toHaveBeenCalledTimes(1)

    // Fresh spy — must not be called. A throwing get is swallowed by try/catch → log.error,
    // so "terminated stayed 1" alone is tautological; assert the spy was never invoked.
    const getSpy = vi.fn(async () => {
      throw new Error('get must not run on idempotent cancel')
    })
    env.FLOW_RUN.get = getSpy
    const second = await app.request(cancelUrl(runId), { method: 'POST', headers, body: '{}' }, env)
    expect(second.status).toBe(200)
    const body = (await second.json()) as { run: { status: string } }
    expect(body.run.status).toBe('cancelled')
    expect(getSpy).not.toHaveBeenCalled()
    expect(getInstance().terminated).toBe(1)
    const row = await db.select().from(flowRuns).where(eq(flowRuns.id, runId)).all()
    expect(row[0]?.status).toBe('cancelled')
  })

  it('terminate throw still leaves cancelled and returns 200', async () => {
    const { app, env, db, headers, runId, getInstance } = await publishQueued()
    getInstance().terminate = vi.fn(async () => {
      throw new Error('workflow terminate down')
    })
    const res = await app.request(cancelUrl(runId), { method: 'POST', headers, body: '{}' }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { run: { status: string } }
    expect(body.run.status).toBe('cancelled')
    expect(env.FLOW_RUN.get).toHaveBeenCalledWith(runId)
    const row = await db.select().from(flowRuns).where(eq(flowRuns.id, runId)).all()
    expect(row[0]?.status).toBe('cancelled')
  })

  it('denies super_admin who is only an operator member and does not terminate', async () => {
    const { app, env, db, runId, getInstance } = await publishQueued()
    await seedOperatorWriteOnAcme(db)
    await db
      .insert(baMember)
      .values({
        id: 'mem_super_cancel_op',
        organizationId: ORG_ACME,
        userId: 'user_super',
        role: 'operator',
        createdAt: new Date(),
      })
      .run()
    const superCookie = await login(app, env, SUPER_EMAIL)
    const res = await app.request(
      cancelUrl(runId),
      { method: 'POST', headers: sessionHeaders(superCookie, ORG_ACME), body: '{}' },
      env,
    )
    await expectError(res, 403, 'FORBIDDEN')
    expectNoTerminate(env, getInstance)
    const row = await db.select().from(flowRuns).where(eq(flowRuns.id, runId)).all()
    expect(row[0]?.status).toBe('queued')
  })
})
