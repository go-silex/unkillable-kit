import { AppError } from '@kit/core'
import type { KitD1Database } from '@kit/db'
import type { Context, Env, Hono, MiddlewareHandler } from 'hono'
import type { BetterAuthLike } from '../better-auth-port'
import { accessAllows, type ModuleOp } from '../module-grants'
import {
  type OrgCapability,
  type OrgRoleKey,
  type PlatformRole,
  roleAtLeast,
  roleHasCapability,
} from '../org-roles'
import type { SessionIdentity } from '../snapshot/core-rows'
import { handlerOf, hostedRoutes, type Routes } from './hosted-routes'
import {
  type AdmittedOrganization,
  admitOrganization,
  type ImpersonationPolicy,
  type KeyScopePolicy,
  MODULE_DENIAL,
  type OrgContextOpts,
} from './request-policy'
import { type AdmittedView, project } from './request-projection'
import { createRequestState, type Stage } from './request-state'

export type { AdmittedView } from './request-projection'

export type RequestAuthorizationOptions<E extends Env> = Readonly<{
  db: (c: Context<E>) => KitD1Database
  auth: (c: Context<E>) => BetterAuthLike | undefined
  modules?: true
  keyScope?: KeyScopePolicy
  impersonation?: ImpersonationPolicy<E>
}>

export type RequestAuthorization<E extends Env> = Readonly<{
  requireAuth: MiddlewareHandler<E>
  requireSession: MiddlewareHandler<E>
  requireOrgContext(opts?: OrgContextOpts<E>): MiddlewareHandler<E>
  requireOrgRole(minimum: OrgRoleKey): MiddlewareHandler<E>
  requireOrgCapability(capability: OrgCapability): MiddlewareHandler<E>
  requirePlatformRole(...roles: PlatformRole[]): MiddlewareHandler<E>
  requireModule(id: string, op?: ModuleOp): MiddlewareHandler<E>
  betterAuthMount: MiddlewareHandler<E>
  session(c: Context<E>): Promise<SessionIdentity | null>
  view(c: Context<E>): AdmittedView
  middleware(app: Pick<Hono<E>, 'routes'>, register: () => void): void
  hosted(
    app: Pick<Hono<E>, 'routes'>,
    register: () => void,
    opts?: Readonly<{ platformRole?: true }>,
  ): void
}>

/** The first Kit guard loads the fixed core for the current routing context. */
export function createRequestAuthorization<E extends Env>(
  options: RequestAuthorizationOptions<E>,
): RequestAuthorization<E> {
  const routes: Routes = {
    guards: new WeakMap(),
    middleware: new WeakSet(),
    declared: new WeakMap(),
  }

  const { authenticate, betterAuthMount, view } = createRequestState(options, routes)

  type Check = (c: Context<E>, stage: Stage) => AdmittedOrganization | null
  function guard(
    check?: Check,
    orgOpts?: OrgContextOpts<E>,
    organization = false,
  ): MiddlewareHandler<E> {
    const middleware: MiddlewareHandler<E> = async (c, next) => {
      const stage = await authenticate(
        c,
        organization ? 'organization' : 'guard',
        orgOpts?.organizationId,
        middleware,
      )
      const org = check?.(c, stage)
      if (!stage.pending) project(c, stage, org ?? undefined)
      await next()
    }
    routes.guards.set(middleware, organization ? 'organization' : 'identity')
    return middleware
  }

  function organization(c: Context<E>, stage: Stage, opts: OrgContextOpts<E> = {}) {
    if (
      stage.delegationMode === 'recovery' ||
      (stage.state.claim && stage.state.claim.organizationId === undefined)
    ) {
      throw AppError.forbidden('Organization context required')
    }
    return admitOrganization({
      id: stage.selection,
      snapshot: stage.snapshot,
      method: c.req.method,
      allowSuperAdmin: opts.allowSuperAdmin,
      allowSuperAdminWrite: opts.allowSuperAdminWrite,
      platformRole:
        !(stage.state.claim || stage.delegationMode) &&
        stage.snapshot.identity?.method === 'session'
          ? (stage.platformRole ?? null)
          : null,
    })
  }

  routes.guards.set(betterAuthMount, 'identity')

  const authorization: RequestAuthorization<E> = Object.freeze({
    requireAuth: guard(),
    requireSession: guard((_c, stage) => {
      if (stage.snapshot.identity?.method !== 'session')
        throw AppError.forbidden('This route requires a session cookie')
      return null
    }),
    requireOrgContext(opts: OrgContextOpts<E> = {}) {
      const policy = { ...opts }
      return guard((c, stage) => organization(c, stage, policy), policy, true)
    },
    requireOrgRole(minimum: OrgRoleKey) {
      return guard(
        (c, stage) => {
          const org = stage.state.view.organization ?? organization(c, stage)
          if (!(org.bypass || (org.role && roleAtLeast(org.role, minimum))))
            throw AppError.forbidden('Insufficient organization role')
          return org
        },
        undefined,
        true,
      )
    },
    requireOrgCapability(capability: OrgCapability) {
      return guard(
        (c, stage) => {
          const org = stage.state.view.organization ?? organization(c, stage)
          if (org.bypass && capability === 'delete_org') {
            throw AppError.forbidden('Super admin cannot delete organization via break-glass')
          }
          if (!(org.bypass || (org.role && roleHasCapability(org.role, capability))))
            throw AppError.forbidden('Insufficient organization capability')
          return org
        },
        undefined,
        true,
      )
    },
    requirePlatformRole(...roles: PlatformRole[]) {
      return guard((_c, stage) => {
        const role = stage.platformRole
        if (!(role && roles.includes(role))) throw AppError.forbidden('Platform role required')
        return null
      })
    },
    requireModule(id: string, op: ModuleOp = 'read') {
      if (!options.modules) throw new TypeError('Module guards require modules: true')
      return guard(
        (c, stage) => {
          const org = stage.state.view.organization ?? organization(c, stage)
          const module = org.modules === 'disabled' ? undefined : org.modules.get(id)
          if (!module?.available) throw AppError.notFound(MODULE_DENIAL.notAvailable)
          if (!(org.bypass || accessAllows(module.access, op)))
            throw AppError.forbidden(MODULE_DENIAL.insufficientGrant)
          return org
        },
        undefined,
        true,
      )
    },
    betterAuthMount,
    async session(c: Context<E>) {
      const { snapshot, delegationMode } = await authenticate(c, 'helper')
      return !delegationMode && snapshot.identity?.method === 'session' ? snapshot.identity : null
    },
    view,
    middleware(app: Pick<Hono<E>, 'routes'>, register: () => void) {
      const start = app.routes.length
      register()
      for (const route of app.routes.slice(start)) {
        if (!routes.guards.has(handlerOf(route))) routes.middleware.add(route)
      }
    },
    hosted(
      app: Pick<Hono<E>, 'routes'>,
      register: () => void,
      opts?: Readonly<{ platformRole?: true }>,
    ) {
      const start = app.routes.length
      register()
      const declaration = { app, platformRole: opts?.platformRole === true }
      for (const route of app.routes.slice(start)) {
        if (!routes.guards.has(handlerOf(route))) {
          routes.declared.set(route, declaration)
        }
      }
    },
  })
  hostedRoutes.set(authorization, routes)
  return authorization
}
