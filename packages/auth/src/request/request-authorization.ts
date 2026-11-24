import { AppError } from '@kit/core'
import type { KitD1Database } from '@kit/db'
import type { Context, Env, MiddlewareHandler, Next } from 'hono'
import type { BetterAuthLike } from '../better-auth-port'
import { parseBearer } from '../keys'
import {
  type OrgCapability,
  type OrgRoleKey,
  type PlatformRole,
  roleAtLeast,
  roleHasCapability,
} from '../org-roles'
import type { AuthorizationFact } from '../snapshot/facts'
import { loadRequestSnapshot, type RequestSnapshot } from '../snapshot/load'
import {
  admitOrganization,
  assertModule,
  authUnavailable,
  contextVariables,
  directIdentity,
  type GuardState,
  isOrgFact,
  type OrgContextOpts,
  projectIdentity,
  readAdmittedFact,
  snapshotFacts,
} from './authorization-admission'
import {
  type AuthorizationPlan,
  type AuthorizationUse,
  type ModuleAuthorizationFacts,
  planAuthorization,
  organizationSelection as readOrganizationSelection,
} from './authorization-plan'
import { requestSessionCookie } from './effective-session-cookie'

export { MODULE_DENIAL, type OrgContextOpts } from './authorization-admission'
export type { ModuleAuthorizationFacts } from './authorization-plan'

type Options<E extends Env> = Readonly<{
  db: (c: Context<E>) => KitD1Database
  auth: (c: Context<E>) => BetterAuthLike | undefined
  moduleFacts?: (id: string) => ModuleAuthorizationFacts | undefined
  delegation?: true
}>

