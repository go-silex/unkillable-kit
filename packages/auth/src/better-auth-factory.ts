/**
 * Per-request Better Auth factory (CF Workers pattern, ADR-0002 + ADR-0008 D6).
 * Products import this — they do not copy `example-api/src/lib/better-auth.ts`.
 */
import type { KitD1Database } from '@kit/db'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError, isAPIError } from 'better-auth/api'
import { magicLink } from 'better-auth/plugins'
import { drizzle } from 'drizzle-orm/d1'
import {
  type AuthEmailPort,
  MAGIC_LINK_EXPIRES_IN_SEC,
  RESET_PASSWORD_TOKEN_EXPIRES_IN_SEC,
  sendMagicLinkMail,
  sendResetPasswordMail,
} from './auth-email'
import { BA_BASE_PATH } from './better-auth-base-path'
import { assertAuthSecret, assertTrustedOrigins } from './better-auth-env'
import type { BetterAuthLike } from './better-auth-port'
import {
  type BetterAuthTables,
  betterAuthDrizzleSchema,
  withBetterAuthRelations,
} from './better-auth-schema'
import { createSessionAccountGuard, InactiveSessionError } from './better-auth-session-guard'
import { sessionCookieName } from './cookie-name'
import { createFirstSessionAfterHook, type FirstSessionHandler } from './first-session-hook'
import { logBetterAuthEvent } from './logging/better-auth-logger'
import { createKitOrganizationPlugin } from './org-plugin'
import { isAccountActive } from './repos/account-state'
import { hashVerificationIdentifier } from './verification-identifier'

/**
 * Hono context surface for BA instance (handler + session API).
 * Structural type — avoids TS2742 when plugins (magicLink) pull non-portable zod paths
 * into `ReturnType<typeof createBetterAuth>` under declaration emit.
 */
export type KitBetterAuth = BetterAuthLike & {
  handler: (request: Request) => Response | Promise<Response>
}

export type BetterAuthDatabase = KitD1Database

export type CreateBetterAuthOpts = {
  /** `@kit/db` `KitD1Database` binding (or test double). */
  database: BetterAuthDatabase
  secret: string
  baseURL: string
  trustedOrigins: string[]
  /** Loopback origins allowed only for explicit development|test adapters. Default false. */
  allowLoopbackOrigins?: boolean
  /**
   * When true, `baseURL` may be the request Host (dev without BETTER_AUTH_URL).
   * Token href allowlist is then `trustedOrigins` only — a poisoned Host cannot
   * self-allowlist. Default false: pin `baseURL` origin into the allowlist.
   */
  requestDerivedBaseURL?: boolean
  /** When set, registers magic-link + password-reset send. Omit for password-only peers. */
  emailPort?: AuthEmailPort
  schema?: BetterAuthTables
  cookieName?: string
  useSecureCookies?: boolean
  allowPublicSignup?: boolean
  /** Product typically wires audit `tryFirstLogin`. Omit if audit module is not mounted. */
  onFirstSession?: FirstSessionHandler
  magicLinkExpiresIn?: number
  resetPasswordTokenExpiresIn?: number
  /** Only for explicit development|test placeholders — never production. */
  allowKitPlaceholderSecret?: boolean
}

