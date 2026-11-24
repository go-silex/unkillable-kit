import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { AppError } from '@kit/core'
import { deleteRule, listRules, putRule } from '@kit/notifications/repos'
import type { MiddlewareHandler } from 'hono'
import {
  authErrorResponses,
  invalidRequest,
  notFoundErrorResponse,
  sessionOnlySecurity,
  validationErrorResponse,
} from '../../lib/openapi'
import { requireOrgContext } from '../../middleware/org-context'
import { requireAuth } from '../../middleware/require-auth'
import { requireSession } from '../../middleware/require-session'
import {
  includeNotificationAccess,
  loadNotificationScope,
} from '../../services/notifications/access'
import { validateRuleInput } from '../../services/notifications/rule-input'
import {
  listEffectiveRules,
  listNotificationTypes,
  validateRuleCursor,
} from '../../services/notifications/user-rules'
import type { AppEnv } from '../../types'
import {
  effectiveRuleDtoSchema,
  emptyQuerySchema,
  notificationPageQuerySchema,
  okResponseSchema,
  orgParamsSchema,
  pageResponseSchema,
  ruleDtoSchema,
  ruleResponseSchema,
  typeDtoSchema,
  userRuleInputSchema,
} from './shared.schemas'
import { userRuleParamsSchema } from './user.schemas'

export const notificationsUserRoutes = new OpenAPIHono<AppEnv>()

function strictQuery(allowed: readonly string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const seen = new Set<string>()
    for (const key of new URL(c.req.url).searchParams.keys()) {
      if (!allowed.includes(key) || seen.has(key)) throw AppError.validation('Invalid query')
      seen.add(key)
    }
    await next()
  }
}

const strictUserBody: MiddlewareHandler<AppEnv> = async (c, next) => {
  let body: unknown
  try {
    body = await c.req.raw.clone().json()
  } catch {
    throw AppError.validation('Invalid notification rule')
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const value = body as Record<string, unknown>
    if (Object.keys(value).some((key) => !['selector', 'channel', 'enabled'].includes(key)))
      throw AppError.validation('Invalid notification rule')
    if (
      value.selector &&
      typeof value.selector === 'object' &&
      !Array.isArray(value.selector) &&
      Object.keys(value.selector).some((key) => !['kind', 'value'].includes(key))
    )
      throw AppError.validation('Invalid notification rule')
  }
  await next()
}

const pageQuery = strictQuery(['limit', 'cursor'])
const noQuery = strictQuery([])
const baseErrors = { ...validationErrorResponse, ...authErrorResponses }
const typesRoute = createRoute({
  method: 'get',
  path: '/api/notification-types',
  tags: ['notifications'],
  summary: 'List notification types',
  security: sessionOnlySecurity,
  middleware: [requireAuth, requireSession, pageQuery] as const,
  request: { query: notificationPageQuerySchema },
  responses: {
    200: {
      description: 'Notification type page',
      content: { 'application/json': { schema: pageResponseSchema(typeDtoSchema) } },
    },
    ...baseErrors,
  },
})
const rulesRoute = createRoute({
  method: 'get',
  path: '/api/me/notification-rules',
  tags: ['notifications'],
  summary: 'List personal notification rules',
  security: sessionOnlySecurity,
  middleware: [requireAuth, requireSession, pageQuery] as const,
  request: { query: notificationPageQuerySchema },
  responses: {
    200: {
      description: 'Personal rule page',
      content: { 'application/json': { schema: pageResponseSchema(ruleDtoSchema) } },
    },
    ...baseErrors,
  },
})
const putRoute = createRoute({
  method: 'put',
  path: '/api/me/notification-rules',
  tags: ['notifications'],
  summary: 'Set a personal notification rule',
  security: sessionOnlySecurity,
  middleware: [requireAuth, requireSession, noQuery, strictUserBody] as const,
  request: {
    query: emptyQuerySchema,
    body: { required: true, content: { 'application/json': { schema: userRuleInputSchema } } },
  },
  responses: {
    200: {
      description: 'Personal rule',
      content: { 'application/json': { schema: ruleResponseSchema } },
    },
    ...baseErrors,
  },
})
const deleteRoute = createRoute({
  method: 'delete',
  path: '/api/me/notification-rules/{ruleId}',
  tags: ['notifications'],
  summary: 'Delete a personal notification rule',
  security: sessionOnlySecurity,
  middleware: [requireAuth, requireSession, noQuery] as const,
  request: { params: userRuleParamsSchema, query: emptyQuerySchema },
  responses: {
    200: {
      description: 'Rule deleted or absent',
      content: { 'application/json': { schema: okResponseSchema } },
    },
    ...baseErrors,
  },
})
const effectiveRoute = createRoute({
  method: 'get',
  path: '/api/orgs/{orgId}/notifications/effective-rules',
  tags: ['notifications'],
  summary: 'Preview effective personal notification rules',
  security: sessionOnlySecurity,
  middleware: [
    requireAuth,
    requireSession,
    requireOrgContext(),
    includeNotificationAccess,
    pageQuery,
  ] as const,
  request: { params: orgParamsSchema, query: notificationPageQuerySchema },
  responses: {
    200: {
      description: 'Effective rule page',
      content: { 'application/json': { schema: pageResponseSchema(effectiveRuleDtoSchema) } },
    },
    ...baseErrors,
    ...notFoundErrorResponse,
  },
})

notificationsUserRoutes.openapi(
  typesRoute,
  (c) => c.json({ ...listNotificationTypes(c.req.valid('query')), requestId: c.get('requestId') }),
  invalidRequest('Invalid query'),
)
notificationsUserRoutes.openapi(
  rulesRoute,
  async (c) => {
    const query = c.req.valid('query')
    validateRuleCursor(query.cursor)
    const page = await listRules(c.get('db')!, { level: 'user', userId: c.get('subject')! }, query)
    return c.json({
      ...page,
      items: page.items.map((item) => ruleDtoSchema.parse(item)),
      requestId: c.get('requestId'),
    })
  },
  invalidRequest('Invalid query'),
)
notificationsUserRoutes.openapi(
  putRoute,
  async (c) => {
    const rule = validateRuleInput('user', { ...c.req.valid('json'), locked: false })
    const saved = await putRule(
      c.get('db')!,
      { level: 'user', userId: c.get('subject')! },
      { ...rule, id: crypto.randomUUID() },
      Date.now(),
    )
    return c.json({ rule: ruleDtoSchema.parse(saved), requestId: c.get('requestId') })
  },
  invalidRequest('Invalid notification rule'),
)
notificationsUserRoutes.openapi(
  deleteRoute,
  async (c) => {
    await deleteRule(
      c.get('db')!,
      { level: 'user', userId: c.get('subject')! },
      c.req.valid('param').ruleId,
    )
    return c.json({ ok: true as const, requestId: c.get('requestId') })
  },
  invalidRequest('Invalid request'),
)
notificationsUserRoutes.openapi(
  effectiveRoute,
  async (c) => {
    const scope = await loadNotificationScope(c)
    const page = await listEffectiveRules(c.get('db')!, scope, c.req.valid('query'))
    return c.json({
      ...page,
      items: page.items.map((item) => effectiveRuleDtoSchema.parse(item)),
      requestId: c.get('requestId'),
    })
  },
  invalidRequest('Invalid query'),
)
