/**
 * Per-request Better Auth factory (CF Workers pattern, ADR-0002 + ADR-0008 D6).
 * Products import this — they do not copy `example-api/src/lib/better-auth.ts`.
 */
import type { KitD1Database } from '@kit/db'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError, isAPIError } from 'better-auth/api'
// The minimal initializer leaves out Kysely and its migration runner; the factory supplies Drizzle.
import { betterAuth } from 'better-auth/minimal'
import { magicLink } from 'better-auth/plugins'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import {
  type AuthEmailOptions,
  assertEmailConfig,
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
import { apiErrorOptions, authenticationLinkOrigins } from './better-auth-urls'
import { sessionCookieName } from './cookie-name'
import { createFirstSessionAfterHook, type FirstSessionHandler } from './first-session-hook'
import {
  type GoogleSignInOptions,
  googleAccountHooks,
  googleConfiguration,
  googleRedirectOnlyPlugins,
} from './google/sign-in'
import { logBetterAuthEvent } from './logging/better-auth-logger'
import { type OidcProviderConfig, providerComposition } from './oidc/oidc-config'
import { registerLogoutD1 } from './oidc/oidc-logout-planning'
import { withOptionalOidcSchema } from './oidc/oidc-provider-schema'
import { createKitOrganizationPlugin } from './org-plugin'
import { createSessionAccountGuard, InactiveSessionError } from './policy/better-auth-session-guard'
import { isAccountActive } from './repos/account-state'
import { recordSessionCookie } from './request/effective-session-cookie'
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
  schema?: BetterAuthTables
  cookieName?: string
  useSecureCookies?: boolean
  allowPublicSignup?: boolean
  google?: GoogleSignInOptions
  /** Absolute trusted App login URL for Google errors when OAuth state cannot supply one. */
  googleErrorURL?: string
  /** Product typically wires audit `tryFirstLogin`. Omit if audit module is not mounted. */
  onFirstSession?: FirstSessionHandler
  magicLinkExpiresIn?: number
  resetPasswordTokenExpiresIn?: number
  /** Only for explicit development|test placeholders — never production. */
  allowKitPlaceholderSecret?: boolean
  /** Opt-in provider composition, created by the separate @kit/auth/oidc-provider entry. */
  oidcProvider?: OidcProviderConfig
} & AuthEmailOptions

