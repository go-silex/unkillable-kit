import { D1_IN_ARRAY_CHUNK, mapInChunks } from '@kit/db'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { kitTaskAssignees, kitTaskLinks, kitTaskStages, kitTasks } from './drizzle-schema'

type Db = DrizzleD1Database<Record<string, unknown>>

export async function listStages(db: Db, orgId: string, boardKey?: string) {
  if (boardKey) {
    return db
      .select()
      .from(kitTaskStages)
      .where(and(eq(kitTaskStages.orgId, orgId), eq(kitTaskStages.boardKey, boardKey)))
      .orderBy(asc(kitTaskStages.position))
      .all()
  }
  return db
    .select()
    .from(kitTaskStages)
    .where(eq(kitTaskStages.orgId, orgId))
    .orderBy(asc(kitTaskStages.position))
    .all()
}

export async function insertStage(db: Db, row: typeof kitTaskStages.$inferInsert) {
  await db.insert(kitTaskStages).values(row).run()
  return row
}

export async function listTasks(db: Db, orgId: string) {
  return db.select().from(kitTasks).where(eq(kitTasks.orgId, orgId)).all()
}

export async function getTask(db: Db, orgId: string, id: string) {
  const rows = await db
    .select()
    .from(kitTasks)
    .where(and(eq(kitTasks.orgId, orgId), eq(kitTasks.id, id)))
    .all()
  return rows[0] ?? null
}

export async function insertTask(
  db: Db,
  row: typeof kitTasks.$inferInsert,
  assigneeIds: string[] = [],
) {
  const assignees = [...new Set(assigneeIds)]
  await db.batch([
    db.insert(kitTasks).values(row),
    ...assigneeInserts(db, row.orgId, row.id, assignees, row.createdAt),
  ])
  return row
}

/** Fields a patch may never carry: identity and the tenant of record (ADR-0007 D2). */
const IMMUTABLE_TASK_FIELDS = ['id', 'orgId', 'createdBy', 'createdAt'] as const

export async function updateTask(
  db: Db,
  orgId: string,
  id: string,
  patch: Omit<Partial<typeof kitTasks.$inferInsert>, (typeof IMMUTABLE_TASK_FIELDS)[number]>,
) {
  // Type-level guard for typed callers; the throw covers untyped ones (the tenant must never move).
  for (const field of IMMUTABLE_TASK_FIELDS) {
    if (field in patch) throw new Error(`updateTask: ${field} is immutable`)
  }
  await db
    .update(kitTasks)
    .set(patch)
    .where(and(eq(kitTasks.orgId, orgId), eq(kitTasks.id, id)))
    .run()
}

/** Deletes the task and its children in `orgId`. A task of another org is left untouched. */
export async function deleteTask(db: Db, orgId: string, id: string) {
  // Children first, only after the task is proven to belong to `orgId`.
  if (!(await getTask(db, orgId, id))) return
  await db.delete(kitTaskAssignees).where(eq(kitTaskAssignees.taskId, id)).run()
  await db
    .delete(kitTaskLinks)
    .where(
      and(
        eq(kitTaskLinks.orgId, orgId),
        // drizzle: delete where from or to — two deletes
        eq(kitTaskLinks.fromTaskId, id),
      ),
    )
    .run()
  await db
    .delete(kitTaskLinks)
    .where(and(eq(kitTaskLinks.orgId, orgId), eq(kitTaskLinks.toTaskId, id)))
    .run()
  await db
    .delete(kitTasks)
    .where(and(eq(kitTasks.orgId, orgId), eq(kitTasks.id, id)))
    .run()
}

/** Assignees of `taskIds` owned by `orgId`. */
export async function listAssigneesForTasks(db: Db, orgId: string, taskIds: string[]) {
  return mapInChunks(taskIds, D1_IN_ARRAY_CHUNK, (chunk) =>
    db
      .select({
        orgId: kitTasks.orgId,
        taskId: kitTaskAssignees.taskId,
        userId: kitTaskAssignees.userId,
        createdAt: kitTaskAssignees.createdAt,
      })
      .from(kitTaskAssignees)
      .innerJoin(kitTasks, eq(kitTasks.id, kitTaskAssignees.taskId))
      .where(and(eq(kitTasks.orgId, orgId), inArray(kitTaskAssignees.taskId, chunk)))
      .all(),
  )
}

