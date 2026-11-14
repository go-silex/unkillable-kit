import {
  type Audience,
  canSetCommentVisibility,
  canViewComment,
  createCommentInputSchema,
  filterCommentsForAudience,
} from '@kit/comments'
import * as commentsRepo from '@kit/comments/repos'
import { AppError, parseOrThrow } from '@kit/core'
import { canViewTask } from '@kit/tasks'
import * as tasksRepo from '@kit/tasks/repos'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../db/schema'

type Db = DrizzleD1Database<typeof schema>

async function requireViewableTask(db: Db, orgId: string, taskId: string, audience: Audience) {
  const task = await tasksRepo.getTask(db, orgId, taskId)
  if (!(task && canViewTask({ visibility: task.visibility as 'internal' | 'shared' }, audience))) {
    throw AppError.notFound('Task not found')
  }
}

export async function listCommentsForTarget(
  db: Db,
  orgId: string,
  targetType: string,
  targetId: string,
  audience: Audience,
) {
  if (targetType === 'task') {
    await requireViewableTask(db, orgId, targetId, audience)
  }
  const rows = await commentsRepo.listByTarget(db, orgId, targetType, targetId)
  return filterCommentsForAudience(
    rows.map((r) => ({
      ...r,
      visibility: r.visibility as 'internal' | 'shared',
    })),
    audience,
  )
}

export async function createCommentForOrg(
  db: Db,
  orgId: string,
  actorId: string,
  audience: Audience,
  raw: unknown,
) {
  const input = parseOrThrow(
    createCommentInputSchema,
    { ...(raw as object), orgId, authorId: actorId },
    'Invalid comment',
  )
  const visibility = input.visibility ?? 'shared'
  if (!canSetCommentVisibility(audience, visibility)) {
    throw AppError.forbidden('Cannot set this visibility')
  }
  if (input.targetType === 'task') {
    await requireViewableTask(db, orgId, input.targetId, audience)
  }
  const now = Date.now()
  const id = crypto.randomUUID()
  await commentsRepo.insertComment(db, {
    id,
    orgId,
    targetType: input.targetType,
    targetId: input.targetId,
    authorId: actorId,
    body: input.body,
    visibility,
    createdAt: now,
    updatedAt: now,
  })
  const row = await commentsRepo.getComment(db, orgId, id)
  return row
}

export async function deleteCommentForOrg(
  db: Db,
  orgId: string,
  id: string,
  audience: Audience,
  actorId: string,
) {
  if (audience === 'external') throw AppError.forbidden()
  const row = await commentsRepo.getComment(db, orgId, id)
  if (!row) throw AppError.notFound('Comment not found')
  if (!canViewComment({ visibility: row.visibility as 'internal' | 'shared' }, audience)) {
    throw AppError.notFound('Comment not found')
  }
  if (row.authorId !== actorId && audience === 'staff') {
    // staff may delete any in dogfood; keep simple
  }
  await commentsRepo.deleteComment(db, orgId, id)
}
