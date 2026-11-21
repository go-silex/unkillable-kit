import type Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import {
  deleteLink,
  deleteTask,
  getTask,
  insertLink,
  insertStage,
  insertTask,
  listAssigneesForTasks,
  listLinks,
  listStages,
  listTasks,
  replaceAssignees,
  updateTask,
} from './repos'
import { createMemoryD1 } from './test/memory-d1'

/** D1 rejects statements with more than ~100 bound parameters. */
const D1_MAX_BOUND_PARAMS = 100

type TaskPatch = Parameters<typeof updateTask>[3]

function stage(orgId: string, id: string) {
  return {
    id,
    orgId,
    boardKey: 'b',
    label: 'L',
    position: 0,
    isDefault: false,
    isTerminal: false,
    createdAt: 1,
    updatedAt: 1,
  }
}

function task(orgId: string, id: string, stageId: string) {
  return {
    id,
    orgId,
    title: id,
    boardKey: 'b',
    stageId,
    createdBy: 'u',
    createdAt: 1,
    updatedAt: 1,
  }
}

function link(orgId: string, id: string, fromTaskId: string, toTaskId: string) {
  return { id, orgId, fromTaskId, toTaskId, kind: 'blocks', createdAt: 1 }
}

/** org-a: t1, t2 (stage s-a) · org-b: t3 (stage s-b). */
async function seedTwoOrgs() {
  const handle = createMemoryD1()
  const { db } = handle
  await insertStage(db, stage('org-a', 's-a'))
  await insertStage(db, stage('org-b', 's-b'))
  await insertTask(db, task('org-a', 't1', 's-a'))
  await insertTask(db, task('org-a', 't2', 's-a'))
  await insertTask(db, task('org-b', 't3', 's-b'))
  return handle
}

function count(sqlite: Database.Database, sql: string, ...args: string[]) {
  return sqlite
    .prepare(sql)
    .pluck()
    .get(...args) as number
}

describe('tasks repos org predicates', () => {
  it('lists stages, tasks and links scoped to the org', async () => {
    const { db } = await seedTwoOrgs()
    await insertLink(db, link('org-a', 'l1', 't1', 't2'))
    expect(await listStages(db, 'org-a')).toEqual([expect.objectContaining({ id: 's-a' })])
    expect(await listStages(db, 'org-a', 'other-board')).toEqual([])
    expect(await listStages(db, 'org-b')).toEqual([expect.objectContaining({ id: 's-b' })])
    expect((await listTasks(db, 'org-a')).map((t) => t.id).sort()).toEqual(['t1', 't2'])
    expect((await listTasks(db, 'org-b')).map((t) => t.id)).toEqual(['t3'])
    expect(await listLinks(db, 'org-a')).toEqual([expect.objectContaining({ id: 'l1' })])
    expect(await listLinks(db, 'org-b')).toEqual([])
  })

  it('get and update only reach a task of the same org', async () => {
    const { db } = await seedTwoOrgs()
    expect(await getTask(db, 'org-a', 't1')).toMatchObject({ id: 't1', orgId: 'org-a' })
    expect(await getTask(db, 'org-b', 't1')).toBeNull()

    await updateTask(db, 'org-b', 't1', { title: 'x' })
    expect(await getTask(db, 'org-a', 't1')).toMatchObject({ title: 't1' })

    await updateTask(db, 'org-a', 't1', { title: 'renamed' })
    expect(await getTask(db, 'org-a', 't1')).toMatchObject({ title: 'renamed' })
  })

  it('updateTask refuses to move the tenant of record or rewrite identity', async () => {
    const { db } = await seedTwoOrgs()
    // The patch type already omits these keys; untyped callers (JS, `as` casts) must still hit the runtime guard.
    const moveTenant = { orgId: 'org-b' } as unknown as TaskPatch
    await expect(updateTask(db, 'org-a', 't1', moveTenant)).rejects.toThrow(/orgId/)
    const rewriteId = { id: 'other' } as unknown as TaskPatch
    await expect(updateTask(db, 'org-a', 't1', rewriteId)).rejects.toThrow(/id/)
    expect(await getTask(db, 'org-a', 't1')).toMatchObject({ id: 't1', orgId: 'org-a' })
    expect(await getTask(db, 'org-b', 't1')).toBeNull()
  })
})

