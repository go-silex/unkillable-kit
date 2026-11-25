import { accessAllows } from '@kit/auth'
import { AppError } from '@kit/core'
import type { InboxScope } from '@kit/notifications/repos'
import type { Context } from 'hono'
import { isKitModuleId } from '../../lib/kit-modules'
import { notificationsDogfoodRegistry } from '../../lib/notifications-dogfood'
import { authorization } from '../../middleware/authorization'
import type { AppEnv } from '../../types'

const notificationModuleIds = new Set<string>()
for (const definition of Object.values(notificationsDogfoodRegistry)) {
  if (definition.moduleId && isKitModuleId(definition.moduleId))
    notificationModuleIds.add(definition.moduleId)
}

/** Requires the ordinary session/member org guard; support access is never Inbox access. */
export function loadNotificationScope(c: Context<AppEnv>): InboxScope {
  const { identity, organization } = authorization.view(c)
  if (
    identity?.method !== 'session' ||
    !organization?.role ||
    organization.bypass ||
    organization.modules === 'disabled'
  ) {
    throw AppError.notFound()
  }

  const readableModuleIds: string[] = []
  for (const moduleId of notificationModuleIds) {
    const module = organization.modules.get(moduleId)
    if (module?.available && accessAllows(module.access, 'read')) readableModuleIds.push(moduleId)
  }
  return { orgId: organization.id, userId: identity.subject, readableModuleIds }
}
