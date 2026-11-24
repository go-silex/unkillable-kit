import { type ApiKeyScope, parseBearer } from '@kit/auth'
import { AppError } from '@kit/core'
import type { MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'
import { admitKeyScope, authenticateKey } from './auth'
import type { AppEnv } from './types'

// A key may reach only explicitly declared method/path pairs.
const keyScopeRoutes: ReadonlyArray<{ method: string; path: string; scope: ApiKeyScope }> = [
  { method: 'GET', path: '/api/me', scope: 'read' },
  { method: 'GET', path: '/api/orgs/:orgId/members', scope: 'read' },
]

export const keyScopeGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!parseBearer(c.req.header('authorization'))) return next()
  const { scopes } = await authenticateKey(c)
  const routes = matchedRoutes(c).filter((route) => route.method === c.req.method)
  if (
    !routes.length ||
    routes.some((route) => {
      const declaration = keyScopeRoutes.find(
        (entry) => entry.method === route.method && entry.path === route.path,
      )
      return !(declaration && scopes.includes(declaration.scope))
    })
  ) {
    throw AppError.forbidden()
  }
  admitKeyScope(c)
  await next()
}
