import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import { AppError } from '@kit/core'
import { countUnread, hasInboxNotification, listInbox, markRead } from '@kit/notifications/repos'
import type { MiddlewareHandler } from 'hono'
import {
  authErrorResponses,
  errorResponse,
  invalidRequest,
  notFoundErrorResponse,
  sessionOnlySecurity,
  validationErrorResponse,
} from '../../lib/openapi'
import { notificationLocale } from '../../messages'
import { requireOrgContext } from '../../middleware/org-context'
import { requireAuth } from '../../middleware/require-auth'
import { requireSession } from '../../middleware/require-session'
import {
  includeNotificationAccess,
  loadNotificationScope,
} from '../../services/notifications/access'
import { renderInboxRow } from '../../services/notifications/inbox'
import type { AppEnv } from '../../types'
import {
  inboxIdParamsSchema,
  inboxQuerySchema,
  readAllResponseSchema,
  unreadCountResponseSchema,
} from './inbox.schemas'
import {
  emptyBodySchema,
  emptyQuerySchema,
  inboxDtoSchema,
  okResponseSchema,
  orgParamsSchema,
  pageResponseSchema,
} from './shared.schemas'

const base = '/api/orgs/{orgId}/notifications'
const localeHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.header('Content-Language', notificationLocale(c.req.header('Accept-Language')))
  c.header('Cache-Control', 'private, no-store')
  c.header('Vary', 'Accept-Language', { append: true })
  await next()
}
const strictInput: MiddlewareHandler<AppEnv> = async (c, next) => {
  const seen = new Set<string>()
  const url = new URL(c.req.url)
  const list = c.req.method === 'GET' && url.pathname.endsWith('/notifications')
  for (const key of url.searchParams.keys()) {
    if (!(list && ['limit', 'cursor', 'filter'].includes(key)) || seen.has(key))
      throw AppError.validation('Invalid notification request')
    seen.add(key)
  }
  if (c.req.method === 'POST') {
    let body: unknown
    try {
      body = await c.req.raw.clone().json()
    } catch {
      throw AppError.validation('Invalid notification request')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0)
      throw AppError.validation('Invalid notification request')
  }
  await next()
}
const middleware = [
  localeHeaders,
  requireAuth,
  requireSession,
  requireOrgContext(),
  includeNotificationAccess,
  strictInput,
] as const
const errors = {
  ...validationErrorResponse,
  ...authErrorResponses,
  ...notFoundErrorResponse,
  500: errorResponse('Internal error'),
}
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const countRoute = createRoute({
  method: 'get',
  path: `${base}/unread-count`,
  tags: ['notifications'],
  security: sessionOnlySecurity,
  middleware: [...middleware] as const,
  request: { params: orgParamsSchema, query: emptyQuerySchema },
  responses: {
    200: { description: 'Visible unread count', content: json(unreadCountResponseSchema) },
    ...errors,
  },
})
const readAllRoute = createRoute({
  method: 'post',
  path: `${base}/read-all`,
  tags: ['notifications'],
  security: sessionOnlySecurity,
  middleware: [...middleware] as const,
  request: {
    params: orgParamsSchema,
    query: emptyQuerySchema,
    body: { required: true, content: json(emptyBodySchema) },
  },
  responses: {
    200: {
      description: 'Marked visible unread notifications',
      content: json(readAllResponseSchema),
    },
    ...errors,
  },
})
const listRoute = createRoute({
  method: 'get',
  path: base,
  tags: ['notifications'],
  security: sessionOnlySecurity,
  middleware: [...middleware] as const,
  request: { params: orgParamsSchema, query: inboxQuerySchema },
  responses: {
    200: {
      description: 'Visible notification page',
      content: json(pageResponseSchema(inboxDtoSchema)),
    },
    ...errors,
  },
})
const readRoute = createRoute({
  method: 'post',
  path: `${base}/{notificationId}/read`,
  tags: ['notifications'],
  security: sessionOnlySecurity,
  middleware: [...middleware] as const,
  request: {
    params: inboxIdParamsSchema,
    query: emptyQuerySchema,
    body: { required: true, content: json(emptyBodySchema) },
  },
  responses: {
    200: { description: 'Marked notification read', content: json(okResponseSchema) },
    ...errors,
  },
})

export const notificationsInboxRoutes = new OpenAPIHono<AppEnv>()
const invalid = invalidRequest('Invalid notification request')
notificationsInboxRoutes.openapi(
  countRoute,
  async (c) => {
    const scope = await loadNotificationScope(c)
    const db = c.get('db')
    if (!db) throw AppError.internal()
    return c.json({ unreadCount: await countUnread(db, scope), requestId: c.get('requestId') }, 200)
  },
  invalid,
)
notificationsInboxRoutes.openapi(
  readAllRoute,
  async (c) => {
    const scope = await loadNotificationScope(c)
    const db = c.get('db')
    if (!db) throw AppError.internal()
    const updated = await markRead(db, scope, { now: Date.now() })
    return c.json({ ok: true as const, updated, requestId: c.get('requestId') }, 200)
  },
  invalid,
)
notificationsInboxRoutes.openapi(
  listRoute,
  async (c) => {
    const scope = await loadNotificationScope(c)
    const db = c.get('db')
    if (!db) throw AppError.internal()
    const { filter, ...query } = c.req.valid('query')
    const page = await listInbox(db, scope, { ...query, unreadOnly: filter === 'unread' })
    const locale = notificationLocale(c.req.header('Accept-Language'))
    return c.json(
      {
        items: page.items.map((row) => renderInboxRow(row, locale)),
        nextCursor: page.nextCursor,
        requestId: c.get('requestId'),
      },
      200,
    )
  },
  invalid,
)
notificationsInboxRoutes.openapi(
  readRoute,
  async (c) => {
    const scope = await loadNotificationScope(c)
    const db = c.get('db')
    if (!db) throw AppError.internal()
    const { notificationId } = c.req.valid('param')
    const updated = await markRead(db, scope, { id: notificationId, now: Date.now() })
    if (!(updated || (await hasInboxNotification(db, scope, notificationId))))
      throw AppError.notFound()
    return c.json({ ok: true as const, requestId: c.get('requestId') }, 200)
  },
  invalid,
)
