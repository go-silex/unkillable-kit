import { AppError, createLogger, parseOrThrow } from '@kit/core'
import {
  canDecideFlowApproval,
  flowApprovalEventType,
  isApproveTask,
  parseRunnerView,
} from '@kit/flows'
import * as flowsRepo from '@kit/flows/repos'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../db/schema'
import type { Env } from '../env'
import { approvalDecisionBodySchema } from '../lib/flows-body-schemas'
import { createAppNotificationResolver } from './notifications/app'
import { resolveFlowApproval } from './notifications/flow-producer'

type Db = DrizzleD1Database<typeof schema>

const log = createLogger({ service: 'example-api', component: 'flows-approval' })

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
async function repairApprovalNotification(
  db: Db,
  input: { orgId: string; runId: string; taskId: string },
): Promise<void> {
  try {
    await resolveFlowApproval(createAppNotificationResolver(db), input)
  } catch {
    log.error('flow_approval_notification_resolve_failed', {
      orgId: input.orgId,
      runId: input.runId,
      taskId: input.taskId,
      code: 'APPROVAL_NOTIFICATION_FAILED',
    })
  }
}

async function wakeFlowApproval(
  env: Pick<Env, 'FLOW_RUN'>,
  input: { orgId: string; runId: string; taskId: string },
): Promise<boolean> {
  try {
    const instance = await env.FLOW_RUN.get(input.runId)
    await instance.sendEvent({ type: await flowApprovalEventType(input.taskId), payload: {} })
    return true
  } catch (err) {
    log.error('flow_approval_wake_failed', {
      runId: input.runId,
      orgId: input.orgId,
      taskId: input.taskId,
      error: errorMessage(err),
    })
    return false
  }
}

export async function decideRunApproval(
  db: Db,
  env: Pick<Env, 'FLOW_RUN'>,
  input: {
    orgId: string
    runId: string
    taskId: string
    subject: string
    orgRole: string | null | undefined
    authMethod: 'session' | 'api_key' | null | undefined
    body: unknown
  },
) {
  if (
    !canDecideFlowApproval({
      orgRole: input.orgRole,
      authMethod: input.authMethod,
    })
  ) {
    throw AppError.forbidden()
  }
  const { decision } = parseOrThrow(approvalDecisionBodySchema, input.body)
  const run = await flowsRepo.getRun(db, input.runId, input.orgId)
  if (!run) throw AppError.notFound()
  let snapshot: unknown
  try {
    snapshot = JSON.parse(run.snapshotJson) as unknown
  } catch {
    throw AppError.notFound()
  }
  const view = parseRunnerView(snapshot)
  if (!(view.ok && isApproveTask(view.runnerView, input.taskId))) throw AppError.notFound()
  const recorded = await flowsRepo.recordRunApproval(db, {
    orgId: input.orgId,
    runId: input.runId,
    taskId: input.taskId,
    decision,
    decidedBy: input.subject,
  })
  if (!recorded.ok) {
    if (recorded.reason === 'not_found') throw AppError.notFound()
    const existing = await flowsRepo.getRunApproval(db, {
      orgId: input.orgId,
      runId: input.runId,
      taskId: input.taskId,
    })
    if (existing) await repairApprovalNotification(db, input)
    if (recorded.reason === 'conflict') {
      if (existing?.decision === decision) {
        return {
          runId: input.runId,
          taskId: input.taskId,
          decision,
          woken: await wakeFlowApproval(env, input),
          status: 200 as const,
        }
      }
      throw AppError.conflict('Approval already decided')
    }
    throw AppError.conflict('Task is not waiting for approval')
  }
  await repairApprovalNotification(db, input)
  return {
    runId: input.runId,
    taskId: input.taskId,
    decision,
    woken: await wakeFlowApproval(env, input),
    status: 202 as const,
  }
}
