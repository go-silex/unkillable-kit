import { baMember } from '@kit/auth/schema'
import {
  createRunSnapshot,
  createToolRegistry,
  flowApprovalEventType,
  loadPlanFromYaml,
  mintCapabilityGrant,
} from '@kit/flows'
import { driveFlowRun } from '@kit/flows/run'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { flowRunApprovals, flowRuns } from './db/schema'
import { mintApiKey } from './services/auth'
import { decideRunApproval } from './services/flows-approval'
import { bearerHeaders, sessionHeaders } from './test/api-fixture'
import {
  BOTH_ORGS,
  enableFlowsForOrgs,
  expectError,
  insertTeamPlanAndRun,
  login,
  MEMBER_EMAIL,
  ORG_ACME,
  ORG_TEAM,
  STAFF_EMAIL,
  SUPER_EMAIL,
  seedFlowsApp,
  seedOperatorWriteOnAcme,
} from './test/flows-fixture'
import { workflowInstanceStub } from './test/memory-env'

const APPROVE_YAML = `flows: v0
plan:
  id: approve-then-echo
permits:
  tools:
    - echo
tasks:
  gate:
    approve: {}
  echo_hello:
    after:
      - gate
    invoke:
      tool: echo
      args:
        text: after-approve
`

const WAITING = JSON.stringify({
  receiptVersion: 1,
  tokensUsed: 0,
  tasks: { gate: { taskId: 'gate', outcome: 'waiting' } },
})

async function publishWaiting() {
  const { app, env, db } = await seedFlowsApp()
  await enableFlowsForOrgs(db, BOTH_ORGS)
  const cookie = await login(app, env, STAFF_EMAIL)
  const headers = sessionHeaders(cookie, ORG_ACME)
  const created = await app.request(
    '/api/flows/plans',
    { method: 'POST', headers, body: JSON.stringify({ yaml: APPROVE_YAML }) },
    env,
  )
  expect(created.status).toBe(201)
  const planId = ((await created.json()) as { plan: { id: string } }).plan.id
  const queued = await app.request(
    `/api/flows/plans/${planId}/runs`,
    { method: 'POST', headers, body: '{}' },
    env,
  )
  expect(queued.status).toBe(202)
  const runId = ((await queued.json()) as { run: { id: string } }).run.id
  await db
    .update(flowRuns)
    .set({ status: 'running', receiptJson: WAITING, workflowInstanceId: runId })
    .where(eq(flowRuns.id, runId))
    .run()
  return { app, env, db, headers, cookie, runId }
}

function approvalUrl(runId: string, taskId = 'gate') {
  return `/api/flows/runs/${runId}/tasks/${taskId}/approval`
}

async function approvalCount(db: Awaited<ReturnType<typeof publishWaiting>>['db']) {
  const rows = await db.select().from(flowRunApprovals).all()
  return rows.length
}

