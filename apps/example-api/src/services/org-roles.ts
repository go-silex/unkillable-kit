import {
  accessAllows,
  canInviteRole,
  grantsDominate,
  isAssignableRoleKey,
  isModuleAccess,
  isOrgRoleKey,
  type ModuleAccess,
  type ModuleOp,
  ORG_ROLE_KEYS,
  type OrgRoleKey,
  systemRoleGrantSeed,
} from '@kit/auth'
import * as orgRolesRepo from '@kit/auth/repos/org-roles'
import * as orgsRepo from '@kit/auth/repos/orgs'
import { AppError } from '@kit/core'
import { FLOWS_MODULE_ID } from '@kit/flows'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../db/schema'
import { isKitModuleId, KIT_MODULE_IDS } from '../lib/kit-modules'
import * as platformModulesService from './platform-modules'

type Db = DrizzleD1Database<typeof schema>

const SYSTEM_ROLE_NAMES: Record<OrgRoleKey, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  reader: 'Reader',
}

function newRoleId(): string {
  return `role_${crypto.randomUUID().replace(/-/g, '')}`
}

function slugRoleKey(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48)
}

/**
 * Idempotent seed: create missing system roles + missing grants only.
 * Does **not** re-upsert existing grants (avoids hot-path write amplification).
 */
export async function ensureSystemRoles(db: Db, organizationId: string): Promise<void> {
  const now = Date.now()
  // V0: FLOWS_ADMIN_ROLES (owner|admin) only — do not auto-write for member/reader (Roxabi/roxabi-boilerplate-cf#29 review).
  const seed = systemRoleGrantSeed(KIT_MODULE_IDS).map((row) => {
    if (row.moduleId !== FLOWS_MODULE_ID) return row
    if (row.roleKey === 'owner' || row.roleKey === 'admin')
      return { ...row, access: 'write' as const }
    return { ...row, access: 'disabled' as const }
  })
  for (const roleKey of ORG_ROLE_KEYS) {
    let role = await orgRolesRepo.findRoleByKey(db, organizationId, roleKey)
    if (!role) {
      const id = newRoleId()
      await orgRolesRepo.insertRole(db, {
        id,
        organizationId,
        key: roleKey,
        name: SYSTEM_ROLE_NAMES[roleKey],
        isSystem: true,
        createdAt: now,
      })
      role = await orgRolesRepo.findRoleByKey(db, organizationId, roleKey)
    }
    if (!role) continue
    const existing = await orgRolesRepo.listGrantsForRole(db, role.id)
    const have = new Set(existing.map((g) => g.moduleId))
    for (const row of seed.filter((s) => s.roleKey === roleKey)) {
      if (have.has(row.moduleId)) continue
      await orgRolesRepo.upsertGrant(db, {
        organizationId,
        roleId: role.id,
        moduleId: row.moduleId,
        access: row.access,
      })
    }
  }
}

export async function listRolesWithGrants(
  db: Db,
  organizationId: string,
  options?: { readOnly?: boolean },
) {
  if (!options?.readOnly) await ensureSystemRoles(db, organizationId)
  const roles = await orgRolesRepo.listRolesForOrg(db, organizationId)
  const grants = await orgRolesRepo.listGrantsForRoles(
    db,
    roles.map((r) => r.id),
  )
  const byRole = new Map<string, { moduleId: string; access: ModuleAccess }[]>()
  for (const g of grants) {
    if (!isModuleAccess(g.access)) continue
    const list = byRole.get(g.roleId) ?? []
    list.push({ moduleId: g.moduleId, access: g.access })
    byRole.set(g.roleId, list)
  }
  return roles.map((r) => ({
    id: r.id,
    organizationId: r.organizationId,
    key: r.key,
    name: r.name,
    isSystem: Boolean(r.isSystem),
    grants: byRole.get(r.id) ?? [],
  }))
}

