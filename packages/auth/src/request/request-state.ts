import { AppError } from '@kit/core'
import type { Context, Env, MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'
import { BA_BASE_PATH } from '../better-auth-base-path'
import { hasKitKeyBearer, parseBearer } from '../keys'
import type { PlatformRole } from '../org-roles'
import { type CoreSnapshot, loadCore } from '../snapshot/core-load'
import { unavailable } from '../snapshot/core-rows'
import { requestSessionCookie } from './effective-session-cookie'
import {
  type HostedClaim,
  handlerOf,
  hasOrganizationGuardBeforeTerminal,
  hostedClaims,
  inspectHostedRoutes,
  type Routes,
  terminalRoutes,
} from './hosted-routes'
import { type Selection, selectOrganization } from './organization-selection'
import type { RequestAuthorizationOptions } from './request-authorization'
import {
  admitImpersonation,
  admitKeyScope,
  type DeferredDelegation,
  type OrgContextOpts,
} from './request-policy'
import { type AdmittedView, EMPTY_VIEW } from './request-projection'

type DelegationMode = 'recovery' | 'business' | undefined
type State = {
  claim?: HostedClaim
  authorization?: string
  cookie?: string
  selected?: string
  initial: { selection: Selection; promise: Promise<CoreSnapshot> }
  scoped?: Promise<CoreSnapshot>
  policy?: Promise<DelegationMode | DeferredDelegation>
  deferred?: Promise<'business'>
  view: AdmittedView
}

export type Stage = {
  state: State
  snapshot: CoreSnapshot
  selection: string | undefined
  delegationMode: DelegationMode
  pending: boolean
  platformRole: PlatformRole | null | undefined
}

function isNativeSignOut<E extends Env>(c: Context<E>): boolean {
  return c.req.method === 'POST' && new URL(c.req.url).pathname === `${BA_BASE_PATH}/sign-out`
}

function assertReproduced(first: CoreSnapshot, second: CoreSnapshot) {
  if (!second.identity) throw AppError.unauthorized()
  if (
    first.keyId !== second.keyId ||
    first.platformRole !== second.platformRole ||
    first.impersonationPermissions?.read !== second.impersonationPermissions?.read ||
    first.impersonationPermissions?.write !== second.impersonationPermissions?.write ||
    JSON.stringify(first.identity) !== JSON.stringify(second.identity) ||
    JSON.stringify(first.delegation) !== JSON.stringify(second.delegation)
  )
    throw unavailable()
}

export function createRequestState<E extends Env>(
  options: RequestAuthorizationOptions<E>,
  routes: Routes,
) {
  const requests = new WeakMap<Context<E>, State>()

  async function load(
    c: Context<E>,
    state: Pick<State, 'authorization' | 'cookie' | 'claim'>,
    organizationId?: string,
  ) {
    try {
      const auth =
        !state.claim && state.cookie && (options.impersonation || !parseBearer(state.authorization))
          ? options.auth(c)
          : undefined
      return await loadCore({
        db: () => options.db(c),
        authorization: state.authorization,
        cookie: auth ? requestSessionCookie(auth, state.cookie ?? null) : undefined,
        hosted: state.claim?.principal,
        organizationId,
        modules: options.modules,
        impersonation: Boolean(options.impersonation),
      })
    } catch {
      throw unavailable()
    }
  }

  /** Memoised per request: the Impersonation hook audits attempts and runs once. */
  async function impersonationPolicy(
    c: Context<E>,
    state: State,
    snapshot: CoreSnapshot,
    mode: Invocation,
    runningGuard?: MiddlewareHandler<E>,
  ) {
    if (state.claim || !options.impersonation) return
    const matched = matchedRoutes(c)
    return admitImpersonation({
      c,
      policy: options.impersonation,
      snapshot,
      routes: terminalRoutes(matched, routes),
      selection: state.initial.selection.id,
      selectionError: state.initial.selection.error,
      hasBearerScheme: /^\s*Bearer\b/i.test(state.authorization ?? ''),
      hasParsedBearer: Boolean(parseBearer(state.authorization)),
      signOut: isNativeSignOut(c),
      nativeMount:
        mode === 'mount' || matched.some((route) => handlerOf(route) === betterAuthMount),
      canDeferModules: () => {
        const index = c.req.routeIndex
        const current = matched[index]
        if (mode !== 'guard' || !current) return false
        const handler = handlerOf(current)
        return (
          handler === runningGuard &&
          routes.guards.has(handler) &&
          hasOrganizationGuardBeforeTerminal(matched, routes, index)
        )
      },
    })
  }

  type Invocation = 'guard' | 'organization' | 'mount' | 'helper'
  function hostedClaim(c: Context<E>, state: State | undefined, mode: Invocation) {
    const claim = state?.claim ?? hostedClaims.get(c.req.raw)
    if (!claim) return
    if (!claim.lifetime.open || claim.policy !== routes) throw AppError.unauthorized()
    if (!state && (claim.claimed || mode === 'helper')) throw AppError.unauthorized()
    claim.claimed = true
    const declaration = inspectHostedRoutes(
      matchedRoutes(c),
      routes,
      claim.app,
      claim.organizationId !== undefined,
    )
    if (
      !declaration ||
      (claim.platformRole && !declaration.platformRole) ||
      claim.headers.some((name) => !declaration.headers.has(name))
    ) {
      throw AppError.forbidden('Hosted operation not declared')
    }
    return claim
  }

  function requestSelection(
    c: Context<E>,
    state: State | undefined,
    claim: HostedClaim | undefined,
    choose?: OrgContextOpts<E>['organizationId'],
  ): Selection {
    const selection = selectOrganization(c, choose)
    if (selection.error) return selection
    const { id } = selection
    if (claim && id !== claim.organizationId && (!state || id !== undefined)) {
      return { error: AppError.forbidden('Organization mismatch') }
    }
    if (state?.selected !== undefined && id !== undefined && id !== state.selected) {
      return { error: AppError.forbidden('Organization mismatch') }
    }
    return selection
  }

  function assertNativeMount(
    state: State,
    identity: CoreSnapshot['identity'],
    delegationMode: DelegationMode,
  ) {
    if (hasKitKeyBearer(state.authorization)) {
      if (!identity) throw AppError.unauthorized()
      throw AppError.forbidden()
    }
    if (state.claim || delegationMode === 'business') throw AppError.forbidden()
  }

  function assertAdmission(
    mode: Invocation,
    state: State,
    first: CoreSnapshot,
    selection: Selection,
    delegationMode: DelegationMode,
  ) {
    const { claim } = state
    if (claim && !claim.lifetime.open) throw AppError.unauthorized()
    if (mode === 'mount') assertNativeMount(state, first.identity, delegationMode)
    if (!first.identity && (mode === 'guard' || mode === 'organization'))
      throw AppError.unauthorized()
    const error = state.initial.selection.error ?? selection.error
    if (first.identity && error) throw error
  }

  function assertBinding(first: CoreSnapshot, selected: string | undefined, mode: DelegationMode) {
    if (selected === undefined) return
    if (first.identity?.method === 'api_key' && selected !== first.identity.organizationId) {
      throw AppError.forbidden('API key is bound to a different organization')
    }
    if (mode === 'business' && first.delegation?.row.organizationId !== selected) {
      throw AppError.forbidden('Organization mismatch')
    }
  }

  function scoped(c: Context<E>, state: State, first: CoreSnapshot, selected: string | undefined) {
    if (!first.identity || selected === undefined || state.initial.selection.id !== undefined)
      return first
    if (state.claim || (state.selected !== undefined && state.selected !== selected)) {
      throw AppError.forbidden('Organization mismatch')
    }
    state.selected = selected
    state.scoped ??= load(c, state, selected).then((second) => {
      assertReproduced(first, second)
      return second
    })
    return state.scoped
  }

  function prepare(c: Context<E>, mode: Invocation, choose?: OrgContextOpts<E>['organizationId']) {
    const authorization = c.req.header('authorization')
    const cookie = c.req.header('cookie')
    let state = requests.get(c)
    const claim = hostedClaim(c, state, mode)
    if (state && (state.authorization !== authorization || state.cookie !== cookie))
      throw unavailable()
    const selection = requestSelection(c, state, claim, choose)
    if (!state) {
      const credentials = { authorization, cookie, claim }
      state = {
        ...credentials,
        selected: selection.id,
        view: EMPTY_VIEW,
        initial: { selection, promise: load(c, credentials, selection.id) },
      }
      requests.set(c, state)
    }
    return { state, claim, selection }
  }

  type Authentication = Readonly<{
    mode: Invocation
    choose?: OrgContextOpts<E>['organizationId']
    runningGuard?: MiddlewareHandler<E>
    /** A session-only check judges no key scope: a key is refused or answered null as a non-session. */
    sessionOnly?: true
  }>

  // Per invocation, not memoised with the Impersonation hook: a session-only call skips no guard.
  function admitKeyRoute(c: Context<E>, first: CoreSnapshot, request: Authentication) {
    if (request.mode === 'mount' || request.sessionOnly || first.identity?.method !== 'api_key')
      return
    admitKeyScope(options.keyScope, terminalRoutes(matchedRoutes(c), routes), first.identity.scopes)
  }

  async function authenticate(c: Context<E>, request: Authentication): Promise<Stage> {
    const { mode, choose, runningGuard } = request
    const { state, claim, selection } = prepare(c, mode, choose)
    const first = await state.initial.promise
    state.policy ??= impersonationPolicy(c, state, first, mode, runningGuard)
    const decision = await state.policy
    admitKeyRoute(c, first, request)
    const delegationMode = typeof decision === 'function' ? 'business' : decision
    assertAdmission(mode, state, first, selection, delegationMode)
    const selected = selection.id ?? state.selected
    assertBinding(first, selected, delegationMode)
    const pending = typeof decision === 'function' && mode !== 'organization' && !state.deferred
    const snapshot = pending ? first : await scoped(c, state, first, selected)
    if (typeof decision === 'function' && mode === 'organization')
      state.deferred ??= decision(snapshot, selected)
    if (state.deferred) await state.deferred
    const platformRole =
      delegationMode || (claim && !claim.platformRole) ? undefined : snapshot.platformRole
    return { state, snapshot, selection: selected, delegationMode, platformRole, pending }
  }

  const betterAuthMount: MiddlewareHandler<E> = async (c, next) => {
    if (
      options.impersonation ||
      hostedClaims.has(c.req.raw) ||
      hasKitKeyBearer(c.req.header('authorization'))
    )
      await authenticate(c, { mode: 'mount' })
    await next()
  }

  function view(c: Context<E>): AdmittedView {
    return requests.get(c)?.view ?? EMPTY_VIEW
  }

  return { authenticate, betterAuthMount, view }
}
