import { AppError, createLogger, parseOrThrow } from '@kit/core'
import { canCancelFlowRun, isApproveTask, parseRunnerView, readRunRollup } from '@kit/flows'
import * as flowsRepo from '@kit/flows/repos'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../db/schema'
import type { Env } from '../env'
import { cancelRunBodySchema } from '../lib/flows-body-schemas'
import { createAppNotificationResolver } from './notifications/app'
import { resolveFlowApproval } from './notifications/flow-producer'

type Db = DrizzleD1Database<typeof schema>
type RunRow = typeof import('../db/schema').flowRuns.$inferSelect

const log = createLogger({ service: 'example-api', component: 'flows-cancel' })

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
async function repairCancelledApprovals(db: Db, row: RunRow): Promise<void> {
  let taskIds: string[]
  try {
    const parsed = parseRunnerView(JSON.parse(row.snapshotJson) as unknown)
    if (!parsed.ok || parsed.runnerView.orgId !== row.orgId) throw new Error('INVALID_RUNNER_VIEW')
    taskIds = Object.keys(parsed.runnerView.sealedPlan.tasks).filter((taskId) =>
      isApproveTask(parsed.runnerView, taskId),
    )
  } catch {
    log.error('flow_cancel_notification_snapshot_failed', {
      orgId: row.orgId,
      runId: row.id,
      code: 'APPROVAL_NOTIFICATION_FAILED',
    })
    return
  }
  const notifications = createAppNotificationResolver(db)
  for (const taskId of taskIds) {
    try {
      await resolveFlowApproval(notifications, { orgId: row.orgId, runId: row.id, taskId })
    } catch {
      log.error('flow_cancel_notification_resolve_failed', {
        orgId: row.orgId,
        runId: row.id,
        taskId,
        code: 'APPROVAL_NOTIFICATION_FAILED',
      })
    }
  }
}

function toPublicRun(row: RunRow) {
  const rollup = readRunRollup({
    status: row.status,
    receiptJson: row.receiptJson,
    errorCode: row.errorCode,
  })
  return {
    id: row.id,
    orgId: row.orgId,
    planId: row.planId,
    status: rollup.status,
    receipts: rollup.receipts,
    errorCode: rollup.errorCode ?? null,
  }
}

export async function cancelFlowRun(
  db: Db,
  env: Pick<Env, 'FLOW_RUN'>,
  input: {
    orgId: string
    runId: string
    orgRole: string | null | undefined
    authMethod: 'session' | 'api_key' | null | undefined
    body: unknown
  },
) {
  if (!canCancelFlowRun({ orgRole: input.orgRole, authMethod: input.authMethod })) {
    throw AppError.forbidden()
  }
  parseOrThrow(cancelRunBodySchema, input.body)
  const existing = await flowsRepo.getRun(db, input.runId, input.orgId)
  if (!existing) throw AppError.notFound()
  if (existing.status === 'cancelled') {
    await repairCancelledApprovals(db, existing)
    return toPublicRun(existing)
  }
  if (existing.status === 'succeeded' || existing.status === 'failed') {
    throw AppError.conflict('Run is already terminal')
  }
  const changes = await flowsRepo.cancelRun(db, { id: input.runId, orgId: input.orgId })
  if (changes === 0) {
    const again = await flowsRepo.getRun(db, input.runId, input.orgId)
    if (!again) throw AppError.notFound()
    if (again.status === 'cancelled') {
      await repairCancelledApprovals(db, again)
      return toPublicRun(again)
    }
    if (again.status === 'succeeded' || again.status === 'failed') {
      throw AppError.conflict('Run is already terminal')
    }
    throw AppError.conflict('Run could not be cancelled')
  }
  await repairCancelledApprovals(db, existing)
  try {
    const instance = await env.FLOW_RUN.get(input.runId)
    await instance.terminate()
  } catch (err) {
    log.error('flow_run_terminate_failed', {
      runId: input.runId,
      orgId: input.orgId,
      error: errorMessage(err),
    })
  }
  const cancelled = await flowsRepo.getRun(db, input.runId, input.orgId)
  if (!cancelled) throw AppError.notFound()
  return toPublicRun(cancelled)
}
