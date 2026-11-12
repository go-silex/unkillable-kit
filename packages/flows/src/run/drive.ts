/** Snapshot-only driver. Dispatch is interpret.readyTaskIds only. */

import { z } from 'zod'
import type { interpretRun } from '../interpret'
import { emptyBundle, parseReceipts, type ReceiptBundle } from '../receipts'
import { parseRunnerView } from '../snapshot'
import type { ApprovalNotificationPorts, AwaitApprovalPort } from './approve-step'
import { driveWaves } from './drive-waves'
import { DriveNonRetryableError } from './errors'
import { claimRun, closeOwnedRun, loadRun as defaultLoadRun, persistBundle } from './persist'
import {
  commitReceipts,
  type DriveStep,
  failStartedTasks,
  type InferPort,
  type InvokePort,
  noRetry,
  type StepReceiptCtx,
} from './step-io'

export { DriveNonRetryableError } from './errors'
export type { AwaitApprovalPort, DriveStep, InferPort, InvokePort }

const paramsSchema = z
  .object({
    runId: z.string().min(1).max(100),
    orgId: z.string().min(1).max(256),
  })
  .strict()

const instanceIdSchema = z.string().min(1).max(128)

function parseSnapshot(raw: string) {
  try {
    return parseRunnerView(JSON.parse(raw) as unknown)
  } catch {
    return {
      ok: false as const,
      issues: [{ code: 'RUNNER_VIEW_INVALID', message: 'snapshot_json is not JSON' }],
    }
  }
}

async function writeBundle(
  step: DriveStep,
  io: StepReceiptCtx,
  name: string,
  input: { status: string; bundle: ReceiptBundle; errorCode?: string | null },
): Promise<void> {
  await step(name, () => commitReceipts(io, input), noRetry)
}

async function failClosed(
  step: DriveStep,
  io: StepReceiptCtx,
  name: string,
  errorCode: string,
  bundle: ReceiptBundle = emptyBundle(),
): Promise<never> {
  await writeBundle(step, io, name, { status: 'failed', bundle, errorCode })
  throw new DriveNonRetryableError(errorCode)
}

const closeRetries = { retries: { limit: 3 } } as const

function closeStartedReceipts(raw: string | null) {
  if (!raw) return null
  try {
    const parsed = parseReceipts(JSON.parse(raw) as unknown)
    return parsed.ok ? failStartedTasks(parsed.receipts) : null
  } catch {
    // Preserve malformed receipt bytes while closing the run.
    return null
  }
}

async function rejectChangedClose(io: StepReceiptCtx, instanceId: string): Promise<void> {
  const current = await defaultLoadRun(io.db, io.ids.runId, io.ids.orgId)
  if (
    current &&
    (current.workflow_instance_id === null || current.workflow_instance_id === instanceId)
  ) {
    throw new Error('close snapshot changed')
  }
}

/** Close an open run or scrub its terminal receipt, fenced to its owner. */
async function closeFailedRun(
  step: DriveStep,
  io: StepReceiptCtx,
  instanceId: string,
): Promise<void> {
  await step(
    'persist:receipt-lost',
    async () => {
      const row = await defaultLoadRun(io.db, io.ids.runId, io.ids.orgId)
      if (!row) return
      if (row.workflow_instance_id !== null && row.workflow_instance_id !== instanceId) return
      const closed = closeStartedReceipts(row.receipt_json)
      const open = row.status === 'queued' || row.status === 'running'
      if (!(open || closed?.lost)) return
      const changes = await closeOwnedRun(io.db, {
        ...io.ids,
        instanceId,
        beforeReceiptJson: row.receipt_json,
        receiptJson: closed?.lost ? JSON.stringify(closed.bundle) : row.receipt_json,
        errorCode: closed?.lost ? 'RECEIPT_LOST' : null,
      })
      if (changes !== 1) await rejectChangedClose(io, instanceId)
    },
    closeRetries,
  )
}

async function closeAndRethrow(
  step: DriveStep,
  io: StepReceiptCtx,
  instanceId: string,
  error: unknown,
): Promise<never> {
  try {
    await closeFailedRun(step, io, instanceId)
  } catch {
    // The workflow must retain the original error even if closure exhausts its retries.
  }
  throw error
}

export type DriveFlowRunInput = {
  step: DriveStep
  db: D1Database
  invoke: InvokePort
  infer?: InferPort
  hasTool?: (name: string) => boolean
  /** Live registry sensitiveOutput — not sealed into RunnerView (Roxabi/roxabi-boilerplate-cf#231). */
  isSensitive?: (name: string) => boolean
  awaitApproval?: AwaitApprovalPort
  approvalNotifications?: ApprovalNotificationPorts
  interpret?: typeof interpretRun
  persistBundle?: typeof persistBundle
  loadRun?: typeof defaultLoadRun
  payload: unknown
  instanceId: string
}

export async function driveFlowRun(input: DriveFlowRunInput): Promise<void> {
  const { step, db, instanceId } = input
  const persist = input.persistBundle ?? persistBundle
  const load = input.loadRun ?? defaultLoadRun

  if (!instanceIdSchema.safeParse(instanceId).success) {
    throw new DriveNonRetryableError('invalid payload')
  }
  const parsed = paramsSchema.safeParse(input.payload)
  if (!parsed.success) throw new DriveNonRetryableError('invalid payload')
  const { runId, orgId } = parsed.data
  const ids = { runId, orgId }
  let io: StepReceiptCtx = { persist, load, db, ids, taskIds: [] }

  let claimed: number
  try {
    claimed = await step('claim', () => claimRun(db, { runId, orgId, instanceId }), noRetry)
  } catch (error) {
    return await closeAndRethrow(step, io, instanceId, error)
  }
  if (claimed === 0) throw new DriveNonRetryableError('claim lost')

  try {
    const row = await step('load', () => load(db, runId, orgId), noRetry)
    if (!row) throw new DriveNonRetryableError('run not found')

    const viewParsed = parseSnapshot(row.snapshot_json)
    if (!viewParsed.ok) {
      return await failClosed(step, io, 'persist:invalid-view', 'RUNNER_VIEW_INVALID')
    }
    const view = viewParsed.runnerView
    if (view.orgId !== orgId || view.orgId !== row.org_id) {
      return await failClosed(step, io, 'persist:org-mismatch', 'ORG_MISMATCH')
    }

    const taskIds = Object.keys(view.sealedPlan.tasks)
    io = { ...io, taskIds }
    await driveWaves({ input, view, row, io, taskIds, writeBundle, failClosed })
  } catch (error) {
    return await closeAndRethrow(step, io, instanceId, error)
  }
}
