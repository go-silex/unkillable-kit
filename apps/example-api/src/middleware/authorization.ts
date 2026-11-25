import type { ApiKeyScope } from '@kit/auth'
import {
  createRequestAuthorization,
  originGuard,
  type RequestAuthorization,
  securityHeaders,
} from '@kit/auth/hono'
import { recordImpersonationRequest } from '@kit/auth/repos/impersonation'
import { COMMENTS_MODULE_ID } from '@kit/comments'
import { TASKS_MODULE_ID } from '@kit/tasks'
import { requireBaAdapter } from '../lib/require-ba-adapter'
import type { AppEnv } from '../types'
import { withBetterAuth } from './better-auth'
import { corsMiddleware } from './cors'
import { withDb } from './db'
import { requestIdMiddleware } from './request-id'

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
  { method: 'GET', path: '/api/tasks/links', scope: 'read' },
  { method: 'POST', path: '/api/tasks/links', scope: 'write' },
  { method: 'DELETE', path: '/api/tasks/comments/:commentId', scope: 'write' },
  { method: 'GET', path: '/api/tasks/:id/comments', scope: 'read' },
  { method: 'POST', path: '/api/tasks/:id/comments', scope: 'write' },
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
  { method: 'POST', path: '/api/uploads/presign', scope: 'write' },
  { method: 'POST', path: '/api/uploads/:uploadId/complete', scope: 'write' },
  { method: 'POST', path: '/api/jobs/ping', scope: 'write' },
  { method: 'POST', path: '/api/demo/email', scope: 'write' },
]

// Only these terminal operations may run under delegation. Treat every matched
// registration as reachable, even when today's first handler does not fall through.
const taskModules = [TASKS_MODULE_ID]
const commentModules = [TASKS_MODULE_ID, COMMENTS_MODULE_ID]
const delegatedRoutes: Readonly<Partial<Record<string, readonly string[]>>> = {
  'GET /api/modules': [],
  'GET /api/orgs/:orgId/modules': [],
  'GET /api/tasks': taskModules,
  'POST /api/tasks': taskModules,
  'GET /api/tasks/stages': taskModules,
  'GET /api/tasks/links': taskModules,
  'POST /api/tasks/links': taskModules,
  'GET /api/tasks/:id': taskModules,
  'PATCH /api/tasks/:id': taskModules,
  'DELETE /api/tasks/:id': taskModules,
  'GET /api/tasks/:id/comments': commentModules,
  'POST /api/tasks/:id/comments': commentModules,
  'DELETE /api/tasks/comments/:commentId': commentModules,
}

const specialDelegationRoutes: Readonly<
  Partial<Record<string, { kind: 'recovery' | 'conflict'; method: string; pattern: string }>>
> = {
  'GET /api/me': { kind: 'recovery', method: 'GET', pattern: '/api/me' },
  'POST /api/impersonation/stop': {
    kind: 'recovery',
    method: 'POST',
    pattern: '/api/impersonation/stop',
  },
  'POST /api/auth/sign-out': { kind: 'recovery', method: 'ALL', pattern: '/api/auth/*' },
  'POST /api/impersonation/start': {
    kind: 'conflict',
    method: 'POST',
    pattern: '/api/impersonation/start',
  },
}

export const authorization: RequestAuthorization<AppEnv> = createRequestAuthorization<AppEnv>({
  db: (c) => c.env.DB,
  auth: (c) => c.get('betterAuth'),
  modules: true,
  middleware: [
    requestIdMiddleware,
    securityHeaders,
    corsMiddleware,
    originGuard,
    withDb,
    withBetterAuth,
    requireBaAdapter,
  ],
  keyScope: ({ method, path }, scopes) =>
    keyScopeRoutes.some(
      (entry) => entry.method === method && entry.path === path && scopes.includes(entry.scope),
    ),
  impersonation: {
    operation({ method, path, routes }) {
      if (!routes.length) return null
      const special = specialDelegationRoutes[`${method} ${path}`]
      if (special) {
        return routes.every(
          (route) => route.method === special.method && route.path === special.pattern,
        )
          ? { kind: special.kind }
          : null
      }
      const modules = new Set<string>()
      for (const route of routes) {
        const required = delegatedRoutes[`${route.method} ${route.path}`]
        if (route.method !== method || !required) return null
        for (const id of required) modules.add(id)
      }
      return { kind: 'business', modules: [...modules], op: method === 'GET' ? 'read' : 'write' }
    },
    fence: (c) => c.req.header('x-impersonation-id'),
    audit: (c, { row, method, path }) =>
      recordImpersonationRequest(c.get('db')!, row, {
        requestId: c.get('requestId'),
        method,
        path,
        ip: c.req.header('cf-connecting-ip'),
      }),
  },
})
