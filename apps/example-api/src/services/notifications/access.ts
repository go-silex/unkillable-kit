import { AppError } from '@kit/core'
import type { InboxScope } from '@kit/notifications/repos'
import type { Context } from 'hono'
import { notificationsDogfoodRegistry } from '../../lib/notifications-dogfood'
import type { AppEnv } from '../../types'
import { resolveModuleAccess } from '../org-roles'

const notificationModuleIds = new Set<string>()
for (const definition of Object.values(notificationsDogfoodRegistry)) {
  if (definition.moduleId) notificationModuleIds.add(definition.moduleId)
}

/** Requires the ordinary session/member org guard; support access is never Inbox access. */
export async function loadNotificationScope(c: Context<AppEnv>): Promise<InboxScope> {
  const orgId = c.get('orgId')
  const userId = c.get('subject')
  const roleKey = c.get('orgRole')
  if (!(orgId && userId && roleKey) || c.get('orgBypass')) throw AppError.notFound()
  const db = c.get('db')
  if (!db) throw AppError.internal('db not bound')

  const readableModuleIds: string[] = []
  for (const moduleId of notificationModuleIds) {
    if (
      await resolveModuleAccess(db, {
        organizationId: orgId,
        roleKey,
        moduleId,
        op: 'read',
      })
    )
      readableModuleIds.push(moduleId)
  }
  return { orgId, userId, readableModuleIds }
}
