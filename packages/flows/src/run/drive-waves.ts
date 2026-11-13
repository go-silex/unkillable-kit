/** Wave loop for driveFlowRun — approve then invoke/infer (Roxabi/roxabi-boilerplate-cf#287 cog-authz). */

import { DEFAULT_APPROVE_TIMEOUT_HOURS } from '../constants'
import { interpretRun } from '../interpret'
import { type ReceiptBundle, receiptsFromRow } from '../receipts'
import type { PlanTask } from '../schema'
import type { RunnerView } from '../snapshot'
import {
  type ApprovalNotificationPorts,
  type AwaitApprovalPort,
  runApproveStep,
} from './approve-step'
import { DriveNonRetryableError } from './errors'
import { runInferStep } from './infer-step'
import { runInvokeStep } from './invoke-step'
import type { FlowRunRow } from './persist'
import {
  type DriveStep,
  failStartedTasks,
  type InferPort,
  type InvokePort,
  noRetry,
  type StepReceiptCtx,
} from './step-io'

export type DriveWavesInput = {
  step: DriveStep
  invoke: InvokePort
  infer?: InferPort
  hasTool?: (name: string) => boolean
  isSensitive?: (name: string) => boolean
  awaitApproval?: AwaitApprovalPort
  approvalNotifications?: ApprovalNotificationPorts
  interpret?: typeof interpretRun
}

function sealedVerb(
  task: PlanTask,
):
  | { kind: 'invoke'; body: NonNullable<PlanTask['invoke']> }
  | { kind: 'infer'; body: NonNullable<PlanTask['infer']> }
  | { kind: 'approve'; body: NonNullable<PlanTask['approve']> } {
  if (task.invoke !== undefined && task.infer === undefined && task.approve === undefined) {
    return { kind: 'invoke', body: task.invoke }
  }
  if (task.infer !== undefined && task.invoke === undefined && task.approve === undefined) {
    return { kind: 'infer', body: task.infer }
  }
  if (task.approve !== undefined && task.invoke === undefined && task.infer === undefined) {
    return { kind: 'approve', body: task.approve }
  }
  throw new DriveNonRetryableError('TASK_VERB_INVALID')
}

function terminalErrorCode(
  result: ReturnType<typeof interpretRun>,
  closed: ReturnType<typeof failStartedTasks>,
): string | null {
  const tasks = Object.values(closed.bundle.tasks)
  const receiptLost = tasks.some((rec) => rec.errorCode === 'RECEIPT_LOST')
  const approvalError = tasks.find(
    (rec) => rec.outcome === 'fail' && rec.errorCode?.startsWith('APPROVAL_'),
  )?.errorCode
  return receiptLost ? 'RECEIPT_LOST' : (result.stuck ?? approvalError ?? null)
}

async function runApproveReady(
  input: DriveWavesInput,
  view: RunnerView,
  readyTaskIds: string[],
  waitingTaskIds: string[],
  io: StepReceiptCtx,
): Promise<void> {
  for (const taskId of [
    ...readyTaskIds.filter((id) => view.sealedPlan.tasks[id]?.approve),
    ...waitingTaskIds,
  ]) {
    const task = view.sealedPlan.tasks[taskId]
    if (!task) throw new DriveNonRetryableError('TASK_VERB_INVALID')
    const verb = sealedVerb(task)
    if (verb.kind !== 'approve') continue
    await runApproveStep({
      step: input.step,
      awaitApproval: input.awaitApproval,
      approvalNotifications: input.approvalNotifications,
      taskId,
      timeoutHours: verb.body.timeout_hours ?? DEFAULT_APPROVE_TIMEOUT_HOURS,
      io,
    })
  }
}

async function runEffectReady(
  input: DriveWavesInput,
  view: RunnerView,
  readyTaskIds: string[],
  io: StepReceiptCtx,
): Promise<void> {
  const { step, invoke, infer, hasTool, isSensitive } = input
  for (const taskId of readyTaskIds) {
    const task = view.sealedPlan.tasks[taskId]
    if (!task) throw new DriveNonRetryableError('TASK_VERB_INVALID')
    const verb = sealedVerb(task)
    switch (verb.kind) {
      case 'approve':
        continue
      case 'invoke':
        await runInvokeStep({
          step,
          invoke,
          hasTool,
          isSensitive,
          view,
          taskId,
          tool: verb.body.tool,
          args: verb.body.args,
          io,
        })
        break
      case 'infer':
        await runInferStep({
          step,
          infer,
          view,
          taskId,
          body: verb.body,
          io,
        })
        break
      default: {
        const _exhaustive: never = verb
        throw new DriveNonRetryableError('TASK_VERB_INVALID')
      }
    }
  }
}

async function closeTerminalWave(
  result: ReturnType<typeof interpretRun>,
  step: DriveStep,
  io: StepReceiptCtx,
  writeBundle: (
    step: DriveStep,
    io: StepReceiptCtx,
    name: string,
    input: { status: string; bundle: ReceiptBundle; errorCode?: string | null },
  ) => Promise<void>,
): Promise<void> {
  const status = result.rollup === 'succeeded' ? 'succeeded' : 'failed'
  const closed = failStartedTasks(result.receipts)
  const errorCode = terminalErrorCode(result, closed)
  await writeBundle(step, io, 'persist:terminal', {
    status,
    bundle: closed.bundle,
    errorCode,
  })
  if (result.rollup === 'succeeded') return
  throw new DriveNonRetryableError(errorCode ?? 'failed')
}

export async function driveWaves(ctx: {
  input: DriveWavesInput
  view: RunnerView
  row: FlowRunRow
  io: StepReceiptCtx
  taskIds: string[]
  writeBundle: (
    step: DriveStep,
    io: StepReceiptCtx,
    name: string,
    input: { status: string; bundle: ReceiptBundle; errorCode?: string | null },
  ) => Promise<void>
  failClosed: (
    step: DriveStep,
    io: StepReceiptCtx,
    name: string,
    errorCode: string,
  ) => Promise<never>
}): Promise<void> {
  const { input, view, row, io, taskIds, writeBundle, failClosed } = ctx
  const interpret = input.interpret ?? interpretRun
  const { step } = input
  const { db, load } = io
  const { runId, orgId } = io.ids
  let wave = 0
  while (true) {
    if (wave > taskIds.length) {
      return await failClosed(step, io, 'persist:terminal', 'DAG_STUCK')
    }
    const current =
      wave === 0 ? row : await step(`load:${wave}`, () => load(db, runId, orgId), noRetry)
    if (!current) throw new DriveNonRetryableError('run not found')

    const receipts = receiptsFromRow(current.receipt_json, taskIds)
    if (!receipts) {
      return await failClosed(step, io, 'persist:invalid-receipts', 'RECEIPTS_INVALID')
    }

    const result = interpret(view, receipts)
    const waitingTaskIds = result.waitingTaskIds ?? []
    if (result.readyTaskIds.length === 0 && waitingTaskIds.length === 0) {
      return await closeTerminalWave(result, step, io, writeBundle)
    }

    await runApproveReady(input, view, result.readyTaskIds, waitingTaskIds, io)
    await runEffectReady(input, view, result.readyTaskIds, io)
    wave += 1
  }
}
