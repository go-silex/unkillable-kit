import { betterAuthBaseURL } from '@kit/auth'
import { createRequestAuthorization } from '@kit/auth/hono'
import { createDb } from '@kit/db'
import type { MiddlewareHandler } from 'hono'
import { createBetterAuth } from './better-auth'
import { type AppEnv, schema } from './types'

export const bindPlatform: MiddlewareHandler<AppEnv> = async (c, next) => {
  const db = createDb(c.env.DB, schema)
  c.set('db', db)
  c.set('betterAuth', createBetterAuth(c.env, betterAuthBaseURL(c.env, c.req.url), db))
  await next()
}

const authorization = createRequestAuthorization<AppEnv>({
  db: (c) => c.env.DB,
  auth: (c) => c.get('betterAuth'),
})

export const { admitKeyScope, authenticateKey, requireAuth } = authorization
export const requireOrg = authorization.requireOrgContext()
