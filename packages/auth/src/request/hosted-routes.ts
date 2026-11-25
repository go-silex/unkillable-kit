import type { RouterRoute } from 'hono/types'
import type { HostedPrincipal } from '../snapshot/hosted-principal'

export type Route = Readonly<{ method: string; path: string }>

type HostedDeclaration = Readonly<{
  app: object
  platformRole: boolean
  headers: ReadonlySet<string>
}>

export type Routes = Readonly<{
  guards: WeakMap<RouterRoute['handler'], 'identity' | 'organization'>
  middleware: WeakSet<RouterRoute>
  declared: WeakMap<RouterRoute, HostedDeclaration>
}>

// Credentials, selection, framing, hop-by-hop and client-address headers stay Kit- or runtime-owned.
const RESERVED_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'expect',
  'forwarded',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'true-client-ip',
  'upgrade',
  'x-org-id',
  'x-real-ip',
  'x-request-id',
])
const RESERVED_PREFIXES = ['cf-', 'proxy-', 'sec-', 'x-forwarded-']
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u

/** Validates one header name an App declares for a hosted operation; returns its lowercase form. */
export function declaredHeaderName(name: unknown): string {
  if (typeof name !== 'string' || !TOKEN.test(name)) {
    throw new TypeError('Hosted header names must be HTTP field names')
  }
  const lower = name.toLowerCase()
  if (RESERVED_HEADERS.has(lower) || RESERVED_PREFIXES.some((prefix) => lower.startsWith(prefix)))
    throw new TypeError(`Hosted operations cannot declare the reserved header ${name}`)
  return lower
}

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
  let orgGuard = !orgBound
  const declarations: HostedDeclaration[] = []
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
    declarations.push(declaration)
  }
  const [first, ...rest] = declarations
  if (!first) return null
  return {
    platformRole: declarations.every((declaration) => declaration.platformRole),
    // Every terminal registration Hono matched must accept a header the dispatch carries.
    headers: new Set(
      [...first.headers].filter((name) =>
        rest.every((declaration) => declaration.headers.has(name)),
      ),
    ),
  }
}

export type HostedClaim = {
  readonly policy: Routes
  readonly app: object
  readonly lifetime: { open: boolean }
  readonly principal: HostedPrincipal
  readonly organizationId: string | undefined
  readonly platformRole: boolean
  readonly headers: readonly string[]
  claimed: boolean
}

// Only the hosted dispatch module attaches association; a header or Context value cannot claim it.
export const hostedClaims = new WeakMap<Request, HostedClaim>()