export function createBetterAuth(opts: CreateBetterAuthOpts): KitBetterAuth {
  assertAuthSecret('BETTER_AUTH_SECRET', opts.secret, {
    allowKitPlaceholder: opts.allowKitPlaceholderSecret,
  })
  const trustedOrigins = assertTrustedOrigins(opts.trustedOrigins, {
    allowLoopback: opts.allowLoopbackOrigins === true,
  })
  const schema =
    !opts.schema || opts.schema === betterAuthDrizzleSchema
      ? betterAuthDrizzleSchema
      : withBetterAuthRelations(opts.schema)
  // drizzle-orm/d1 names the workers `D1Database` type; the public contract is `@kit/db` `KitD1Database`.
  const db = drizzle(opts.database as never, { schema })
  const cookieName = sessionCookieName({ name: opts.cookieName })
  const secure = opts.useSecureCookies ?? true
  const publicSignup = opts.allowPublicSignup ?? false
  const emailPort = opts.emailPort
  const linkOrigins = new Set<string>(trustedOrigins)
  let base: URL
  try {
    base = new URL(opts.baseURL)
  } catch {
    throw new Error('BETTER_AUTH_URL must be an absolute origin')
  }
  if (!opts.requestDerivedBaseURL) linkOrigins.add(base.origin)
  // Better Auth routes on a baseURL path when there is one; the kit throttle matches BA_BASE_PATH.
  const mount = base.pathname.replace(/\/+$/, '')
  if (mount !== '' && mount !== BA_BASE_PATH) {
    throw new Error(`BETTER_AUTH_URL path must be / or ${BA_BASE_PATH}`)
  }
  const tokenHref = {
    allowedOrigins: [...linkOrigins],
    allowLoopbackHttp: opts.allowLoopbackOrigins === true,
  }

  const auth = betterAuth({
    baseURL: opts.baseURL,
    basePath: BA_BASE_PATH,
    // Leave Better Auth's default warn threshold intact; its messages and args are untrusted.
    logger: { log: logBetterAuthEvent },
    // Better Call otherwise logs the raw non-API error after Better Auth's logger returns.
    onAPIError: { throw: true },
    // The kit throttles in front, on D1 (`@kit/auth/repos/ba-throttle`). Better Auth's own limiter
    // is memory per isolate, keyed `ip|path`, and on only when NODE_ENV is 'production': pinned off.
    rateLimit: { enabled: false },
    secret: opts.secret,
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema,
    }),
    hooks: { before: createSessionAccountGuard(db, schema) },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            let active = false
            try {
              active = await isAccountActive(db, session.userId, schema.user)
            } catch {
              // An unreadable account state must never issue a session.
            }
            if (!active) {
              throw new APIError('UNAUTHORIZED', { message: 'Invalid email or password' })
            }
          },
          after: createFirstSessionAfterHook(opts.onFirstSession),
        },
      },
    },
    verification: { storeIdentifier: { hash: hashVerificationIdentifier } },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !publicSignup,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn:
        opts.resetPasswordTokenExpiresIn ?? RESET_PASSWORD_TOKEN_EXPIRES_IN_SEC,
      ...(emailPort
        ? {
            sendResetPassword: async ({ user, url }) => {
              await sendResetPasswordMail(emailPort, { email: user.email, url, ...tokenHref })
            },
          }
        : {}),
    },
    plugins: [
      createKitOrganizationPlugin(),
      ...(emailPort
        ? [
            magicLink({
              expiresIn: opts.magicLinkExpiresIn ?? MAGIC_LINK_EXPIRES_IN_SEC,
              disableSignUp: !publicSignup,
              sendMagicLink: async ({ email, url }) => {
                await sendMagicLinkMail(emailPort, { email, url, ...tokenHref })
              },
            }),
          ]
        : []),
    ],
    advanced: {
      disableOriginCheck: false,
      database: { joins: true },
      useSecureCookies: secure,
      cookies: {
        session_token: {
          name: cookieName,
          attributes: {
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            secure,
          },
        },
      },
    },
    trustedOrigins,
  })
  const handler = auth.handler
  const safeHandler = async (request: Request): Promise<Response> => {
    try {
      const response = await handler(request)
      if (response.status >= 500) console.error('[Better Auth] server_error_response')
      return response
    } catch (error) {
      if (isAPIError(error)) throw error
      console.error('[Better Auth] handler_exception')
      return new Response(null, { status: 500, statusText: 'Internal Server Error' })
    }
  }
  auth.api.getSession = new Proxy(auth.api.getSession, {
    async apply(target, thisArg, args) {
      try {
        return await Reflect.apply(target, thisArg, args)
      } catch (error) {
        const options = args[0] as
          | { asResponse?: boolean; returnHeaders?: boolean; returnStatus?: boolean }
          | undefined
        if (
          error instanceof InactiveSessionError &&
          !options?.asResponse &&
          !options?.returnHeaders &&
          !options?.returnStatus
        )
          return null
        throw error
      }
    },
  })
  auth.handler = safeHandler
  auth.fetch = safeHandler
  return auth
}
