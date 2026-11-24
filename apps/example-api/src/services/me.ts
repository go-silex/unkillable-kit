/**
 * GET /api/me aggregate — platform role, BA profile, membership orgs (D11 key filter).
 */
import type { ImpersonationInfo, ImpersonationPermissions } from '@kit/api-client/me'
import type { PlatformRole } from '@kit/auth'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../db/schema'
import * as usersRepo from '../repos/users'
import * as orgsService from './orgs'

type Db = DrizzleD1Database<typeof schema>

type MeOrg = Awaited<ReturnType<typeof orgsService.listMembershipOrgsForSubject>>[number]

export type MeProfile = {
  platformRole: PlatformRole | null
  email?: string
  name?: string
  orgs: MeOrg[]
  impersonation: ImpersonationInfo | null
  impersonationPermissions: ImpersonationPermissions
}

type MeOptions = {
  authMethod?: 'session' | 'api_key'
  keyOrganizationId?: string | null
  platformRole: PlatformRole | null
  impersonation?: ImpersonationInfo
  impersonationPermissions?: ImpersonationPermissions
}

async function getProfileOrgs(db: Db, subject: string, opts: MeOptions): Promise<MeOrg[]> {
  let orgs = await orgsService.listMembershipOrgsForSubject(db, subject)
  if (opts.impersonation) {
    const { organizationId } = opts.impersonation
    orgs = orgs.filter((org) => org.id === organizationId)
  }
  // D11 — an unbound API key never receives the full membership catalogue.
  if (opts?.authMethod === 'api_key') {
    const keyOrg = opts.keyOrganizationId
    orgs = keyOrg ? orgs.filter((org) => org.id === keyOrg) : []
  }
  return orgs
}

/**
 * Profile payload for the authenticated subject.
 * D11: when `authMethod === 'api_key'`, `orgs` is filtered to `keyOrganizationId`
 * if set, otherwise **empty** (fail-closed — never the full membership catalogue).
 */
export async function getMeProfile(db: Db, subject: string, opts: MeOptions): Promise<MeProfile> {
  const impersonation = opts.impersonation ?? null
  const platformRole = impersonation ? null : opts.platformRole
  const sessionPermissions =
    opts.authMethod === 'session' ? opts.impersonationPermissions : undefined
  const impersonationPermissions = sessionPermissions ?? { read: false, write: false }

  // A revoked delegation remains attached until explicitly stopped. Do not
  // expose the actor or the target's profile through this recovery-only view.
  if (impersonation && !impersonation.active) {
    return {
      platformRole: null,
      orgs: [],
      impersonation: { ...impersonation, subject: { id: impersonation.subject.id } },
      impersonationPermissions,
    }
  }

  const orgs = await getProfileOrgs(db, subject, opts)

  const user = impersonation ? impersonation.subject : await usersRepo.findBaUserById(db, subject)
  const email = user?.email?.trim() || undefined
  const name = user?.name?.trim() || undefined

  return {
    platformRole,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    orgs,
    impersonation,
    impersonationPermissions,
  }
}
