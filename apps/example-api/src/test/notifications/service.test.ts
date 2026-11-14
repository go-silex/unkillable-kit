import { createHash } from 'node:crypto'
import { upsertOrgModule, upsertPlatformModule } from '@kit/auth/repos/platform-modules'
import { baOrganization } from '@kit/auth/schema'
import { putRule } from '@kit/notifications/repos'
import { kitNotificationDeliveries, kitNotifications } from '@kit/notifications/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { notificationsDogfoodRegistry } from '../../lib/notifications-dogfood'
import {
  createAppNotificationPersistencePorts,
  createAppNotificationService,
} from '../../services/notifications/app'
import { createNotificationService } from '../../services/notifications/service'
import { createRecordingNotificationRuntime } from '../notification-runtime'
import { createNotificationFixture, type NotificationFixture } from './fixture'

const orgId = 'org_team'
const owner = 'user_team_owner'
const task = {
  orgId,
  type: 'tasks.assigned' as const,
  source: { kind: 'task', id: 't1' },
  params: { taskTitle: 'Original' },
}

async function enableTasks(db: NotificationFixture['db']) {
  await upsertPlatformModule(db, {
    moduleId: 'tasks',
    available: true,
    configJson: null,
    updatedAt: 1,
  })
  await upsertOrgModule(db, {
    organizationId: orgId,
    moduleId: 'tasks',
    enabled: true,
    updatedAt: 1,
  })
}