export async function createCustomRole(
  db: Db,
  input: {
    organizationId: string
    key: string
    name: string
    grants?: Array<{ moduleId: string; access: ModuleAccess }>
    /** Actor membership role key — used for ceiling. */
    actorRoleKey: string
  },
) {
  await ensureSystemRoles(db, input.organizationId)
  const key = slugRoleKey(input.key)
  if (!key || isOrgRoleKey(key)) {
    throw AppError.fieldErrors('Invalid custom role key', {
      key: ['Use a non-system key (a-z, 0-9, _)'],
    })
  }
  const name = input.name.trim()
  if (!name) {
    throw AppError.fieldErrors('name is required', {
      name: ['name is required'],
    })
  }

  const existing = await orgRolesRepo.findRoleByKey(db, input.organizationId, key)
  if (existing) throw AppError.conflict('Role key already exists')

  const grants =
    input.grants ?? KIT_MODULE_IDS.map((moduleId) => ({ moduleId, access: 'read' as const }))
  for (const g of grants) {
    if (!KIT_MODULE_IDS.includes(g.moduleId as (typeof KIT_MODULE_IDS)[number])) {
      throw AppError.fieldErrors('Unknown module in grants', {
        moduleId: [g.moduleId],
      })
    }
    if (!isModuleAccess(g.access)) {
      throw AppError.fieldErrors('Invalid access level', {
        access: [g.access],
      })
    }
  }

  const actorMap = await grantsMapForRoleKey(db, input.organizationId, input.actorRoleKey)
  const targetMap = new Map(grants.map((g) => [g.moduleId, g.access]))
  if (!grantsDominate(actorMap, targetMap, KIT_MODULE_IDS)) {
    throw AppError.forbidden('Cannot create a role with grants beyond your own capabilities')
  }

  const id = newRoleId()
  await orgRolesRepo.insertRole(db, {
    id,
    organizationId: input.organizationId,
    key,
    name,
    isSystem: false,
    createdAt: Date.now(),
  })
  for (const g of grants) {
    await orgRolesRepo.upsertGrant(db, {
      organizationId: input.organizationId,
      roleId: id,
      moduleId: g.moduleId,
      access: g.access,
    })
  }
  const created = (await listRolesWithGrants(db, input.organizationId)).find((r) => r.id === id)
  if (!created) throw AppError.internal()
  return created
}

export async function setRoleGrant(
  db: Db,
  input: {
    organizationId: string
    roleId: string
    moduleId: string
    access: ModuleAccess
    actorRoleKey: string
  },
) {
  await ensureSystemRoles(db, input.organizationId)
  const role = await orgRolesRepo.findRoleById(db, input.organizationId, input.roleId)
  if (!role) throw AppError.notFound('Role not found')
  if (role.isSystem) throw AppError.forbidden('System role grants are immutable')
  if (!KIT_MODULE_IDS.includes(input.moduleId as (typeof KIT_MODULE_IDS)[number])) {
    throw AppError.notFound('Unknown module')
  }
  if (!isModuleAccess(input.access)) {
    throw AppError.fieldErrors('Invalid access', {
      access: [input.access],
    })
  }

  const actorMap = await grantsMapForRoleKey(db, input.organizationId, input.actorRoleKey)
  const current = await orgRolesRepo.listGrantsForRole(db, role.id)
  const targetMap = new Map(
    current
      .filter((g) => isModuleAccess(g.access))
      .map((g) => [g.moduleId, g.access as ModuleAccess]),
  )
  targetMap.set(input.moduleId, input.access)
  if (!grantsDominate(actorMap, targetMap, KIT_MODULE_IDS)) {
    throw AppError.forbidden('Cannot set grant beyond your own capabilities')
  }

  const granted = await orgRolesRepo.upsertGrant(db, {
    organizationId: input.organizationId,
    roleId: role.id,
    moduleId: input.moduleId,
    access: input.access,
  })
  if (!granted) throw AppError.notFound('Role not found')
  const updated = (await listRolesWithGrants(db, input.organizationId)).find(
    (r) => r.id === role.id,
  )
  if (!updated) throw AppError.internal()
  return updated
}

