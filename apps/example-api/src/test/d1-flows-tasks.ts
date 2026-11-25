import { claimRun, persistRunBundle } from '@kit/flows/repos'
import { expect } from 'vitest'
import type { KitDb } from '../lib/db-type'
import { createNotificationDeliveryRuntime } from '../notifications-delivery/admission'
import { mintApiKey } from '../services/auth'
import { createAppNotificationService } from '../services/notifications/app'
import { createFlowApprovalNotificationPorts } from '../services/notifications/flow-producer'
import { type ApiEnv, bearerHeaders, sessionHeaders } from './api-fixture'
import { createRouteFixture, type Probe } from './d1-route-fixture'
import { enableFlowsForOrgs, login, ORG_ACME, STAFF_EMAIL } from './flows-fixture'
import { workflowInstanceStub } from './memory-env'

const approvalYaml = `flows: v0
plan:
  id: d1-approval-budget
permits:
  tools: []
tasks:
  gate:
    approve: {}
`

const boardKey = 'main'
const assignee = 'user_team_owner'

function withAuth(probe: Probe, headers: HeadersInit, variant?: string): Probe {
  return (route, ceiling, options) => probe(route, ceiling, { ...options, headers, variant })
}

async function measureFlows(db: KitDb, env: ApiEnv, probe: Probe) {
  await enableFlowsForOrgs(db, [ORG_ACME])
  const body = { yaml: approvalYaml }
  await probe('POST /api/flows/plans/check', 8, { body })
  const created = await probe('POST /api/flows/plans', 10, { body, status: 201 })
  const { plan } = (await created.json()) as { plan: { id: string } }
  const plans = await probe('GET /api/flows/plans', 5)
  expect(await plans.json()).toMatchObject({ plans: expect.arrayContaining([plan]) })
  const planPath = `/api/flows/plans/${plan.id}`
  const detail = await probe('GET /api/flows/plans/:planId', 2, { path: planPath })
  expect(await detail.json()).toMatchObject({ plan })

  const queued = await probe('POST /api/flows/plans/:planId/runs', 10, {
    path: `${planPath}/runs`,
    body: {},
    status: 202,
  })
  const { run } = (await queued.json()) as { run: { id: string; status: string } }
  expect(run.status).toBe('queued')
  const runId = run.id
  const runPath = `/api/flows/runs/${runId}`
  const runs = await probe('GET /api/flows/runs', 2)
  expect(await runs.json()).toMatchObject({
    runs: expect.arrayContaining([expect.objectContaining(run)]),
  })

  // Workflow runner preconditions are written outside the measured HTTP requests.
  const workflow = workflowInstanceStub(runId)
  env.FLOW_RUN.get = async (id) => {
    expect(id).toBe(runId)
    return workflow
  }
  expect(await claimRun(db, { orgId: ORG_ACME, runId, instanceId: runId })).toBe(1)
  expect(
    await persistRunBundle(db, {
      orgId: ORG_ACME,
      runId,
      status: 'running',
      receiptJson: JSON.stringify({
        receiptVersion: 1,
        tokensUsed: 0,
        tasks: { gate: { taskId: 'gate', outcome: 'waiting' } },
      }),
    }),
  ).toBe(1)
  const notices = createFlowApprovalNotificationPorts(
    db,
    createAppNotificationService(db, createNotificationDeliveryRuntime(db, env)),
  )
  const taskId = 'gate'
  await notices.opened({ orgId: ORG_ACME, runId, taskId })

  const running = await probe('GET /api/flows/runs/:runId', 5, { path: runPath })
  expect(await running.json()).toMatchObject({ run: { id: runId, status: 'running' } })
  const approval = await probe('POST /api/flows/runs/:runId/tasks/:taskId/approval', 4, {
    path: `${runPath}/tasks/${taskId}/approval`,
    body: { decision: 'approved' },
    status: 202,
  })
  expect(await approval.json()).toMatchObject({ runId, taskId, decision: 'approved', woken: true })
  const cancelled = await probe('POST /api/flows/runs/:runId/cancel', 5, {
    path: `${runPath}/cancel`,
    body: {},
  })
  expect(await cancelled.json()).toMatchObject({ run: { id: runId, status: 'cancelled' } })
  expect(workflow.terminated).toBe(1)
  const disabled = await probe('PATCH /api/flows/plans/:planId', 4, {
    path: planPath,
    body: { enabled: false },
  })
  expect(await disabled.json()).toMatchObject({ plan: { id: plan.id, enabled: false } })
}