describe('notification app service', () => {
  it('checks membership and module access and excludes an actor only when supplied', async () => {
    const { db } = await createNotificationFixture()
    const service = createAppNotificationService(db, createRecordingNotificationRuntime().runtime)
    await enableTasks(db)
    const excluded = await service.notify({
      ...task,
      userIds: [owner, owner, 'user_solo'],
      actorId: owner,
    })
    expect(excluded.createdNotificationIds).toEqual([])
    const admitted = await service.notify({ ...task, userIds: [owner, owner, 'user_solo'] })
    expect(admitted.createdNotificationIds).toHaveLength(1)
    await upsertOrgModule(db, {
      organizationId: orgId,
      moduleId: 'tasks',
      enabled: false,
      updatedAt: 2,
    })
    expect(
      (await service.notify({ ...task, source: { kind: 'task', id: 't2' }, userIds: [owner] }))
        .createdNotificationIds,
    ).toEqual([])
    expect((await db.select().from(kitNotifications)).map((row) => row.userId)).toEqual([owner])
    await enableTasks(db)
    await db.update(baOrganization).set({ status: 'suspended' }).where(eq(baOrganization.id, orgId))
    expect(
      (await service.notify({ ...task, source: { kind: 'task', id: 't3' }, userIds: [owner] }))
        .createdNotificationIds,
    ).toEqual([])
    expect(
      (await service.notify({ ...task, orgId: 'missing_org', userIds: [owner] }))
        .createdNotificationIds,
    ).toEqual([])
  })

  it('keeps inbox with external channels off, preserves read and params on duplicates and resolves independently', async () => {
    const { db } = await createNotificationFixture()
    await enableTasks(db)
    for (const channel of ['email', 'slack']) {
      await putRule(
        db,
        { level: 'user', userId: owner },
        { id: `off_${channel}`, selector: { kind: 'all' }, channel, enabled: false, locked: false },
        1,
      )
    }
    const service = createAppNotificationService(db, createRecordingNotificationRuntime().runtime)
    const first = await service.notify({ ...task, userIds: [owner] })
    expect(first.createdNotificationIds).toHaveLength(1)
    expect(first.createdDeliveries).toEqual([])
    await db
      .update(kitNotifications)
      .set({ readAt: 42 })
      .where(eq(kitNotifications.id, first.createdNotificationIds[0]!))
    const duplicate = await service.notify({
      ...task,
      params: { taskTitle: 'Changed' },
      userIds: [owner],
    })
    expect(duplicate).toEqual({ createdNotificationIds: [], createdDeliveries: [] })
    await service.resolve({ orgId, source: task.source, userIds: [] })
    expect((await db.select().from(kitNotifications))[0]?.resolvedAt).toBeNull()
    await service.resolve({ orgId, source: task.source })
    const row = (await db.select().from(kitNotifications))[0]!
    expect(row.readAt).toBe(42)
    expect(row.paramsJson).toBe('{"taskTitle":"Original"}')
    expect(row.resolvedAt).not.toBeNull()
    expect(
      (await service.notify({ ...task, userIds: [owner] })).createdNotificationIds,
    ).toHaveLength(1)
  })

  it('persists the SHA owner identity and original 24-hour deadline', async () => {
    const { db } = await createNotificationFixture()
    await enableTasks(db)
    const before = Date.now()
    const result = await createAppNotificationService(
      db,
      createRecordingNotificationRuntime().runtime,
    ).notify({ ...task, userIds: [owner] })
    expect(result.createdDeliveries.length).toBeGreaterThan(0)
    expect(
      await createAppNotificationService(db, createRecordingNotificationRuntime().runtime).notify({
        ...task,
        userIds: [owner],
      }),
    ).toEqual({
      createdNotificationIds: [],
      createdDeliveries: [],
    })
    const rows = await db.select().from(kitNotificationDeliveries)
    for (const row of rows) {
      const digest = createHash('sha256')
        .update(JSON.stringify(['notification-delivery', 1, orgId, 'user', row.id]))
        .digest('hex')
      expect(row.workflowId).toBe(`nd-v1-${digest}`)
      expect(row.admissionDeadlineAt).toBe(row.createdAt + 86_400_000)
      expect(row.createdAt).toBeGreaterThanOrEqual(before)
      expect(row.admissionStatus).toBe('pending')
    }
  })

  it('continues sibling admissions after a postcommit failure and does not readmit duplicates', async () => {
    const { db } = await createNotificationFixture()
    await enableTasks(db)
    for (const channel of ['email', 'slack']) {
      await putRule(
        db,
        { level: 'user', userId: owner },
        { id: `on_${channel}`, selector: { kind: 'all' }, channel, enabled: true, locked: false },
        1,
      )
    }
    const recording = createRecordingNotificationRuntime()
    const service = createAppNotificationService(db, {
      ...recording.runtime,
      async ensureDeliveryAdmission(ref) {
        await recording.runtime.ensureDeliveryAdmission(ref)
        expect(await db.select().from(kitNotificationDeliveries)).toHaveLength(2)
        if (recording.admissions.length === 1) throw new Error('private failure')
      },
    })
    const result = await service.notify({ ...task, userIds: [owner] })
    expect(result.createdNotificationIds).toHaveLength(1)
    expect(result.createdDeliveries).toHaveLength(2)
    expect(recording.admissions).toEqual(result.createdDeliveries)
    expect(recording.failures).toEqual([
      {
        operation: 'admission',
        ref: result.createdDeliveries[0],
        code: 'delivery_admission_interrupted',
      },
    ])
    expect(await service.notify({ ...task, userIds: [owner] })).toEqual({
      createdNotificationIds: [],
      createdDeliveries: [],
    })
    expect(recording.admissions).toEqual(result.createdDeliveries)
  })

  it('rejects an invalid generated identity before the persistence boundary', async () => {
    const { db } = await createNotificationFixture()
    const ports = {
      ...createAppNotificationPersistencePorts(db),
      ...createRecordingNotificationRuntime().runtime,
    }
    const service = createNotificationService({
      registry: notificationsDogfoodRegistry,
      ports,
      now: () => 1,
      newId: () => 'bad\n',
    })
    await expect(service.notify({ ...task, userIds: [owner] })).rejects.toThrow()
    let generated = 0
    const laterInvalid = createNotificationService({
      registry: notificationsDogfoodRegistry,
      ports,
      now: () => 1,
      newId: () => (++generated === 1 ? 'valid' : 'invalid\n'),
    })
    await expect(laterInvalid.notify({ ...task, userIds: [owner] })).rejects.toThrow()
    const app = createAppNotificationService(db, createRecordingNotificationRuntime().runtime)
    await expect(
      app.notify({ ...task, source: { kind: 'task', id: 'bad\0id' }, userIds: [owner] }),
    ).rejects.toThrow()
    await expect(
      app.notify({ ...task, params: { taskTitle: '' }, userIds: [owner] }),
    ).rejects.toThrow()
    expect(await db.select().from(kitNotifications)).toEqual([])
  })
})
