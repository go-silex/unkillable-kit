import { AppError } from '@kit/core'
import type { Context, Env, MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'
import type { AuthorizationFact } from '../snapshot/facts'

export type ModuleAuthorizationFacts = Readonly<{
  availability: AuthorizationFact<unknown>
  grant: AuthorizationFact<unknown>
  delegatedGrant?: AuthorizationFact<unknown>
}>

export type AuthorizationUse = Readonly<{
  org?: true
  module?: string
  facts?: readonly AuthorizationFact<unknown>[]
}>

type OrganizationSelection =
  | { kind: 'selected'; id: string }
  | { kind: 'missing' | 'conflict' | 'unused' }

export type AuthorizationPlan<E extends Env> = Readonly<{
  selection: OrganizationSelection
  pending: Set<MiddlewareHandler<E>>
  facts: ReadonlySet<AuthorizationFact<unknown>>
  modules: ReadonlyMap<string, ModuleAuthorizationFacts>
}>

export function organizationSelection<E extends Env>(c: Context<E>): OrganizationSelection {
  const routes = matchedRoutes(c)
  const originalIndex = c.req.routeIndex
  let pathOrgId: string | undefined
  try {
    for (const [index, route] of routes.entries()) {
      if (route.method !== c.req.method && !(c.req.method === 'HEAD' && route.method === 'GET'))
        continue
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

export function planAuthorization<E extends Env>(
  c: Context<E>,
  uses: WeakMap<MiddlewareHandler<E>, AuthorizationUse>,
  moduleFacts: ((moduleId: string) => ModuleAuthorizationFacts | undefined) | undefined,
): AuthorizationPlan<E> {
  const pending = new Set<MiddlewareHandler<E>>()
  const facts = new Set<AuthorizationFact<unknown>>()
  const modules = new Map<string, ModuleAuthorizationFacts>()
  let org = false
  for (const route of matchedRoutes(c)) {
    const handler = route.handler as MiddlewareHandler<E>
    const use = uses.get(handler)
    if (!use) continue
    pending.add(handler)
    if (use.org) org = true
    for (const fact of use.facts ?? []) facts.add(fact)
    if (!use.module || modules.has(use.module)) continue
    const policy = moduleFacts?.(use.module)
    if (policy) modules.set(use.module, policy)
  }
  return { selection: org ? organizationSelection(c) : { kind: 'unused' }, pending, facts, modules }
}

export function selectedOrganization(plan: Pick<AuthorizationPlan<Env>, 'selection'>): string {
  const selection = plan.selection
  if (selection.kind === 'conflict') throw AppError.forbidden('organization id mismatch')
  if (selection.kind !== 'selected') {
    throw AppError.validation('organization id required (path or X-Org-Id)')
  }
  return selection.id
}
