import { type ApiKeyScope, parseBearer } from '@kit/auth'
import { AppError } from '@kit/core'
import type { MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'
import type { AppEnv } from '../types'
import { requireAuth } from './require-auth'

// An exact method and path declaration is required before a key can reach a handler.
export const keyScopeRoutes: ReadonlyArray<{ method: string; path: string; scope: ApiKeyScope }> = [
  { method: 'GET', path: '/api/me', scope: 'read' },
  { method: 'GET', path: '/api/keys', scope: 'read' },
  { method: 'GET', path: '/api/orgs', scope: 'read' },
  { method: 'GET', path: '/api/orgs/:orgId', scope: 'read' },
  { method: 'GET', path: '/api/orgs/:orgId/members', scope: 'read' },
  { method: 'GET', path: '/api/orgs/:orgId/invitations', scope: 'read' },
  { method: 'GET', path: '/api/orgs/:orgId/modules', scope: 'read' },
  { method: 'GET', path: '/api/orgs/:orgId/roles', scope: 'read' },
  { method: 'PATCH', path: '/api/orgs/:orgId/modules/:moduleId', scope: 'admin' },
  { method: 'GET', path: '/api/tasks', scope: 'read' },
  { method: 'GET', path: '/api/tasks/stages', scope: 'read' },
  { method: 'GET', path: '/api/tasks/:id', scope: 'read' },
  { method: 'POST', path: '/api/tasks', scope: 'write' },
  { method: 'PATCH', path: '/api/tasks/:id', scope: 'write' },
  { method: 'DELETE', path: '/api/tasks/:id', scope: 'write' },
  { method: 'GET', path: '/api/notes', scope: 'read' },
  { method: 'GET', path: '/api/notes/:id', scope: 'read' },
  { method: 'POST', path: '/api/notes', scope: 'write' },
  { method: 'DELETE', path: '/api/notes/:id', scope: 'write' },
  { method: 'GET', path: '/api/items', scope: 'read' },
  { method: 'GET', path: '/api/items/:id', scope: 'read' },
  { method: 'POST', path: '/api/items', scope: 'write' },
  { method: 'PATCH', path: '/api/items/:id', scope: 'write' },
  { method: 'DELETE', path: '/api/items/:id', scope: 'write' },
]

export const keyScopeGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!parseBearer(c.req.header('authorization'))) return next()
  await requireAuth(c, async () => {
    const routes = matchedRoutes(c).filter((route) => route.method === c.req.method)
    if (
      !routes.length ||
      routes.some((route) => {
        const declaration = keyScopeRoutes.find(
          (entry) => entry.method === route.method && entry.path === route.path,
        )
        if (!declaration) return true
        return !c.get('keyScopes')?.includes(declaration.scope)
      })
    )
      throw AppError.forbidden()
    await next()
  })
}
