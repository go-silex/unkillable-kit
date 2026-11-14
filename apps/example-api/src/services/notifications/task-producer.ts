import { findMembership } from '@kit/auth/repos/orgs'
import { AppError } from '@kit/core'
import { canViewTask, isTerminalStage, type TaskMutationEvent } from '@kit/tasks'
import * as tasksRepo from '@kit/tasks/repos'
import type { KitDb } from '../../lib/db-type'
import type { notificationsDogfoodRegistry } from '../../lib/notifications-dogfood'
import { resolveAudience } from '../tasks-audience'
import type { NotificationService } from './service'

type Notifications = NotificationService<typeof notificationsDogfoodRegistry>

async function currentTask(db: KitDb, orgId: string, taskId: string) {
  const task = await tasksRepo.getTask(db, orgId, taskId)
  if (!task || task.done) return null
  const stages = await tasksRepo.listStages(db, orgId, task.boardKey)
  if (isTerminalStage(stages, task.stageId)) return null
  const assignees = await tasksRepo.listAssigneesForTasks(db, orgId, [taskId])
  return { task, assigned: new Set(assignees.map((row) => row.userId)) }
}

export async function notifyTaskMutation(
  db: KitDb,
  notifications: Notifications,
  event: TaskMutationEvent,
): Promise<void> {
  if (!(event.taskId && ['create', 'update', 'delete'].includes(event.kind))) return
  const { orgId, taskId } = event
  const source = { kind: 'task', id: taskId } as const
  const scope = { orgId, source, types: ['tasks.assigned'] }
  try {
    if (event.kind === 'delete') {
      await notifications.resolve(scope)
      return
    }
    const current = await currentTask(db, orgId, taskId)
    if (!current) {
      await notifications.resolve(scope)
      return
    }
    const removed = [...new Set(event.assignees?.removed ?? [])].filter(
      (id) => !current.assigned.has(id),
    )
    if (removed.length) await notifications.resolve({ ...scope, userIds: removed })
    const added = [...new Set(event.assignees?.added ?? [])].filter((id) =>
      current.assigned.has(id),
    )
    const recipients: string[] = []
    for (const userId of added) {
      const member = await findMembership(db, orgId, userId)
      if (
        member &&
        canViewTask(
          { visibility: current.task.visibility as 'internal' | 'shared' },
          resolveAudience({ orgRole: member.role }),
        )
      )
        recipients.push(userId)
    }
    if (!recipients.length) return
    await notifications.notify({
      orgId,
      type: 'tasks.assigned',
      source,
      userIds: recipients,
      actorId: event.actorId,
      params: { taskTitle: current.task.title },
    })
    const after = await currentTask(db, orgId, taskId)
    if (!after) {
      await notifications.resolve(scope)
      return
    }
    const noLongerAssigned = recipients.filter((id) => !after.assigned.has(id))
    if (noLongerAssigned.length) {
      await notifications.resolve({ ...scope, userIds: noLongerAssigned })
    }
  } catch {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'task_notification_failed',
        code: 'TASK_NOTIFICATION_FAILED',
        orgId,
        taskId,
      }),
    )
    throw AppError.internal()
  }
}
