import * as platformModulesRepo from '@kit/auth/repos/platform-modules'
import * as platformRolesRepo from '@kit/auth/repos/platform-roles'
import { baAccount, baMember, baOrganization, baUser } from '@kit/auth/schema'
import { COMMENTS_MODULE_ID } from '@kit/comments'
import { TASKS_MODULE_ID } from '@kit/tasks'
import { hashPassword } from 'better-auth/crypto'
import { eq } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../db/schema'
import * as orgRolesService from '../services/org-roles'
import * as platformModulesService from '../services/platform-modules'
import * as tasksService from '../services/tasks'
import { TENANCY_ORGS, TENANCY_PERSONAS } from './tenancy-data'

/** Platform-available dogfood. tasks+comments: org_acme only (ADR-0007). demo: org_acme + org_team. */
const ACME_DOGFOOD_MODULES = new Set<string>([TASKS_MODULE_ID, COMMENTS_MODULE_ID])
const PLATFORM_AVAILABLE_MODULES = new Set<string>([...ACME_DOGFOOD_MODULES, 'demo'])
const DEMO_ENABLED_ORGS = new Set(['org_acme', 'org_team'])

type Db = DrizzleD1Database<typeof schema>

export type TenancySeedResult = {
  users: { id: string; email: string; created: boolean }[]
  orgs: { id: string; slug: string; created: boolean }[]
  platformRoles: { userId: string; role: string }[]
}

function tenancyEnvAllows(opts?: { environment?: string | null; force?: boolean }): boolean {
  const env = opts?.environment?.trim().toLowerCase()
  if (env === 'staging' || env === 'production') return false
  if (!opts?.force && env && env !== 'development' && env !== 'test') return false
  return true
}

async function seedTenancyUsers(
  db: Db,
  now: Date,
  ts: number,
  hashCredential: typeof hashPassword,
): Promise<TenancySeedResult['users']> {
  const users: TenancySeedResult['users'] = []
  for (const p of TENANCY_PERSONAS) {
    const existing = await db.select().from(baUser).where(eq(baUser.id, p.id)).limit(1)
    if (existing[0]) {
      users.push({ id: p.id, email: p.email, created: false })
    } else {
      const passwordHash = await hashCredential(p.password)
      await db.insert(baUser).values({
        id: p.id,
        name: p.name,
        email: p.email,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      await db.insert(baAccount).values({
        id: `acc_${p.id}`,
        accountId: p.id,
        providerId: 'credential',
        issuer: 'local:credential',
        userId: p.id,
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      })
      users.push({ id: p.id, email: p.email, created: true })
    }
    if (p.platformRole) {
      await platformRolesRepo.setPlatformRole(db, p.id, p.platformRole, ts)
    }
  }
  return users
}

async function seedTenancyOrgs(db: Db, now: Date): Promise<TenancySeedResult['orgs']> {
  const orgs: TenancySeedResult['orgs'] = []
  for (const o of TENANCY_ORGS) {
    const existing = await db
      .select()
      .from(baOrganization)
      .where(eq(baOrganization.id, o.id))
      .limit(1)
    if (existing[0]) {
      orgs.push({ id: o.id, slug: o.slug, created: false })
    } else {
      await db.insert(baOrganization).values({
        id: o.id,
        name: o.name,
        slug: o.slug,
        kind: o.kind,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      orgs.push({ id: o.id, slug: o.slug, created: true })
    }
    for (const m of o.members) {
      const memId = `mem_${o.id}_${m.userId}`
      const memExisting = await db.select().from(baMember).where(eq(baMember.id, memId)).limit(1)
      if (!memExisting[0]) {
        await db.insert(baMember).values({
          id: memId,
          organizationId: o.id,
          userId: m.userId,
          role: m.role,
          createdAt: now,
        })
      }
    }
    await orgRolesService.ensureSystemRoles(db, o.id)
  }
  return orgs
}

async function seedTenancyModules(db: Db, ts: number): Promise<void> {
  for (const moduleId of PLATFORM_AVAILABLE_MODULES) {
    await platformModulesRepo.upsertPlatformModule(db, {
      moduleId,
      available: true,
      configJson: null,
      updatedAt: ts,
    })
  }
  const platform = await platformModulesRepo.listPlatformModules(db)
  for (const o of TENANCY_ORGS) {
    for (const mod of platform) {
      const enabled =
        Boolean(mod.available) &&
        (mod.moduleId === 'demo'
          ? DEMO_ENABLED_ORGS.has(o.id)
          : o.id === 'org_acme' && ACME_DOGFOOD_MODULES.has(mod.moduleId))
      await platformModulesRepo.upsertOrgModule(db, {
        organizationId: o.id,
        moduleId: mod.moduleId,
        enabled,
        locked: false,
        updatedAt: ts,
      })
    }
    if (o.id === 'org_acme') {
      await tasksService.ensureDefaultBoard(db, o.id)
    }
  }
}

export async function seedTenancyDemo(
  db: Db,
  opts?: { now?: Date; environment?: string | null; force?: boolean },
  hashCredential: typeof hashPassword = hashPassword,
): Promise<TenancySeedResult> {
  if (!tenancyEnvAllows(opts)) {
    return { users: [], orgs: [], platformRoles: [] }
  }
  const now = opts?.now ?? new Date()
  const ts = now.getTime()
  await platformModulesService.ensurePlatformModules(db)
  const users = await seedTenancyUsers(db, now, ts, hashCredential)
  const orgs = await seedTenancyOrgs(db, now)
  await seedTenancyModules(db, ts)
  const platformRoles = TENANCY_PERSONAS.filter((p) => p.platformRole).map((p) => ({
    userId: p.id,
    role: p.platformRole!,
  }))
  return { users, orgs, platformRoles }
}