/** Guards over a private request-local load. The App supplies read declarations, not database callbacks. */
export function createRequestAuthorization<E extends Env>(options: Options<E>) {
  const requests = new WeakMap<Context<E>, GuardState<E>>()
  const uses = new WeakMap<MiddlewareHandler<E>, AuthorizationUse>()

  async function load(c: Context<E>, plan: AuthorizationPlan<E>): Promise<RequestSnapshot> {
    const authorization = c.req.header('authorization')
    const header = c.req.header('cookie')
    const auth =
      header && (options.delegation || !parseBearer(authorization)) ? options.auth(c) : undefined
    const cookie = auth ? requestSessionCookie(auth, header ?? null) : undefined
    try {
      return await loadRequestSnapshot({
        db: options.db(c),
        authorization,
        cookie,
        organizationId: plan.selection.kind === 'selected' ? plan.selection.id : undefined,
        delegation: options.delegation,
        facts: snapshotFacts(plan),
      })
    } catch {
      throw authUnavailable()
    }
  }

  function stateOf(c: Context<E>): GuardState<E> {
    const found = requests.get(c)
    if (found) return found
    const plan = planAuthorization(c, uses, options.moduleFacts)
    const state: GuardState<E> = {
      plan,
      load: load(c, plan),
      authenticated: false,
      keyScope: false,
      fence: !options.delegation,
      delegated: null,
      org: undefined,
    }
    requests.set(c, state)
    return state
  }

  function guard(
    use: AuthorizationUse,
    check: (c: Context<E>, state: GuardState<E>, snapshot: RequestSnapshot) => void,
  ): MiddlewareHandler<E> {
    const middleware = async (c: Context<E>, next: Next) => {
      const state = stateOf(c)
      check(c, state, await state.load)
      state.plan.pending.delete(middleware)
      await next()
    }
    uses.set(middleware, use)
    return middleware
  }

  const requireAuth = guard({}, (c, state, snapshot) => {
    if (!state.fence) throw AppError.forbidden('Credential fence not admitted')
    const delegation = state.delegated ? snapshot.delegation : undefined
    if (delegation?.row) {
      projectIdentity(c, { ...delegation.actor, subject: delegation.row.subjectUserId })
      contextVariables(c).set('platformRole', null)
    } else {
      projectIdentity(c, directIdentity(snapshot, state.keyScope))
      contextVariables(c).set('platformRole', snapshot.platformRole)
    }
    state.authenticated = true
  })

  function requireOrgContext(opts: OrgContextOpts = {}) {
    const bypassPolicy = { ...opts }
    return guard({ org: true }, (c, state, snapshot) => {
      admitOrganization(c, state, snapshot, bypassPolicy)
    })
  }

  function requireOrgRole(minimum: OrgRoleKey) {
    return guard({}, (_c, state) => {
      if (state.org?.bypass) return
      const role = state.org?.role
      if (!(role && roleAtLeast(role, minimum)))
        throw AppError.forbidden('Insufficient organization role')
    })
  }

  function requireOrgCapability(capability: OrgCapability) {
    return guard({}, (_c, state) => {
      if (state.org?.bypass) {
        if (capability === 'delete_org') {
          throw AppError.forbidden('Super admin cannot delete organization via break-glass')
        }
        return
      }
      const role = state.org?.role
      if (!(role && roleHasCapability(role, capability))) {
        throw AppError.forbidden('Insufficient organization capability')
      }
    })
  }

  function requirePlatformRole(...allowed: PlatformRole[]) {
    return guard({}, (c, state, snapshot) => {
      if (!state.authenticated) throw AppError.unauthorized()
      const role = state.delegated ? null : snapshot.platformRole
      if (!(role && allowed.includes(role))) throw AppError.forbidden('Platform role required')
      contextVariables(c).set('platformRole', role)
    })
  }

  function requireModule(moduleId: string, op: 'read' | 'write' = 'read') {
    return guard({ org: true, module: moduleId }, (_c, state, snapshot) => {
      if (!state.org) throw AppError.forbidden('Organization context required')
      const mode = state.delegated ? 'delegated' : state.org.bypass ? 'bypass' : 'normal'
      assertModule(state.plan.modules.get(moduleId), snapshot, mode, op)
    })
  }

  function includeFacts(...facts: AuthorizationFact<unknown>[]): MiddlewareHandler<E> {
    return guard(
      { org: facts.some((fact) => isOrgFact(fact.scope.kind)) ? true : undefined, facts },
      () => {},
    )
  }

  function fact<T>(c: Context<E>, descriptor: AuthorizationFact<T>): Promise<T> {
    return readAdmittedFact(requests.get(c), descriptor)
  }

  async function session(c: Context<E>) {
    const state = stateOf(c)
    if (!state.fence || state.delegated) return null
    const { identity } = await state.load
    return identity?.method === 'session' ? identity : null
  }

  async function authenticateKey(c: Context<E>) {
    const { identity } = await stateOf(c).load
    if (identity?.method !== 'api_key') throw AppError.unauthorized()
    return identity
  }

  function admitKeyScope(c: Context<E>) {
    stateOf(c).keyScope = true
  }

  async function delegation(c: Context<E>) {
    return (await stateOf(c).load).delegation
  }

  function admitFence(c: Context<E>) {
    stateOf(c).fence = true
  }

  async function admitDelegation(c: Context<E>, mode: 'recovery' | 'business') {
    const state = stateOf(c)
    const { delegation } = await state.load
    const row = delegation?.row
    if (
      !(delegation?.targetActive && row) ||
      /^\s*Bearer\b/i.test(c.req.header('authorization') ?? '')
    ) {
      throw AppError.unauthorized()
    }
    if (mode === 'business' && !delegation.eligible) {
      throw AppError.forbidden('Impersonation is no longer eligible')
    }
    projectIdentity(c, { ...delegation.actor, subject: row.subjectUserId })
    state.delegated = mode
    state.authenticated = true
    state.fence = true
  }

  async function assertDelegationModule(c: Context<E>, id: string, op: 'read' | 'write') {
    const state = stateOf(c)
    const snapshot = await state.load
    try {
      assertModule(state.plan.modules.get(id), snapshot, 'delegated', op)
    } catch {
      throw AppError.forbidden('Module access required')
    }
  }

  function organizationSelection(c: Context<E>) {
    const selection = stateOf(c).plan.selection
    return selection.kind === 'unused' ? readOrganizationSelection(c) : selection
  }

  return {
    requireAuth,
    requireOrgContext,
    requireOrgRole,
    requireOrgCapability,
    requirePlatformRole,
    requireModule,
    includeFacts,
    fact,
    authenticateKey,
    admitKeyScope,
    session,
    delegation,
    admitFence,
    admitDelegation,
    assertDelegationModule,
    organizationSelection,
  }
}
