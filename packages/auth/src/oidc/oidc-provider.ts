import { oauthProvider } from '@better-auth/oauth-provider'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { jwt } from 'better-auth/plugins'
import type { KitBetterAuth } from '../better-auth-factory'
import type { OidcProviderConfig } from './oidc-config'
import { createOidcLogoutPlugin } from './oidc-logout'

export { endOidcUserSessions } from './oidc-logout'

export type OidcProviderOptions = {
  loginPage: string
  consentPage?: string
  claims?: (input: {
    user: { id: string; email: string; emailVerified: boolean; name: string }
  }) => Promise<Record<string, unknown>> | Record<string, unknown>
  /** Bind to the execution context of the request that created the auth instance. */
  waitUntil: (promise: Promise<unknown>) => void
}

const protectedClaims = [
  'iss',
  'sub',
  'aud',
  'exp',
  'nbf',
  'iat',
  'jti',
  'auth_time',
  'nonce',
  'acr',
  'amr',
  'azp',
  'sid',
  'at_hash',
  'c_hash',
  's_hash',
  'email',
  'email_verified',
  'name',
  'picture',
  'given_name',
  'family_name',
  'middle_name',
  'nickname',
  'preferred_username',
  'profile',
  'website',
  'gender',
  'birthdate',
  'zoneinfo',
  'locale',
  'phone_number',
  'phone_number_verified',
  'address',
  'updated_at',
  'client_id',
  'scope',
  'cnf',
  'events',
  'token_type',
  '__proto__',
  'constructor',
]

function validateAuthorizeQuery(query: URLSearchParams): void {
  if (!query.get('scope')?.split(/\s+/).includes('openid')) {
    throw new APIError('BAD_REQUEST', {
      error: 'invalid_scope',
      error_description: 'openid scope is required',
    })
  }
  if (query.has('claims')) {
    throw new APIError('BAD_REQUEST', {
      error: 'invalid_request',
      error_description: 'claims requests are not supported',
    })
  }
  if (query.has('resource')) {
    throw new APIError('BAD_REQUEST', {
      error: 'invalid_target',
      error_description: 'resource indicators are not supported',
    })
  }
}

/** Separate entry point keeps the provider peer out of the default factory import. */
export function createOidcProvider(options: OidcProviderOptions): OidcProviderConfig {
  return {
    waitUntil: options.waitUntil,
    plugins: (isActive) => {
      const assertActive = async (userId: string) => {
        let active = false
        try {
          active = await isActive(userId)
        } catch {
          // Unreadable account state is not authorization.
        }
        if (!active) throw new APIError('UNAUTHORIZED', { message: 'Unauthorized' })
      }
      const userClaims = async (
        user: { id: string; email: string; emailVerified: boolean; name: string },
        scopes: string[],
      ) => {
        const custom = options.claims ? await options.claims({ user }) : {}
        const safe = Object.fromEntries(
          Object.entries(custom).filter(([key]) => !protectedClaims.includes(key)),
        )
        return {
          ...safe,
          ...(scopes.includes('email')
            ? { email: user.email, email_verified: user.emailVerified }
            : {}),
          ...(scopes.includes('profile') ? { name: user.name } : {}),
        }
      }
      return [
        {
          id: 'kit-oidc-policy',
          hooks: {
            before: [
              {
                matcher: (ctx) => ctx.path === '/oauth2/authorize' || ctx.path === '/oauth2/token',
                handler: createAuthMiddleware(async (ctx) => {
                  if (ctx.path === '/oauth2/authorize') {
                    validateAuthorizeQuery(new URL(ctx.request!.url).searchParams)
                  } else if (ctx.body?.resource !== undefined) {
                    throw new APIError('BAD_REQUEST', {
                      error: 'invalid_target',
                      error_description: 'resource indicators are not supported',
                    })
                  }
                }),
              },
            ],
            after: [
              {
                matcher: (ctx) => ctx.path === '/oauth2/userinfo',
                handler: createAuthMiddleware(async (ctx) => {
                  const result = ctx.context.returned
                  if (
                    !result ||
                    typeof result !== 'object' ||
                    result instanceof Response ||
                    result instanceof Error
                  )
                    return
                  const {
                    picture: _picture,
                    given_name: _given,
                    family_name: _family,
                    ...safe
                  } = result as Record<string, unknown>
                  return ctx.json(safe)
                }),
              },
            ],
          },
        },
        jwt({ jwks: { keyPairConfig: { alg: 'RS256' } }, disableSettingJwtHeader: true }),
        oauthProvider({
          loginPage: options.loginPage,
          consentPage: options.consentPage ?? options.loginPage,
          scopes: ['openid', 'email', 'profile'],
          grantTypes: ['authorization_code'],
          allowDynamicClientRegistration: false,
          customTokenResponseFields: async ({ user, scopes }) => {
            if (!user) throw new APIError('UNAUTHORIZED', { message: 'Unauthorized' })
            await assertActive(user.id)
            if (!scopes.includes('openid'))
              throw new APIError('BAD_REQUEST', {
                error: 'invalid_scope',
                error_description: 'openid scope is required',
              })
            return {}
          },
          customAccessTokenClaims: ({ resources }) => {
            // The provider also invokes this when validating opaque tokens.
            if (resources?.length) {
              throw new APIError('BAD_REQUEST', {
                error: 'invalid_target',
                error_description: 'resource indicators are not supported',
              })
            }
            return {}
          },
          customIdTokenClaims: ({ user, scopes }) => userClaims(user, scopes),
          customUserInfoClaims: async ({ user, scopes }) => {
            await assertActive(user.id)
            return userClaims(user, scopes)
          },
        }),
        createOidcLogoutPlugin(),
      ]
    },
  }
}

type AdminClientApi = {
  adminCreateOAuthClient: (input: {
    headers: Headers
    body: {
      redirect_uris: string[]
      client_name?: string
      token_endpoint_auth_method: 'client_secret_basic'
      application_type: 'web'
      grant_types: ['authorization_code']
      response_types: ['code']
      require_pkce: true
      skip_consent: boolean
      enable_end_session: true
      post_logout_redirect_uris?: string[]
      backchannel_logout_uri?: string
    }
  }) => Promise<{ client_id: string; client_secret?: string | null }>
}

/** The calling route must authorize the administrator and validate its Origin. */
export async function registerOidcClient(
  auth: KitBetterAuth,
  input: {
    headers: Headers
    redirectUris: string[]
    name?: string
    firstParty: boolean
    postLogoutRedirectUris?: string[]
    backchannelLogoutUri?: string
  },
) {
  const api = auth.api as unknown as AdminClientApi
  return api.adminCreateOAuthClient({
    headers: input.headers,
    body: {
      redirect_uris: input.redirectUris,
      client_name: input.name,
      token_endpoint_auth_method: 'client_secret_basic',
      application_type: 'web',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      require_pkce: true,
      skip_consent: input.firstParty,
      enable_end_session: true,
      post_logout_redirect_uris: input.postLogoutRedirectUris,
      backchannel_logout_uri: input.backchannelLogoutUri,
    },
  })
}
