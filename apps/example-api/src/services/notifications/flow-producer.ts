import * as orgsRepo from '@kit/auth/repos/orgs'
import { canDecideFlowApproval, isApproveTask, parseReceipts, parseRunnerView } from '@kit/flows'
import * as flowsRepo from '@kit/flows/repos'
import type { ApprovalNotice, ApprovalNotificationPorts } from '@kit/flows/run'
import type { SourceRef } from '@kit/notifications'
import type { KitDb } from '../../lib/db-type'
import type { notificationsDogfoodRegistry } from '../../lib/notifications-dogfood'
import { resolveModuleAccess } from '../org-roles'
import type { NotificationResolver, NotificationService } from './service'

type Notifications = NotificationService<typeof notificationsDogfoodRegistry>

export function flowApprovalSource({
  runId,
  taskId,
}: Pick<ApprovalNotice, 'runId' | 'taskId'>): SourceRef {
  return { kind: 'flow_approval', id: JSON.stringify([runId, taskId]) }
}

export async function resolveFlowApproval(
  notifications: NotificationResolver,
  notice: ApprovalNotice,
): Promise<void> {
  await notifications.resolve({
    orgId: notice.orgId,
    source: flowApprovalSource(notice),
    types: ['flows.approval_requested'],
  })
}

async function isOpen(db: KitDb, notice: ApprovalNotice): Promise<boolean> {
  const run = await flowsRepo.getRun(db, notice.runId, notice.orgId)
  if (!run) return false
  const parsed = parseRunnerView(JSON.parse(run.snapshotJson) as unknown)
  if (!parsed.ok || parsed.runnerView.orgId !== notice.orgId)
    throw new Error('APPROVAL_NOTIFICATION_FAILED')
  const view = parsed.runnerView
  if (!isApproveTask(view, notice.taskId)) return false
  let waiting = false
  if (run.receiptJson) {
    const receipts = parseReceipts(
      JSON.parse(run.receiptJson) as unknown,
      Object.keys(view.sealedPlan.tasks),
    )
    if (!receipts.ok) throw new Error('APPROVAL_NOTIFICATION_FAILED')
    waiting = receipts.receipts.tasks[notice.taskId]?.outcome === 'waiting'
  }
  const decision = await flowsRepo.getRunApproval(db, notice)
  return run.status === 'running' && waiting && !decision
}

async function eligibleUsers(db: KitDb, orgId: string): Promise<string[]> {
  const members = await orgsRepo.listMembers(db, orgId)
  const permissions = new Map<string, boolean>()
  const users: string[] = []
  for (const member of members) {
    if (!canDecideFlowApproval({ orgRole: member.role, authMethod: 'session' })) continue
    let allowed = permissions.get(member.role)
    if (allowed === undefined) {
      allowed = await resolveModuleAccess(db, {
        organizationId: orgId,
        roleKey: member.role,
        moduleId: 'flows',
        op: 'write',
        orgBypass: false,
      })
      permissions.set(member.role, allowed)
    }
    if (allowed) users.push(member.userId)
  }
  return users
}

export function createFlowApprovalNotificationPorts(
  db: KitDb,
  notifications: Notifications,
): Required<ApprovalNotificationPorts> {
  return {
    opened: async (notice) => {
      try {
        if (!(await isOpen(db, notice))) {
          await resolveFlowApproval(notifications, notice)
          return
        }
        const userIds = await eligibleUsers(db, notice.orgId)
        await notifications.notify({
          orgId: notice.orgId,
          type: 'flows.approval_requested',
          source: flowApprovalSource(notice),
          userIds,
          params: {},
        })
        if (!(await isOpen(db, notice))) await resolveFlowApproval(notifications, notice)
      } catch {
        throw new Error('APPROVAL_NOTIFICATION_FAILED')
      }
    },
    closed: async (notice) => {
      try {
        await resolveFlowApproval(notifications, notice)
      } catch {
        throw new Error('APPROVAL_NOTIFICATION_FAILED')
      }
    },
  }
}
