import * as orgs from '@kit/auth/repos/orgs'
import { AppError } from '@kit/core'
import type { AccessFacts, DeliveryRef, UserRule } from '@kit/notifications'
import {
  admitNotifications,
  type ConfiguredDestination,
  listDestinations,
  resolveNotifications,
} from '@kit/notifications/repos'
import type { KitDb } from '../../lib/db-type'
import { isKitModuleId } from '../../lib/kit-modules'
import { notificationsDogfoodRegistry } from '../../lib/notifications-dogfood'
import { resolveModuleAccess } from '../org-roles'
import { isModuleEffective } from '../platform-modules'
import { deliveryWorkflowId } from './delivery-identity'
import { allRules } from './rules-pager'
import {
  createNotificationResolver,
  createNotificationService,
  type NotificationPersistencePorts,
  type NotificationResolver,
  type NotificationRuntimePorts,
  type NotificationService,
} from './service'

export function createAppNotificationPersistencePorts(db: KitDb): NotificationPersistencePorts {
  return {
    async recipientAccess({ orgId, userIds, moduleId }) {
      const organization = await orgs.findOrgById(db, orgId)
      const active = organization?.status === 'active'
      const roles = new Map<string, Promise<boolean>>()
      const facts = new Map<string, AccessFacts>()
      for (const userId of userIds) {
        const membership = await orgs.findMembership(db, orgId, userId)
        let readable = !moduleId
        if (active && membership && moduleId) {
          let result = roles.get(membership.role)
          if (!result) {
            result = resolveModuleAccess(db, {
              organizationId: orgId,
              roleKey: membership.role,
              moduleId,
              op: 'read',
              orgBypass: false,
            })
            roles.set(membership.role, result)
          }
          readable = await result
        }
        facts.set(userId, {
          organizationActive: active,
          member: Boolean(membership),
          moduleReadable: readable,
        })
      }
      return facts
    },
    async rules({ orgId, userIds }) {
      const [deployment, organization, ...userRows] = await Promise.all([
        allRules(db, { level: 'deployment' }),
        allRules(db, { level: 'organization', orgId }),
        ...userIds.map((userId) => allRules(db, { level: 'user', userId })),
      ])
      const users = new Map<string, readonly UserRule[]>()
      for (const [index, userId] of userIds.entries()) {
        const rows = userRows[index] ?? []
        if (rows.some((row) => row.locked)) throw AppError.internal('Invalid user rule')
        users.set(userId, rows as UserRule[])
      }
      return { deployment, organization, users }
    },
    async destinations({ orgId, moduleId }) {
      const org = await orgs.findOrgById(db, orgId)
      const active = org?.status === 'active'
      const effective =
        !moduleId || (isKitModuleId(moduleId) && (await isModuleEffective(db, orgId, moduleId)))
      const rows: ConfiguredDestination[] = []
      let cursor: string | undefined
      do {
        const page = await listDestinations(db, orgId, { limit: 100, cursor })
        rows.push(
          ...page.items.map((row) => ({
            ...row,
            facts: {
              configured: true,
              selector: row.selector,
              organizationActive: active,
              moduleEffective: effective,
            },
          })),
        )
        cursor = page.nextCursor ?? undefined
      } while (cursor !== undefined)
      return rows
    },
    async admit(batch) {
      const refs: DeliveryRef[] = [
        ...batch.users.flatMap((user) =>
          user.deliveries.map((delivery) => ({
            orgId: batch.orgId,
            kind: 'user' as const,
            id: delivery.id,
          })),
        ),
        ...batch.organizations.map((delivery) => ({
          orgId: batch.orgId,
          kind: 'organization' as const,
          id: delivery.id,
        })),
      ]
      const identities = await Promise.all(
        refs.map(async (ref) => ({
          ref,
          workflowId: await deliveryWorkflowId(ref),
          admissionDeadlineAt: batch.now + 86_400_000,
        })),
      )
      return admitNotifications(db, batch, identities)
    },
    resolve: (input) => resolveNotifications(db, input),
  }
}

export function createAppNotificationService(
  db: KitDb,
  runtime: NotificationRuntimePorts,
  persistence: NotificationPersistencePorts = createAppNotificationPersistencePorts(db),
): NotificationService<typeof notificationsDogfoodRegistry> {
  return createNotificationService({
    registry: notificationsDogfoodRegistry,
    ports: { ...persistence, ...runtime },
    now: Date.now,
    newId: () => crypto.randomUUID(),
  })
}

export function createAppNotificationResolver(db: KitDb): NotificationResolver {
  return createNotificationResolver({
    ports: { resolve: (input) => resolveNotifications(db, input) },
    now: Date.now,
  })
}
