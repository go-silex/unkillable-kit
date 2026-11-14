import * as auditRepo from '@kit/auth/repos/audit'
import { createDb } from '@kit/db'
import * as tasksRepo from '@kit/tasks/repos'
import { kitTasks } from '@kit/tasks/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { auditEvents, schema } from './db/schema'
import type { KitDb } from './lib/db-type'
import { seedDemoDatabase } from './seed/seed-db'
import * as taskAudit from './services/task-audit'
import * as tasksService from './services/tasks'
import { hashFixtureCredential } from './test/fixture-credential'
import { createMemoryEnv } from './test/memory-env'
import { createRecordingNotificationRuntime } from './test/notification-runtime'

const ORG = 'org_acme'
const ACTOR = 'user_staff'
const SECRET_TITLE = 'ghp_live_example'
const SECRET_BODY = 'reset me'

async function seed() {
  const env = createMemoryEnv()
  const db = createDb(env.DB as unknown as D1Database, schema)
  await seedDemoDatabase(db, { notes: false, environment: 'test' }, hashFixtureCredential)
  return db
}

async function rowsFor(db: KitDb, targetId: string) {
  return db.select().from(auditEvents).where(eq(auditEvents.targetId, targetId))
}

describe('task afterMutation audit', () => {
  it('does not initialize a board during read-only task reads', async () => {
    const env = createMemoryEnv()
    const db = createDb(env.DB as unknown as D1Database, schema)
    const orgId = 'org_read_only'
    await env.DB.prepare(
      'INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(orgId, orgId, orgId, 1)
      .run()

    expect(await tasksService.listTasksForOrg(db, orgId, 'staff', { readOnly: true })).toEqual([])
    expect(await tasksService.listStagesForOrg(db, orgId, undefined, { readOnly: true })).toEqual(
      [],
    )
    expect(await tasksRepo.listStages(db, orgId, 'main')).toEqual([])
    await tasksService.listTasksForOrg(db, orgId, 'staff')
    expect(await tasksRepo.listStages(db, orgId, 'main')).toHaveLength(3)
  })

  it('preserves a concurrent reassignment after creation commits', async () => {
    const db = await seed()
    let release!: () => void
    let signalInserted!: (id: string) => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const inserted = new Promise<string>((resolve) => {
      signalInserted = resolve
    })
    const insert = tasksRepo.insertTask
    const insertSpy = vi.spyOn(tasksRepo, 'insertTask').mockImplementationOnce(async (...args) => {
      const result = await insert(...args)
      signalInserted(result.id)
      await blocked
      return result
    })
    const events = vi.spyOn(taskAudit, 'recordTaskMutation')
    try {
      const creating = tasksService.createTaskForOrg(
        db,
        createRecordingNotificationRuntime().runtime,
        ORG,
        ACTOR,
        'staff',
        {
          title: 'concurrent',
          boardKey: 'main',
          assigneeIds: ['user_staff', 'user_staff'],
        },
      )
      const id = await inserted
      const before = await tasksService.getTaskForOrg(db, ORG, id, 'staff')
      expect(before.assigneeIds).toEqual(['user_staff'])
      await tasksService.updateTaskForOrg(
        db,
        createRecordingNotificationRuntime().runtime,
        ORG,
        id,
        ACTOR,
        'staff',
        {
          assigneeIds: ['user_team_owner'],
        },
      )
      expect(events.mock.calls.at(-1)?.[2].assignees).toEqual({
        added: ['user_team_owner'],
        removed: ['user_staff'],
      })
      release()
      const created = await creating
      expect(created.assigneeIds).toEqual(['user_team_owner'])
      const createEvent = events.mock.calls.find(([, , event]) => event.kind === 'create')?.[2]
      expect(createEvent?.assignees).toEqual({ added: ['user_staff'], removed: [] })
      expect((await tasksService.getTaskForOrg(db, ORG, id, 'staff')).assigneeIds).toEqual([
        'user_team_owner',
      ])
    } finally {
      release()
      insertSpy.mockRestore()
      events.mockRestore()
    }
  })

  it('emits set-based assignee deltas without putting assignees in audit metadata', async () => {
    const db = await seed()
    const spy = vi.spyOn(taskAudit, 'recordTaskMutation')
    try {
      const created = await tasksService.createTaskForOrg(
        db,
        createRecordingNotificationRuntime().runtime,
        ORG,
        ACTOR,
        'staff',
        {
          title: 'assigned',
          boardKey: 'main',
          assigneeIds: ['user_staff', 'user_staff'],
        },
      )
      expect(spy.mock.calls.at(-1)?.[2].assignees).toEqual({
        added: ['user_staff'],
        removed: [],
      })

      const update = (patch: object) =>
        tasksService.updateTaskForOrg(
          db,
          createRecordingNotificationRuntime().runtime,
          ORG,
          created.id,
          ACTOR,
          'staff',
          patch,
        )
      await update({ assigneeIds: ['user_team_owner', 'user_staff', 'user_team_owner'] })
      expect(spy.mock.calls.at(-1)?.[2].assignees).toEqual({
        added: ['user_team_owner'],
        removed: [],
      })
      await update({ assigneeIds: ['user_staff', 'user_team_owner', 'user_staff'] })
      expect(spy.mock.calls.at(-1)?.[2]).not.toHaveProperty('assignees')
      const unchanged = await update({ title: 'renamed' })
      expect(spy.mock.calls.at(-1)?.[2]).not.toHaveProperty('assignees')
      expect(new Set(unchanged.assigneeIds)).toEqual(new Set(['user_staff', 'user_team_owner']))

      await update({ assigneeIds: ['user_team_owner'] })
      expect(spy.mock.calls.at(-1)?.[2].assignees).toEqual({
        added: [],
        removed: ['user_staff'],
      })
      await update({ assigneeIds: ['user_staff', 'user_staff'] })
      expect(spy.mock.calls.at(-1)?.[2].assignees).toEqual({
        added: ['user_staff'],
        removed: ['user_team_owner'],
      })
      const cleared = await update({ assigneeIds: [] })
      expect(spy.mock.calls.at(-1)?.[2].assignees).toEqual({
        added: [],
        removed: ['user_staff'],
      })
      expect(cleared.assigneeIds).toEqual([])
      await update({ assigneeIds: [] })
      expect(spy.mock.calls.at(-1)?.[2]).not.toHaveProperty('assignees')

      const rows = await rowsFor(db, created.id)
      expect(rows).toHaveLength(8)
      for (const row of rows) {
        expect(JSON.parse(row.metaJson ?? '{}')).toEqual({
          boardKey: 'main',
          stageId: created.stageId,
        })
        expect(row.metaJson).not.toContain('user_staff')
        expect(row.metaJson).not.toContain('user_team_owner')
      }
      await tasksService.createTaskForOrg(
        db,
        createRecordingNotificationRuntime().runtime,
        ORG,
        ACTOR,
        'staff',
        {
          title: 'unassigned',
          boardKey: 'main',
        },
      )
      expect(spy.mock.calls.at(-1)?.[2].assignees).toEqual({ added: [], removed: [] })
    } finally {
      spy.mockRestore()
    }
  })

  it('writes one row per mutation and keeps title and description out of meta', async () => {
    const db = await seed()
    const created = await tasksService.createTaskForOrg(
      db,
      createRecordingNotificationRuntime().runtime,
      ORG,
      ACTOR,
      'staff',
      {
        title: SECRET_TITLE,
        description: SECRET_BODY,
        boardKey: 'main',
        externalUrl: 'https://example.test/hook',
        orgId: 'org_beta',
      },
    )
    expect(created?.orgId).toBe(ORG)

    const createdRows = await rowsFor(db, created!.id)
    expect(createdRows).toHaveLength(1)
    expect(createdRows[0]).toMatchObject({
      action: 'task.create',
      actorUserId: ACTOR,
      targetType: 'task',
      targetId: created!.id,
      orgId: ORG,
    })
    const createdMeta = JSON.parse(createdRows[0]!.metaJson ?? '{}') as Record<string, unknown>
    expect(createdMeta).toEqual({ boardKey: 'main', stageId: created!.stageId })
    expect(createdRows[0]!.metaJson).not.toContain(SECRET_TITLE)
    expect(createdRows[0]!.metaJson).not.toContain(SECRET_BODY)

    const other = await tasksService.createTaskForOrg(
      db,
      createRecordingNotificationRuntime().runtime,
      ORG,
      ACTOR,
      'staff',
      {
        title: 'other',
        boardKey: 'main',
      },
    )
    const link = await tasksService.createLinkForOrg(db, ORG, ACTOR, 'staff', {
      fromTaskId: created!.id,
      toTaskId: other!.id,
      kind: 'blocks',
      orgId: 'org_beta',
    })
    const linkRows = await rowsFor(db, link.id)
    expect(linkRows).toHaveLength(1)
    expect(linkRows[0]).toMatchObject({
      action: 'task.link_create',
      actorUserId: ACTOR,
      targetType: 'task_link',
      targetId: link.id,
      orgId: ORG,
    })
    expect(JSON.parse(linkRows[0]!.metaJson ?? '{}')).toEqual({ linkKind: 'blocks' })

    const updated = await tasksService.updateTaskForOrg(
      db,
      createRecordingNotificationRuntime().runtime,
      ORG,
      created!.id,
      ACTOR,
      'staff',
      {
        title: 'renamed',
        description: SECRET_BODY,
      },
    )
    expect(updated?.id).toBe(created!.id)
    const updateRows = (await rowsFor(db, created!.id)).filter(
      (row) => row.action === 'task.update',
    )
    expect(updateRows).toHaveLength(1)
    expect(updateRows[0]).toMatchObject({
      actorUserId: ACTOR,
      targetType: 'task',
      targetId: created!.id,
      orgId: ORG,
    })
    expect(updateRows[0]!.metaJson).not.toContain(SECRET_BODY)
    expect(updateRows[0]!.metaJson).not.toContain('renamed')

    await tasksService.deleteTaskForOrg(
      db,
      createRecordingNotificationRuntime().runtime,
      ORG,
      created!.id,
      ACTOR,
      'staff',
    )
    const deleteRows = (await rowsFor(db, created!.id)).filter(
      (row) => row.action === 'task.delete',
    )
    expect(deleteRows).toHaveLength(1)
    expect(deleteRows[0]).toMatchObject({
      actorUserId: ACTOR,
      targetType: 'task',
      targetId: created!.id,
      orgId: ORG,
    })
    const linkDeletes = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'task.link_delete'))
    expect(linkDeletes).toHaveLength(0)
  })

  it('still returns the task when the audit insert fails, and the hook runs after the write', async () => {
    const db = await seed()
    let seenAfterWrite = false
    const spy = vi.spyOn(auditRepo, 'insertAuditEvent').mockImplementation(async (_db, row) => {
      const found = await db
        .select()
        .from(kitTasks)
        .where(eq(kitTasks.id, row.targetId ?? ''))
      seenAfterWrite = found.length === 1
      throw new Error('insert fail')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const task = await tasksService.createTaskForOrg(
      db,
      createRecordingNotificationRuntime().runtime,
      ORG,
      ACTOR,
      'staff',
      {
        title: SECRET_TITLE,
        boardKey: 'main',
      },
    )
    expect(spy).toHaveBeenCalledTimes(1)
    expect(seenAfterWrite).toBe(true)
    expect(task?.id).toBeTruthy()
    const rows = await rowsFor(db, task!.id)
    expect(rows).toHaveLength(0)
    spy.mockRestore()
    errSpy.mockRestore()
  })
})
