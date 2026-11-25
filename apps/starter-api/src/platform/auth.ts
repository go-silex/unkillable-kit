import { betterAuthBaseURL, corsAllowlist } from '@kit/auth'
import {
  createRequestAuthorization,
  originGuard,
  type RequestAuthorization,
  securityHeaders,
} from '@kit/auth/hono'
import { newRequestId } from '@kit/core'
import { createDb } from '@kit/db'
import type { MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import { createBetterAuth } from './better-auth'
import { type AppEnv, schema } from './types'

const bindPlatform: MiddlewareHandler<AppEnv> = async (c, next) => {
  const db = createDb(c.env.DB, schema)
  c.set('db', db)
  c.set('betterAuth', createBetterAuth(c.env, betterAuthBaseURL(c.env, c.req.url), db))
  await next()
}

const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = newRequestId()
  c.set('requestId', id)
  c.header('x-request-id', id)
  await next()
}

const appCors: MiddlewareHandler<AppEnv> = (c, next) =>
  cors({
    origin: (origin) => (corsAllowlist(c.env).includes(origin) ? origin : null),
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'X-Org-Id'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
  })(c, next)

export const platformMiddleware = [
  requestId,
  securityHeaders,
  appCors,
  originGuard,
  bindPlatform,
] as const

export const authorization: RequestAuthorization<AppEnv> = createRequestAuthorization<AppEnv>({
  db: (c) => c.env.DB,
  auth: (c) => c.get('betterAuth'),
  keyScope: ({ method, path }, scopes) =>
    method === 'GET' &&
    (path === '/api/me' || path === '/api/orgs/:orgId/members') &&
    scopes.includes('read'),
})

export const { betterAuthMount, requireAuth } = authorization
export const requireOrg = authorization.requireOrgContext()