function createSafeHandler(handler: (request: Request) => Response | Promise<Response>) {
  return async (request: Request): Promise<Response> => {
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
}

export function createBetterAuth(opts: CreateBetterAuthOpts): KitBetterAuth {
  assertAuthSecret('BETTER_AUTH_SECRET', opts.secret, {
    allowKitPlaceholder: opts.allowKitPlaceholderSecret,
  })
  const trustedOrigins = assertTrustedOrigins(opts.trustedOrigins, {
    allowLoopback: opts.allowLoopbackOrigins === true,
  })
  const baseSchema =
    !opts.schema || opts.schema === betterAuthDrizzleSchema
      ? betterAuthDrizzleSchema
      : withBetterAuthRelations(opts.schema)
  const schema = withOptionalOidcSchema(baseSchema, opts.oidcProvider !== undefined)
  // drizzle-orm/d1 names the workers `D1Database` type; the public contract is `@kit/db` `KitD1Database`.
  const db = drizzle(opts.database as never, { schema })
  const provider = providerComposition(
    opts.oidcProvider,
    (id) => isAccountActive(db, id, schema.user),
    opts.database,
  )
  const cookieName = sessionCookieName({ name: opts.cookieName })
  const secure = opts.useSecureCookies ?? true
  const publicSignup = opts.allowPublicSignup ?? false
  const { emailPort, emailConfig } = opts
  assertEmailConfig(emailPort, emailConfig)
  // Better Auth treats falsy overrides as unset when issuing tokens.
  const magicLinkExpiresIn = opts.magicLinkExpiresIn || MAGIC_LINK_EXPIRES_IN_SEC
  const resetPasswordTokenExpiresIn =
    opts.resetPasswordTokenExpiresIn || RESET_PASSWORD_TOKEN_EXPIRES_IN_SEC
  const tokenHref = {
    allowedOrigins: authenticationLinkOrigins(opts, trustedOrigins),
    allowLoopbackHttp: opts.allowLoopbackOrigins === true,
  }
  const google = opts.google !== undefined
  const auth = betterAuth({
    baseURL: opts.baseURL,
    basePath: BA_BASE_PATH,
    disabledPaths: provider.disabledPaths,
    // Leave Better Auth's default warn threshold intact; its messages and args are untrusted.
    logger: { log: logBetterAuthEvent },
    // Better Call otherwise logs the raw non-API error after Better Auth's logger returns.
    onAPIError: apiErrorOptions(google, trustedOrigins, opts.googleErrorURL),
    // The kit throttles in front, on D1 (`@kit/auth/repos/ba-throttle`). Better Auth's own limiter
    // is memory per isolate, keyed `ip|path`, and on only when NODE_ENV is 'production': pinned off.
    rateLimit: { enabled: false },
    secret: opts.secret,
    session: { cookieCache: { enabled: false } },
    database: ((options) =>
      registerLogoutD1(
        drizzleAdapter(db, { provider: 'sqlite', schema })(options),
        opts.database,
      )) as ReturnType<typeof drizzleAdapter>,
    hooks: { before: createSessionAccountGuard(db, schema) },
    databaseHooks: {
      account: google ? googleAccountHooks : undefined,
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
              throw new APIError('UNAUTHORIZED', {
                message: 'Invalid email or password',
                ...(google ? { code: 'account_inactive' } : {}),
              })
            }
          },
          after: createFirstSessionAfterHook(opts.onFirstSession),
        },
      },
    },
    verification: { storeIdentifier: { hash: hashVerificationIdentifier } },
    ...googleConfiguration(opts.google, async (id) => {
      const [existing] = await db
        .select({ email: schema.user.email })
        .from(schema.user)
        .where(eq(schema.user.id, id))
        .limit(1)
        .catch(() => [])
      const active = await isAccountActive(db, id, schema.user).catch(() => false)
      return existing && { email: existing.email, active }
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !publicSignup,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn,
      ...(emailPort && emailConfig
        ? {
            sendResetPassword: async ({ user, url, token }) => {
              const callback = new URL(url)
              const redirectTo = callback.searchParams.get('callbackURL')
              // Better Auth invokes this only for known accounts. Returning silently
              // preserves its generic response when no redirect was supplied.
              if (!redirectTo) return
              callback.pathname = callback.pathname.slice(
                0,
                callback.pathname.lastIndexOf('/reset-password/'),
              )
              callback.search = ''
              const resetUrl = new URL(redirectTo, callback)
              resetUrl.searchParams.set('token', token)
              await sendResetPasswordMail(emailPort, {
                email: user.email,
                url: resetUrl.href,
                emailConfig,
                expiresInSec: resetPasswordTokenExpiresIn,
                ...tokenHref,
              })
            },
          }
        : {}),
    },
    plugins: [
      createKitOrganizationPlugin(),
      ...provider.plugins,
      ...googleRedirectOnlyPlugins(google),
      ...(emailPort && emailConfig
        ? [
            magicLink({
              expiresIn: magicLinkExpiresIn,
              disableSignUp: !publicSignup,
              sendMagicLink: async ({ email, url }) => {
                await sendMagicLinkMail(emailPort, {
                  email,
                  url,
                  emailConfig,
                  expiresInSec: magicLinkExpiresIn,
                  ...tokenHref,
                })
              },
            }),
          ]
        : []),
    ],
    advanced: {
      disableOriginCheck: false,
      backgroundTasks: provider.backgroundTasks,
      database: { joins: true },
      useSecureCookies: secure,
      cookies: {
        session_token: {
          name: cookieName,
          attributes: { httpOnly: true, sameSite: 'lax', path: '/', secure },
        },
      },
    },
    trustedOrigins,
  })
  const handle = createSafeHandler(auth.handler)
  auth.fetch = auth.handler = (request) =>
    provider.protectResponse?.(request, handle) ?? handle(request)
  auth.api.getSession = new Proxy(auth.api.getSession, {
    async apply(target, thisArg, args) {
      try {
        return await Reflect.apply(target, thisArg, args)
      } catch (error) {
        const options = args[0] as
          | { asResponse?: boolean; returnHeaders?: boolean; returnStatus?: boolean }
          | undefined
        const rawSession = !(options?.asResponse || options?.returnHeaders || options?.returnStatus)
        if (error instanceof InactiveSessionError && rawSession) return null
        throw error
      }
    },
  })
  recordSessionCookie(auth, secure ? `__Secure-${cookieName}` : cookieName, opts.secret)
  return auth
}
