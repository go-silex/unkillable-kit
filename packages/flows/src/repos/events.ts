import { and, eq, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { flowRunEvents, flowRuns } from '../drizzle-schema'

type Db = DrizzleD1Database<Record<string, unknown>>
export type FlowRunEventRow = typeof flowRunEvents.$inferSelect
export type FlowRunEventKind = 'status' | 'receipt'

type EventInput = {
  orgId: string
  runId: string
  kind: FlowRunEventKind
  statusFrom?: string | null
  statusTo?: string | null
  taskId?: string | null
  outcome?: string | null
  errorCode?: string | null
  now?: number
}

/** Each conditional insert propagates the previous statement's single-row change. */
export function eventStatement(db: Db, input: EventInput, conditional: boolean) {
  return db.insert(flowRunEvents).select(sql`
    SELECT ${`evt_${crypto.randomUUID().replace(/-/g, '')}`},
      ${input.orgId}, ${input.runId},
      COALESCE((SELECT MAX(seq) FROM flow_run_events WHERE run_id = ${input.runId}), 0) + 1,
      ${input.kind}, ${input.statusFrom ?? null}, ${input.statusTo ?? null},
      ${input.taskId ?? null}, ${input.outcome ?? null}, ${input.errorCode ?? null},
      ${input.now ?? Date.now()}
      ${conditional ? sql`WHERE changes() = 1` : sql``}
  `)
}

/** Append-only. Fails the caller if the insert fails — never a silent gap. */
export async function insertFlowRunEvent(db: Db, input: EventInput): Promise<void> {
  await eventStatement(db, input, false).run()
}

/** Always filters by org_id. Foreign org → empty. */
export async function listFlowRunEvents(
  db: Db,
  orgId: string,
  runId: string,
): Promise<FlowRunEventRow[]> {
  return db
    .select()
    .from(flowRunEvents)
    .where(and(eq(flowRunEvents.orgId, orgId), eq(flowRunEvents.runId, runId)))
    .orderBy(flowRunEvents.seq)
    .all()
}

type ReceiptTask = { taskId?: string; outcome?: string; errorCode?: string }

function receiptOutcome(task: ReceiptTask | undefined) {
  return {
    outcome: task && typeof task.outcome === 'string' ? task.outcome : null,
    errorCode: task && typeof task.errorCode === 'string' ? task.errorCode : null,
  }
}

function parseReceiptTasks(raw: string | null): Record<string, ReceiptTask> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as { tasks?: Record<string, ReceiptTask> }
    return parsed.tasks && typeof parsed.tasks === 'object' ? parsed.tasks : {}
  } catch {
    return {}
  }
}

export function receiptEventStatements(
  db: Db,
  input: {
    orgId: string
    runId: string
    beforeJson: string | null
    afterJson: string
    now: number
  },
) {
  const beforeTasks = parseReceiptTasks(input.beforeJson)
  return Object.entries(parseReceiptTasks(input.afterJson)).flatMap(([taskId, after]) => {
    const next = receiptOutcome(after)
    const prev = receiptOutcome(beforeTasks[taskId])
    if (!next.outcome || (prev.outcome === next.outcome && prev.errorCode === next.errorCode))
      return []
    return [
      eventStatement(
        db,
        {
          orgId: input.orgId,
          runId: input.runId,
          kind: 'receipt',
          taskId,
          outcome: next.outcome,
          errorCode: next.errorCode,
          now: input.now,
        },
        true,
      ),
    ]
  })
}

/** Receipt-only write. Keeps status and error_code; any current status. Org-scoped. */
export async function persistReceiptJson(
  db: Db,
  input: { runId: string; orgId: string; receiptJson: string; now?: number },
): Promise<number> {
  const now = input.now ?? Date.now()
  const rows = await db
    .select()
    .from(flowRuns)
    .where(and(eq(flowRuns.id, input.runId), eq(flowRuns.orgId, input.orgId)))
    .all()
  const row = rows[0]
  if (!row) return 0
  const mutation = db
    .update(flowRuns)
    .set({ receiptJson: input.receiptJson, updatedAt: now })
    .where(
      and(
        eq(flowRuns.id, input.runId),
        eq(flowRuns.orgId, input.orgId),
        sql`${flowRuns.receiptJson} IS ${row.receiptJson}`,
      ),
    )
  const [result] = await db.batch([
    mutation,
    ...receiptEventStatements(db, {
      orgId: input.orgId,
      runId: input.runId,
      beforeJson: row.receiptJson,
      afterJson: input.receiptJson,
      now,
    }),
  ])
  return result?.meta.changes ?? 0
}

export async function markQueuedRunCreateFailed(db: Db, input: { id: string; orgId: string }) {
  const now = Date.now()
  const mutation = db
    .update(flowRuns)
    .set({ status: 'failed', errorCode: 'WORKFLOW_CREATE_FAILED', updatedAt: now })
    .where(
      and(
        eq(flowRuns.id, input.id),
        eq(flowRuns.orgId, input.orgId),
        eq(flowRuns.status, 'queued'),
      ),
    )
  const [result] = await db.batch([
    mutation,
    eventStatement(
      db,
      {
        orgId: input.orgId,
        runId: input.id,
        kind: 'status',
        statusFrom: 'queued',
        statusTo: 'failed',
        errorCode: 'WORKFLOW_CREATE_FAILED',
        now,
      },
      true,
    ),
  ])
  return (result?.meta.changes ?? 0) === 1
}
