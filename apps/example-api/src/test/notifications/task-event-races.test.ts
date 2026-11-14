import { upsertOrgModule } from '@kit/auth/repos/platform-modules'
import { kitNotificationDeliveries, kitNotifications } from '@kit/notifications/schema'
import * as tasksRepo from '@kit/tasks/repos'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { notifyTaskMutation } from '../../services/notifications/task-producer'
import { createTaskNotificationService } from '../../services/notifications/task-service'
import { recordTaskLinkMutation, recordTaskMutation } from '../../services/task-audit'
import { createRecordingNotificationRuntime } from '../notification-runtime'
import { createNotificationFixture, type NotificationFixture } from './fixture'

let f: NotificationFixture
const orgId = 'org_acme'
const actorId = 'user_staff'
const recipient = 'user_team_owner'

beforeEach(async () => {
  f = await createNotificationFixture()
})
afterEach(() => {
  f.env.close()
})

async function task() {
  const response = await f.app.request(
    '/api/tasks',
    {
      method: 'POST',
      headers: await f.headersFor(actorId, orgId),
      body: JSON.stringify({ title: 'Delayed event', boardKey: 'main', visibility: 'shared' }),
    },
    f.env,
  )
  expect(response.status).toBe(201)
  return ((await response.json()) as { task: { id: string } }).task.id
}
async function rows(id: string) {
  return f.db.select().from(kitNotifications).where(eq(kitNotifications.sourceId, id))
}

describe('task mutation event races', () => {
  it('ignores stale additions and removals without closing a legitimate reassignment', async () => {
    const id = await task()
    const added = {
      kind: 'update' as const,
      orgId,
      taskId: id,
      actorId,
      assignees: { added: [recipient], removed: [] },
    }
    const removed = { ...added, assignees: { added: [], removed: [recipient] } }
    await recordTaskMutation(f.db, createRecordingNotificationRuntime().runtime, added)
    expect(await rows(id)).toEqual([])
    await tasksRepo.replaceAssignees(f.db, orgId, id, [recipient], Date.now())
    await recordTaskMutation(f.db, createRecordingNotificationRuntime().runtime, added)
    expect((await rows(id)).filter((row) => row.resolvedAt === null)).toHaveLength(1)
    await recordTaskMutation(f.db, createRecordingNotificationRuntime().runtime, removed)
    expect((await rows(id)).filter((row) => row.resolvedAt === null)).toHaveLength(1)
    await recordTaskLinkMutation(f.db, { ...added, kind: 'link_create' })
    expect(await rows(id)).toHaveLength(1)
  })

  it('keeps a new reassignment notice when an earlier removal resolves late', async () => {
    const id = await task()
    await tasksRepo.replaceAssignees(f.db, orgId, id, [recipient], Date.now())
    await tasksRepo.replaceAssignees(f.db, orgId, id, [], Date.now())
    expect(await rows(id)).toEqual([])

    let resume!: () => void
    let reachedResolve!: () => void
    const blocked = new Promise<void>((resolve) => {
      resume = resolve
    })
    const atResolve = new Promise<void>((resolve) => {
      reachedResolve = resolve
    })
    const real = createTaskNotificationService(f.db, createRecordingNotificationRuntime().runtime)
    let deliveries: (typeof kitNotificationDeliveries.$inferSelect)[] = []
    const removal = notifyTaskMutation(
      f.db,
      {
        ...real,
        async resolve(input) {
          reachedResolve()
          await blocked
          return real.resolve(input)
        },
      },
      {
        kind: 'update',
        orgId,
        taskId: id,
        actorId,
        assignees: { added: [], removed: [recipient] },
      },
    )
    try {
      await atResolve
      const response = await f.app.request(
        `/api/tasks/${id}`,
        {
          method: 'PATCH',
          headers: await f.headersFor(actorId, orgId),
          body: JSON.stringify({ assigneeIds: [recipient] }),
        },
        f.env,
      )
      expect(response.status).toBe(200)
      const assigned = await rows(id)
      expect(assigned).toHaveLength(1)
      expect(assigned[0]!.resolvedAt).toBeNull()
      deliveries = await f.db
        .select()
        .from(kitNotificationDeliveries)
        .where(eq(kitNotificationDeliveries.notificationId, assigned[0]!.id))
      expect(deliveries.length).toBeGreaterThan(0)
      expect(deliveries.every((delivery) => delivery.status === 'pending')).toBe(true)
    } finally {
      resume()
      await removal
    }
    const final = await rows(id)
    expect(final).toHaveLength(1)
    expect(final[0]!.resolvedAt).toBeNull()
    expect(
      await f.db
        .select()
        .from(kitNotificationDeliveries)
        .where(eq(kitNotificationDeliveries.notificationId, final[0]!.id)),
    ).toEqual(deliveries)
  })

  it('does not admit an assigned member when the task module is disabled', async () => {
    const id = await task()
    await tasksRepo.replaceAssignees(f.db, orgId, id, [recipient], Date.now())
    await upsertOrgModule(f.db, {
      organizationId: orgId,
      moduleId: 'tasks',
      enabled: false,
      updatedAt: Date.now(),
    })
    await recordTaskMutation(f.db, createRecordingNotificationRuntime().runtime, {
      kind: 'update',
      orgId,
      taskId: id,
      actorId,
      assignees: { added: [recipient], removed: [] },
    })
    expect(await rows(id)).toEqual([])
  })

  it('repairs unassignment or completion observed after actual admission', async () => {
    for (const change of ['unassign', 'done'] as const) {
      const id = await task()
      await tasksRepo.replaceAssignees(f.db, orgId, id, [recipient], Date.now())
      const real = createTaskNotificationService(f.db, createRecordingNotificationRuntime().runtime)
      await notifyTaskMutation(
        f.db,
        {
          ...real,
          async notify(input) {
            const result = await real.notify(input)
            if (change === 'unassign')
              await tasksRepo.replaceAssignees(f.db, orgId, id, [], Date.now())
            else await tasksRepo.updateTask(f.db, orgId, id, { done: true })
            return result
          },
        },
        {
          kind: 'update',
          orgId,
          taskId: id,
          actorId,
          assignees: { added: [recipient], removed: [] },
        },
      )
      const observed = await rows(id)
      expect(observed).toHaveLength(1)
      expect(observed[0]!.resolvedAt).not.toBeNull()
    }
  })
})
