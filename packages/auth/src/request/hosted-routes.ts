import type { RouterRoute } from 'hono/types'
import type { HostedPrincipal } from '../snapshot/hosted-principal'

export type Route = Readonly<{ method: string; path: string }>
// Registered middleware is compared by reference, never invoked by Kit.
export type MiddlewareIdentity = (...args: never[]) => unknown

export type Routes = Readonly<{
  guards: WeakMap<RouterRoute['handler'], 'identity' | 'organization'>
  middleware: WeakSet<MiddlewareIdentity>
  declared: WeakMap<RouterRoute, Readonly<{ app: object; platformRole: boolean }>>
}>

export const hostedRoutes = new WeakMap<object, Routes>()

export function handlerOf(route: RouterRoute): RouterRoute['handler'] {
  type Composed = RouterRoute['handler'] & { __COMPOSED_HANDLER?: Composed }
  let handler: Composed = route.handler
  while (handler.__COMPOSED_HANDLER) handler = handler.__COMPOSED_HANDLER
  return handler
}

export function terminalRoutes(routes: readonly RouterRoute[], policy: Routes): RouterRoute[] {
  return routes.filter((route) => {
    const handler = handlerOf(route)
    return !(policy.guards.has(handler) || policy.middleware.has(handler))
  })
}

export function inspectHostedRoutes(
  routes: readonly RouterRoute[],
  policy: Routes,
  app: object,
  orgBound: boolean,
) {
  const relevant = routes.filter((route) => !policy.middleware.has(handlerOf(route)))
  const first = relevant[0]
  if (!(first && policy.guards.has(handlerOf(first)))) return null
  let terminals = 0
  let orgGuard = !orgBound
  let platformRole = true
  for (const route of relevant) {
    const guard = policy.guards.get(handlerOf(route))
    if (guard === 'organization') orgGuard = true
    if (guard) continue
    const declaration = policy.declared.get(route)
    if (!orgGuard || declaration?.app !== app) return null
    if (!declaration.platformRole) platformRole = false
    terminals++
  }
  return terminals ? { platformRole } : null
}

export type HostedClaim = {
  readonly policy: Routes
  readonly app: object
  readonly lifetime: { open: boolean }
  readonly principal: HostedPrincipal
  readonly organizationId: string | undefined
  readonly platformRole: boolean
  claimed: boolean
}

// Only the hosted dispatch module attaches association; a header or Context value cannot claim it.
export const hostedClaims = new WeakMap<Request, HostedClaim>()