async function measureTasks(probe: Probe, anchorId: string) {
  const stages = await probe('GET /api/tasks/stages', 3, {
    path: `/api/tasks/stages?boardKey=${boardKey}`,
  })
  expect(await stages.json()).toMatchObject({
    stages: expect.arrayContaining([expect.objectContaining({ boardKey, isDefault: true })]),
  })
  const created = await probe('POST /api/tasks', 29, {
    body: { title: 'Task budget', boardKey, visibility: 'shared', assigneeIds: [assignee] },
    status: 201,
  })
  const { task } = (await created.json()) as { task: { id: string; assigneeIds: string[] } }
  expect(task.assigneeIds).toEqual([assignee])
  const taskPath = `/api/tasks/${task.id}`
  const tasks = await probe('GET /api/tasks', 4)
  expect(await tasks.json()).toMatchObject({
    tasks: expect.arrayContaining([
      expect.objectContaining(task),
      expect.objectContaining({ id: anchorId }),
    ]),
  })
  const detail = await probe('GET /api/tasks/:id', 3, { path: taskPath })
  expect(await detail.json()).toMatchObject({ task })

  const linkBody = { fromTaskId: task.id, toTaskId: anchorId, kind: 'blocks' }
  const linked = await probe('POST /api/tasks/links', 7, { status: 201, body: linkBody })
  expect(await linked.json()).toMatchObject({ link: linkBody })
  const links = await probe('GET /api/tasks/links', 3)
  expect(await links.json()).toMatchObject({
    links: expect.arrayContaining([expect.objectContaining(linkBody)]),
  })

  const commentPath = `${taskPath}/comments`
  const added = await probe('POST /api/tasks/:id/comments', 4, {
    path: commentPath,
    body: { body: 'Task budget comment', visibility: 'shared' },
    status: 201,
  })
  const { comment } = (await added.json()) as { comment: { id: string } }
  const comments = await probe('GET /api/tasks/:id/comments', 3, { path: commentPath })
  expect(await comments.json()).toMatchObject({ comments: expect.arrayContaining([comment]) })
  await probe('DELETE /api/tasks/comments/:commentId', 3, {
    path: `/api/tasks/comments/${comment.id}`,
  })
  const updated = await probe('PATCH /api/tasks/:id', 9, {
    path: taskPath,
    body: { done: true },
  })
  expect(await updated.json()).toMatchObject({ task: { id: task.id, done: true } })
  await probe('DELETE /api/tasks/:id', 10, { path: taskPath })
}

export async function measureFlowsAndTasks(record: Set<string>) {
  const { app, env, db, probe } = await createRouteFixture(record)
  const headers = sessionHeaders(await login(app, env, STAFF_EMAIL), ORG_ACME)
  const sessionProbe = withAuth(probe, headers)
  await measureFlows(db, env, sessionProbe)

  // Both task scenarios link to the same real task; setup HTTP is not measured.
  const anchor = await app.request(
    '/api/tasks',
    { method: 'POST', headers, body: JSON.stringify({ title: 'Link target', boardKey }) },
    env,
  )
  expect(anchor.status).toBe(201)
  const { task } = (await anchor.json()) as { task: { id: string } }
  const { key } = await mintApiKey(db, 'user_staff', {
    organizationId: ORG_ACME,
    scopes: ['read', 'write'],
  })
  await measureTasks(sessionProbe, task.id)
  await measureTasks(withAuth(probe, bearerHeaders(key, ORG_ACME), 'api-key'), task.id)
}
