import { AppError } from '@kit/core'
import type { MiddlewareHandler } from 'hono'
import {
  type OrgCapability,
  type OrgContextRecord,
  type OrgRoleKey,
  type PlatformRole,
  roleAtLeast,
  roleHasCapability,
} from './org-roles'
import type { KitRepoDb } from './repos/db-type'
import { findOrgContext } from './repos/orgs'
import { getPlatformRole } from './repos/platform-roles'
import type { ApiKeyScope } from './require-auth'

export type { OrgContextRecord } from './org-roles'
export { type OriginGuardEnv, originGuard } from './origin-guard'
export { scrubBetterAuthServerError } from './policy/ba-server-error'
export { type BetterAuthHandlerEnv, createBetterAuthHandler } from './policy/better-auth-handler'
export { createKitRequireAuth, type KitRequireAuthContext } from './policy/kit-require-auth'
export { isPasswordSignInPath, normalizePasswordSignInResponse } from './policy/sign-in-anti-enum'
export { isEmailSignUpPath, normalizeEmailSignUpResponse } from './policy/sign-up-anti-enum'
export {
  applySecurityHeaders,
  type SecurityHeadersEnv,
  securityHeaders,
} from './security-headers'

/**
 * Module denial wording, shared so every layer answers identically.
 *
 * `requireModule` answers first on HTTP, but a service-side backstop (e.g. a
 * grant mint) decides the same two conditions and MUST reply identically:
 * a module that is not effective for the org is `notFound` with
 * `notAvailable`; a role without the grant is `forbidden` with
 * `insufficientGrant`. The backstop must not invent a third answer — two
 * literals would let a caller tell the layers apart.
 */
export const MODULE_DENIAL = {
  notAvailable: 'Module not available',
  insufficientGrant: 'Insufficient module grant',
} as const

export type OrgContextOpts = {
  /** Super_admin may read without membership (audit logged). */
  allowSuperAdmin?: boolean
  /** Super_admin may write without membership — default false (ADR-0003 D9). */
  allowSuperAdminWrite?: boolean
}

export type OrgMiddlewareVariables = {
  subject?: string
  authMethod?: 'session' | 'api_key'
  keyOrganizationId?: string | null
  keyScopes?: ApiKeyScope[]
  requestId?: string
  db?: unknown
  orgId?: string
  orgRole?: string
  orgBypass?: boolean
  platformRole?: PlatformRole | null
}

export type OrgMiddlewareEnv = {
  Variables: OrgMiddlewareVariables
}

export type OrgContextPorts = {
  findOrgContext(db: unknown, orgId: string, subject: string): Promise<OrgContextRecord | null>
  getPlatformRole(db: unknown, subject: string): Promise<PlatformRole | null>
  resolveModuleAccess(
    db: unknown,
    input: {
      organizationId: string
      roleKey: string | undefined
      moduleId: string
      op: 'read' | 'write'
      orgBypass?: boolean
    },
  ): Promise<boolean>
  isModuleEffective(db: unknown, orgId: string, moduleId: string): Promise<boolean>
}

/** Use the kit organization and platform-role repositories with caller-owned module policy. */
export function createKitOrgMiddleware(
  ports: Pick<OrgContextPorts, 'resolveModuleAccess' | 'isModuleEffective'>,
) {
  return createOrgMiddleware({
    ...ports,
    findOrgContext: (db, orgId, subject) => findOrgContext(db as KitRepoDb, orgId, subject),
    getPlatformRole: (db, subject) => getPlatformRole(db as KitRepoDb, subject),
  })
}

function dbOf(c: { get: (k: 'db') => unknown | undefined }): unknown {
  const db = c.get('db')
  if (!db) throw AppError.internal('db not bound')
  return db
}

function isSafeMethod(method: string): boolean {
  switch (method) {
    case 'GET':
    case 'HEAD':
    case 'OPTIONS':
      return true
    default:
      return false
  }
}

function assertOrgAccess(
  membershipRole: string | null,
  platformRole: PlatformRole | null,
  safe: boolean,
  opts: OrgContextOpts,
): void {
  if (membershipRole !== null) return
  if (platformRole !== 'super_admin') throw AppError.notFound('Organization not found')
  if (safe && opts.allowSuperAdmin) return
  if (!safe && opts.allowSuperAdminWrite) return
  if (!safe && opts.allowSuperAdmin) {
    throw AppError.forbidden('Super admin write requires break-glass flag')
  }
  throw AppError.notFound('Organization not found')
}

