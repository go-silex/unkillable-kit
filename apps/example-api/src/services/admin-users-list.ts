/**
 * Admin user directory list — staff-scoped (shared orgs) vs super_admin full catalogue.
 * Staff scope is applied **before** keyset pagination (not filter-after-page).
 */
import type { PlatformRole } from '@kit/auth'
import * as orgsRepo from '@kit/auth/repos/orgs'
import * as platformRolesRepo from '@kit/auth/repos/platform-roles'
import {
  AppError,
  clampListLimit,
  decodeListCursor,
  isRepresentableEpochMs,
  takeListPage,
} from '@kit/core'
import type { ListPage } from '@kit/types'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../db/schema'
import * as usersRepo from '../repos/users'

type Db = DrizzleD1Database<typeof schema>

export type ListAdminUsersInput = {
  actorUserId: string
  actorPlatformRole: PlatformRole
  q?: string
  limit?: number
  cursor?: string | null
}

export type AdminUserListItem = {
  id: string
  email: string
  name: string
  platformRole: PlatformRole | null
  createdAt: string
}

function parseCreatedAtIdKeyset(cursor: string): { createdAt: number; id: string } {
  const decoded = decodeListCursor(cursor)
  const keys = Object.keys(decoded)
  if (keys.length !== 2 || !keys.includes('createdAt') || !keys.includes('id')) {
    throw AppError.validation('Invalid cursor')
  }
  const createdAt = decoded.createdAt
  const id = decoded.id
  if (typeof createdAt !== 'number' || !isRepresentableEpochMs(createdAt)) {
    throw AppError.validation('Invalid cursor')
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw AppError.validation('Invalid cursor')
  }
  return { createdAt, id }
}

/**
 * List BA users for the admin directory.
 * - super_admin: full platform directory
 * - staff: only users who share ≥1 org membership with the actor (privacy / IDOR)
 */
export async function listAdminUsers(
  db: Db,
  input: ListAdminUsersInput,
): Promise<ListPage<AdminUserListItem>> {
  if (input.actorPlatformRole !== 'super_admin' && input.actorPlatformRole !== 'staff') {
    throw AppError.forbidden('Platform role required')
  }

  let userIds: string[] | undefined
  if (input.actorPlatformRole === 'staff') {
    const actorOrgs = await orgsRepo.listMembershipsForUser(db, input.actorUserId)
    const orgIds = actorOrgs.map((m) => m.organizationId)
    const members = await orgsRepo.listMembersInOrgs(db, orgIds)
    const allowed = new Set<string>()
    for (const mem of members) {
      allowed.add(mem.userId)
    }
    userIds = [...allowed]
  }

  const limit = clampListLimit(input.limit)
  const keyset = input.cursor ? parseCreatedAtIdKeyset(input.cursor) : undefined

  const rows = await usersRepo.listBaUsers(db, {
    q: input.q,
    limit: limit + 1,
    cursor: keyset,
    userIds,
  })

  const page = takeListPage(rows, limit, (r) => {
    const createdAt = r.createdAt instanceof Date ? r.createdAt.getTime() : Number(r.createdAt)
    return { createdAt, id: r.id }
  })

  const rolesByUser = await platformRolesRepo.getPlatformRolesForUsers(
    db,
    page.items.map((r) => r.id),
  )

  return {
    items: page.items.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      platformRole: rolesByUser.get(r.id) ?? null,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    })),
    nextCursor: page.nextCursor,
  }
}
