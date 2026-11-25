import type { RouterRoute } from 'hono/types'
import type { HostedPrincipal } from '../snapshot/hosted-principal'

export type Route = Readonly<{ method: string; path: string }>

export type Routes = Readonly<{
  guards: WeakMap<RouterRoute['handler'], 'identity' | 'organization'>
  middleware: WeakSet<RouterRoute>
  declared: WeakMap<RouterRoute, Readonly<{ app: object; platformRole: boolean }>>
}>

export const hostedRoutes = new WeakMap<object, Routes>()

export function handlerOf(route: RouterRoute): RouterRoute['handler'] {
  type Composed = RouterRoute['handler'] & { __COMPOSED_HANDLER?: Composed }
  let handler: Composed = route.handler
  while (handler.__COMPOSED_HANDLER) handler = handler.__COMPOSED_HANDLER
  return handler
}

/** Only identified middleware preceding the first Kit guard is exempt. */
export function terminalRoutes(routes: readonly RouterRoute[], policy: Routes): RouterRoute[] {
  let guarded = false
  return routes.filter((route) => {
    const handler = handlerOf(route)
    if (policy.guards.has(handler)) {
      guarded = true
      return false
    }
    return guarded || !policy.middleware.has(route)
  })
}

export function hasOrganizationGuardBeforeTerminal(
  routes: readonly RouterRoute[],
  policy: Routes,
  routeIndex: number,
): boolean {
  for (let i = routeIndex + 1; i < routes.length; i++) {
    const guard = policy.guards.get(handlerOf(routes[i]!))
    if (!guard) return false
    if (guard === 'organization') return true
  }
  return false
}

export function inspectHostedRoutes(
  routes: readonly RouterRoute[],
  policy: Routes,
  app: object,
  orgBound: boolean,
) {
  const start = routes.findIndex((route) => !policy.middleware.has(route))
  if (start === -1 || !policy.guards.has(handlerOf(routes[start]!))) return null
  let terminals = 0
  let orgGuard = !orgBound
  let platformRole = true
  for (let i = start; i < routes.length; i++) {
    const route = routes[i]!
    const handler = handlerOf(route)
    const guard = policy.guards.get(handler)
    if (guard) {
      if (guard === 'organization') orgGuard = true
      continue
    }
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
