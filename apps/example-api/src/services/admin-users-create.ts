import { isInvitableOrgRole, isPlatformRole, normalizeEmail, type PlatformRole } from '@kit/auth'
import * as orgsRepo from '@kit/auth/repos/orgs'
import { AppError } from '@kit/core'
import { buildWelcomeSetPasswordEmailText } from '@kit/email'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../db/schema'
import * as usersRepo from '../repos/users'
import type { CreateAdminUserInput } from './admin-users'
import * as orgRolesService from './org-roles'

type Db = DrizzleD1Database<typeof schema>

export async function assertAdminCreateActor(input: CreateAdminUserInput): Promise<string> {
  if (input.actorPlatformRole !== 'super_admin' && input.actorPlatformRole !== 'staff') {
    throw AppError.forbidden('Platform role required')
  }
  const email = normalizeEmail(input.email)
  if (!email?.includes('@')) {
    throw AppError.fieldErrors('Invalid email', {
      email: ['Valid email required'],
    })
  }
  return email
}

export async function assertEmailAvailable(
  db: Db,
  input: CreateAdminUserInput,
  email: string,
): Promise<void> {
  const existing = await usersRepo.findBaUserByEmail(db, email)
  if (!existing) return
  if (input.actorPlatformRole === 'staff') {
    const actorOrgs = await orgsRepo.listMembershipsForUser(db, input.actorUserId)
    const targetOrgs = await orgsRepo.listMembershipsForUser(db, existing.id)
    const actorSet = new Set(actorOrgs.map((m) => m.organizationId))
    const shared = targetOrgs.some((m) => actorSet.has(m.organizationId))
    if (!shared) throw AppError.notFound('User not found')
  }
  throw AppError.conflict('User already exists')
}

export async function resolvePlatformRole(
  input: CreateAdminUserInput,
): Promise<PlatformRole | null> {
  if (input.platformRole == null || input.platformRole === undefined) return null
  if (!isPlatformRole(input.platformRole)) {
    throw AppError.fieldErrors('Invalid platformRole', {
      platformRole: ['Invalid platform role'],
    })
  }
  if (input.actorPlatformRole !== 'super_admin') {
    throw AppError.forbidden('Only super_admin may assign platform roles')
  }
  return input.platformRole
}

async function assertOneMembershipTarget(
  db: Db,
  input: CreateAdminUserInput,
  m: { orgId: string; role: string },
  actorMemberships: { organizationId: string; role: string }[],
  actorOrgIds: Set<string>,
): Promise<void> {
  const org = await orgsRepo.findOrgById(db, m.orgId)
  if (org?.status !== 'active') {
    throw AppError.notFound('Organization not found')
  }
  if (input.actorPlatformRole === 'staff' && !actorOrgIds.has(m.orgId)) {
    throw AppError.notFound('Organization not found')
  }
  if (!isInvitableOrgRole(m.role)) {
    const inviterRole =
      input.actorPlatformRole === 'super_admin'
        ? 'owner'
        : (actorMemberships.find((x) => x.organizationId === m.orgId)?.role ?? 'member')
    await orgRolesService.assertAssignableRole(db, m.orgId, m.role, inviterRole)
    return
  }
  if (input.actorPlatformRole === 'staff') {
    const inviterRole = actorMemberships.find((x) => x.organizationId === m.orgId)?.role ?? ''
    await orgRolesService.assertAssignableRole(db, m.orgId, m.role, inviterRole)
  }
}

export async function assertMembershipTargets(
  db: Db,
  input: CreateAdminUserInput,
  memberships: { orgId: string; role: string }[],
): Promise<void> {
  const actorMemberships =
    input.actorPlatformRole === 'staff'
      ? await orgsRepo.listMembershipsForUser(db, input.actorUserId)
      : []
  const actorOrgIds = new Set(actorMemberships.map((m) => m.organizationId))
  for (const m of memberships) {
    await assertOneMembershipTarget(db, input, m, actorMemberships, actorOrgIds)
  }
}

export async function sendWelcomeOrCompensate(
  db: Db,
  input: CreateAdminUserInput,
  args: { userId: string; email: string; name: string; token: string },
): Promise<boolean> {
  if (input.sendEmail === false) return false
  const base = input.webBaseUrl.replace(/\/$/, '')
  let setPasswordUrl = `${base}/reset-password?token=${encodeURIComponent(args.token)}`
  if (input.afterSetPasswordPath?.startsWith('/') && !input.afterSetPasswordPath.startsWith('//')) {
    setPasswordUrl += `&next=${encodeURIComponent(input.afterSetPasswordPath)}`
  }
  try {
    const tmpl = buildWelcomeSetPasswordEmailText({
      to: args.email,
      setPasswordUrl,
      expiresHint: 'about 1 hour',
      name: args.name,
      allowedOrigins: input.allowedOrigins,
    })
    const sent = await input.emailPort.send({
      to: tmpl.to,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
    })
    if (!sent.ok) throw new Error('email send returned not ok')
    return true
  } catch {
    await usersRepo.deleteBaUserCascade(db, args.userId)
    throw AppError.internal('Failed to send welcome email')
  }
}
