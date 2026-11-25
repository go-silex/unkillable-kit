import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { AppError } from '@kit/core'
import { resolveEmailPort } from '../lib/email-port'
import {
  authErrorResponses,
  errorResponse,
  invalidRequest,
  notFoundErrorResponse,
  rateLimitErrorResponse,
  sessionOnlySecurity,
  validationErrorResponse,
} from '../lib/openapi'
import { corsAllowlist } from '../lib/session-env'
import { requirePlatformRole } from '../middleware/org-context'
import { requireAuth } from '../middleware/require-auth'
import * as adminUsersService from '../services/admin-users'
import type { AppEnv } from '../types'

const createSchema = z
  .object({
    email: z.string().email().max(254),
    name: z.string().min(1).max(120).optional(),
    platformRole: z.enum(['staff', 'super_admin']).nullable().optional(),
    memberships: z
      .array(
        z.object({
          orgId: z.string().min(1).max(64),
          role: z.string().min(1).max(48),
        }),
      )
      .max(20)
      .optional(),
    sendEmail: z.boolean().optional(),
  })
  .strict()

const listSchema = z.object({
  q: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(512).optional(),
})

const idParamSchema = z.object({ id: z.string().min(1) })

const adminUserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    platformRole: z.enum(['super_admin', 'staff']).nullable(),
    createdAt: z.string(),
  })
  .openapi('AdminUser')

export const adminUsersRoutes = new OpenAPIHono<AppEnv>()

adminUsersRoutes.use('/api/admin/users', requireAuth)
adminUsersRoutes.use('/api/admin/users/*', requireAuth)

const platformStaff = requirePlatformRole('super_admin', 'staff')

function requireSession(c: { get: (k: 'authMethod') => string | undefined }) {
  if (c.get('authMethod') !== 'session') {
    throw AppError.forbidden('Admin user management requires a session cookie')
  }
}

function webBase(c: {
  env: AppEnv['Bindings']
  req: { header: (n: string) => string | undefined }
}): string {
  const origin = c.req.header('origin')
  const list = corsAllowlist(c.env)
  if (origin && list.includes(origin)) return origin
  return list[0]
}

const listAdminUsers = createRoute({
  method: 'get',
  path: '/api/admin/users',
  tags: ['admin-users'],
  summary: 'List platform users',
  security: sessionOnlySecurity,
  middleware: [platformStaff] as const,
  request: { query: listSchema },
  responses: {
    200: {
      description: 'Cursor page of admin-directory users',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(adminUserSchema),
            nextCursor: z.string().nullable(),
            requestId: z.string(),
          }),
        },
      },
    },
    ...validationErrorResponse,
    ...authErrorResponses,
  },
})

adminUsersRoutes.openapi(
  listAdminUsers,
  async (c) => {
    requireSession(c)
    const data = c.req.valid('query')
    const db = c.get('db')!
    const platformRole = c.get('platformRole')
    if (platformRole !== 'super_admin' && platformRole !== 'staff') {
      throw AppError.forbidden('Platform role required')
    }
    const page = await adminUsersService.listAdminUsers(db, {
      actorUserId: c.get('subject')!,
      actorPlatformRole: platformRole,
      q: data.q,
      limit: data.limit,
      cursor: data.cursor,
    })
    return c.json({ ...page, requestId: c.get('requestId') })
  },
  invalidRequest('Invalid query'),
)

const createAdminUser = createRoute({
  method: 'post',
  path: '/api/admin/users',
  tags: ['admin-users'],
  summary: 'Create a platform user',
  security: sessionOnlySecurity,
  middleware: [platformStaff] as const,
  request: {
    body: { content: { 'application/json': { schema: createSchema } }, required: true },
  },
  responses: {
    201: {
      description: 'Created user',
      content: {
        'application/json': {
          schema: z.object({
            user: z.object({
              id: z.string(),
              email: z.string(),
              name: z.string(),
              platformRole: z.enum(['super_admin', 'staff']).nullable(),
            }),
            memberships: z.array(z.object({ organizationId: z.string(), role: z.string() })),
            welcomeEmailSent: z.boolean(),
            requestId: z.string(),
          }),
        },
      },
    },
    ...validationErrorResponse,
    ...authErrorResponses,
    ...notFoundErrorResponse,
    409: errorResponse('User already exists'),
    ...rateLimitErrorResponse,
  },
})

adminUsersRoutes.openapi(
  createAdminUser,
  async (c) => {
    requireSession(c)
    const data = c.req.valid('json')
    const platformRole = c.get('platformRole')
    if (platformRole !== 'super_admin' && platformRole !== 'staff') {
      throw AppError.forbidden('Platform role required')
    }
    const db = c.get('db')!
    const result = await adminUsersService.createAdminUser(db, {
      actorUserId: c.get('subject')!,
      actorPlatformRole: platformRole,
      email: data.email,
      name: data.name,
      platformRole: data.platformRole ?? null,
      memberships: data.memberships,
      sendEmail: data.sendEmail,
      webBaseUrl: webBase(c),
      allowedOrigins: corsAllowlist(c.env),
      emailPort: resolveEmailPort(c.env),
      requestId: c.get('requestId'),
    })
    return c.json(
      {
        user: result.user,
        memberships: result.memberships,
        welcomeEmailSent: result.welcomeEmailSent,
        requestId: c.get('requestId'),
      },
      201,
    )
  },
  invalidRequest('Invalid create user payload'),
)

const resendWelcome = createRoute({
  method: 'post',
  path: '/api/admin/users/{id}/resend-welcome',
  tags: ['admin-users'],
  summary: 'Resend the welcome set-password email',
  security: sessionOnlySecurity,
  middleware: [platformStaff] as const,
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Welcome email re-sent',
      content: {
        'application/json': { schema: z.object({ ok: z.literal(true), requestId: z.string() }) },
      },
    },
    ...validationErrorResponse,
    ...authErrorResponses,
    ...notFoundErrorResponse,
    ...rateLimitErrorResponse,
  },
})

adminUsersRoutes.openapi(resendWelcome, async (c) => {
  requireSession(c)
  const platformRole = c.get('platformRole')
  if (platformRole !== 'super_admin' && platformRole !== 'staff') {
    throw AppError.forbidden('Platform role required')
  }
  const db = c.get('db')!
  await adminUsersService.resendWelcome(db, {
    actorUserId: c.get('subject')!,
    actorPlatformRole: platformRole,
    userId: c.req.valid('param').id,
    webBaseUrl: webBase(c),
    allowedOrigins: corsAllowlist(c.env),
    emailPort: resolveEmailPort(c.env),
  })
  return c.json({ ok: true, requestId: c.get('requestId') })
})
