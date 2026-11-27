import { and, eq, sql } from 'drizzle-orm'
import * as z from 'zod'
import { type DeliveryRef, deliveryRefSchema } from '../delivery-ref'
import {
  kitNotifications as notifications,
  kitNotificationOrganizationDeliveries as orgDelivery,
  kitNotificationDeliveries as userDelivery,
} from '../drizzle-schema'
import type { DeliveryState, Json } from '../types'
import type { Db, DeliveryRow } from './types'
import { epochMsSchema, parseRepositoryInput } from './validation'

const codeSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('\0'))
const outcomeSchema = z.strictObject({
  status: z.enum(['sent', 'failed', 'skipped']),
  code: codeSchema.optional(),
})

type Receipt = {
  status: string
  workflowId: string
  admissionStatus: string
  admissionDeadlineAt: number
  admittedAt: number | null
  lastAdmissionCheckAt: number | null
  attemptCount: number
  lastAttemptAt: number | null
  errorCode: string | null
  createdAt: number
  finishedAt: number | null
  channel: string
}
function receipt(row: Receipt) {
  return {
    ...row,
    status: row.status as DeliveryState,
    admissionStatus: row.admissionStatus as DeliveryRow['admissionStatus'],
  }
}
export async function loadDelivery(db: Db, input: DeliveryRef): Promise<DeliveryRow | null> {
  const ref = parseRepositoryInput(deliveryRefSchema, input)
  if (ref.kind === 'user') {
    const rows = await db
      .select({ delivery: userDelivery, notification: notifications })
      .from(userDelivery)
      .innerJoin(
        notifications,
        and(
          eq(userDelivery.notificationId, notifications.id),
          eq(userDelivery.orgId, notifications.orgId),
        ),
      )
      .where(and(eq(userDelivery.id, ref.id), eq(userDelivery.orgId, ref.orgId)))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    const { typeKey, moduleId, sourceKind, sourceId, paramsJson, userId, resolvedAt } =
      row.notification
    const { id: _id, orgId: _orgId, notificationId: _notificationId, ...delivery } = row.delivery
    return {
      ...receipt(delivery),
      ref,
      type: typeKey,
      moduleId,
      source: { kind: sourceKind, id: sourceId },
      params: JSON.parse(paramsJson) as Json,
      userId,
      destinationId: null,
      resolvedAt,
    }
  }
  const rows = await db
    .select()
    .from(orgDelivery)
    .where(and(eq(orgDelivery.id, ref.id), eq(orgDelivery.orgId, ref.orgId)))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  const {
    id: _id,
    orgId: _orgId,
    typeKey,
    moduleId,
    sourceKind,
    sourceId,
    paramsJson,
    destinationId,
    resolvedAt,
    ...delivery
  } = row
  return {
    ...receipt(delivery),
    ref,
    type: typeKey,
    moduleId,
    source: { kind: sourceKind, id: sourceId },
    params: JSON.parse(paramsJson) as Json,
    userId: null,
    destinationId,
    resolvedAt,
  }
}

export async function recordAttempt(
  db: Db,
  input: DeliveryRef,
  inputNow: number,
): Promise<boolean> {
  const ref = parseRepositoryInput(deliveryRefSchema, input)
  const now = parseRepositoryInput(epochMsSchema, inputNow)
  const t = ref.kind === 'user' ? userDelivery : orgDelivery
  const rows = await db
    .update(t)
    .set({ attemptCount: sql`${t.attemptCount} + 1`, lastAttemptAt: now })
    .where(and(eq(t.id, ref.id), eq(t.orgId, ref.orgId), eq(t.status, 'pending')))
    .returning({ id: t.id })
  return rows.length > 0
}
export async function recordRetryableFailure(
  db: Db,
  input: DeliveryRef,
  inputCode: string,
  inputNow: number,
): Promise<boolean> {
  const ref = parseRepositoryInput(deliveryRefSchema, input)
  const code = parseRepositoryInput(codeSchema, inputCode)
  const now = parseRepositoryInput(epochMsSchema, inputNow)
  const t = ref.kind === 'user' ? userDelivery : orgDelivery
  const rows = await db
    .update(t)
    .set({ errorCode: code, lastAttemptAt: now })
    .where(and(eq(t.id, ref.id), eq(t.orgId, ref.orgId), eq(t.status, 'pending')))
    .returning({ id: t.id })
  return rows.length > 0
}
export async function finishDelivery(
  db: Db,
  input: DeliveryRef,
  inputOutcome: { status: Exclude<DeliveryState, 'pending'>; code?: string },
  inputNow: number,
): Promise<boolean> {
  const ref = parseRepositoryInput(deliveryRefSchema, input)
  const outcome = parseRepositoryInput(outcomeSchema, inputOutcome)
  const now = parseRepositoryInput(epochMsSchema, inputNow)
  const t = ref.kind === 'user' ? userDelivery : orgDelivery
  const rows = await db
    .update(t)
    .set({ status: outcome.status, errorCode: outcome.code ?? null, finishedAt: now })
    .where(and(eq(t.id, ref.id), eq(t.orgId, ref.orgId), eq(t.status, 'pending')))
    .returning({ id: t.id })
  return rows.length > 0
}
