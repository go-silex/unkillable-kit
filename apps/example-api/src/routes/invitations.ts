import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { clientIp } from '@kit/auth/repos/rate-limit'
import { AppError } from '@kit/core'
import { invitationIdSchema } from '../lib/invitation-id'
import {
  authErrorResponses,
  notFoundErrorResponse,
  rateLimitErrorResponse,
  sessionOnlySecurity,
  validationErrorResponse,
} from '../lib/openapi'
import { requireAuth } from '../middleware/require-auth'
import * as invitationsService from '../services/invitations'
import type { AppEnv } from '../types'

const invitationIdParamSchema = z.object({ invitationId: invitationIdSchema })

const acceptInvitationResponseSchema = z.object({
  org: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
  }),
  membership: z.object({
    id: z.string(),
    userId: z.string(),
    role: z.string(),
    organizationId: z.string(),
  }),
  requestId: z.string(),
})

export const invitationsRoutes = new OpenAPIHono<AppEnv>()

invitationsRoutes.use('/api/invitations/*', requireAuth)

const acceptInvitation = createRoute({
  method: 'post',
  path: '/api/invitations/{invitationId}/accept',
  tags: ['invitations'],
  summary: 'Accept an organization invitation',
  security: sessionOnlySecurity,
  request: { params: invitationIdParamSchema },
  responses: {
    200: {
      description: 'Accepted invitation — org + membership',
      content: { 'application/json': { schema: acceptInvitationResponseSchema } },
    },
    ...validationErrorResponse,
    ...authErrorResponses,
    ...notFoundErrorResponse,
    ...rateLimitErrorResponse,
  },
})

invitationsRoutes.openapi(acceptInvitation, async (c) => {
  if (c.get('authMethod') !== 'session') {
    throw AppError.forbidden('Accepting invitations requires a session cookie')
  }
  // Platform address when there is one (bounds a multi-account caller); else the subject, never a
  // shared constant. Prefixes keep the two keyspaces apart.
  const ip = clientIp(c.req)
  const result = await invitationsService.acceptInvitation(c.get('db')!, {
    invitationId: c.req.valid('param').invitationId,
    subjectUserId: c.get('subject')!,
    rateKey: ip === null ? `sub:${c.get('subject')!}` : `ip:${ip}`,
    requestId: c.get('requestId'),
  })
  return c.json({ ...result, requestId: c.get('requestId') })
})
