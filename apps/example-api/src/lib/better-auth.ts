/**
 * example-api Env adapter for `@kit/auth/factory` (ADR-0008 D6).
 * Product apps: import `createBetterAuth` from `@kit/auth/factory` and
 * env helpers from `@kit/auth` — do not copy this file as the factory.
 */
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
import { betterAuthDrizzleSchema } from '@kit/auth/schema'
import type { Env } from '../env'
import { emailConfig } from './email-config'
import { resolveEmailPort } from './email-port'

export { betterAuthBaseURL } from '@kit/auth'
export type { KitBetterAuth }

export function createBetterAuth(env: Env, baseURL: string): KitBetterAuth {
  assertBetterAuthConfigured(env)
  return createKitBetterAuth({
    database: env.DB,
    schema: betterAuthDrizzleSchema,
    secret: getBetterAuthSecret(env),
    allowKitPlaceholderSecret: isDevLikeEnvironment(env),
    baseURL,
    requestDerivedBaseURL: !env.BETTER_AUTH_URL?.trim(),
    cookieName: sessionCookieNameFromEnv(env),
    useSecureCookies: useSecureCookie(env),
    allowPublicSignup: allowPublicSignup(env),
    allowLoopbackOrigins: isDevLikeEnvironment(env),
    trustedOrigins: corsAllowlist(env),
    // Resolve on send — constructing BA every request must not require EMAIL_TRANSPORT.
    emailPort: {
      send: async (input) => resolveEmailPort(env).send(input),
    },
    emailConfig,
    onFirstSession: async ({ userId }) => {
      const { createDb } = await import('@kit/db')
      const { schema: kitSchema } = await import('../db/schema')
      const { tryFirstLogin } = await import('../services/audit')
      const kitDb = createDb(env.DB, kitSchema)
      await tryFirstLogin(kitDb, {
        userId,
        actorUserId: userId,
        method: 'session',
      })
    },
  })
}
