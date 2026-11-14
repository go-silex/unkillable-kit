import type { OrgKind } from '@kit/auth'
import * as orgsRepo from '@kit/auth/repos/orgs'
import * as platformModulesRepo from '@kit/auth/repos/platform-modules'
import * as platformRolesRepo from '@kit/auth/repos/platform-roles'
import { AppError } from '@kit/core'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../db/schema'
import * as orgRolesService from './org-roles'

type Db = DrizzleD1Database<typeof schema>

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

/**
 * Memberships only (no super_admin catalogue dump).
 * Used by GET /api/me — S1 pin: me.orgs never expands to all orgs.
 */
export async function listMembershipOrgsForSubject(db: Db, subject: string) {
  const memberships = await orgsRepo.listMembershipsForUser(db, subject)
  return memberships.map((m) => ({
    id: m.organizationId,
    name: m.orgName,
    slug: m.orgSlug,
    kind: m.orgKind as 'client' | 'internal',
    status: m.orgStatus as 'active' | 'suspended' | 'archived',
    role: m.role as 'owner' | 'admin' | 'member' | 'reader',
  }))
}

/**
 * Orgs the subject may list on GET /api/orgs:
 * - super_admin → full catalogue (role null when not a member)
 * - everyone else → memberships only
 */
export async function listOrgsForSubject(db: Db, subject: string) {
  const platformRole = await platformRolesRepo.getPlatformRole(db, subject)
  if (platformRole === 'super_admin') {
    const all = await orgsRepo.listAllOrgs(db)
    const memberships = await orgsRepo.listMembershipsForUser(db, subject)
    const roleByOrg = new Map(memberships.map((m) => [m.organizationId, m.role]))
    return all.map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      kind: o.kind,
      status: o.status,
      role: (roleByOrg.get(o.id) ?? null) as string | null,
    }))
  }
  return listMembershipOrgsForSubject(db, subject)
}

export async function createOrganization(
  db: Db,
  input: {
    name: string
    slug?: string
    kind?: OrgKind
    ownerUserId: string
  },
) {
  const name = input.name.trim()
  if (!name) {
    throw AppError.fieldErrors('name is required', { name: ['name is required'] })
  }
  const slug = slugify(input.slug?.trim() || name)
  if (!slug) {
    throw AppError.fieldErrors('slug is required', { slug: ['slug is required'] })
  }
  const existing = await orgsRepo.findOrgBySlug(db, slug)
  if (existing) throw AppError.conflict('Organization slug already exists')

  const now = new Date()
  const orgId = newId('org')
  const kind = input.kind ?? 'client'
  await orgsRepo.insertOrganization(db, {
    id: orgId,
    name,
    slug,
    kind,
    status: 'active',
    createdAt: now,
  })
  await orgsRepo.insertMember(db, {
    id: newId('mem'),
    organizationId: orgId,
    userId: input.ownerUserId,
    role: 'owner',
    createdAt: now,
  })

  // Seed organization_modules for available platform modules (disabled by default)
  const platform = await platformModulesRepo.listPlatformModules(db)
  const ts = Date.now()
  for (const mod of platform) {
    if (!mod.available) continue
    await platformModulesRepo.upsertOrgModule(db, {
      organizationId: orgId,
      moduleId: mod.moduleId,
      enabled: false,
      locked: false,
      updatedAt: ts,
    })
  }

  // Phase B — system roles + grant seed
  await orgRolesService.ensureSystemRoles(db, orgId)

  return { id: orgId, name, slug, kind, status: 'active' as const, role: 'owner' as const }
}

export async function getOrgForSubject(db: Db, orgId: string, subject: string) {
  const org = await orgsRepo.findOrgById(db, orgId)
  if (!org) throw AppError.notFound('Organization not found')
  const membership = await orgsRepo.findMembership(db, orgId, subject)
  if (membership) {
    return { ...org, role: membership.role, bypass: false }
  }
  const platformRole = await platformRolesRepo.getPlatformRole(db, subject)
  if (platformRole === 'super_admin') {
    return { ...org, role: null as string | null, bypass: true }
  }
  throw AppError.notFound('Organization not found')
}

export async function listOrgMembers(db: Db, orgId: string) {
  const members = await orgsRepo.listMembers(db, orgId)
  return members.map((m) => ({
    id: m.id,
    userId: m.userId,
    role: m.role,
    createdAt: m.createdAt,
  }))
}
