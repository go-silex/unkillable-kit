import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  findImpersonationSession,
  listImpersonationPermissions,
  setImpersonationPermissions,
  startImpersonationSession,
  stopImpersonationSession,
} from '@kit/auth/repos/impersonation'
import * as platformRolesRepo from '@kit/auth/repos/platform-roles'
import { AppError } from '@kit/core'
import {
  authErrorResponses,
  errorResponse,
  invalidRequest,
  sessionOnlySecurity,
  validationErrorResponse,
} from '../lib/openapi'
import { getImpersonationEligibility, getImpersonationInfo } from '../services/impersonation'
import type { AppEnv } from '../types'

const rolePermission = z
  .object({ role: z.enum(['staff', 'super_admin']), read: z.boolean(), write: z.boolean() })
  .strict()
const permissionsResponse = z.object({
  permissions: z.array(rolePermission),
  requestId: z.string(),
})
const user = z.object({ id: z.string(), name: z.string().optional(), email: z.string().optional() })
const info = z.object({
  id: z.string(),
  mode: z.enum(['read', 'write']),
  organizationId: z.string(),
  actor: user,
  subject: user,
  startedAt: z.number(),
  active: z.boolean(),
})
const startBody = z
  .object({
    organizationId: z.string().min(1),
    subjectUserId: z.string().min(1),
    mode: z.enum(['read', 'write']),
  })
  .strict()
const stopBody = z.object({ impersonationId: z.string().min(1) }).strict()
const conflicts = { 409: errorResponse('Impersonation context changed') }
const json = (schema: typeof permissionsResponse) => ({ 'application/json': { schema } })

export const impersonationRoutes = new OpenAPIHono<AppEnv>()

const permissionsGet = createRoute({
  method: 'get',
  path: '/api/admin/impersonation/permissions',
  tags: ['impersonation'],
  summary: 'Get impersonation permissions',
  security: sessionOnlySecurity,
  responses: {
    200: { description: 'Role permissions', content: json(permissionsResponse) },
    ...authErrorResponses,
  },
})
const permissionsPatch = createRoute({
  method: 'patch',
  path: '/api/admin/impersonation/permissions',
  tags: ['impersonation'],
  summary: 'Set impersonation permissions',
  security: sessionOnlySecurity,
  request: { body: { content: { 'application/json': { schema: rolePermission } } } },
  responses: {
    200: { description: 'Role permissions', content: json(permissionsResponse) },
    ...validationErrorResponse,
    ...authErrorResponses,
    ...conflicts,
  },
})
const start = createRoute({
  method: 'post',
  path: '/api/impersonation/start',
  tags: ['impersonation'],
  summary: 'Start impersonating an organization member',
  security: sessionOnlySecurity,
  request: { body: { content: { 'application/json': { schema: startBody } } } },
  responses: {
    200: {
      description: 'Impersonation started',
      content: {
        'application/json': { schema: z.object({ impersonation: info, requestId: z.string() }) },
      },
    },
    ...validationErrorResponse,
    ...authErrorResponses,
    ...conflicts,
  },
})
const stop = createRoute({
  method: 'post',
  path: '/api/impersonation/stop',
  tags: ['impersonation'],
  summary: 'Return to the operator identity',
  security: sessionOnlySecurity,
  request: { body: { content: { 'application/json': { schema: stopBody } } } },
  responses: {
    200: {
      description: 'Impersonation stopped',
      content: {
        'application/json': { schema: z.object({ stopped: z.boolean(), requestId: z.string() }) },
      },
    },
    ...validationErrorResponse,
    ...authErrorResponses,
    ...conflicts,
  },
})

function identity(c: {
  get: (key: 'actorSubject' | 'sessionId') => string | undefined
  req: { header: (name: string) => string | undefined }
}) {
  if (/^Bearer\s/i.test(c.req.header('authorization') ?? ''))
    throw AppError.forbidden('A session cookie is required')
  const actorUserId = c.get('actorSubject')
  const sessionId = c.get('sessionId')
  if (!(actorUserId && sessionId)) throw AppError.unauthorized('A valid session is required')
  return { actorUserId, sessionId }
}

impersonationRoutes.openapi(permissionsGet, async (c) => {
  const { actorUserId } = identity(c)
  const db = c.get('db')!
  if ((await platformRolesRepo.getPlatformRole(db, actorUserId)) !== 'super_admin')
    throw AppError.forbidden()
  return c.json({
    permissions: await listImpersonationPermissions(db),
    requestId: c.get('requestId'),
  })
})

impersonationRoutes.openapi(
  permissionsPatch,
  async (c) => {
    const { actorUserId, sessionId } = identity(c)
    const db = c.get('db')!
    if ((await platformRolesRepo.getPlatformRole(db, actorUserId)) !== 'super_admin')
      throw AppError.forbidden()
    if (await findImpersonationSession(db, sessionId))
      throw AppError.forbidden('Cannot configure permissions while impersonating')
    await setImpersonationPermissions(db, c.req.valid('json'), {
      actorUserId,
      requestId: c.get('requestId'),
      ip: c.req.header('cf-connecting-ip'),
    })
    return c.json(
      {
        permissions: await listImpersonationPermissions(db),
        requestId: c.get('requestId'),
      },
      200,
    )
  },
  invalidRequest('Invalid impersonation permissions'),
)

impersonationRoutes.openapi(
  start,
  async (c) => {
    const { actorUserId, sessionId } = identity(c)
    const db = c.get('db')!
    if (await findImpersonationSession(db, sessionId))
      throw AppError.conflict('Already impersonating')
    const row = {
      id: crypto.randomUUID(),
      sessionId,
      actorUserId,
      ...c.req.valid('json'),
      createdAt: Date.now(),
    }
    if (!(await getImpersonationEligibility(db, row)))
      throw AppError.forbidden('Impersonation is not permitted')
    try {
      await startImpersonationSession(db, row, {
        actorUserId,
        requestId: c.get('requestId'),
        ip: c.req.header('cf-connecting-ip'),
      })
    } catch (error) {
      if (await findImpersonationSession(db, sessionId))
        throw AppError.conflict('Already impersonating')
      throw error
    }
    return c.json(
      {
        impersonation: await getImpersonationInfo(db, row, true),
        requestId: c.get('requestId'),
      },
      200,
    )
  },
  invalidRequest('Invalid impersonation request'),
)

impersonationRoutes.openapi(
  stop,
  async (c) => {
    const { actorUserId, sessionId } = identity(c)
    const db = c.get('db')!
    const expectedId = c.req.valid('json').impersonationId
    const current = await findImpersonationSession(db, sessionId)
    if (current && (current.id !== expectedId || current.actorUserId !== actorUserId))
      throw AppError.conflict('Impersonation context changed')
    const stopped = await stopImpersonationSession(
      db,
      { sessionId, expectedId },
      { actorUserId, requestId: c.get('requestId'), ip: c.req.header('cf-connecting-ip') },
    )
    if (!stopped && (await findImpersonationSession(db, sessionId)))
      throw AppError.conflict('Impersonation context changed')
    return c.json({ stopped, requestId: c.get('requestId') }, 200)
  },
  invalidRequest('Invalid stop request'),
)