describe('HITL approve route', () => {
  it('rejects unauthorized approve and writes no decision row', async () => {
    const { app, env, db, headers, runId } = await publishWaiting()
    const body = JSON.stringify({ decision: 'approved' })
    const url = approvalUrl(runId)

    const anon = await app.request(
      url,
      { method: 'POST', body, headers: { 'content-type': 'application/json' } },
      env,
    )
    await expectError(anon, 401, 'UNAUTHORIZED')

    const minted = await mintApiKey(db, 'user_staff', {
      organizationId: ORG_ACME,
      name: 'flows-sk-approve',
      scopes: ['read', 'write', 'admin'],
    })
    const sk = await app.request(
      url,
      { method: 'POST', headers: bearerHeaders(minted.key), body },
      env,
    )
    await expectError(sk, 403, 'FORBIDDEN')

    const memberCookie = await login(app, env, MEMBER_EMAIL)
    const member = await app.request(
      url,
      { method: 'POST', headers: sessionHeaders(memberCookie, ORG_ACME), body },
      env,
    )
    await expectError(member, 403, 'FORBIDDEN')

    await seedOperatorWriteOnAcme(db)
    const operatorCookie = await login(app, env, MEMBER_EMAIL)
    const operator = await app.request(
      url,
      { method: 'POST', headers: sessionHeaders(operatorCookie, ORG_ACME), body },
      env,
    )
    await expectError(operator, 403, 'FORBIDDEN')

    await insertTeamPlanAndRun(db, { planId: 'plan_stolen_approve', runId: 'run_stolen_approve' })
    const stolen = await app.request(
      approvalUrl('run_stolen_approve'),
      { method: 'POST', headers, body },
      env,
    )
    await expectError(stolen, 404, 'NOT_FOUND')

    expect(await approvalCount(db)).toBe(0)
    const row = await db.select().from(flowRuns).where(eq(flowRuns.id, runId)).all()
    expect(row[0]?.status).toBe('running')
    expect(row[0]?.receiptJson).toBe(WAITING)
  })

  it('authorized approve writes the row, wakes, and unblocks the downstream invoke', async () => {
    const { app, env, db, headers, runId } = await publishWaiting()
    await db
      .update(flowRuns)
      .set({ status: 'queued', receiptJson: null, workflowInstanceId: null })
      .where(eq(flowRuns.id, runId))
      .run()
    const instance = workflowInstanceStub(runId)
    env.FLOW_RUN.get = vi.fn(async () => instance)
    let release: (value: 'event') => void = () => {}
    const woke = new Promise<'event'>((resolve) => {
      release = resolve
    })
    let invokes = 0
    const driving = driveFlowRun({
      step: async (_name, fn) => fn(),
      db: env.DB as unknown as D1Database,
      invoke: async () => {
        invokes += 1
        return { output: 'after-approve' }
      },
      awaitApproval: async () => woke,
      payload: { runId, orgId: ORG_ACME },
      instanceId: runId,
    })
    let waiting = false
    for (let i = 0; i < 50 && !waiting; i++) {
      const rows = await db.select().from(flowRuns).where(eq(flowRuns.id, runId)).all()
      waiting = rows[0]?.receiptJson?.includes('"waiting"') ?? false
      if (!waiting) await new Promise((r) => setTimeout(r, 5))
    }
    expect(waiting).toBe(true)

    const res = await app.request(
      approvalUrl(runId),
      { method: 'POST', headers, body: JSON.stringify({ decision: 'approved' }) },
      env,
    )
    expect(res.status).toBe(202)
    const body = (await res.json()) as {
      runId: string
      taskId: string
      decision: string
      woken: boolean
    }
    expect(body).toMatchObject({ runId, taskId: 'gate', decision: 'approved', woken: true })
    expect(instance.sent).toEqual([{ type: await flowApprovalEventType('gate'), payload: {} }])
    expect(await approvalCount(db)).toBe(1)

    const again = await app.request(
      approvalUrl(runId),
      { method: 'POST', headers, body: JSON.stringify({ decision: 'rejected' }) },
      env,
    )
    await expectError(again, 409, 'CONFLICT')
    expect(instance.sent).toEqual([{ type: await flowApprovalEventType('gate'), payload: {} }])
    expect(await approvalCount(db)).toBe(1)

    release('event')
    await driving
    const row = await db.select().from(flowRuns).where(eq(flowRuns.id, runId)).all()
    expect(row[0]?.status).toBe('succeeded')
    const tasks = JSON.parse(row[0]?.receiptJson ?? '{}').tasks
    expect(tasks.gate.outcome).toBe('ok')
    expect(tasks.gate.approval.by).toBe('user_staff')
    expect(tasks.gate.approval.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(tasks.echo_hello.outcome).toBe('ok')
    expect(invokes).toBe(1)
  })

  it('re-sends a failed wake on a same-decision repeat', async () => {
    const { app, env, db, headers, runId } = await publishWaiting()
    env.FLOW_RUN.get = vi.fn(async () => {
      throw new Error('workflow binding down')
    })
    const first = await app.request(
      approvalUrl(runId),
      { method: 'POST', headers, body: JSON.stringify({ decision: 'approved' }) },
      env,
    )
    expect(first.status).toBe(202)
    expect((await first.json()) as { woken: boolean; decision: string }).toMatchObject({
      woken: false,
      decision: 'approved',
    })
    expect(await approvalCount(db)).toBe(1)

    const instance = workflowInstanceStub(runId)
    env.FLOW_RUN.get = vi.fn(async () => instance)
    const repeated = await app.request(
      approvalUrl(runId),
      { method: 'POST', headers, body: JSON.stringify({ decision: 'approved' }) },
      env,
    )
    expect(repeated.status).toBe(200)
    expect((await repeated.json()) as { woken: boolean; decision: string }).toMatchObject({
      woken: true,
      decision: 'approved',
    })
    expect(instance.sent).toEqual([{ type: await flowApprovalEventType('gate'), payload: {} }])
    const row = await db.select().from(flowRuns).where(eq(flowRuns.id, runId)).all()
    expect(row[0]?.status).toBe('running')
  })

  it('re-sends a failed rejected-decision wake on a same-decision repeat', async () => {
    const { app, env, db, headers, runId } = await publishWaiting()
    const failedWake = vi.fn(async () => {
      throw new Error('workflow binding down')
    })
    env.FLOW_RUN.get = failedWake
    const first = await app.request(
      approvalUrl(runId),
      { method: 'POST', headers, body: JSON.stringify({ decision: 'rejected' }) },
      env,
    )
    expect(first.status).toBe(202)
    expect((await first.json()) as { woken: boolean; decision: string }).toMatchObject({
      woken: false,
      decision: 'rejected',
    })
    expect(failedWake).toHaveBeenCalledOnce()
    expect(failedWake).toHaveBeenCalledWith(runId)
    expect(await approvalCount(db)).toBe(1)

    const instance = workflowInstanceStub(runId)
    env.FLOW_RUN.get = vi.fn(async () => instance)
    const repeated = await app.request(
      approvalUrl(runId),
      { method: 'POST', headers, body: JSON.stringify({ decision: 'rejected' }) },
      env,
    )
    expect(repeated.status).toBe(200)
    expect((await repeated.json()) as { woken: boolean; decision: string }).toMatchObject({
      woken: true,
      decision: 'rejected',
    })
    expect(instance.sent).toEqual([{ type: await flowApprovalEventType('gate'), payload: {} }])
  })

  it('does not wake an expired decision row while the task still waits', async () => {
    const { app, env, db, headers, runId } = await publishWaiting()
    await db
      .insert(flowRunApprovals)
      .values({
        id: 'appr_expired_rewake',
        orgId: ORG_ACME,
        runId,
        taskId: 'gate',
        decision: 'expired',
        decidedBy: 'system',
        decidedAt: Date.now(),
      })
      .run()
    const instance = workflowInstanceStub(runId)
    env.FLOW_RUN.get = vi.fn(async () => instance)

    const repeated = await app.request(
      approvalUrl(runId),
      { method: 'POST', headers, body: JSON.stringify({ decision: 'approved' }) },
      env,
    )
    await expectError(repeated, 409, 'CONFLICT', 'Approval already decided')
    expect(env.FLOW_RUN.get).not.toHaveBeenCalled()
    expect(instance.sent).toEqual([])
  })

  it('does not re-send after the approved task stops waiting', async () => {
    const { app, env, db, headers, runId } = await publishWaiting()
    env.FLOW_RUN.get = vi.fn(async () => {
      throw new Error('workflow binding down')
    })
    const first = await app.request(
      approvalUrl(runId),
      { method: 'POST', headers, body: JSON.stringify({ decision: 'approved' }) },
      env,
    )
    expect(first.status).toBe(202)
    expect((await first.json()) as { woken: boolean; decision: string }).toMatchObject({
      woken: false,
      decision: 'approved',
    })
    expect(await approvalCount(db)).toBe(1)
    await db
      .update(flowRuns)
      .set({
        receiptJson: JSON.stringify({
          receiptVersion: 1,
          tokensUsed: 0,
          tasks: { gate: { taskId: 'gate', outcome: 'ok' } },
        }),
      })
      .where(eq(flowRuns.id, runId))
      .run()
    const instance = workflowInstanceStub(runId)
    env.FLOW_RUN.get = vi.fn(async () => instance)

    const repeated = await app.request(
      approvalUrl(runId),
      { method: 'POST', headers, body: JSON.stringify({ decision: 'approved' }) },
      env,
    )
    await expectError(repeated, 409, 'CONFLICT', 'Task is not waiting for approval')
    expect(env.FLOW_RUN.get).not.toHaveBeenCalled()
    expect(instance.sent).toEqual([])
  })
})

describe('HITL approve guards', () => {
  it('denies a super_admin who is only an operator member', async () => {
    const { app, env, db, runId } = await publishWaiting()
    await seedOperatorWriteOnAcme(db)
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
    const res = await app.request(
      approvalUrl(runId),
      {
        method: 'POST',
        headers: sessionHeaders(superCookie, ORG_ACME),
        body: JSON.stringify({ decision: 'approved' }),
      },
      env,
    )
    await expectError(res, 403, 'FORBIDDEN')
    expect(await approvalCount(db)).toBe(0)
  })

  it('404s a cross-org approval repeat without sending another wake', async () => {
    const { app, env, db, headers } = await publishWaiting()
    const registry = createToolRegistry('reg-idor', [
      { name: 'echo', description: 'Echo', grantClass: 'mintable' },
    ])
    const minted = mintCapabilityGrant({
      orgId: ORG_TEAM,
      registry,
      facts: { moduleEffective: true, canRead: true, canWrite: true, allowedModels: [] },
    })
    if (!minted.ok) throw new Error(minted.message)
    const snap = createRunSnapshot({
      plan: loadPlanFromYaml(APPROVE_YAML),
      grant: minted.grant,
      registry,
      actorId: 'user_team_owner',
    })
    if (!snap.ok) throw new Error(snap.issues.map((i) => i.code).join(','))
    const stolen = 'run_stolen_valid'
    await insertTeamPlanAndRun(db, { planId: 'plan_stolen_valid', runId: stolen })
    await db
      .update(flowRuns)
      .set({
        status: 'running',
        snapshotJson: JSON.stringify(snap.runnerView),
        planDigest: snap.runnerView.planDigest,
        receiptJson: WAITING,
      })
      .where(eq(flowRuns.id, stolen))
      .run()
    const instance = workflowInstanceStub(stolen)
    env.FLOW_RUN.get = vi.fn(async () => instance)
    const teamHeaders = sessionHeaders(await login(app, env, MEMBER_EMAIL), ORG_TEAM)
    const first = await app.request(
      approvalUrl(stolen),
      { method: 'POST', headers: teamHeaders, body: JSON.stringify({ decision: 'approved' }) },
      env,
    )
    expect(first.status).toBe(202)

    const res = await app.request(
      approvalUrl(stolen),
      { method: 'POST', headers, body: JSON.stringify({ decision: 'approved' }) },
      env,
    )
    await expectError(res, 404, 'NOT_FOUND')
    expect(instance.sent).toEqual([{ type: await flowApprovalEventType('gate'), payload: {} }])
    expect(env.FLOW_RUN.get).toHaveBeenCalledTimes(1)
    expect(await approvalCount(db)).toBe(1)
    const row = await db.select().from(flowRuns).where(eq(flowRuns.id, stolen)).all()
    expect(row[0]?.status).toBe('running')
    expect(row[0]?.receiptJson).toBe(WAITING)
  })

  it('409s queued, missing receipt, and ok receipt; 404s non-approve and unknown tasks', async () => {
    const { app, env, db, headers, runId } = await publishWaiting()
    const body = JSON.stringify({ decision: 'approved' })
    await db.update(flowRuns).set({ status: 'queued' }).where(eq(flowRuns.id, runId)).run()
    await expectError(
      await app.request(approvalUrl(runId), { method: 'POST', headers, body }, env),
      409,
      'CONFLICT',
    )
    await db
      .update(flowRuns)
      .set({ status: 'running', receiptJson: null })
      .where(eq(flowRuns.id, runId))
      .run()
    await expectError(
      await app.request(approvalUrl(runId), { method: 'POST', headers, body }, env),
      409,
      'CONFLICT',
    )
    await db
      .update(flowRuns)
      .set({
        receiptJson: JSON.stringify({
          receiptVersion: 1,
          tokensUsed: 0,
          tasks: { gate: { taskId: 'gate', outcome: 'ok' } },
        }),
      })
      .where(eq(flowRuns.id, runId))
      .run()
    await expectError(
      await app.request(approvalUrl(runId), { method: 'POST', headers, body }, env),
      409,
      'CONFLICT',
    )
    await db.update(flowRuns).set({ receiptJson: WAITING }).where(eq(flowRuns.id, runId)).run()
    await expectError(
      await app.request(approvalUrl(runId, 'echo_hello'), { method: 'POST', headers, body }, env),
      404,
      'NOT_FOUND',
    )
    await expectError(
      await app.request(approvalUrl(runId, 'missing_task'), { method: 'POST', headers, body }, env),
      404,
      'NOT_FOUND',
    )
    expect(await approvalCount(db)).toBe(0)
  })

  it('rejects a bad decision body with 400 and no row', async () => {
    const { app, env, db, headers, runId } = await publishWaiting()
    for (const body of [{ decision: 'yes' }, { decision: 'approved', extra: true }, {}]) {
      const res = await app.request(
        approvalUrl(runId),
        { method: 'POST', headers, body: JSON.stringify(body) },
        env,
      )
      await expectError(res, 400, 'VALIDATION_ERROR')
    }
    expect(await approvalCount(db)).toBe(0)
  })

  it('records a route rejection and the driver fails closed without invoking', async () => {
    const { app, env, db, headers, runId } = await publishWaiting()
    const instance = workflowInstanceStub(runId)
    env.FLOW_RUN.get = vi.fn(async () => instance)
    const res = await app.request(
      approvalUrl(runId),
      { method: 'POST', headers, body: JSON.stringify({ decision: 'rejected' }) },
      env,
    )
    expect(res.status).toBe(202)
    const rows = await db.select().from(flowRunApprovals).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.decision).toBe('rejected')
    let invokes = 0
    await expect(
      driveFlowRun({
        step: async (_n, fn) => fn(),
        db: env.DB as unknown as D1Database,
        invoke: async () => {
          invokes += 1
          return {}
        },
        awaitApproval: async () => {
          throw new Error('row already decided')
        },
        payload: { runId, orgId: ORG_ACME },
        instanceId: runId,
      }),
    ).rejects.toThrow(/APPROVAL_REJECTED/)
    expect(invokes).toBe(0)
  })

  it('409s a decision after the driver expired the wait', async () => {
    const { app, env, db, headers, runId } = await publishWaiting()
    await db
      .update(flowRuns)
      .set({ status: 'queued', receiptJson: null })
      .where(eq(flowRuns.id, runId))
      .run()
    await expect(
      driveFlowRun({
        step: async (_n, fn) => fn(),
        db: env.DB as unknown as D1Database,
        invoke: async () => ({ output: 'no' }),
        awaitApproval: async () => 'timeout',
        payload: { runId, orgId: ORG_ACME },
        instanceId: runId,
      }),
    ).rejects.toThrow(/APPROVAL_TIMEOUT/)
    const res = await app.request(
      approvalUrl(runId),
      { method: 'POST', headers, body: JSON.stringify({ decision: 'approved' }) },
      env,
    )
    await expectError(res, 409, 'CONFLICT')
    const approvals = await db.select().from(flowRunApprovals).all()
    expect(approvals).toHaveLength(1)
    expect(approvals[0]?.decision).toBe('expired')
    const row = await db.select().from(flowRuns).where(eq(flowRuns.id, runId)).all()
    expect(row[0]?.errorCode).toBe('APPROVAL_TIMEOUT')
  })

  it('forbids an api_key call on the service and writes no row', async () => {
    const { db, env, runId } = await publishWaiting()
    await expect(
      decideRunApproval(db, env, {
        orgId: ORG_ACME,
        runId,
        taskId: 'gate',
        subject: 'user_staff',
        orgRole: 'admin',
        authMethod: 'api_key',
        body: { decision: 'approved' },
      }),
    ).rejects.toMatchObject({ status: 403 })
    expect(await approvalCount(db)).toBe(0)
  })
})
