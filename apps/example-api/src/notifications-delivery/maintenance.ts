import { listAllOrgs } from '@kit/auth/repos/orgs'
import { createDb } from '@kit/db'
import { purgeNotifications } from '@kit/notifications/repos'
import { schema } from '../db/schema'
import type { Env } from '../env'
import { createNotificationDeliveryRuntime } from './admission'

const DAY_MS = 86_400_000
const BATCH_SIZE = 100

function retentionDays(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value)) throw new Error('Invalid notification retention configuration')
  const days = Number(value)
  if (!Number.isSafeInteger(days) || days <= 0)
    throw new Error('Invalid notification retention configuration')
  return days
}

function cutoff(now: number, days: number): number {
  return days >= now / DAY_MS ? 0 : now - days * DAY_MS
}

export async function runNotificationMaintenance(env: Env): Promise<void> {
  const notificationDays = retentionDays(env.NOTIFICATIONS_RETENTION_DAYS, 90)
  const deliveryDays = retentionDays(env.NOTIFICATION_DELIVERIES_RETENTION_DAYS, 30)
  const db = createDb(env.DB, schema)
  const runtime = createNotificationDeliveryRuntime(db, env)
  const organizations = await listAllOrgs(db)

  for (const organization of organizations) {
    const now = Date.now()
    try {
      await runtime.reconcileDeliveryAdmissions({ orgId: organization.id, now, limit: BATCH_SIZE })
    } catch {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'notification_admission_maintenance_failed',
          orgId: organization.id,
        }),
      )
    }
    try {
      await purgeNotifications(db, {
        orgId: organization.id,
        now,
        notificationCutoff: cutoff(now, notificationDays),
        deliveryCutoff: cutoff(now, deliveryDays),
        batchSize: BATCH_SIZE,
      })
    } catch {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'notification_retention_maintenance_failed',
          orgId: organization.id,
        }),
      )
    }
  }
}
