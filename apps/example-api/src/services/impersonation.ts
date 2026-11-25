import { isPlatformRole } from '@kit/auth'
import type { ImpersonationSession } from '@kit/auth/repos/impersonation'
import {
  baMember,
  baOrganization,
  baUser,
  impersonationRolePermissions,
  userPlatformRoles,
} from '@kit/auth/schema'
import { and, eq } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { KitDb } from '../lib/db-type'

type Profile = Readonly<{ name: string; email: string }>

const actor = alias(baUser, 'actor')
const target = alias(baUser, 'target')
const actorMember = alias(baMember, 'actor_member')
const targetMember = alias(baMember, 'target_member')
const targetRole = alias(userPlatformRoles, 'target_role')

/** Start's prospective target comes from the validated body, not an attached delegation. */
export async function findEligibleImpersonation(db: KitDb, row: ImpersonationSession) {
  if (row.actorUserId === row.subjectUserId) return null
  const candidate = await db
    .select({
      actor: { name: actor.name, email: actor.email },
      target: { name: target.name, email: target.email },
      actorMembership: actorMember.role,
      targetMembership: targetMember.role,
      targetRole: targetRole.role,
    })
    .from(baOrganization)
    .innerJoin(actor, and(eq(actor.id, row.actorUserId), eq(actor.disabled, false)))
    .innerJoin(target, and(eq(target.id, row.subjectUserId), eq(target.disabled, false)))
    .innerJoin(
      actorMember,
      and(eq(actorMember.organizationId, baOrganization.id), eq(actorMember.userId, actor.id)),
    )
    .innerJoin(
      targetMember,
      and(eq(targetMember.organizationId, baOrganization.id), eq(targetMember.userId, target.id)),
    )
    .innerJoin(userPlatformRoles, eq(userPlatformRoles.userId, actor.id))
    .innerJoin(
      impersonationRolePermissions,
      eq(impersonationRolePermissions.role, userPlatformRoles.role),
    )
    .leftJoin(targetRole, eq(targetRole.userId, target.id))
    .where(
      and(
        eq(baOrganization.id, row.organizationId),
        eq(baOrganization.status, 'active'),
        eq(impersonationRolePermissions[row.mode], true),
      ),
    )
    .get()
  if (!(candidate?.actorMembership && candidate.targetMembership)) return null
  if (candidate.targetRole && isPlatformRole(candidate.targetRole)) return null
  return impersonationInfo({ ...row, startedAt: row.createdAt }, candidate.actor, candidate.target)
}

export function impersonationInfo(
  row: Pick<
    ImpersonationSession,
    'id' | 'mode' | 'organizationId' | 'actorUserId' | 'subjectUserId'
  > & {
    startedAt: number
  },
  actor: Profile | null,
  subject: Profile | null,
) {
  const common = {
    id: row.id,
    mode: row.mode,
    organizationId: row.organizationId,
    startedAt: row.startedAt,
  }
  if (!(actor && subject)) {
    return {
      ...common,
      actor: { id: row.actorUserId },
      subject: { id: row.subjectUserId },
      active: false,
    }
  }
  const profile = (id: string, user: Profile) => ({
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