export function createOrgMiddleware(ports: OrgContextPorts) {
  function resolveRequestOrgId(c: {
    req: {
      param: (name: string) => string | undefined
      header: (name: string) => string | undefined
    }
  }): string {
    const pathOrg = c.req.param('orgId')?.trim()
    const headerOrg = c.req.header('x-org-id')?.trim()
    const orgId = pathOrg || headerOrg
    if (!orgId) {
      throw AppError.validation('organization id required (path or X-Org-Id)')
    }
    if (pathOrg && headerOrg && pathOrg !== headerOrg) {
      throw AppError.forbidden('organization id mismatch')
    }
    return orgId
  }

  function assertApiKeyMatchesOrg(
    c: { get: (key: 'authMethod' | 'keyOrganizationId') => string | undefined },
    orgId: string,
  ): void {
    if (c.get('authMethod') !== 'api_key') return
    const keyOrg = c.get('keyOrganizationId')
    if (!keyOrg) {
      throw AppError.forbidden('API key must be organization-bound for tenant routes')
    }
    if (keyOrg !== orgId) {
      throw AppError.forbidden('API key is bound to a different organization')
    }
  }

  function logSuperAdminBypass(
    c: { get: (key: 'requestId') => string | undefined },
    action: 'read' | 'write',
    actor: string,
    orgId: string,
  ): void {
    console.info(
      JSON.stringify({
        level: 'info',
        msg: 'super_admin_org_bypass',
        action,
        actor,
        orgId,
        requestId: c.get('requestId'),
      }),
    )
  }

  function requireOrgContext(opts: OrgContextOpts = {}): MiddlewareHandler<OrgMiddlewareEnv> {
    return async (c, next) => {
      const subject = c.get('subject')
      if (!subject) throw AppError.unauthorized()

      const orgId = resolveRequestOrgId(c)
      assertApiKeyMatchesOrg(c, orgId)

      const db = dbOf(c)
      const org = await ports.findOrgContext(db, orgId, subject)
      if (!org) throw AppError.notFound('Organization not found')

      const { membershipRole, platformRole } = org
      const safe = isSafeMethod(c.req.method)
      assertOrgAccess(membershipRole, platformRole, safe, opts)
      if (org.status !== 'active') {
        throw AppError.forbidden('Organization is not active')
      }

      c.set('platformRole', platformRole)
      if (membershipRole !== null) {
        c.set('orgId', orgId)
        c.set('orgRole', membershipRole)
        c.set('orgBypass', false)
        await next()
        return
      }

      c.set('orgRole', undefined)
      c.set('orgId', orgId)
      c.set('orgBypass', true)
      logSuperAdminBypass(c, safe ? 'read' : 'write', subject, orgId)
      await next()
    }
  }

  function requireOrgRole(min: OrgRoleKey): MiddlewareHandler<OrgMiddlewareEnv> {
    return async (c, next) => {
      if (c.get('orgBypass')) {
        await next()
        return
      }
      const role = c.get('orgRole')
      if (!(role && roleAtLeast(role, min))) {
        throw AppError.forbidden('Insufficient organization role')
      }
      await next()
    }
  }

  function requireOrgCapability(capability: OrgCapability): MiddlewareHandler<OrgMiddlewareEnv> {
    return async (c, next) => {
      if (c.get('orgBypass')) {
        if (capability === 'delete_org') {
          throw AppError.forbidden('Super admin cannot delete organization via break-glass')
        }
        await next()
        return
      }
      const role = c.get('orgRole')
      if (!(role && roleHasCapability(role, capability))) {
        throw AppError.forbidden('Insufficient organization capability')
      }
      await next()
    }
  }

  function requirePlatformRole(...roles: PlatformRole[]): MiddlewareHandler<OrgMiddlewareEnv> {
    const allowed =
      roles.length === 1 && Array.isArray(roles[0]) ? (roles[0] as PlatformRole[]) : roles
    return async (c, next) => {
      const subject = c.get('subject')
      if (!subject) throw AppError.unauthorized()
      const db = dbOf(c)
      const role = await ports.getPlatformRole(db, subject)
      c.set('platformRole', role)
      if (!(role && allowed.includes(role))) {
        throw AppError.forbidden('Platform role required')
      }
      await next()
    }
  }

  function requireModule(
    moduleId: string,
    op: 'read' | 'write' = 'read',
  ): MiddlewareHandler<OrgMiddlewareEnv> {
    return async (c, next) => {
      const orgId = c.get('orgId')
      if (!orgId) throw AppError.forbidden('Organization context required')
      const db = dbOf(c)
      const allowed = await ports.resolveModuleAccess(db, {
        organizationId: orgId,
        roleKey: c.get('orgRole'),
        moduleId,
        op,
        orgBypass: Boolean(c.get('orgBypass')),
      })
      if (!allowed) {
        const platformOk = await ports.isModuleEffective(db, orgId, moduleId)
        if (!platformOk) throw AppError.notFound(MODULE_DENIAL.notAvailable)
        throw AppError.forbidden(MODULE_DENIAL.insufficientGrant)
      }
      await next()
    }
  }

  return {
    requireOrgContext,
    requireOrgRole,
    requireOrgCapability,
    requirePlatformRole,
    requireModule,
  }
}
