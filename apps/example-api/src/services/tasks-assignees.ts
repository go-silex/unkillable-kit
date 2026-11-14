import * as orgsRepo from '@kit/auth/repos/orgs'
import { AppError } from '@kit/core'
import * as tasksRepo from '@kit/tasks/repos'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../db/schema'

type Db = DrizzleD1Database<typeof schema>

/** ADR-0016 D4: an assignee is a member of the task's owner org. */
export async function assertAssigneesAreMembers(db: Db, orgId: string, assigneeIds: string[]) {
  const wanted = [...new Set(assigneeIds)]
  if (wanted.length === 0) return
  const members = new Set(await orgsRepo.filterMemberUserIds(db, orgId, wanted))
  const strangers = wanted.filter((id) => !members.has(id))
  if (strangers.length > 0) {
    throw AppError.fieldErrors('Invalid task', {
      assigneeIds: [`Not a member of this organization: ${strangers.join(', ')}`],
    })
  }
}

export async function replaceAssigneesOrThrow(
  db: Db,
  orgId: string,
  taskId: string,
  assigneeIds: string[],
  now: number,
) {
  const delta = await tasksRepo.replaceAssignees(db, orgId, taskId, assigneeIds, now)
  if (!delta) throw AppError.notFound('Task not found')
  return delta
}