describe('tasks repos — assignees (ADR-0007 D2)', () => {
  it('rolls back task creation and earlier assignee chunks when a later insert fails', async () => {
    const { db, sqlite } = await seedTwoOrgs()
    sqlite.exec(
      "CREATE TRIGGER reject_initial BEFORE INSERT ON kit_task_assignees WHEN NEW.user_id = 'u19' BEGIN SELECT RAISE(ABORT, 'rejected'); END;",
    )
    const users = Array.from({ length: 25 }, (_, i) => `u${i}`)
    await expect(insertTask(db, task('org-a', 'new', 's-a'), users)).rejects.toThrow()
    expect(await getTask(db, 'org-a', 'new')).toBeNull()
    expect(await listAssigneesForTasks(db, 'org-a', ['new'])).toEqual([])
  })

  it('listAssigneesForTasks returns only assignees of tasks of the org', async () => {
    const { db } = await seedTwoOrgs()
    await replaceAssignees(db, 'org-a', 't1', ['u1'], 1)
    await replaceAssignees(db, 'org-b', 't3', ['u9'], 1)

    expect(await listAssigneesForTasks(db, 'org-a', ['t1', 't2', 't3'])).toEqual([
      expect.objectContaining({ orgId: 'org-a', taskId: 't1', userId: 'u1' }),
    ])
    expect(await listAssigneesForTasks(db, 'org-b', ['t1'])).toEqual([])
    expect(await listAssigneesForTasks(db, 'org-a', [])).toEqual([])
  })

  it('listAssigneesForTasks chunks ids under the D1 bind limit', async () => {
    const { db, boundParams } = await seedTwoOrgs()
    const ids = Array.from({ length: 130 }, (_, i) => `bulk-${i}`)
    for (const id of ids) {
      await insertTask(db, task('org-a', id, 's-a'))
      await replaceAssignees(db, 'org-a', id, ['u1'], 1)
    }
    boundParams.length = 0
    const rows = await listAssigneesForTasks(db, 'org-a', ids)
    expect(rows).toHaveLength(130)
    expect(Math.max(...boundParams)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS)
  })

  it('replaceAssignees from another org writes nothing and keeps the owner assignees', async () => {
    const { db, sqlite } = await seedTwoOrgs()
    await replaceAssignees(db, 'org-a', 't1', ['u1', 'u2'], 1)

    expect(await replaceAssignees(db, 'org-b', 't1', ['evil'], 2)).toBeNull()
    expect(await replaceAssignees(db, 'org-b', 't1', [], 2)).toBeNull()

    const owner = await listAssigneesForTasks(db, 'org-a', ['t1'])
    expect(owner.map((a) => a.userId).sort()).toEqual(['u1', 'u2'])
    expect(
      count(sqlite, `SELECT count(*) AS n FROM kit_task_assignees WHERE org_id = ?`, 'org-b'),
    ).toBe(0)
  })

  it('replaceAssignees replaces the set and stores the owner org on every row', async () => {
    const { db, sqlite } = await seedTwoOrgs()
    expect(await replaceAssignees(db, 'org-a', 't1', ['u1', 'u2'], 1)).toEqual({
      added: ['u1', 'u2'],
      removed: [],
    })
    expect(await replaceAssignees(db, 'org-a', 't1', ['u2', 'u3'], 2)).toEqual({
      added: ['u3'],
      removed: ['u1'],
    })
    expect((await listAssigneesForTasks(db, 'org-a', ['t1'])).map((a) => a.userId).sort()).toEqual([
      'u2',
      'u3',
    ])
    expect(
      count(sqlite, `SELECT count(*) AS n FROM kit_task_assignees WHERE org_id = ?`, 'org-a'),
    ).toBe(2)
  })

  it('serializes overlapping replacements with deltas against each committed baseline', async () => {
    const { db, sqlite } = await seedTwoOrgs()
    await replaceAssignees(db, 'org-a', 't1', ['u0'], 1)
    let release!: () => void
    let signalStarted!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    const batch = db.batch.bind(db)
    const spy = vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
      signalStarted()
      await blocked
      return batch(statements)
    })
    const members = () =>
      (
        sqlite
          .prepare('SELECT user_id FROM kit_task_assignees WHERE task_id = ? ORDER BY user_id')
          .all('t1') as { user_id: string }[]
      ).map((row) => row.user_id)
    try {
      const a = replaceAssignees(db, 'org-a', 't1', ['uA'], 2)
      await started
      expect(members()).toEqual(['u0'])
      const bDelta = await replaceAssignees(db, 'org-a', 't1', ['uB'], 3)
      expect(bDelta).toEqual({ added: ['uB'], removed: ['u0'] })
      expect(members()).toEqual(['uB'])
      release()
      expect(await a).toEqual({ added: ['uA'], removed: ['uB'] })
      expect(members()).toEqual(['uA'])
    } finally {
      release()
      spy.mockRestore()
    }
  })

  it('rolls back the deletion and earlier insert chunks when a later insert fails', async () => {
    const { db, sqlite } = await seedTwoOrgs()
    await replaceAssignees(db, 'org-a', 't1', ['original'], 1)
    sqlite.exec(
      "CREATE TRIGGER reject_assignee BEFORE INSERT ON kit_task_assignees WHEN NEW.user_id = 'u19' BEGIN SELECT RAISE(ABORT, 'rejected'); END;",
    )
    const users = Array.from({ length: 25 }, (_, i) => `u${i}`)
    await expect(replaceAssignees(db, 'org-a', 't1', users, 2)).rejects.toThrow()
    expect((await listAssigneesForTasks(db, 'org-a', ['t1'])).map((row) => row.userId)).toEqual([
      'original',
    ])
  })

  it('replaceAssignees stores the MAX_ASSIGNEES set in statements under the D1 bind limit', async () => {
    const { db, boundParams } = await seedTwoOrgs()
    const users = Array.from({ length: 50 }, (_, i) => `u${i}`)
    boundParams.length = 0
    expect(await replaceAssignees(db, 'org-a', 't1', users, 1)).toEqual({
      added: users,
      removed: [],
    })
    expect(Math.max(...boundParams)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS)
    expect(await listAssigneesForTasks(db, 'org-a', ['t1'])).toHaveLength(50)
  })
})

