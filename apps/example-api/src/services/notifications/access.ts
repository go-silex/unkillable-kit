import { accessAllows, isModuleAccess } from '@kit/auth'
import { defineAuthorizationFact } from '@kit/auth/snapshot'
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

const availabilityColumns = ['module_id', 'enabled', 'available'] as const
const grantColumns = ['module_id', 'access'] as const

function moduleFlag(value: unknown) {
  if (value === 0 || value === 1) return value === 1
  throw new TypeError('Unreadable Module policy')
}

// One bounded projection per registry module; never load unrelated org settings or grants.
const moduleFacts = Array.from(notificationModuleIds, (moduleId) => ({
  moduleId,
  availability: defineAuthorizationFact({
    table: { name: 'organization_modules', columns: ['organization_id', ...availabilityColumns] },
    scope: { kind: 'organization', organizationId: 'organization_id' },
    select: availabilityColumns,
    where: { module_id: moduleId },
    maxRows: 1,
    decode: ([row]) => {
      if (!row) return false
      const enabled = moduleFlag(row.enabled)
      const available = moduleFlag(row.available)
      return row.module_id === moduleId && enabled && available
    },
  }),
  grant: defineAuthorizationFact({
    table: { name: 'organization_role_module_grants', columns: ['role_id', ...grantColumns] },
    scope: { kind: 'organization-role', roleId: 'role_id' },
    select: grantColumns,
    where: { module_id: moduleId },
    maxRows: 1,
    decode: ([row]) => {
      if (!row) return false
      if (typeof row.access !== 'string' || !isModuleAccess(row.access)) {
        throw new TypeError('Unreadable Module grant')
      }
      return row.module_id === moduleId && accessAllows(row.access, 'read')
    },
  }),
}))

export const includeNotificationAccess = authorization.includeFacts(
  ...moduleFacts.flatMap(({ availability, grant }) => [availability, grant]),
)

/** Requires the ordinary session/member org guard; support access is never Inbox access. */
export async function loadNotificationScope(c: Context<AppEnv>): Promise<InboxScope> {
  const orgId = c.get('orgId')
  const userId = c.get('subject')
  const roleKey = c.get('orgRole')
  if (!(orgId && userId && roleKey) || c.get('orgBypass')) throw AppError.notFound()

  const readableModuleIds: string[] = []
  for (const { moduleId, availability, grant } of moduleFacts) {
    if ((await authorization.fact(c, availability)) && (await authorization.fact(c, grant)))
      readableModuleIds.push(moduleId)
  }
  return { orgId, userId, readableModuleIds }
}
