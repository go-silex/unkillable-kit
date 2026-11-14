import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { impersonationInfoSchema, impersonationPermissionsSchema } from '@kit/api-client/me'
import { assertRateLimit } from '@kit/auth/repos/rate-limit'
import { AppError } from '@kit/core'
import {
  authErrorResponses,
  invalidRequest,
  notFoundErrorResponse,
  orgIsolationDescription,
  rateLimitErrorResponse,
  sessionOnlySecurity,
  sessionOrKeySecurity,
  validationErrorResponse,
} from '../lib/openapi'
import { requireAuth } from '../middleware/require-auth'
import { appendAudit } from '../services/audit'
import * as authService from '../services/auth'
import * as meService from '../services/me'
import type { AppEnv } from '../types'

/** 30 key mints / subject / hour (D1 fixed-window). */
const MINT_LIMIT = 30
const MINT_WINDOW_MS = 60 * 60 * 1000

const mintKeySchema = z.object({
  name: z.string().max(80).optional(),
  scopes: z.array(z.enum(['read', 'write', 'admin'])).min(1),
  organizationId: z.string().min(1).optional(),
})

const keyIdParamSchema = z.object({ id: z.string().min(1) })

const meOrgSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    kind: z.string(),
    status: z.string(),
    role: z.string(),
  })
  .openapi('MeOrg')

const apiKeySchema = z
  .object({
    id: z.string(),
    subject: z.string(),
    keyPrefix: z.string(),
    organizationId: z.string(),
    name: z.string().nullable(),
    scopes: z.array(z.enum(['read', 'write', 'admin'])),
    createdAt: z.number(),
    expiresAt: z.number().nullable(),
    revokedAt: z.number().nullable(),
  })
  .openapi('ApiKey')

export const meRoutes = new OpenAPIHono<AppEnv>()

// Path-scoped — do not use('*') when mounted at `/` (would auth every path including unknown).
meRoutes.use('/api/me', requireAuth)
meRoutes.use('/api/keys', requireAuth)
meRoutes.use('/api/keys/*', requireAuth)

const getMe = createRoute({
  method: 'get',
  path: '/api/me',
  tags: ['me'],
  summary: 'Current subject profile',
  security: sessionOrKeySecurity,
  responses: {
    200: {
      description: 'Authenticated subject, platform role, and membership orgs',
      content: {
        'application/json': {
          schema: z.object({
            subject: z.string(),
            email: z.string().optional(),
            name: z.string().optional(),
            authMethod: z.enum(['session', 'api_key']).optional(),
            platformRole: z.enum(['super_admin', 'staff']).nullable(),
            orgs: z.array(meOrgSchema),
            impersonation: impersonationInfoSchema.nullable(),
            impersonationPermissions: impersonationPermissionsSchema,
            requestId: z.string(),
          }),
        },
      },
    },
    ...authErrorResponses,
  },
})

meRoutes.openapi(getMe, async (c) => {
  const subject = c.get('subject')!
  const db = c.get('db')!
  const profile = await meService.getMeProfile(db, subject, {
    authMethod: c.get('authMethod'),
    keyOrganizationId: c.get('keyOrganizationId'),
    impersonation: c.get('impersonationInfo'),
    actorUserId: c.get('actorSubject'),
  })

  return c.json({
    subject,
    ...(profile.email ? { email: profile.email } : {}),
    ...(profile.name ? { name: profile.name } : {}),
    authMethod: c.get('authMethod'),
    platformRole: profile.platformRole,
    orgs: profile.orgs,
    impersonation: profile.impersonation,
    impersonationPermissions: profile.impersonationPermissions,
    requestId: c.get('requestId'),
  })
})

const listKeys = createRoute({
  method: 'get',
  path: '/api/keys',
  tags: ['me'],
  summary: 'List API keys for the caller',
  security: sessionOrKeySecurity,
  responses: {
    200: {
      description: 'Keys for the session subject, or org-scoped keys for an API key',
      content: {
        'application/json': {
          schema: z.object({ keys: z.array(apiKeySchema), requestId: z.string() }),
        },
      },
    },
    ...authErrorResponses,
  },
})

