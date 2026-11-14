import {
  getImpersonationPermissions,
  type ImpersonationSession,
} from '@kit/auth/repos/impersonation'
import * as orgsRepo from '@kit/auth/repos/orgs'
import type { KitDb } from '../lib/db-type'
import * as usersRepo from '../repos/users'

/** Re-evaluated for every delegated request, including recovery introspection. */
export async function getImpersonationEligibility(
  db: KitDb,
  row: ImpersonationSession,
): Promise<boolean> {
  if (row.actorUserId === row.subjectUserId) return false
  const [actor, subject, actorUser, subjectUser] = await Promise.all([
    orgsRepo.findOrgContext(db, row.organizationId, row.actorUserId),
    orgsRepo.findOrgContext(db, row.organizationId, row.subjectUserId),
    usersRepo.findBaUserById(db, row.actorUserId),
    usersRepo.findBaUserById(db, row.subjectUserId),
  ])
  if (
    !(actorUser && subjectUser) ||
    actor?.status !== 'active' ||
    subject?.status !== 'active' ||
    !actor.membershipRole ||
    !subject.membershipRole ||
    !actor.platformRole ||
    subject.platformRole
  )
    return false
  const permission = await getImpersonationPermissions(db, actor.platformRole)
  return permission[row.mode]
}

export async function getImpersonationInfo(db: KitDb, row: ImpersonationSession, active?: boolean) {
  const eligible = active ?? (await getImpersonationEligibility(db, row))
  const [actor, subject] = await Promise.all([
    usersRepo.findBaUserById(db, row.actorUserId),
    eligible ? usersRepo.findBaUserById(db, row.subjectUserId) : null,
  ])
  const common = {
    id: row.id,
    mode: row.mode,
    organizationId: row.organizationId,
    startedAt: row.createdAt,
  }
  if (!(eligible && actor && subject)) {
    return {
      ...common,
      actor: { id: row.actorUserId },
      subject: { id: row.subjectUserId },
      active: false,
    }
  }
  const profile = (id: string, user: NonNullable<typeof actor>) => ({
    id,
    ...(user.name?.trim() ? { name: user.name.trim() } : {}),
    ...(user.email?.trim() ? { email: user.email.trim() } : {}),
  })
  return {
    ...common,
    actor: profile(row.actorUserId, actor),
    subject: profile(row.subjectUserId, subject),
    active: true,
  }
}
