import { AppError } from '@kit/core'
import type { Context, Env, MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'
import { BA_BASE_PATH } from '../better-auth-base-path'
import { parseBearer } from '../keys'
import type { PlatformRole } from '../org-roles'
import { type CoreSnapshot, loadCore } from '../snapshot/core-load'
import { isIdentifier, unavailable } from '../snapshot/core-rows'
import { requestSessionCookie } from './effective-session-cookie'
import {
  type HostedClaim,
  handlerOf,
  hostedClaims,
  inspectHostedRoutes,
  type Routes,
  terminalRoutes,
} from './hosted-routes'
import { organizationHeader } from './organization-selection'
import type { RequestAuthorizationOptions } from './request-authorization'
import { admitImpersonation, admitKeyScope, type OrgContextOpts } from './request-policy'
import { type AdmittedView, EMPTY_VIEW } from './request-projection'

type Selection = { id?: string; error?: AppError }
type DelegationMode = 'recovery' | 'business' | undefined
type State = {
  claim?: HostedClaim
  authorization?: string
  cookie?: string
  selected?: string
  initial: { selection: Selection; promise: Promise<CoreSnapshot> }
  scoped?: Promise<CoreSnapshot>
  policy?: Promise<DelegationMode>
  view: AdmittedView
}

export type Stage = {
  state: State
  snapshot: CoreSnapshot
  selection: string | undefined
  delegationMode: DelegationMode
  platformRole: PlatformRole | null | undefined
}

function isNativeSignOut<E extends Env>(c: Context<E>): boolean {
  return c.req.method === 'POST' && new URL(c.req.url).pathname === `${BA_BASE_PATH}/sign-out`
}

function select<E extends Env>(
  c: Context<E>,
  choose?: OrgContextOpts<E>['organizationId'],
): Selection {
  let header: string | undefined
  try {
    header = organizationHeader(c.req.raw.headers)
  } catch (error) {
    return { error: error instanceof AppError ? error : unavailable() }
  }
  const path = c.req.param('orgId')
  if (path !== undefined && !isIdentifier(path))
    return { error: AppError.validation('Invalid organization id') }
  if (path !== undefined && header !== undefined && path !== header) {
    return { error: AppError.forbidden('Organization mismatch') }
  }
  const supplied = path ?? header
  if (!choose) return { id: supplied }
  let chosen: unknown
  try {
    chosen = choose(c)
  } catch {
    return { error: unavailable() }
  }
  if (!isIdentifier(chosen)) return { error: AppError.validation('Invalid organization id') }
  return supplied !== undefined && supplied !== chosen
    ? { error: AppError.forbidden('Organization mismatch') }
    : { id: chosen }
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

  async function policies(c: Context<E>, state: State, snapshot: CoreSnapshot, mount: boolean) {
    if (state.claim) return
    const matched =
      options.impersonation || snapshot.identity?.method === 'api_key' ? matchedRoutes(c) : []
    const mode = options.impersonation
      ? await admitImpersonation({
          c,
          policy: options.impersonation,
          snapshot,
          routes: terminalRoutes(matched, routes),
          selection: state.initial.selection.id,
          selectionError: state.initial.selection.error,
          hasBearerScheme: /^\s*Bearer\b/i.test(state.authorization ?? ''),
          hasParsedBearer: Boolean(parseBearer(state.authorization)),
          signOut: isNativeSignOut(c),
          nativeMount: mount || matched.some((route) => handlerOf(route) === betterAuthMount),
        })
      : undefined
    if (!mount && snapshot.identity?.method === 'api_key')
      admitKeyScope(options.keyScope, terminalRoutes(matched, routes), snapshot.identity.scopes)
    return mode
  }

  type Invocation = 'guard' | 'mount' | 'helper'
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
    if (!declaration || (claim.platformRole && !declaration.platformRole)) {
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
    const selection = select(c, choose)
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
    if (parseBearer(state.authorization)) {
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
    if (!first.identity && mode === 'guard') throw AppError.unauthorized()
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

  async function authenticate(
    c: Context<E>,
    mode: Invocation,
    choose?: OrgContextOpts<E>['organizationId'],
  ): Promise<Stage> {
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
    const first = await state.initial.promise
    state.policy ??= policies(c, state, first, mode === 'mount')
    const delegationMode = await state.policy
    assertAdmission(mode, state, first, selection, delegationMode)
    const selected = selection.id ?? state.selected
    assertBinding(first, selected, delegationMode)
    const snapshot = await scoped(c, state, first, selected)
    const platformRole =
      delegationMode || (claim && !claim.platformRole) ? undefined : snapshot.platformRole
    return { state, snapshot, selection: selected, delegationMode, platformRole }
  }

  const betterAuthMount: MiddlewareHandler<E> = async (c, next) => {
    if (
      options.impersonation ||
      hostedClaims.has(c.req.raw) ||
      parseBearer(c.req.header('authorization'))
    )
      await authenticate(c, 'mount')
    await next()
  }

  function view(c: Context<E>): AdmittedView {
    return requests.get(c)?.view ?? EMPTY_VIEW
  }

  return { authenticate, betterAuthMount, view }
}
