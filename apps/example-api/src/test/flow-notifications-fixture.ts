import { baMember } from '@kit/auth/schema'
import { listInbox } from '@kit/notifications/repos'
import { and, eq } from 'drizzle-orm'
import { expect } from 'vitest'
import * as z from 'zod'
import { flowRuns } from '../db/schema'
import { createAppNotificationService } from '../services/notifications/app'
import { createFlowApprovalNotificationPorts } from '../services/notifications/flow-producer'
import { sessionHeaders } from './api-fixture'
import { enableFlowsForOrgs, login, ORG_ACME, STAFF_EMAIL, seedFlowsApp } from './flows-fixture'
import { createRecordingNotificationRuntime } from './notification-runtime'

const yaml = `flows: v0
plan:
  id: notifications-two-gates
permits:
  tools: []
tasks:
  first:
    approve: {}
  second:
    approve: {}
`
export const waiting = JSON.stringify({
  receiptVersion: 1,
  tokensUsed: 0,
  tasks: {
    first: { taskId: 'first', outcome: 'waiting' },
    second: { taskId: 'second', outcome: 'waiting' },
  },
})

export async function setupFlowNotifications() {
  const f = await seedFlowsApp()
  await enableFlowsForOrgs(f.db, [ORG_ACME])
  await f.db
    .update(baMember)
    .set({ role: 'owner' })
    .where(and(eq(baMember.organizationId, ORG_ACME), eq(baMember.userId, 'user_staff')))
  const headers = sessionHeaders(await login(f.app, f.env, STAFF_EMAIL), ORG_ACME)
  const plan = await f.app.request(
    '/api/flows/plans',
    { method: 'POST', headers, body: JSON.stringify({ yaml }) },
    f.env,
  )
  expect(plan.status).toBe(201)
  const {
    plan: { id: planId },
  } = z.object({ plan: z.object({ id: z.string() }) }).parse(await plan.json())
  const created = await f.app.request(
    `/api/flows/plans/${planId}/runs`,
    { method: 'POST', headers, body: '{}' },
    f.env,
  )
  expect(created.status).toBe(202)
  const {
    run: { id: runId },
  } = z.object({ run: z.object({ id: z.string() }) }).parse(await created.json())
  await f.db
    .update(flowRuns)
    .set({ status: 'running', receiptJson: waiting, workflowInstanceId: runId })
    .where(eq(flowRuns.id, runId))
  const notifications = createAppNotificationService(
    f.db,
    createRecordingNotificationRuntime().runtime,
  )
  const ports = createFlowApprovalNotificationPorts(f.db, notifications)
  const notice = (taskId: string) => ({ orgId: ORG_ACME, runId, taskId })
  const inbox = () =>
    listInbox(
      f.db,
      { orgId: ORG_ACME, userId: 'user_staff', readableModuleIds: ['flows'] },
      { unreadOnly: false },
    )
  return { ...f, headers, runId, notifications, ports, notice, inbox }
}
