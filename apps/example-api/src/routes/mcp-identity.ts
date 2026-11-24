import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { isAccountActive } from '@kit/auth/repos/account-state'
import { AppError } from '@kit/core'
import { authErrorResponses, invalidRequest, validationErrorResponse } from '../lib/openapi'
import { corsAllowlist } from '../lib/session-env'
import { authorization } from '../middleware/authorization'
import {
  isAllowedMcpResumeUrl,
  mintIdentityTicket,
  redeemIdentityTicket,
} from '../services/mcp-identity-ticket'
import type { AppEnv } from '../types'

export const mcpIdentityRoutes = new OpenAPIHono<AppEnv>()

const ticketQuery = z.object({
  resume: z.string().min(1),
})

const redeemBody = z.object({
  ticket: z.string().min(8),
})

const redeemResponse = z.object({
  userId: z.string(),
  email: z.string().optional(),
  requestId: z.string(),
})

const startTicket = createRoute({
  method: 'get',
  path: '/api/mcp-identity/ticket',
  tags: ['mcp-identity'],
  summary: 'Mint a one-time MCP identity ticket and resume authorize',
  description:
    'Session cookie only. Missing session redirects to the SPA login. The ticket is not an MCP access token.',
  request: { query: ticketQuery },
  responses: {
    302: { description: 'Redirect to MCP authorize with ticket, or to /login' },
    ...validationErrorResponse,
    ...authErrorResponses,
  },
})

mcpIdentityRoutes.openapi(startTicket, async (c) => {
  const resume = isAllowedMcpResumeUrl(c.req.valid('query').resume)
  if (!resume) {
    throw AppError.fieldErrors('Invalid MCP resume URL', {
      resume: ['Must be a loopback http(s) /authorize URL'],
    })
  }

  const session = await authorization.session(c)
  if (!session) {
    const web = corsAllowlist(c.env)[0] ?? 'http://127.0.0.1:5173'
    const login = new URL('/login', web)
    login.searchParams.set('next', `/mcp-oauth/resume?r=${encodeURIComponent(resume.toString())}`)
    return c.redirect(login.toString(), 302)
  }

  const ticket = await mintIdentityTicket({
    userId: session.subject,
    ...(session.email ? { email: session.email } : {}),
  })
  resume.searchParams.set('mcp_identity_ticket', ticket)
  return c.redirect(resume.toString(), 302)
})

const redeemTicket = createRoute({
  method: 'post',
  path: '/api/mcp-identity/ticket/redeem',
  tags: ['mcp-identity'],
  summary: 'Consume a one-time MCP identity ticket',
  request: {
    body: { content: { 'application/json': { schema: redeemBody } }, required: true },
  },
  responses: {
    200: {
      description: 'Human identity for MCP authorize — ticket is spent',
      content: { 'application/json': { schema: redeemResponse } },
    },
    ...validationErrorResponse,
    ...authErrorResponses,
  },
})

mcpIdentityRoutes.openapi(
  redeemTicket,
  async (c) => {
    const { ticket } = c.req.valid('json')
    const identity = await redeemIdentityTicket(ticket)
    if (!identity) {
      throw AppError.unauthorized('Invalid or expired identity ticket')
    }
    try {
      if (!(await isAccountActive(c.get('db')!, identity.userId))) throw AppError.unauthorized()
    } catch {
      throw AppError.unauthorized()
    }
    return c.json({
      userId: identity.userId,
      ...(identity.email ? { email: identity.email } : {}),
      requestId: c.get('requestId'),
    })
  },
  invalidRequest('Invalid identity ticket payload'),
)
