import { upsertOrgModule, upsertPlatformModule } from '@kit/auth/repos/platform-modules'
import {
  kitNotificationDeploymentRules,
  kitNotificationDestinations,
  kitNotificationOrganizationDeliveries,
  kitNotificationOrganizationRules,
  kitNotificationUserRules,
} from '@kit/notifications/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createAppNotificationService } from '../../services/notifications/app'
import { createRecordingNotificationRuntime } from '../notification-runtime'
import { createNotificationFixture } from './fixture'

describe('notification configuration pagination', () => {
  it('hydrates deployment, organization and global user rules beyond the first page', async () => {
    const { db } = await createNotificationFixture()
    await upsertPlatformModule(db, {
      moduleId: 'tasks',
      available: true,
      configJson: null,
      updatedAt: 1,
    })
    await upsertOrgModule(db, {
      organizationId: 'org_team',
      moduleId: 'tasks',
      enabled: true,
      updatedAt: 1,
    })
    for (let i = 0; i < 100; i++) {
      const base = {
        selectorKind: 'type',
        selectorValue: `other${i}`,
        channel: 'email',
        enabled: true,
        locked: false,
        createdAt: 100 + i,
        updatedAt: 100 + i,
      }
      await db.insert(kitNotificationDeploymentRules).values({ ...base, id: `d${i}` })
      await db
        .insert(kitNotificationOrganizationRules)
        .values({ ...base, id: `o${i}`, orgId: 'org_team' })
      await db
        .insert(kitNotificationUserRules)
        .values({ ...base, id: `u${i}`, userId: 'user_team_owner' })
    }
    const base = {
      selectorKind: 'type',
      selectorValue: 'tasks.assigned',
      enabled: false,
      locked: false,
      createdAt: 1,
      updatedAt: 1,
    }
    await db
      .insert(kitNotificationDeploymentRules)
      .values({ ...base, id: 'dep_target', channel: 'email', locked: true })
    await db
      .insert(kitNotificationOrganizationRules)
      .values({ ...base, id: 'org_target', orgId: 'org_team', channel: 'slack', locked: true })
    await db
      .insert(kitNotificationUserRules)
      .values({ ...base, id: 'user_target', userId: 'user_team_owner', channel: 'email' })
    const service = createAppNotificationService(db, createRecordingNotificationRuntime().runtime)
    const input = {
      orgId: 'org_team',
      type: 'tasks.assigned' as const,
      source: { kind: 'task', id: 'page' },
      userIds: ['user_team_owner'],
      params: { taskTitle: 'Paging' },
    }
    const result = await service.notify(input)
    expect(result.createdNotificationIds).toHaveLength(1)
    expect(result.createdDeliveries).toEqual([])
    await db.delete(kitNotificationUserRules).where(eq(kitNotificationUserRules.id, 'user_target'))
    const deploymentOff = await service.notify({
      ...input,
      source: { kind: 'task', id: 'deployment-rule' },
    })
    expect(deploymentOff.createdDeliveries).toEqual([])
    await db
      .insert(kitNotificationUserRules)
      .values({ ...base, id: 'user_target', userId: 'user_team_owner', channel: 'email' })
    await db
      .delete(kitNotificationDeploymentRules)
      .where(eq(kitNotificationDeploymentRules.id, 'dep_target'))
    const userOff = await service.notify({ ...input, source: { kind: 'task', id: 'user-rule' } })
    expect(userOff.createdDeliveries).toEqual([])
    await db.delete(kitNotificationUserRules).where(eq(kitNotificationUserRules.id, 'user_target'))
    const orgOff = await service.notify({ ...input, source: { kind: 'task', id: 'org-rule' } })
    expect(orgOff.createdDeliveries).toHaveLength(1)
    await db
      .delete(kitNotificationOrganizationRules)
      .where(eq(kitNotificationOrganizationRules.id, 'org_target'))
    const allOn = await service.notify({ ...input, source: { kind: 'task', id: 'defaults' } })
    expect(allOn.createdDeliveries).toHaveLength(2)
  })

  it('loads a matching destination beyond page one without any users', async () => {
    const { db } = await createNotificationFixture()
    await upsertPlatformModule(db, {
      moduleId: 'flows',
      available: true,
      configJson: null,
      updatedAt: 1,
    })
    await upsertOrgModule(db, {
      organizationId: 'org_team',
      moduleId: 'flows',
      enabled: true,
      updatedAt: 1,
    })
    for (let i = 0; i < 100; i++) {
      await db.insert(kitNotificationDestinations).values({
        id: `dest${i}`,
        orgId: 'org_team',
        channel: 'slack',
        externalId: `unused${i}`,
        selectorKind: 'type',
        selectorValue: 'other',
        createdAt: 100 + i,
        updatedAt: 100 + i,
      })
    }
    await db.insert(kitNotificationDestinations).values({
      id: 'target',
      orgId: 'org_team',
      channel: 'slack',
      externalId: 'target',
      selectorKind: 'type',
      selectorValue: 'flows.approval_requested',
      createdAt: 1,
      updatedAt: 1,
    })
    const service = createAppNotificationService(db, createRecordingNotificationRuntime().runtime)
    const input = {
      orgId: 'org_team',
      type: 'flows.approval_requested' as const,
      source: { kind: 'flow_approval', id: '["run","task"]' },
      userIds: [],
      params: {},
    }
    const result = await service.notify(input)
    expect(result.createdNotificationIds).toEqual([])
    expect(result.createdDeliveries).toHaveLength(1)
    expect((await service.notify(input)).createdDeliveries).toEqual([])
    const rows = await db.select().from(kitNotificationOrganizationDeliveries)
    expect(rows.map((row) => row.destinationId)).toEqual(['target'])
    await service.resolve({ orgId: input.orgId, source: input.source, userIds: [] })
    expect(
      (await db.select().from(kitNotificationOrganizationDeliveries))[0]?.resolvedAt,
    ).toBeNull()
    await service.resolve({ orgId: input.orgId, source: input.source })
    expect(
      (await db.select().from(kitNotificationOrganizationDeliveries))[0]?.resolvedAt,
    ).not.toBeNull()
  })
})