export async function deleteCustomRole(db: Db, organizationId: string, roleId: string) {
  const role = await orgRolesRepo.findRoleById(db, organizationId, roleId)
  if (!role) throw AppError.notFound('Role not found')
  if (role.isSystem) throw AppError.forbidden('System roles cannot be deleted')
  const members = await orgsRepo.listMembers(db, organizationId)
  if (members.some((m) => m.role === role.key))
    throw AppError.conflict('Role is still assigned to members')
  if (!(await orgRolesRepo.deleteRole(db, organizationId, roleId))) {
    throw AppError.notFound('Role not found')
  }
}

async function grantsMapForRoleKey(
  db: Db,
  organizationId: string,
  roleKey: string,
): Promise<Map<string, ModuleAccess>> {
  await ensureSystemRoles(db, organizationId)
  const role = await orgRolesRepo.findRoleByKey(db, organizationId, roleKey)
  const map = new Map<string, ModuleAccess>()
  if (!role) return map
  const grants = await orgRolesRepo.listGrantsForRole(db, role.id)
  for (const g of grants) {
    if (isModuleAccess(g.access)) map.set(g.moduleId, g.access)
  }
  return map
}

/**
 * Single runtime resolver for module ops (Phase B).
 * platform.available ∧ org.enabled ∧ grant access.
 */
export async function resolveModuleAccess(
  db: Db,
  input: {
    organizationId: string
    roleKey: string | undefined
    moduleId: string
    op: ModuleOp
    /** Super admin break-glass already decided at middleware. */
    orgBypass?: boolean
    readOnly?: boolean
  },
): Promise<boolean> {
  if (input.orgBypass) return true
  if (!input.roleKey) return false
  if (!isKitModuleId(input.moduleId)) return false

  const platformOk = await platformModulesService.isModuleEffective(
    db,
    input.organizationId,
    input.moduleId,
  )
  if (!platformOk) return false

  if (!input.readOnly) await ensureSystemRoles(db, input.organizationId)
  const role = await orgRolesRepo.findRoleByKey(db, input.organizationId, input.roleKey)
  if (!role) return false
  const grants = await orgRolesRepo.listGrantsForRole(db, role.id)
  const row = grants.find((g) => g.moduleId === input.moduleId)
  if (!(row && isModuleAccess(row.access))) return false
  return accessAllows(row.access, input.op)
}

/**
 * Ceiling for invite/assign.
 * - Target system roles: **always** `canInviteRole` (never grant-dominance).
 * - Custom actors cannot mint system roles.
 * - Custom targets: module grant dominance only.
 */
export async function assertAssignableRole(
  db: Db,
  organizationId: string,
  roleKey: string,
  actorRoleKey: string,
): Promise<void> {
  await ensureSystemRoles(db, organizationId)
  const roles = await orgRolesRepo.listRolesForOrg(db, organizationId)
  const custom = roles.filter((r) => !r.isSystem).map((r) => r.key)
  if (!isAssignableRoleKey(roleKey, custom)) {
    throw AppError.fieldErrors('Unknown role', {
      role: [roleKey],
    })
  }
  if (roleKey === 'owner') {
    throw AppError.forbidden('Cannot assign owner via this path')
  }

  // System target: org hierarchy only (never module-grant dominance → admin promote)
  if (isOrgRoleKey(roleKey)) {
    if (!isOrgRoleKey(actorRoleKey)) {
      throw AppError.forbidden('Custom roles cannot assign system roles')
    }
    if (!canInviteRole(actorRoleKey, roleKey)) {
      throw AppError.forbidden('Invite role exceeds inviter ceiling')
    }
    return
  }

  // Custom target: actor must dominate module grants
  const actorMap = await grantsMapForRoleKey(db, organizationId, actorRoleKey)
  const targetMap = await grantsMapForRoleKey(db, organizationId, roleKey)
  if (!grantsDominate(actorMap, targetMap, KIT_MODULE_IDS)) {
    throw AppError.forbidden('Cannot assign a role beyond your capabilities')
  }
}