describe('tasks repos — delete', () => {
  it('deleteTask from another org leaves the task, its assignees and its links intact', async () => {
    const { db } = await seedTwoOrgs()
    await replaceAssignees(db, 'org-a', 't1', ['u1'], 1)
    await insertLink(db, link('org-a', 'l1', 't1', 't2'))

    await deleteTask(db, 'org-b', 't1')

    expect(await getTask(db, 'org-a', 't1')).toMatchObject({ id: 't1' })
    expect(await listAssigneesForTasks(db, 'org-a', ['t1'])).toHaveLength(1)
    expect(await listLinks(db, 'org-a')).toHaveLength(1)
  })

  it('deleteTask removes the task with its assignees and links', async () => {
    const { db, sqlite } = await seedTwoOrgs()
    await replaceAssignees(db, 'org-a', 't1', ['u1'], 1)
    await replaceAssignees(db, 'org-a', 't2', ['u1'], 1)
    await insertLink(db, link('org-a', 'l1', 't1', 't2'))
    await insertLink(db, link('org-a', 'l2', 't2', 't1'))

    await deleteTask(db, 'org-a', 't1')

    expect(await getTask(db, 'org-a', 't1')).toBeNull()
    expect(await listAssigneesForTasks(db, 'org-a', ['t1'])).toEqual([])
    expect(await listLinks(db, 'org-a')).toEqual([])
    expect(
      count(sqlite, `SELECT count(*) AS n FROM kit_task_assignees WHERE task_id = ?`, 't1'),
    ).toBe(0)
    expect(await listAssigneesForTasks(db, 'org-a', ['t2'])).toHaveLength(1)
  })
})

describe('tasks repos — links', () => {
  it('deleteLink from another org keeps the link', async () => {
    const { db } = await seedTwoOrgs()
    await insertLink(db, link('org-a', 'l1', 't1', 't2'))
    await deleteLink(db, 'org-b', 'l1')
    expect(await listLinks(db, 'org-a')).toHaveLength(1)
    await deleteLink(db, 'org-a', 'l1')
    expect(await listLinks(db, 'org-a')).toEqual([])
  })

  it('insertLink refuses a link whose tasks are not both owned by the link org', async () => {
    const { db } = await seedTwoOrgs()
    // org-b link onto org-a's t1, and org-a link onto org-b's t3: both are cross-tenant.
    await expect(insertLink(db, link('org-b', 'lx', 't1', 't3'))).rejects.toThrow(/link org/)
    await expect(insertLink(db, link('org-a', 'ly', 't1', 't3'))).rejects.toThrow(/link org/)
    await expect(insertLink(db, link('org-a', 'lz', 't1', 'missing'))).rejects.toThrow(/link org/)
    expect(await listLinks(db, 'org-a')).toEqual([])
    expect(await listLinks(db, 'org-b')).toEqual([])
  })
})
