import { kitNotificationDeliveries, kitNotifications } from '@kit/notifications/schema'
import * as tasksRepo from '@kit/tasks/repos'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { notifyTaskMutation } from '../../services/notifications/task-producer'
import { createTaskNotificationService } from '../../services/notifications/task-service'
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

async function request(path: string, method: string, body: object) {
  return f.app.request(
    path,
    { method, headers: await f.headersFor(actorId, orgId), body: JSON.stringify(body) },
    f.env,
  )
}
async function create() {
  const response = await request('/api/tasks', 'POST', {
    title: 'Original title',
    boardKey: 'main',
    visibility: 'shared',
  })
  expect(response.status).toBe(201)
  return ((await response.json()) as { task: { id: string } }).task.id
}
async function patch(id: string, body: object) {
  expect((await request(`/api/tasks/${id}`, 'PATCH', body)).status).toBe(200)
}
async function notices(id: string) {
  return f.db.select().from(kitNotifications).where(eq(kitNotifications.sourceId, id))
}
async function deliveries(notificationId: string) {
  return f.db
    .select()
    .from(kitNotificationDeliveries)
    .where(eq(kitNotificationDeliveries.notificationId, notificationId))
}

describe('guarded task notification resolution', () => {
  it('preserves the original read notification and pending deliveries when reassignment deduplicates it', async () => {
    const id = await create()
    await patch(id, { assigneeIds: [recipient] })
    const initial = (await notices(id))[0]!
    await f.db
      .update(kitNotifications)
      .set({ readAt: 123 })
      .where(eq(kitNotifications.id, initial.id))
    const before = (await notices(id))[0]!
    const beforeDeliveries = await deliveries(before.id)
    expect(beforeDeliveries.length).toBeGreaterThan(0)
    expect(beforeDeliveries.every((row) => row.status === 'pending')).toBe(true)
    await tasksRepo.replaceAssignees(f.db, orgId, id, [], Date.now())
    let resume!: () => void
    let reached!: () => void
    const blocked = new Promise<void>((resolve) => {
      resume = resolve
    })
    const entered = new Promise<void>((resolve) => {
      reached = resolve
    })
    const real = createTaskNotificationService(f.db, createRecordingNotificationRuntime().runtime)
    const removal = notifyTaskMutation(
      f.db,
      {
        ...real,
        async resolve(input) {
          reached()
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
      await entered
      await patch(id, { title: 'Changed title', assigneeIds: [recipient] })
      expect(await notices(id)).toEqual([before])
    } finally {
      resume()
      await removal
    }
    expect(await notices(id)).toEqual([before])
    expect(await deliveries(before.id)).toEqual(beforeDeliveries)
  })

  it('guards delayed post-notify compensation against reassignment after removal or reopening', async () => {
    for (const change of ['unassigned', 'closed'] as const) {
      const id = await create()
      await tasksRepo.replaceAssignees(f.db, orgId, id, [recipient], Date.now())
      let resume!: () => void
      let reached!: () => void
      const blocked = new Promise<void>((resolve) => {
        resume = resolve
      })
      const entered = new Promise<void>((resolve) => {
        reached = resolve
      })
      const real = createTaskNotificationService(f.db, createRecordingNotificationRuntime().runtime)
      const opening = notifyTaskMutation(
        f.db,
        {
          ...real,
          async notify(input) {
            const result = await real.notify(input)
            if (change === 'unassigned')
              await tasksRepo.replaceAssignees(f.db, orgId, id, [], Date.now())
            else await tasksRepo.updateTask(f.db, orgId, id, { done: true })
            return result
          },
          async resolve(input) {
            reached()
            await blocked
            return real.resolve(input)
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
      let activeId = ''
      let pending: (typeof kitNotificationDeliveries.$inferSelect)[] = []
      try {
        await entered
        if (change === 'closed') {
          await patch(id, { done: false })
          await patch(id, { assigneeIds: [] })
        }
        await patch(id, { assigneeIds: [recipient] })
        const active = (await notices(id)).filter((row) => row.resolvedAt === null)
        expect(active).toHaveLength(1)
        activeId = active[0]!.id
        pending = await deliveries(activeId)
        expect(pending.length).toBeGreaterThan(0)
        expect(pending.every((row) => row.status === 'pending')).toBe(true)
      } finally {
        resume()
        await opening
      }
      expect(
        (await notices(id)).filter((row) => row.resolvedAt === null).map((row) => row.id),
      ).toEqual([activeId])
      expect(await deliveries(activeId)).toEqual(pending)
    }
  })
})
