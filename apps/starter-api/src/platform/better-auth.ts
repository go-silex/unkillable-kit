import {
  allowPublicSignup,
  assertBetterAuthConfigured,
  corsAllowlist,
  getBetterAuthSecret,
  isDevLikeEnvironment,
  sessionCookieNameFromEnv,
  useSecureCookie,
} from '@kit/auth'
import { createBetterAuth as createKitBetterAuth, type KitBetterAuth } from '@kit/auth/factory'
import { insertFirstLoginIfAbsent } from '@kit/auth/repos/audit'
import { createDb } from '@kit/db'
import { type Env, schema } from './types'

export function createBetterAuth(
  env: Env,
  baseURL: string,
  db = createDb(env.DB, schema),
): KitBetterAuth {
  assertBetterAuthConfigured(env)
  const dev = isDevLikeEnvironment(env)
  return createKitBetterAuth({
    database: env.DB,
    secret: getBetterAuthSecret(env),
    baseURL,
    requestDerivedBaseURL: !env.BETTER_AUTH_URL?.trim(),
    trustedOrigins: corsAllowlist(env),
    allowLoopbackOrigins: dev,
    allowKitPlaceholderSecret: dev,
    cookieName: sessionCookieNameFromEnv(env),
    useSecureCookies: useSecureCookie(env),
    allowPublicSignup: allowPublicSignup(env),
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
}