/** Bound parameters per assignee row: org_id, task_id, user_id, created_at. */
const ASSIGNEE_COLUMNS = 4

function assigneeInserts(db: Db, orgId: string, taskId: string, userIds: string[], now: number) {
  const owned = sql`exists (select 1 from ${kitTasks} where ${kitTasks.orgId} = ${orgId} and ${kitTasks.id} = ${taskId})`
  const inserts = []
  const chunkSize = Math.floor((D1_IN_ARRAY_CHUNK - 2) / ASSIGNEE_COLUMNS)
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const rows = userIds
      .slice(i, i + chunkSize)
      .map((userId) => sql`(${orgId}, ${taskId}, ${userId}, ${now})`)
    inserts.push(
      db.insert(kitTaskAssignees).select(sql`
        select column1, column2, column3, column4
        from (values ${sql.join(rows, sql`, `)})
        where ${owned}
      `),
    )
  }
  return inserts
}

/**
 * Replaces the assignees of a task owned by `orgId` atomically and returns its membership delta.
 * Returns null, writing nothing, when the task is not owned. Membership is the caller's check.
 */
export async function replaceAssignees(
  db: Db,
  orgId: string,
  taskId: string,
  userIds: string[],
  now: number,
): Promise<{ added: string[]; removed: string[] } | null> {
  const distinct = [...new Set(userIds)]
  const ownedTask = db
    .select({ id: kitTasks.id })
    .from(kitTasks)
    .where(and(eq(kitTasks.orgId, orgId), eq(kitTasks.id, taskId)))
  const previousAssignees = db
    .select({ userId: kitTaskAssignees.userId })
    .from(kitTaskAssignees)
    .innerJoin(kitTasks, eq(kitTasks.id, kitTaskAssignees.taskId))
    .where(and(eq(kitTasks.orgId, orgId), eq(kitTasks.id, taskId)))
  const owned = sql`exists (select 1 from ${kitTasks} where ${kitTasks.orgId} = ${orgId} and ${kitTasks.id} = ${taskId})`
  const remove = db.delete(kitTaskAssignees).where(and(eq(kitTaskAssignees.taskId, taskId), owned))
  const [tasks, previous] = await db.batch([
    ownedTask,
    previousAssignees,
    remove,
    ...assigneeInserts(db, orgId, taskId, distinct, now),
  ])
  if (tasks.length === 0) return null
  const before = new Set(previous.map((row) => row.userId))
  const after = new Set(distinct)
  return {
    added: distinct.filter((userId) => !before.has(userId)),
    removed: [...before].filter((userId) => !after.has(userId)),
  }
}

export async function listLinks(db: Db, orgId: string) {
  return db.select().from(kitTaskLinks).where(eq(kitTaskLinks.orgId, orgId)).all()
}

/** Inserts a link between two tasks of `row.orgId`; throws when either task belongs elsewhere. */
export async function insertLink(db: Db, row: typeof kitTaskLinks.$inferInsert) {
  const ends = [...new Set([row.fromTaskId, row.toTaskId])]
  const owned = await db
    .select({ id: kitTasks.id })
    .from(kitTasks)
    .where(and(eq(kitTasks.orgId, row.orgId), inArray(kitTasks.id, ends)))
    .all()
  if (owned.length !== ends.length) {
    throw new Error('insertLink: both tasks must belong to the link org')
  }
  await db.insert(kitTaskLinks).values(row).run()
  return row
}

export async function deleteLink(db: Db, orgId: string, id: string) {
  await db
    .delete(kitTaskLinks)
    .where(and(eq(kitTaskLinks.orgId, orgId), eq(kitTaskLinks.id, id)))
    .run()
}
