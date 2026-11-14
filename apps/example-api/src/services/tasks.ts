import * as commentsRepo from '@kit/comments/repos'
import { AppError, parseOrThrow } from '@kit/core'
import type { Audience, UpdateTaskInput } from '@kit/tasks'
import {
  canSetVisibility,
  canViewTask,
  createTaskInputSchema,
  filterTasksForAudience,
  findDefaultStage,
  isStageOnBoard,
  suggestedDoneForStage,
  updateTaskInputSchema,
} from '@kit/tasks'
import * as tasksRepo from '@kit/tasks/repos'
import type { kitTasks } from '@kit/tasks/schema'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../db/schema'
import type { NotificationRuntimePorts } from './notifications/service'
import { recordTaskMutation } from './task-audit'
import { assertAssigneesAreMembers, replaceAssigneesOrThrow } from './tasks-assignees'

type Db = DrizzleD1Database<typeof schema>

const DEFAULT_BOARD = 'main'

export async function ensureDefaultBoard(db: Db, orgId: string): Promise<void> {
  const existing = await tasksRepo.listStages(db, orgId, DEFAULT_BOARD)
  if (existing.length > 0) return
  const now = Date.now()
  const stages = [
    {
      id: crypto.randomUUID(),
      orgId,
      boardKey: DEFAULT_BOARD,
      label: 'Todo',
      position: 0,
      isDefault: true,
      isTerminal: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: crypto.randomUUID(),
      orgId,
      boardKey: DEFAULT_BOARD,
      label: 'Doing',
      position: 1,
      isDefault: false,
      isTerminal: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: crypto.randomUUID(),
      orgId,
      boardKey: DEFAULT_BOARD,
      label: 'Done',
      position: 2,
      isDefault: false,
      isTerminal: true,
      createdAt: now,
      updatedAt: now,
    },
  ]
  for (const s of stages) {
    await tasksRepo.insertStage(db, s)
  }
}

