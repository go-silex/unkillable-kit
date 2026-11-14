import { normalizeEmail } from '@kit/auth'
import * as invitationsRepo from '@kit/auth/repos/invitations'
import * as orgsRepo from '@kit/auth/repos/orgs'
import { assertRateLimit } from '@kit/auth/repos/rate-limit'
import { AppError } from '@kit/core'
import { createLogEmailPort, type EmailPort } from '@kit/email'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../db/schema'
import * as usersRepo from '../repos/users'
import * as auditService from './audit'
import { assertInvitationCreateable, sendInvitationMail } from './invitations-create'
import { provisionUserShell } from './user-shell'

type Db = DrizzleD1Database<typeof schema>

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const CREATE_LIMIT = 20
const CREATE_WINDOW_MS = 60 * 60 * 1000
const ACCEPT_LIMIT = 30
const ACCEPT_WINDOW_MS = 60 * 60 * 1000

function newInviteId(): string {
  return `inv_${crypto.randomUUID().replace(/-/g, '')}`
}

function newMemberId(): string {
  return `mem_${crypto.randomUUID().replace(/-/g, '')}`
}

function publicInvitation(row: {
  id: string
  organizationId: string
  email: string
  role: string
  status: string
  expiresAt: Date | null
  createdAt: Date
  inviterId: string
}) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    role: row.role,
    status: row.status,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    inviterId: row.inviterId,
  }
}
export async function createInvitation(
  db: Db,
  input: {
    orgId: string
    inviterUserId: string
    inviterOrgRole: string
    email: string
    role: string
    acceptBaseUrl: string
    allowedOrigins: readonly string[]
    emailPort?: EmailPort
    requestId?: string
  },
) {
  await assertRateLimit(db, `invite-create:${input.orgId}`, CREATE_LIMIT, CREATE_WINDOW_MS)
  const { org, email } = await assertInvitationCreateable(db, input)
  const role = input.role
  const existingUser = await usersRepo.findBaUserByEmail(db, email)

  let provisionedUserId: string | null = null
  let welcomeToken: string | null = null
  if (!existingUser) {
    const shell = await provisionUserShell(db, { email })
    provisionedUserId = shell.userId
    welcomeToken = shell.welcomeToken
    const emailDomain = email.includes('@') ? email.split('@')[1] : undefined
    await auditService.appendAudit(db, {
      action: 'user.created',
      actorUserId: input.inviterUserId,
      targetType: 'user',
      targetId: shell.userId,
      orgId: input.orgId,
      meta: emailDomain ? { emailDomain } : undefined,
      requestId: input.requestId,
    })
  }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS)
  const id = newInviteId()
  await invitationsRepo.insertInvitation(db, {
    id,
    organizationId: input.orgId,
    email,
    role,
    status: 'pending',
    expiresAt,
    createdAt: now,
    inviterId: input.inviterUserId,
  })
  const base = input.acceptBaseUrl.replace(/\/$/, '')
  const acceptUrl = `${base}/invite/accept?invitationId=${encodeURIComponent(id)}`
  const inviter = await usersRepo.findBaUserById(db, input.inviterUserId)
  const port = input.emailPort ?? createLogEmailPort()
  try {
    await sendInvitationMail({
      port,
      email,
      orgName: org.name,
      acceptUrl,
      expiresAt,
      inviterLabel: inviter?.email ?? input.inviterUserId,
      allowedOrigins: input.allowedOrigins,
      welcomeToken,
      provisionedUserId,
      base,
      invitationId: id,
    })
  } catch {
    await invitationsRepo.setInvitationStatus(db, id, input.orgId, 'canceled')
    if (provisionedUserId) {
      await usersRepo.deleteBaUserCascade(db, provisionedUserId)
    }
    throw AppError.internal('Failed to send invitation email')
  }
  const row = await invitationsRepo.findInvitationById(db, id)
  if (!row) throw AppError.internal('Invitation missing after create')
  return publicInvitation(row)
}

export async function listInvitations(
  db: Db,
  orgId: string,
  status: invitationsRepo.InvitationStatus = 'pending',
) {
  const rows = await invitationsRepo.listInvitationsForOrg(db, orgId, status)
  return rows.map(publicInvitation)
}

export async function cancelInvitation(db: Db, orgId: string, invitationId: string) {
  const row = await invitationsRepo.findInvitationById(db, invitationId)
  if (!row || row.organizationId !== orgId) throw AppError.notFound('Invitation not found')
  if (row.status !== 'pending') throw AppError.conflict('Invitation is not pending')
  if (!(await invitationsRepo.setInvitationStatus(db, invitationId, orgId, 'canceled'))) {
    throw AppError.notFound('Invitation not found')
  }
  return { ok: true as const }
}

export async function acceptInvitation(
  db: Db,
  input: {
    invitationId: string
    subjectUserId: string
    rateKey: string
    requestId?: string
  },
) {
  await assertRateLimit(db, `invite-accept:${input.rateKey}`, ACCEPT_LIMIT, ACCEPT_WINDOW_MS)
  const row = await invitationsRepo.findInvitationById(db, input.invitationId)
  if (row?.status !== 'pending') throw AppError.notFound('Invitation not found')
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    throw AppError.notFound('Invitation not found')
  }

  const org = await orgsRepo.findOrgById(db, row.organizationId)
  if (!org) throw AppError.notFound('Invitation not found')
  if (org.status !== 'active') {
    throw AppError.forbidden('Organization is not active')
  }

  const user = await usersRepo.findBaUserById(db, input.subjectUserId)
  if (!user?.email) throw AppError.unauthorized()
  if (normalizeEmail(user.email) !== normalizeEmail(row.email)) {
    throw AppError.forbidden('Invitation email does not match session')
  }

  const existing = await orgsRepo.findMembership(db, row.organizationId, input.subjectUserId)
  if (existing) {
    if (!(await invitationsRepo.setInvitationStatus(db, row.id, row.organizationId, 'accepted'))) {
      throw AppError.notFound('Invitation not found')
    }
    await auditService.appendAudit(db, {
      action: 'invite.accept',
      actorUserId: input.subjectUserId,
      targetType: 'invitation',
      targetId: row.id,
      orgId: row.organizationId,
      meta: { invitationId: row.id },
      requestId: input.requestId,
    })
    return {
      org: { id: org.id, name: org.name, slug: org.slug },
      membership: {
        id: existing.id,
        userId: existing.userId,
        role: existing.role,
        organizationId: existing.organizationId,
      },
    }
  }

  const memberId = newMemberId()
  await orgsRepo.insertMember(db, {
    id: memberId,
    organizationId: row.organizationId,
    userId: input.subjectUserId,
    role: row.role,
    createdAt: new Date(),
  })
  if (!(await invitationsRepo.setInvitationStatus(db, row.id, row.organizationId, 'accepted'))) {
    throw AppError.notFound('Invitation not found')
  }

  await auditService.appendAudit(db, {
    action: 'membership.add',
    actorUserId: input.subjectUserId,
    targetType: 'user',
    targetId: input.subjectUserId,
    orgId: row.organizationId,
    meta: { role: row.role },
    requestId: input.requestId,
  })
  await auditService.appendAudit(db, {
    action: 'invite.accept',
    actorUserId: input.subjectUserId,
    targetType: 'invitation',
    targetId: row.id,
    orgId: row.organizationId,
    meta: { invitationId: row.id },
    requestId: input.requestId,
  })

  return {
    org: { id: org.id, name: org.name, slug: org.slug },
    membership: {
      id: memberId,
      userId: input.subjectUserId,
      role: row.role,
      organizationId: row.organizationId,
    },
  }
}
