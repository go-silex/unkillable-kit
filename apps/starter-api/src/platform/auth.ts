import {
  allowPublicSignup,
  assertBetterAuthConfigured,
  betterAuthBaseURL,
  corsAllowlist,
  getBetterAuthSecret,
  isDevLikeEnvironment,
  sessionCookieNameFromEnv,
  useSecureCookie,
} from '@kit/auth'
import { createBetterAuth } from '@kit/auth/factory'
import { createKitOrgMiddleware, createKitRequireAuth } from '@kit/auth/hono'
import { insertFirstLoginIfAbsent } from '@kit/auth/repos/audit'
import { createDb } from '@kit/db'
import type { Context, MiddlewareHandler } from 'hono'
import { type AppEnv, schema } from './types'

export const bindPlatform: MiddlewareHandler<AppEnv> = async (c, next) => {
  const db = createDb(c.env.DB, schema)
  assertBetterAuthConfigured(c.env)
  const dev = isDevLikeEnvironment(c.env)
  const auth = createBetterAuth({
    database: c.env.DB,
    secret: getBetterAuthSecret(c.env),
    baseURL: betterAuthBaseURL(c.env, c.req.url),
    requestDerivedBaseURL: !c.env.BETTER_AUTH_URL?.trim(),
    trustedOrigins: corsAllowlist(c.env),
    allowLoopbackOrigins: dev,
    allowKitPlaceholderSecret: dev,
    cookieName: sessionCookieNameFromEnv(c.env),
    useSecureCookies: useSecureCookie(c.env),
    allowPublicSignup: allowPublicSignup(c.env),
    onFirstSession: async ({ userId }) => {
      await insertFirstLoginIfAbsent(db, {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        actorUserId: userId,
        targetId: userId,
        metaJson: '{"method":"session"}',
      })
    },
  })
  c.set('db', db)
  c.set('betterAuth', auth)
  await next()
}

export const requireAuth: MiddlewareHandler<AppEnv> = createKitRequireAuth<Context<AppEnv>>((c) =>
  sessionCookieNameFromEnv(c.env),
)

const orgs = createKitOrgMiddleware({
  resolveModuleAccess: async () => false,
  isModuleEffective: async () => false,
})
export const requireOrg = orgs.requireOrgContext() as unknown as MiddlewareHandler<AppEnv>
