import { and, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { flowRuns } from '../drizzle-schema'
import { FLOW_RUN_STATUSES } from '../receipts'
import { eventStatement, receiptEventStatements } from './events'

type Db = DrizzleD1Database<Record<string, unknown>>
const DRIVER_STATUS_SET = new Set<string>(FLOW_RUN_STATUSES)

async function getRun(db: Db, runId: string, orgId: string) {
  const rows = await db
    .select()
    .from(flowRuns)
    .where(and(eq(flowRuns.id, runId), eq(flowRuns.orgId, orgId)))
    .all()
  return rows[0] ?? null
}

/** CAS queued → running, or no-op if this instance already owns the row. */
export async function claimRun(
  db: Db,
  input: { runId: string; orgId: string; instanceId: string; now?: number },
): Promise<number> {
  if (!input.instanceId || input.instanceId.length > 128) return 0
  const now = input.now ?? Date.now()
  const mutation = db
    .update(flowRuns)
    .set({ status: 'running', workflowInstanceId: input.instanceId, updatedAt: now })
    .where(
      and(
        eq(flowRuns.id, input.runId),
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
        runId: input.runId,
        kind: 'status',
        statusFrom: 'queued',
        statusTo: 'running',
        now,
      },
      true,
    ),
  ])
  if (result?.meta.changes === 1) return 1
  const row = await getRun(db, input.runId, input.orgId)
  return row?.status === 'running' && row.workflowInstanceId === input.instanceId ? 1 : 0
}

/** Writes receipts + rollup, fenced to the snapshot used to calculate events. */
export async function persistRunBundle(
  db: Db,
  input: {
    runId: string
    orgId: string
    status: string
    receiptJson: string
    errorCode?: string | null
    now?: number
  },
): Promise<number> {
  if (!DRIVER_STATUS_SET.has(input.status)) return 0
  const now = input.now ?? Date.now()
  const before = await getRun(db, input.runId, input.orgId)
  if (!before) return 0
  const mutation = db
    .update(flowRuns)
    .set({
      receiptJson: input.receiptJson,
      status: input.status,
      errorCode: input.errorCode ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(flowRuns.id, input.runId),
        eq(flowRuns.orgId, input.orgId),
        inArray(flowRuns.status, ['queued', 'running']),
        eq(flowRuns.status, before.status),
        sql`${flowRuns.receiptJson} IS ${before.receiptJson}`,
        sql`${flowRuns.errorCode} IS ${before.errorCode}`,
        sql`${flowRuns.workflowInstanceId} IS ${before.workflowInstanceId}`,
      ),
    )
  const events = receiptEventStatements(db, {
    orgId: input.orgId,
    runId: input.runId,
    beforeJson: before.receiptJson,
    afterJson: input.receiptJson,
    now,
  })
  if (before.status !== input.status)
    events.unshift(
      eventStatement(
        db,
        {
          orgId: input.orgId,
          runId: input.runId,
          kind: 'status',
          statusFrom: before.status,
          statusTo: input.status,
          errorCode: input.errorCode ?? null,
          now,
        },
        true,
      ),
    )
  const [result] = await db.batch([mutation, ...events])
  return result?.meta.changes ?? 0
}

/** Port-free closure; terminal rows receive only a fenced receipt scrub. */
export async function closeOwnedRun(
  db: Db,
  input: {
    runId: string
    orgId: string
    instanceId: string
    beforeReceiptJson: string | null
    receiptJson: string | null
    errorCode: string | null
    now?: number
  },
): Promise<number> {
  const before = await getRun(db, input.runId, input.orgId)
  if (!before || before.receiptJson !== input.beforeReceiptJson) return 0
  const open = before.status === 'queued' || before.status === 'running'
  if (!open && (input.receiptJson === null || input.receiptJson === before.receiptJson)) return 0
  const now = input.now ?? Date.now()
  const fence = and(
    eq(flowRuns.id, input.runId),
    eq(flowRuns.orgId, input.orgId),
    eq(flowRuns.status, before.status),
    or(isNull(flowRuns.workflowInstanceId), eq(flowRuns.workflowInstanceId, input.instanceId)),
    sql`${flowRuns.workflowInstanceId} IS ${before.workflowInstanceId}`,
    sql`${flowRuns.receiptJson} IS ${input.beforeReceiptJson}`,
    sql`${flowRuns.errorCode} IS ${before.errorCode}`,
  )
  const mutation = open
    ? db
        .update(flowRuns)
        .set({
          status: 'failed',
          receiptJson: input.receiptJson,
          errorCode: input.errorCode,
          updatedAt: now,
        })
        .where(fence)
    : db
        .update(flowRuns)
        .set({ receiptJson: input.receiptJson, updatedAt: now })
        .where(and(fence, notInArray(flowRuns.status, ['queued', 'running'])))
  const events =
    input.receiptJson === null
      ? []
      : receiptEventStatements(db, {
          orgId: input.orgId,
          runId: input.runId,
          beforeJson: before.receiptJson,
          afterJson: input.receiptJson,
          now,
        })
  if (open)
    events.unshift(
      eventStatement(
        db,
        {
          orgId: input.orgId,
          runId: input.runId,
          kind: 'status',
          statusFrom: before.status,
          statusTo: 'failed',
          errorCode: input.errorCode,
          now,
        },
        true,
      ),
    )
  const [result] = await db.batch([mutation, ...events])
  return result?.meta.changes ?? 0
}
