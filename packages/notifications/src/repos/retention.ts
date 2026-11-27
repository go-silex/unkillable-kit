import { AppError } from '@kit/core'
import * as z from 'zod'
import { lifecycleBatch, lifecycleStatement } from './admit-sql'
import type { Db } from './types'
import { epochMsSchema, identitySchema, parseRepositoryInput } from './validation'

const inputSchema = z.strictObject({
  orgId: identitySchema,
  now: epochMsSchema,
  notificationCutoff: epochMsSchema,
  deliveryCutoff: epochMsSchema,
  batchSize: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
})

export async function purgeNotifications(
  db: Db,
  input: {
    orgId: string
    now: number
    notificationCutoff: number
    deliveryCutoff: number
    batchSize: number
  },
): Promise<{ notifications: number; deliveries: number; organizationDeliveries: number }> {
  const data = parseRepositoryInput(inputSchema, input)
  if (data.notificationCutoff > data.now || data.deliveryCutoff > data.now)
    throw AppError.validation('Invalid notifications input')
  const statements = [
    lifecycleStatement(
      db,
      `DELETE FROM kit_notification_deliveries WHERE org_id=? AND id IN
      (SELECT id FROM kit_notification_deliveries WHERE org_id=? AND status<>'pending' AND finished_at<=? ORDER BY finished_at,id LIMIT ?) RETURNING id`,
      [data.orgId, data.orgId, data.deliveryCutoff, data.batchSize],
    ),
    lifecycleStatement(
      db,
      `DELETE FROM kit_notification_organization_deliveries WHERE org_id=? AND id IN
      (SELECT id FROM kit_notification_organization_deliveries WHERE org_id=? AND
       ((status<>'pending' AND finished_at<=?) OR (status='pending' AND created_at<=?))
       ORDER BY created_at,id LIMIT ?) RETURNING id`,
      [data.orgId, data.orgId, data.deliveryCutoff, data.notificationCutoff, data.batchSize],
    ),
    lifecycleStatement(
      db,
      `UPDATE kit_notification_deliveries SET status='skipped', error_code='notification_expired', finished_at=?
      WHERE org_id=? AND status='pending' AND notification_id IN
      (SELECT id FROM kit_notifications WHERE org_id=? AND created_at<=? ORDER BY created_at,id LIMIT ?)`,
      [data.now, data.orgId, data.orgId, data.notificationCutoff, data.batchSize],
    ),
    lifecycleStatement(
      db,
      `DELETE FROM kit_notifications WHERE org_id=? AND id IN
      (SELECT id FROM kit_notifications WHERE org_id=? AND created_at<=? ORDER BY created_at,id LIMIT ?) RETURNING id`,
      [data.orgId, data.orgId, data.notificationCutoff, data.batchSize],
    ),
  ]
  const result = await lifecycleBatch(db, statements)
  return {
    deliveries: result[0]?.results.length ?? 0,
    organizationDeliveries: result[1]?.results.length ?? 0,
    notifications: result[3]?.results.length ?? 0,
  }
}
