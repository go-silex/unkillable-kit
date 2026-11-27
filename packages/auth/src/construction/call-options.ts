import type { CreateBetterAuthOpts } from '../better-auth-factory'
import { betterAuthDrizzleSchema, withBetterAuthRelations } from '../better-auth-schema'
import type { OidcProviderConfig } from '../oidc/oidc-config'
import { withOptionalOidcSchema } from '../oidc/oidc-provider-schema'

/**
 * Reads each factory option once, at the call, as the factory always did. The instance is built
 * on the first use of its handle: a caller that reuses or changes its options object meanwhile must
 * not change what an earlier handle builds with.
 */
export function readCallOptions(input: CreateBetterAuthOpts): CreateBetterAuthOpts {
  const options = {
    database: input.database,
    secret: input.secret,
    baseURL: input.baseURL,
    trustedOrigins: input.trustedOrigins,
    allowLoopbackOrigins: input.allowLoopbackOrigins,
    requestDerivedBaseURL: input.requestDerivedBaseURL,
    schema: input.schema,
    cookieName: input.cookieName,
    useSecureCookies: input.useSecureCookies,
    allowPublicSignup: input.allowPublicSignup,
    google: input.google,
    googleErrorURL: input.googleErrorURL,
    onFirstSession: input.onFirstSession,
    magicLinkExpiresIn: input.magicLinkExpiresIn,
    resetPasswordTokenExpiresIn: input.resetPasswordTokenExpiresIn,
    allowKitPlaceholderSecret: input.allowKitPlaceholderSecret,
    oidcProvider: pinProvider(input.oidcProvider),
    emailPort: input.emailPort,
    emailConfig: input.emailConfig,
  } satisfies Record<keyof CreateBetterAuthOpts, unknown>
  return options as CreateBetterAuthOpts
}

/** The provider's methods as they are at the call; `compose` still runs on the provider itself. */
function pinProvider(provider: OidcProviderConfig | undefined): OidcProviderConfig | undefined {
  if (!provider) return undefined
  const { waitUntil, compose } = provider
  return { waitUntil, compose: (isActive, database) => compose.call(provider, isActive, database) }
}

/** The instance's tables, composed at the call from the schema map as it is then. */
export function authSchema(options: CreateBetterAuthOpts) {
  const tables =
    !options.schema || options.schema === betterAuthDrizzleSchema
      ? betterAuthDrizzleSchema
      : withBetterAuthRelations(options.schema)
  return withOptionalOidcSchema(tables, options.oidcProvider !== undefined)
}