meRoutes.openapi(listKeys, async (c) => {
  const db = c.get('db')!
  const subject = c.get('subject')!
  const requestId = c.get('requestId')
  // D11: api_key is org-scoped. Missing/blank key org → [] owned HERE (never call listApiKeysForOrg).
  if (c.get('authMethod') === 'api_key') {
    const org = c.get('keyOrganizationId')
    if (!org?.trim()) return c.json({ keys: [], requestId })
    const keys = await authService.listApiKeysForOrg(db, subject, org)
    return c.json({ keys, requestId })
  }
  const keys = await authService.listApiKeysForSubject(db, subject)
  return c.json({ keys, requestId })
})

const mintKey = createRoute({
  method: 'post',
  path: '/api/keys',
  tags: ['me'],
  summary: 'Mint an organization-bound API key',
  description: orgIsolationDescription,
  security: sessionOnlySecurity,
  request: {
    body: { content: { 'application/json': { schema: mintKeySchema } }, required: true },
  },
  responses: {
    200: {
      description: 'Minted key (plaintext shown once)',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            key: z.string(),
            keyPrefix: z.string(),
            organizationId: z.string(),
            requestId: z.string(),
          }),
        },
      },
    },
    ...validationErrorResponse,
    ...authErrorResponses,
    ...notFoundErrorResponse,
    ...rateLimitErrorResponse,
  },
})

meRoutes.openapi(
  mintKey,
  async (c) => {
    // Mint only with session cookies — not with sk_ (prevents key-chain expansion).
    if (c.get('authMethod') !== 'session') {
      throw AppError.forbidden('API key mint requires a session cookie')
    }
    const subject = c.get('subject')!
    const db = c.get('db')!
    await assertRateLimit(db, `mint:${subject}`, MINT_LIMIT, MINT_WINDOW_MS)

    const data = c.req.valid('json')

    const orgFromHeader = c.req.header('x-org-id')?.trim()
    const organizationId = data.organizationId?.trim() || orgFromHeader || null
    // `mintApiKey` refuses a missing organization itself (ADR-0003 D11) — no opt-in flag to pass.
    const minted = await authService.mintApiKey(db, subject, {
      name: data.name,
      scopes: data.scopes,
      organizationId,
    })
    await appendAudit(db, {
      action: 'api_key.create',
      actorUserId: subject,
      targetType: 'api_key',
      targetId: minted.id,
      orgId: minted.organizationId,
      meta: { scopes: data.scopes },
      requestId: c.get('requestId'),
    })
    return c.json(
      {
        id: minted.id,
        key: minted.key,
        keyPrefix: minted.keyPrefix,
        organizationId: minted.organizationId,
        requestId: c.get('requestId'),
      },
      200,
    )
  },
  invalidRequest('Invalid key mint payload'),
)

const revokeKey = createRoute({
  method: 'delete',
  path: '/api/keys/{id}',
  tags: ['me'],
  summary: 'Revoke an API key',
  security: sessionOnlySecurity,
  request: { params: keyIdParamSchema },
  responses: {
    200: {
      description: 'Revoked',
      content: {
        'application/json': { schema: z.object({ ok: z.literal(true), requestId: z.string() }) },
      },
    },
    ...validationErrorResponse,
    ...authErrorResponses,
    ...notFoundErrorResponse,
  },
})

meRoutes.openapi(revokeKey, async (c) => {
  if (c.get('authMethod') !== 'session') {
    throw AppError.forbidden('API key revoke requires a session cookie')
  }
  const db = c.get('db')!
  const subject = c.get('subject')!
  await authService.revokeApiKey(db, c.req.valid('param').id, subject)
  return c.json({ ok: true, requestId: c.get('requestId') })
})
