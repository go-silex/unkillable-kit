import type { PlatformRole } from '@kit/auth'
import * as orgsRepo from '@kit/auth/repos/orgs'
import * as platformRolesRepo from '@kit/auth/repos/platform-roles'
import { assertRateLimit } from '@kit/auth/repos/rate-limit'
import { AppError } from '@kit/core'
import { buildWelcomeSetPasswordEmailText, type EmailPort } from '@kit/email'
import { hashPassword } from 'better-auth/crypto'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../db/schema'
import * as usersRepo from '../repos/users'
import {
  assertAdminCreateActor,
  assertEmailAvailable,
  assertMembershipTargets,
  resolvePlatformRole,
  sendWelcomeOrCompensate,
} from './admin-users-create'
import * as auditService from './audit'
import {
  newMemberId,
  newUserId,
  newWelcomeToken,
  randomUnusablePassword,
  WELCOME_TTL_SEC,
} from './user-shell'

type Db = DrizzleD1Database<typeof schema>

const CREATE_LIMIT = 20
const CREATE_WINDOW_MS = 60 * 60 * 1000
const RESEND_LIMIT = 10
const RESEND_WINDOW_MS = 60 * 60 * 1000

type MembershipInput = { orgId: string; role: string }

export type CreateAdminUserInput = {
  actorUserId: string
  actorPlatformRole: PlatformRole
  email: string
  name?: string
  platformRole?: PlatformRole | null
  memberships?: MembershipInput[]
  sendEmail?: boolean
  /** SPA origin for set-password link (e.g. http://localhost:5173). */
  webBaseUrl: string
  /** CORS/web origins — must not be derived from the token URL. */
  allowedOrigins: readonly string[]
  emailPort: EmailPort
  /** Optional path after set-password (safe relative only). */
  afterSetPasswordPath?: string
  requestId?: string
}
/**
 * Create BA user (no clear password), optional platform role + memberships, welcome token + email.
 * Email is sent last; failure compensates by cascade-deleting the new user.
 */
export async function createAdminUser(db: Db, input: CreateAdminUserInput) {
  await assertRateLimit(
    db,
    `admin-user-create:${input.actorUserId}`,
    CREATE_LIMIT,
    CREATE_WINDOW_MS,
  )
  const email = await assertAdminCreateActor(input)
  await assertEmailAvailable(db, input, email)
  const platformRole = await resolvePlatformRole(input)
  const memberships = input.memberships ?? []
  await assertMembershipTargets(db, input, memberships)

  const userId = newUserId()
  const name = (input.name?.trim() || email.split('@')[0] || 'User').slice(0, 120)
  const passwordHash = await hashPassword(randomUnusablePassword())
  const now = new Date()

  await usersRepo.insertBaUserWithCredential(db, {
    id: userId,
    email,
    name,
    passwordHash,
    emailVerified: true,
    now,
  })

  if (platformRole) {
    await platformRolesRepo.setPlatformRole(db, userId, platformRole, now.getTime())
  }

  const createdMemberships: { organizationId: string; role: string }[] = []
  for (const m of memberships) {
    await orgsRepo.insertMember(db, {
      id: newMemberId(),
      organizationId: m.orgId,
      userId,
      role: m.role,
      createdAt: now,
    })
    createdMemberships.push({ organizationId: m.orgId, role: m.role })
  }

  const token = newWelcomeToken()
  const expiresAt = new Date(now.getTime() + WELCOME_TTL_SEC * 1000)
  await usersRepo.insertResetPasswordToken(db, {
    userId,
    token,
    expiresAt,
    now,
  })

  const welcomeEmailSent = await sendWelcomeOrCompensate(db, input, {
    userId,
    email,
    name,
    token,
  })

  await auditService.emitAdminUserProvisioned(db, {
    actorUserId: input.actorUserId,
    userId,
    email,
    platformRole,
    memberships: createdMemberships,
    requestId: input.requestId,
  })

  return {
    user: {
      id: userId,
      email,
      name,
      platformRole,
    },
    memberships: createdMemberships,
    welcomeEmailSent,
    _welcomeToken: token,
  }
}

export { listAdminUsers } from './admin-users-list'

export async function resendWelcome(
  db: Db,
  input: {
    actorUserId: string
    actorPlatformRole: PlatformRole
    userId: string
    webBaseUrl: string
    allowedOrigins: readonly string[]
    emailPort: EmailPort
  },
) {
  await assertRateLimit(
    db,
    `admin-user-resend:${input.actorUserId}`,
    RESEND_LIMIT,
    RESEND_WINDOW_MS,
  )

  if (input.actorPlatformRole !== 'super_admin' && input.actorPlatformRole !== 'staff') {
    throw AppError.forbidden('Platform role required')
  }

  const user = await usersRepo.findBaUserById(db, input.userId)
  if (!user?.email) throw AppError.notFound('User not found')

  if (input.actorPlatformRole === 'staff') {
    const actorOrgs = await orgsRepo.listMembershipsForUser(db, input.actorUserId)
    const targetOrgs = await orgsRepo.listMembershipsForUser(db, input.userId)
    const actorSet = new Set(actorOrgs.map((m) => m.organizationId))
    const shared = targetOrgs.some((m) => actorSet.has(m.organizationId))
    if (!shared) throw AppError.notFound('User not found')
  }

  await usersRepo.deleteVerificationsForUser(db, input.userId)
  const token = newWelcomeToken()
  const now = new Date()
  await usersRepo.insertResetPasswordToken(db, {
    userId: input.userId,
    token,
    expiresAt: new Date(now.getTime() + WELCOME_TTL_SEC * 1000),
    now,
  })

  const base = input.webBaseUrl.replace(/\/$/, '')
  const setPasswordUrl = `${base}/reset-password?token=${encodeURIComponent(token)}`
  try {
    const tmpl = buildWelcomeSetPasswordEmailText({
      to: user.email,
      setPasswordUrl,
      expiresHint: 'about 1 hour',
      name: user.name,
      allowedOrigins: input.allowedOrigins,
    })
    const sent = await input.emailPort.send({
      to: tmpl.to,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
    })
    if (!sent.ok) throw new Error('email send returned not ok')
  } catch {
    throw AppError.internal('Failed to send welcome email')
  }

  return { ok: true as const }
}
