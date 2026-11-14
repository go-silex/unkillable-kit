import type { OrgCapability } from '@kit/auth'
import { createOrgMiddleware, type OrgContextOpts, type OrgMiddlewareEnv } from '@kit/auth/hono'
import * as orgsRepo from '@kit/auth/repos/orgs'
import * as platformRolesRepo from '@kit/auth/repos/platform-roles'
import type { MiddlewareHandler } from 'hono'
import type { KitDb } from '../lib/db-type'
import type { KitModuleId } from '../lib/kit-modules'
import * as orgRolesService from '../services/org-roles'
import * as platformModulesService from '../services/platform-modules'
import type { AppEnv } from '../types'

const orgMiddleware = createOrgMiddleware({
  findOrgContext: (db, orgId, subject) => orgsRepo.findOrgContext(db as KitDb, orgId, subject),
  getPlatformRole: (db, subject) => platformRolesRepo.getPlatformRole(db as KitDb, subject),
  resolveModuleAccess: (db, input) => orgRolesService.resolveModuleAccess(db as KitDb, input),
  isModuleEffective: (db, orgId, moduleId) =>
    platformModulesService.isModuleEffective(db as KitDb, orgId, moduleId as KitModuleId),
})

export type { OrgContextOpts }

function asAppMiddleware(handler: MiddlewareHandler<OrgMiddlewareEnv>): MiddlewareHandler<AppEnv> {
  return handler as unknown as MiddlewareHandler<AppEnv>
}

export function requireOrgContext(opts: OrgContextOpts = {}): MiddlewareHandler<AppEnv> {
  return asAppMiddleware(orgMiddleware.requireOrgContext(opts))
}

export function requireOrgCapability(capability: OrgCapability): MiddlewareHandler<AppEnv> {
  return asAppMiddleware(orgMiddleware.requireOrgCapability(capability))
}

export function requirePlatformRole(
  ...roles: import('@kit/auth').PlatformRole[]
): MiddlewareHandler<AppEnv> {
  return asAppMiddleware(orgMiddleware.requirePlatformRole(...roles))
}

export function requireModule(
  moduleId: KitModuleId,
  op: 'read' | 'write' = 'read',
): MiddlewareHandler<AppEnv> {
  const normal = asAppMiddleware(orgMiddleware.requireModule(moduleId, op))
  return async (c, next) => {
    // The global delegation gate has already checked live grants without seeding rows.
    if (c.get('impersonationRow')) {
      await next()
      return
    }
    await normal(c, next)
  }
}