function toApiTask(row: typeof kitTasks.$inferSelect, assigneeIds: string[]) {
  return {
    id: row.id,
    orgId: row.orgId,
    title: row.title,
    description: row.description,
    boardKey: row.boardKey,
    stageId: row.stageId,
    visibility: row.visibility,
    scopeKind: row.scopeKind,
    scopeId: row.scopeId,
    priority: row.priority,
    dueAt: row.dueAt,
    done: row.done,
    order: row.orderIndex,
    externalUrl: row.externalUrl,
    createdBy: row.createdBy,
    assigneeIds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function listTasksForOrg(
  db: Db,
  orgId: string,
  audience: Audience,
  options?: { readOnly?: boolean },
) {
  if (!options?.readOnly) await ensureDefaultBoard(db, orgId)
  const rows = await tasksRepo.listTasks(db, orgId)
  const visible = filterTasksForAudience(
    rows.map((r) => ({ ...r, visibility: r.visibility as 'internal' | 'shared' })),
    audience,
  )
  const ids = visible.map((r) => r.id)
  const assignees = await tasksRepo.listAssigneesForTasks(db, orgId, ids)
  const byTask = new Map<string, string[]>()
  for (const a of assignees) {
    const list = byTask.get(a.taskId) ?? []
    list.push(a.userId)
    byTask.set(a.taskId, list)
  }
  return visible.map((r) => toApiTask(r, byTask.get(r.id) ?? []))
}

export async function getTaskForOrg(db: Db, orgId: string, id: string, audience: Audience) {
  const row = await tasksRepo.getTask(db, orgId, id)
  if (!row) throw AppError.notFound('Task not found')
  if (!canViewTask({ visibility: row.visibility as 'internal' | 'shared' }, audience)) {
    throw AppError.notFound('Task not found')
  }
  const assignees = await tasksRepo.listAssigneesForTasks(db, orgId, [id])
  return toApiTask(
    row,
    assignees.map((a) => a.userId),
  )
}

export async function createTaskForOrg(
  db: Db,
  runtime: NotificationRuntimePorts,
  orgId: string,
  actorId: string,
  audience: Audience,
  raw: unknown,
) {
  await ensureDefaultBoard(db, orgId)
  const input = parseOrThrow(
    createTaskInputSchema,
    { ...(raw as object), orgId, createdBy: actorId },
    'Invalid task',
  )
  await assertAssigneesAreMembers(db, orgId, input.assigneeIds)
  const visibility = input.visibility ?? 'shared'
  if (!canSetVisibility(audience, visibility)) {
    throw AppError.forbidden('Cannot set this visibility')
  }
  const stages = await tasksRepo.listStages(db, orgId, input.boardKey)
  let stageId = input.stageId
  if (!stageId) {
    const def = findDefaultStage(stages, orgId, input.boardKey)
    if (!def) throw AppError.validation('No default stage for board')
    stageId = def.id
  } else if (!isStageOnBoard(stages, orgId, input.boardKey, stageId)) {
    throw AppError.validation('Stage not on board')
  }
  const doneHint = suggestedDoneForStage(stages, stageId)
  const now = Date.now()
  const id = crypto.randomUUID()
  const assignees = [...new Set(input.assigneeIds ?? [])]
  await tasksRepo.insertTask(
    db,
    {
      id,
      orgId,
      title: input.title,
      description: input.description ?? null,
      boardKey: input.boardKey,
      stageId,
      visibility,
      scopeKind: input.scopeKind ?? null,
      scopeId: input.scopeId ?? null,
      priority: input.priority ?? null,
      dueAt: input.dueAt ?? null,
      done: input.done ?? doneHint ?? false,
      orderIndex: input.order ?? 0,
      externalUrl: input.externalUrl ?? null,
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    },
    assignees,
  )
  await recordTaskMutation(db, runtime, {
    kind: 'create',
    orgId,
    taskId: id,
    actorId,
    assignees: { added: assignees, removed: [] },
    meta: { boardKey: input.boardKey, stageId },
  })
  return getTaskForOrg(db, orgId, id, audience)
}
function buildTaskPatch(
  input: UpdateTaskInput,
  stageId: string | undefined,
  done: boolean | undefined,
  now: number,
): Parameters<typeof tasksRepo.updateTask>[3] {
  const patch: Parameters<typeof tasksRepo.updateTask>[3] = { updatedAt: now }
  if (input.title !== undefined) patch.title = input.title
  if (input.description !== undefined) patch.description = input.description
  if (input.boardKey !== undefined) patch.boardKey = input.boardKey
  if (stageId !== undefined) patch.stageId = stageId
  if (input.visibility !== undefined) patch.visibility = input.visibility
  if (input.scopeKind !== undefined) patch.scopeKind = input.scopeKind
  if (input.scopeId !== undefined) patch.scopeId = input.scopeId
  if (input.priority !== undefined) patch.priority = input.priority
  if (input.dueAt !== undefined) patch.dueAt = input.dueAt
  if (done !== undefined) patch.done = done
  if (input.order !== undefined) patch.orderIndex = input.order
  if (input.externalUrl !== undefined) patch.externalUrl = input.externalUrl
  return patch
}

export async function updateTaskForOrg(
  db: Db,
  runtime: NotificationRuntimePorts,
  orgId: string,
  id: string,
  actorId: string,
  audience: Audience,
  raw: unknown,
) {
  const existing = await tasksRepo.getTask(db, orgId, id)
  if (!existing) throw AppError.notFound('Task not found')
  if (!canViewTask({ visibility: existing.visibility as 'internal' | 'shared' }, audience)) {
    throw AppError.notFound('Task not found')
  }
  if (audience === 'external') {
    throw AppError.forbidden('External audience cannot update tasks')
  }
  const input = parseOrThrow(updateTaskInputSchema, raw, 'Invalid task patch')
  if (input.assigneeIds) await assertAssigneesAreMembers(db, orgId, input.assigneeIds)
  if (input.visibility && !canSetVisibility(audience, input.visibility)) {
    throw AppError.forbidden('Cannot set this visibility')
  }
  const boardKey = input.boardKey ?? existing.boardKey
  const stages = await tasksRepo.listStages(db, orgId, boardKey)
  const stageId = input.stageId
  if (stageId && !isStageOnBoard(stages, orgId, boardKey, stageId)) {
    throw AppError.validation('Stage not on board')
  }
  const nextStage = stageId ?? existing.stageId
  let done = input.done
  if (stageId && done === undefined) {
    done = suggestedDoneForStage(stages, nextStage)
  }
  const now = Date.now()
  await tasksRepo.updateTask(db, orgId, id, buildTaskPatch(input, stageId, done, now))
  const assignees =
    input.assigneeIds !== undefined
      ? await replaceAssigneesOrThrow(db, orgId, id, input.assigneeIds, now)
      : undefined
  await recordTaskMutation(db, runtime, {
    kind: 'update',
    orgId,
    taskId: id,
    actorId,
    ...(assignees && assignees.added.length + assignees.removed.length > 0 ? { assignees } : {}),
    meta: { boardKey, stageId: nextStage },
  })
  return getTaskForOrg(db, orgId, id, audience)
}

export async function deleteTaskForOrg(
  db: Db,
  runtime: NotificationRuntimePorts,
  orgId: string,
  id: string,
  actorId: string,
  audience: Audience,
) {
  if (audience === 'external') throw AppError.forbidden('External audience cannot delete tasks')
  const existing = await tasksRepo.getTask(db, orgId, id)
  if (!existing) throw AppError.notFound('Task not found')
  // Comments first: if the task delete then fails, the task is still there and a retry finishes.
  await commentsRepo.deleteByTarget(db, orgId, 'task', id)
  await tasksRepo.deleteTask(db, orgId, id)
  await recordTaskMutation(db, runtime, { kind: 'delete', orgId, taskId: id, actorId })
}

export async function listStagesForOrg(
  db: Db,
  orgId: string,
  boardKey?: string,
  options?: { readOnly?: boolean },
) {
  if (!options?.readOnly) await ensureDefaultBoard(db, orgId)
  return tasksRepo.listStages(db, orgId, boardKey)
}

export { createLinkForOrg, listLinksForOrg } from './tasks-links'
