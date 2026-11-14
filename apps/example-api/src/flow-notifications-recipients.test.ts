import * as orgRolesRepo from '@kit/auth/repos/org-roles'
import { baMember } from '@kit/auth/schema'
import {
  kitNotificationDeliveries,
  kitNotificationDestinations,
  kitNotificationOrganizationDeliveries,
  kitNotifications,
} from '@kit/notifications/schema'
import { describe, expect, it } from 'vitest'
import { resolveModuleAccess } from './services/org-roles'
import { setupFlowNotifications } from './test/flow-notifications-fixture'
import { ORG_ACME, seedOperatorWriteOnAcme } from './test/flows-fixture'

describe('flow approval recipient authority and replay', () => {
  it('requires both explicit approval role and current flows write for each recipient', async () => {
    const f = await setupFlowNotifications()
    await f.db.insert(baMember).values({
      id: 'flow_notification_admin',
      organizationId: ORG_ACME,
      userId: 'user_super',
      role: 'admin',
      createdAt: new Date(),
    })
    await seedOperatorWriteOnAcme(f.db)
    expect(
      await resolveModuleAccess(f.db, {
        organizationId: ORG_ACME,
        roleKey: 'operator',
        moduleId: 'flows',
        op: 'write',
      }),
    ).toBe(true)
    expect(
      await resolveModuleAccess(f.db, {
        organizationId: ORG_ACME,
        roleKey: 'admin',
        moduleId: 'flows',
        op: 'write',
      }),
    ).toBe(true)
    await f.ports.opened(f.notice('first'))

    const firstSource = JSON.stringify([f.runId, 'first'])
    let notifications = await f.db.select().from(kitNotifications)
    let deliveries = await f.db.select().from(kitNotificationDeliveries)
    const first = notifications.filter((row) => row.sourceId === firstSource)
    expect(first.map((row) => row.userId).sort()).toEqual(['user_staff', 'user_super'])
    expect(deliveries).toHaveLength(4)
    expect(
      deliveries.map((row) => first.find((item) => item.id === row.notificationId)?.userId).sort(),
    ).toEqual(['user_staff', 'user_staff', 'user_super', 'user_super'])

    const adminRole = await orgRolesRepo.findRoleByKey(f.db, ORG_ACME, 'admin')
    if (!adminRole) throw new Error('Missing seeded admin role')
    await orgRolesRepo.upsertGrant(f.db, {
      organizationId: ORG_ACME,
      roleId: adminRole.id,
      moduleId: 'flows',
      access: 'read',
    })
    await f.ports.opened(f.notice('second'))
    expect(
      await resolveModuleAccess(f.db, {
        organizationId: ORG_ACME,
        roleKey: 'admin',
        moduleId: 'flows',
        op: 'read',
      }),
    ).toBe(true)
    expect(
      await resolveModuleAccess(f.db, {
        organizationId: ORG_ACME,
        roleKey: 'admin',
        moduleId: 'flows',
        op: 'write',
      }),
    ).toBe(false)

    const secondSource = JSON.stringify([f.runId, 'second'])
    notifications = await f.db.select().from(kitNotifications)
    deliveries = await f.db.select().from(kitNotificationDeliveries)
    const second = notifications.filter((row) => row.sourceId === secondSource)
    expect(second.map((row) => row.userId)).toEqual(['user_staff'])
    const secondDeliveries = deliveries.filter((row) =>
      second.some((item) => item.id === row.notificationId),
    )
    expect(secondDeliveries).toHaveLength(2)
    expect(secondDeliveries.map((row) => row.channel).sort()).toEqual(['email', 'slack'])
    expect(notifications.filter((row) => row.userId === 'user_team_owner')).toEqual([])
  })

  it('does not resurrect user or collective deliveries on a closed callback replay', async () => {
    const f = await setupFlowNotifications()
    await f.db.insert(kitNotificationDestinations).values({
      id: 'flow_replay_destination',
      orgId: ORG_ACME,
      channel: 'slack',
      externalId: JSON.stringify(['slack', 'installation', 'channel']),
      selectorKind: 'type',
      selectorValue: 'flows.approval_requested',
      createdAt: 1,
      updatedAt: 1,
    })
    await f.ports.opened(f.notice('first'))
    const response = await f.app.request(
      `/api/flows/runs/${f.runId}/tasks/first/approval`,
      { method: 'POST', headers: f.headers, body: JSON.stringify({ decision: 'approved' }) },
      f.env,
    )
    expect(response.status).toBe(202)
    const beforeNotifications = await f.db
      .select()
      .from(kitNotifications)
      .orderBy(kitNotifications.id)
    const beforeDeliveries = await f.db
      .select()
      .from(kitNotificationDeliveries)
      .orderBy(kitNotificationDeliveries.id)
    const beforeCollective = await f.db
      .select()
      .from(kitNotificationOrganizationDeliveries)
      .orderBy(kitNotificationOrganizationDeliveries.id)
    expect(beforeNotifications).toHaveLength(1)
    expect(beforeNotifications[0]?.resolvedAt).not.toBeNull()
    expect(beforeDeliveries).toHaveLength(2)
    expect(beforeCollective).toHaveLength(1)
    expect(beforeCollective[0]?.resolvedAt).not.toBeNull()
    await f.ports.opened(f.notice('first'))
    expect(await f.db.select().from(kitNotifications).orderBy(kitNotifications.id)).toEqual(
      beforeNotifications,
    )
    expect(
      await f.db.select().from(kitNotificationDeliveries).orderBy(kitNotificationDeliveries.id),
    ).toEqual(beforeDeliveries)
    expect(
      await f.db
        .select()
        .from(kitNotificationOrganizationDeliveries)
        .orderBy(kitNotificationOrganizationDeliveries.id),
    ).toEqual(beforeCollective)
  })
})
