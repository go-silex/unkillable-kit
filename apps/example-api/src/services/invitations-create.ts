import { normalizeEmail } from '@kit/auth'
import * as invitationsRepo from '@kit/auth/repos/invitations'
import * as orgsRepo from '@kit/auth/repos/orgs'
import { AppError } from '@kit/core'
import { buildInviteEmailText, buildWelcomeSetPasswordEmailText, type EmailPort } from '@kit/email'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../db/schema'
import { emailTemplateOptions } from '../lib/email-config'
import * as usersRepo from '../repos/users'
import * as orgRolesService from './org-roles'

type Db = DrizzleD1Database<typeof schema>

export async function assertInvitationCreateable(
  db: Db,
  input: {
    orgId: string
    inviterOrgRole: string
    email: string
    role: string
  },
): Promise<{ org: NonNullable<Awaited<ReturnType<typeof orgsRepo.findOrgById>>>; email: string }> {
  const org = await orgsRepo.findOrgById(db, input.orgId)
  if (!org) throw AppError.notFound('Organization not found')
  if (org.status !== 'active') {
    throw AppError.forbidden('Organization is not active')
  }
  await orgRolesService.assertAssignableRole(db, input.orgId, input.role, input.inviterOrgRole)
  const email = normalizeEmail(input.email)
  if (!email?.includes('@')) {
    throw AppError.fieldErrors('Invalid email', {
      email: ['Valid email required'],
    })
  }
  const existingUser = await usersRepo.findBaUserByEmail(db, email)
  if (existingUser) {
    const membership = await orgsRepo.findMembership(db, input.orgId, existingUser.id)
    if (membership) {
      throw AppError.conflict('User is already a member of this organization')
    }
  }
  const pendingDup = await invitationsRepo.findPendingByOrgAndEmail(db, input.orgId, email)
  if (pendingDup) {
    throw AppError.conflict('A pending invitation already exists for this email')
  }
  return { org, email }
}

export async function sendInvitationMail(args: {
  port: EmailPort
  email: string
  orgName: string
  acceptUrl: string
  expiresAt: Date
  inviterLabel: string
  allowedOrigins: readonly string[]
  welcomeToken: string | null
  provisionedUserId: string | null
  base: string
  invitationId: string
}): Promise<void> {
  if (args.welcomeToken && args.provisionedUserId) {
    const setPasswordUrl = `${args.base}/reset-password?token=${encodeURIComponent(args.welcomeToken)}&next=${encodeURIComponent(`/invite/accept?invitationId=${args.invitationId}`)}`
    const tmpl = buildWelcomeSetPasswordEmailText({
      ...(await emailTemplateOptions(args.email)),
      to: args.email,
      setPasswordUrl,
      allowedOrigins: args.allowedOrigins,
    })
    const sent = await args.port.send({
      to: tmpl.to,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
    })
    if (!sent.ok) throw new Error('email send returned not ok')
    return
  }
  const tmpl = buildInviteEmailText({
    ...(await emailTemplateOptions(args.email)),
    to: args.email,
    orgName: args.orgName,
    acceptUrl: args.acceptUrl,
    expiresAt: args.expiresAt,
    inviterLabel: args.inviterLabel,
    allowedOrigins: args.allowedOrigins,
  })
  const sent = await args.port.send({
    to: tmpl.to,
    subject: tmpl.subject,
    text: tmpl.text,
    html: tmpl.html,
  })
  if (!sent.ok) throw new Error('email send returned not ok')
}
