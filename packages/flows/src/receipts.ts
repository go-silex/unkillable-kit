import * as z from 'zod'

/** App rollup (`flow_runs.status`). Not CF InstanceStatus. */
export const FLOW_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const

/** `waiting` is produced only for an approve task. `started` is a pre-port marker, not pending. */
export const TASK_RECEIPT_OUTCOMES = ['ok', 'skip', 'fail', 'waiting', 'started'] as const

export type FlowRunStatus = (typeof FLOW_RUN_STATUSES)[number]
export type TaskReceiptOutcome = (typeof TASK_RECEIPT_OUTCOMES)[number]

/** Tool/LLM text in D1 receipts — 4 KiB, not Workflow step state. */
export const RECEIPT_OUTPUT_MAX_CHARS = 4096

/** Whole-value replace for sensitive tool text at D1 write (Roxabi/roxabi-boilerplate-cf#231). */
export const REDACTED_OUTPUT_MARKER = '[redacted]' as const

export type TaskReceipt = {
  taskId: string
  outcome: TaskReceiptOutcome
  errorCode?: string
  output?: string
  approval?: { by: string; at: string }
}

export type ReceiptBundle = {
  receiptVersion: 1
  tokensUsed: number
  tasks: Record<string, TaskReceipt>
}

export type ParseReceiptsResult =
  | { ok: true; receipts: ReceiptBundle }
  | { ok: false; issues: Array<{ code: string; message: string; path?: string }> }

const taskIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)

const approvalSchema = z
  .object({
    by: z.string().min(1).max(200),
    at: z.iso.datetime(),
  })
  .strict()

const taskReceiptSchema = z
  .object({
    taskId: taskIdSchema,
    outcome: z.enum(TASK_RECEIPT_OUTCOMES),
    errorCode: z.string().min(1).max(256).optional(),
    output: z
      .string()
      .transform((value) =>
        value.length > RECEIPT_OUTPUT_MAX_CHARS ? value.slice(0, RECEIPT_OUTPUT_MAX_CHARS) : value,
      )
      .optional(),
    approval: approvalSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.outcome === 'fail' && val.errorCode === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'errorCode is required when outcome is fail',
        path: ['errorCode'],
      })
    }
    if (val.outcome === 'started' && val.output !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'started must not carry output',
        path: ['output'],
      })
    }
  })

export const receiptBundleSchema = z
  .object({
    receiptVersion: z.literal(1),
    tokensUsed: z.number().int().nonnegative(),
    tasks: z.record(taskIdSchema, taskReceiptSchema),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    for (const [id, receipt] of Object.entries(bundle.tasks)) {
      if (receipt.taskId !== id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'taskId must equal the tasks record key',
          path: ['tasks', id, 'taskId'],
        })
      }
    }
  })

export function emptyBundle(): ReceiptBundle {
  return { receiptVersion: 1, tokensUsed: 0, tasks: {} }
}

export function withTask(bundle: ReceiptBundle, rec: TaskReceipt): ReceiptBundle {
  return {
    receiptVersion: 1,
    tokensUsed: bundle.tokensUsed,
    tasks: { ...bundle.tasks, [rec.taskId]: rec },
  }
}

/** Rehydrate a row. Empty → empty bundle. Corrupt → null. */
export function receiptsFromRow(
  raw: string | null,
  taskIds: readonly string[],
): ReceiptBundle | null {
  if (raw == null || raw === '') return emptyBundle()
  try {
    const parsed = parseReceipts(JSON.parse(raw) as unknown, taskIds)
    return parsed.ok ? parsed.receipts : null
  } catch {
    return null
  }
}

/** Fail-closed rehydrate. When `taskIds` is passed, unknown keys are rejected. */
export function parseReceipts(input: unknown, taskIds?: readonly string[]): ParseReceiptsResult {
  const parsed = receiptBundleSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((zi) => ({
        code: 'RECEIPTS_INVALID',
        message: zi.message,
        path: zi.path.length ? zi.path.join('.') : undefined,
      })),
    }
  }

  if (taskIds !== undefined) {
    const allowed = new Set(taskIds)
    const issues: Array<{ code: string; message: string; path?: string }> = []
    for (const id of Object.keys(parsed.data.tasks)) {
      if (!allowed.has(id)) {
        issues.push({
          code: 'UNKNOWN_TASK_ID',
          message: `task id ${id} is not in the known task set`,
          path: `tasks.${id}`,
        })
      }
    }
    if (issues.length > 0) return { ok: false, issues }
  }

  return {
    ok: true,
    receipts: {
      receiptVersion: 1,
      tokensUsed: parsed.data.tokensUsed,
      tasks: parsed.data.tasks,
    },
  }
}

/** App status + parsed receipts. Does not read CF InstanceStatus. */
export function readRunRollup(row: {
  status: string
  receiptJson: string | null
  errorCode?: string | null
}): { status: string; receipts: ReceiptBundle | null; errorCode?: string | null } {
  let receipts: ReceiptBundle | null = null
  if (typeof row.receiptJson === 'string') {
    try {
      const parsed = parseReceipts(JSON.parse(row.receiptJson) as unknown)
      if (parsed.ok) receipts = parsed.receipts
    } catch {
      receipts = null
    }
  }
  return { status: row.status, receipts, errorCode: row.errorCode }
}
