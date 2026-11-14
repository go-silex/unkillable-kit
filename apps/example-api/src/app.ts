import { OpenAPIHono } from '@hono/zod-openapi'
import { applySecurityHeaders, originGuard, securityHeaders } from '@kit/auth/hono'
import { AppError, toApiErrorBody } from '@kit/core'
import { cors } from 'hono/cors'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { defaultHook, securitySchemes } from './lib/openapi'
import { corsAllowlist } from './lib/session-env'
import { withBetterAuth } from './middleware/better-auth'
import { withDb } from './middleware/db'
import { onError } from './middleware/error-handler'
import { impersonationGate } from './middleware/impersonation'
import { keyScopeGate } from './middleware/key-scopes'
import { requestIdMiddleware } from './middleware/request-id'
import { adminAuditRoutes } from './routes/admin-audit'
import { adminUsersRoutes } from './routes/admin-users'
import { authRoutes } from './routes/auth'
import { demoRoutes } from './routes/demo'
import { flowsRoutes } from './routes/flows'
import { healthRoutes } from './routes/health'
import { impersonationRoutes } from './routes/impersonation'
import { invitationsRoutes } from './routes/invitations'
import { itemsRoutes } from './routes/items'
import { jobsRoutes } from './routes/jobs'
import { mcpIdentityRoutes } from './routes/mcp-identity'
import { meRoutes } from './routes/me'
import { modulesRoutes } from './routes/modules'
import { notesRoutes } from './routes/notes'
import { notificationsAdminRoutes } from './routes/notifications/admin'
import { notificationsInboxRoutes } from './routes/notifications/inbox'
import { notificationsUserRoutes } from './routes/notifications/user'
import { orgsRoutes } from './routes/orgs'
import { tasksRoutes } from './routes/tasks'
import { uploadsRoutes } from './routes/uploads'
import type { AppEnv } from './types'

export type { AppEnv }

/** Factory used by Worker entry and unit tests (same shipped app). */
export function createApp() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })

  app.use('*', requestIdMiddleware)
  app.use('*', securityHeaders)
  app.use(
    '*',
    cors({
      origin: (origin, c) => {
        const list = corsAllowlist(c.env)
        if (!origin) return list[0]
        return list.includes(origin) ? origin : null
      },
      credentials: true,
      allowHeaders: [
        'Content-Type',
        'Authorization',
        'x-request-id',
        'X-Org-Id',
        'X-Impersonation-Id',
      ],
      // SPA must be able to read Retry-After on 429 (credentials + expose).
      exposeHeaders: ['x-request-id', 'Retry-After'],
    }),
  )
  app.use('*', originGuard)
  app.use('*', withDb)
  app.use('*', withBetterAuth)
  app.use('*', keyScopeGate)
  app.use('*', impersonationGate)
  app.onError((err, c) => onError(err, c))
  app.notFound((c) => {
    const requestId = c.get('requestId') || 'req_unknown'
    const { body, status } = toApiErrorBody(AppError.notFound(), requestId)
    applySecurityHeaders(c)
    return c.json(body, status as ContentfulStatusCode)
  })

  // routes → services → repos (secondary axis)
  app.route('/', healthRoutes)
  app.route('/', authRoutes)
  app.route('/', notificationsUserRoutes)
  app.route('/', notificationsInboxRoutes)
  app.route('/', notificationsAdminRoutes)
  app.route('/', adminUsersRoutes)
  app.route('/', adminAuditRoutes)
  app.route('/', impersonationRoutes)
  app.route('/', meRoutes)
  app.route('/', mcpIdentityRoutes)
  app.route('/', modulesRoutes)
  app.route('/', orgsRoutes)
  app.route('/', invitationsRoutes)
  app.route('/', notesRoutes)
  app.route('/', itemsRoutes)
  app.route('/', tasksRoutes)
  app.route('/', flowsRoutes)
  app.route('/', uploadsRoutes)
  app.route('/', jobsRoutes)
  app.route('/', demoRoutes)

  app.openAPIRegistry.registerComponent('securitySchemes', 'session', securitySchemes.session)
  app.openAPIRegistry.registerComponent('securitySchemes', 'apiKey', securitySchemes.apiKey)

  return app
}
