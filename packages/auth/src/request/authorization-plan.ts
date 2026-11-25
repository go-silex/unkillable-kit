import { AppError } from '@kit/core'
import type { Context, Env, MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'
import type { AuthorizationFact, AuthorizationProjection } from '../snapshot/facts'

export type ModuleAuthorizationFacts = Readonly<{
  availability: AuthorizationFact<unknown>
  grant: AuthorizationFact<unknown>
  delegatedGrant?: AuthorizationFact<unknown>
}>

export type AuthorizationUse = Readonly<{
  org?: true
  allEndpoint?: true
  sessionOnly?: true
  module?: string
  authority?: AuthorizationProjection
  facts?: readonly AuthorizationFact<unknown>[]
}>

type OrganizationSelection =
  | { kind: 'selected'; id: string }
  | { kind: 'missing' | 'conflict' | 'unused' }

export type AuthorizationPlan<E extends Env> = Readonly<{
  selection: OrganizationSelection
  end: number
  sessionOnly: boolean
  pending: Set<MiddlewareHandler<E>>
  authority?: Readonly<{
    index: number
    guard: MiddlewareHandler<E>
    projection: AuthorizationProjection
    pending: Map<number, MiddlewareHandler<E>>
  }>
  facts: ReadonlySet<AuthorizationFact<unknown>>
  modules: ReadonlyMap<string, ModuleAuthorizationFacts>
}>

type Match = ReturnType<typeof matchedRoutes>[number]
type RouteWindow = Readonly<{ endpoint: string | undefined; end: number }>

export function authUnavailable() {
  return new AppError('INTERNAL_ERROR', 'Authorization unavailable', 503)
}

function selectedMethod(method: string, routes: readonly Match[]) {
  return method === 'HEAD' && !routes.some((route) => route.method === 'HEAD') ? 'GET' : method
}

function dispatchWindow<E extends Env>(
  c: Context<E>,
  routes: readonly Match[],
  uses: WeakMap<MiddlewareHandler<E>, AuthorizationUse>,
): RouteWindow {
  const method = selectedMethod(c.req.method, routes)
  let endpoint: string | undefined
  for (const [index, route] of routes.entries()) {
    // Hono uses ALL for both .use and .all; only an explicit endpoint
    // declaration can tell those registrations apart.
    const allEndpoint =
      route.method === 'ALL' && uses.get(route.handler as MiddlewareHandler<E>)?.allEndpoint
    if (route.method !== method && !allEndpoint) continue
    if (endpoint === undefined) {
      endpoint = route.path
    } else if (endpoint !== route.path) {
      // A literal registered endpoint may precede a parameter fallback.
      // Competing parameter patterns are ambiguous.
      if (endpoint !== c.req.path) throw authUnavailable()
      return { endpoint, end: index }
    }
  }
  return { endpoint, end: routes.length }
}

function readSelection<E extends Env>(
  c: Context<E>,
  routes: readonly Match[],
  { endpoint, end }: RouteWindow,
): OrganizationSelection {
  const originalIndex = c.req.routeIndex
  let pathOrgId: string | undefined
  try {
    for (let index = 0; index < end; index++) {
      const route = routes[index]
      if (!endpoint || route?.path !== endpoint) continue
      c.req.routeIndex = index
      const id = c.req.param('orgId')?.trim()
      if (!id) continue
      if (pathOrgId && pathOrgId !== id) return { kind: 'conflict' }
      pathOrgId = id
    }
  } finally {
    c.req.routeIndex = originalIndex
  }
  const headerId = c.req.header('x-org-id')?.trim()
  if (pathOrgId && headerId && pathOrgId !== headerId) return { kind: 'conflict' }
  const orgId = pathOrgId ?? headerId
  return orgId ? { kind: 'selected', id: orgId } : { kind: 'missing' }
}

export function organizationSelection<E extends Env>(
  c: Context<E>,
  uses: WeakMap<MiddlewareHandler<E>, AuthorizationUse>,
): OrganizationSelection {
  const routes = matchedRoutes(c)
  return readSelection(c, routes, dispatchWindow(c, routes, uses))
}

function includeModule(
  modules: Map<string, ModuleAuthorizationFacts>,
  moduleId: string | undefined,
  moduleFacts: ((moduleId: string) => ModuleAuthorizationFacts | undefined) | undefined,
) {
  if (!moduleId || modules.has(moduleId)) return
  const policy = moduleFacts?.(moduleId)
  if (policy) modules.set(moduleId, policy)
}

function authorityIndices<E extends Env>(
  routes: readonly Match[],
  window: RouteWindow,
  index: number,
  method: string,
  uses: WeakMap<MiddlewareHandler<E>, AuthorizationUse>,
  module: string | undefined,
) {
  const route = routes[index]!
  // `ALL` also denotes .use in Hono, so only a concrete endpoint registration is unambiguous.
  if (route.method !== method || route.path !== window.endpoint) throw authUnavailable()
  const hasHandler = routes.some(
    (candidate, following) =>
      following > index &&
      following < window.end &&
      candidate.method === method &&
      candidate.path === window.endpoint,
  )
  if (!hasHandler) throw authUnavailable()
  const indices = new Map<number, MiddlewareHandler<E>>()
  for (let prior = 0; prior < index; prior++) {
    const handler = routes[prior]!.handler as MiddlewareHandler<E>
    const use = uses.get(handler)
    if (!use) continue
    if (use.authority || use.module === module) throw authUnavailable()
    indices.set(prior, handler)
  }
  indices.set(index, route.handler as MiddlewareHandler<E>)
  return indices
}

export function planAuthorization<E extends Env>(
  c: Context<E>,
  uses: WeakMap<MiddlewareHandler<E>, AuthorizationUse>,
  moduleFacts: ((moduleId: string) => ModuleAuthorizationFacts | undefined) | undefined,
): AuthorizationPlan<E> {
  const routes = matchedRoutes(c)
  const window = dispatchWindow(c, routes, uses)
  const pending = new Set<MiddlewareHandler<E>>()
  const facts = new Set<AuthorizationFact<unknown>>()
  const modules = new Map<string, ModuleAuthorizationFacts>()
  let org = false
  let sessionOnly = false
  let authority: AuthorizationPlan<E>['authority']
  let lastGuard = -1
  for (let index = 0; index < window.end; index++) {
    const route = routes[index]!
    const handler = route.handler as MiddlewareHandler<E>
    const use = uses.get(handler)
    if (!use) continue
    lastGuard = index
    if (use.authority) {
      const method = selectedMethod(c.req.method, routes)
      const indices = authorityIndices(routes, window, index, method, uses, use.module)
      authority = { index, guard: handler, projection: use.authority, pending: indices }
    }
    pending.add(handler)
    org ||= use.org === true
    sessionOnly ||= use.sessionOnly === true
    for (const fact of use.facts ?? []) facts.add(fact)
    includeModule(modules, use.module, moduleFacts)
  }
  if (org && !window.endpoint) throw authUnavailable()
  if (authority && authority.index !== lastGuard) throw authUnavailable()
  return {
    selection: org ? readSelection(c, routes, window) : { kind: 'unused' },
    end: window.end,
    sessionOnly,
    pending,
    authority,
    facts,
    modules,
  }
}

export function selectedOrganization(plan: Pick<AuthorizationPlan<Env>, 'selection'>): string {
  const selection = plan.selection
  if (selection.kind === 'conflict') throw AppError.forbidden('organization id mismatch')
  if (selection.kind !== 'selected') {
    throw AppError.validation('organization id required (path or X-Org-Id)')
  }
  return selection.id
}
