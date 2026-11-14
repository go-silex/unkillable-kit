import { AppError, parseOrThrow } from '@kit/core'
import type { Audience } from '@kit/tasks'
import { canViewTask, checkNewLink, createTaskLinkInputSchema } from '@kit/tasks'
import * as tasksRepo from '@kit/tasks/repos'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../db/schema'
import { recordTaskLinkMutation } from './task-audit'

type Db = DrizzleD1Database<typeof schema>

export async function createLinkForOrg(
  db: Db,
  orgId: string,
  actorId: string,
  audience: Audience,
  raw: unknown,
) {
  if (audience === 'external') throw AppError.forbidden()
  const input = parseOrThrow(
    createTaskLinkInputSchema,
    { ...(raw as object), orgId },
    'Invalid task link',
  )
  const from = await tasksRepo.getTask(db, orgId, input.fromTaskId)
  const to = await tasksRepo.getTask(db, orgId, input.toTaskId)
  if (!(from && to)) throw AppError.notFound('Task not found')
  const existing = await tasksRepo.listLinks(db, orgId)
  const issues = checkNewLink(
    existing.map((e) => ({
      orgId: e.orgId,
      fromTaskId: e.fromTaskId,
      toTaskId: e.toTaskId,
      kind: e.kind as 'parent' | 'blocks' | 'duplicates',
    })),
    {
      orgId,
      fromTaskId: input.fromTaskId,
      toTaskId: input.toTaskId,
      kind: input.kind,
    },
  )
  if (issues.length > 0) {
    throw AppError.validation(issues[0]!.message, { issues })
  }
  const id = crypto.randomUUID()
  const now = Date.now()
  await tasksRepo.insertLink(db, {
    id,
    orgId,
    fromTaskId: input.fromTaskId,
    toTaskId: input.toTaskId,
    kind: input.kind,
    createdAt: now,
  })
  await recordTaskLinkMutation(db, {
    kind: 'link_create',
    orgId,
    taskId: id,
    actorId,
    meta: { linkKind: input.kind },
  })
  return { id, orgId, fromTaskId: input.fromTaskId, toTaskId: input.toTaskId, kind: input.kind }
}

export async function listLinksForOrg(db: Db, orgId: string, audience: Audience) {
  const [links, tasks] = await Promise.all([
    tasksRepo.listLinks(db, orgId),
    tasksRepo.listTasks(db, orgId),
  ])
  const byId = new Map(
    tasks.map((task) => [task.id, { visibility: task.visibility as 'internal' | 'shared' }]),
  )
  return links.filter((link) => {
    const from = byId.get(link.fromTaskId)
    const to = byId.get(link.toTaskId)
    return from != null && to != null && canViewTask(from, audience) && canViewTask(to, audience)
  })
}
