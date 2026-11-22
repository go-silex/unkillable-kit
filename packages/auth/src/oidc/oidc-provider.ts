import { defineRequestState } from '@better-auth/core/context'
import { oauthProvider } from '@better-auth/oauth-provider'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { jwt } from 'better-auth/plugins'
import type { KitBetterAuth } from '../better-auth-factory'
import type { OidcProviderConfig } from './oidc-config'
import { oidcFreshLoginGuard } from './oidc-fresh-login-guard'
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

const protectedClaims = (
  'iss sub aud exp nbf iat jti auth_time nonce acr amr azp sid at_hash c_hash s_hash ' +
  'email email_verified name picture given_name family_name middle_name nickname ' +
  'preferred_username profile website gender birthdate zoneinfo locale phone_number ' +
  'phone_number_verified address updated_at client_id scope cnf events token_type ' +
  '__proto__ constructor'
).split(' ')

function withOidcMetadataPolicy(provider: ReturnType<typeof oauthProvider>) {
  const onRequest = provider.onRequest
  return {
    ...provider,
    onRequest: async (...args: Parameters<NonNullable<typeof onRequest>>) => {
      const result = await onRequest?.(...args)
      if (!(result && 'response' in result)) return result
      const response = result.response
      if (!response.ok) return result
      const headers = new Headers(response.headers)
      headers.delete('content-length')
      if (args[0].method === 'HEAD') {
        return { ...result, response: new Response(null, { status: response.status, headers }) }
      }
      const metadata = (await response.clone().json()) as Record<string, unknown>
      if (!('claims_parameter_supported' in metadata)) return result
      metadata.claims_parameter_supported = false
      return {
        ...result,
        response: new Response(JSON.stringify(metadata), {
          status: response.status,
          statusText: response.statusText,
          headers,
        }),
      }
    },
  }
}

/** Separate entry point keeps the provider peer out of the default factory import. */
export function createOidcProvider(options: OidcProviderOptions): OidcProviderConfig {
  return {
    waitUntil: options.waitUntil,
    plugins: (isActive) => {
      const userInfoScopes = defineRequestState<string[] | undefined>(() => undefined)
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
                matcher: (ctx) => ctx.path === '/oauth2/token',
                handler: createAuthMiddleware(async (ctx) => {
                  if (ctx.body?.resource !== undefined) {
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
                  const scopes = await userInfoScopes.get()
                  if (!scopes) {
                    throw new APIError('INTERNAL_SERVER_ERROR', {
                      message: 'Missing UserInfo scopes',
                    })
                  }
                  const {
                    picture: _picture,
                    given_name: _given,
                    family_name: _family,
                    ...safe
                  } = result as Record<string, unknown>
                  if (!scopes.includes('email')) {
                    delete safe.email
                    delete safe.email_verified
                  }
                  if (!scopes.includes('profile')) delete safe.name
                  return ctx.json(safe)
                }),
              },
            ],
          },
        },
        oidcFreshLoginGuard,
        // OpenID Connect Core §15.1 requires RS256 support; the JWT plugin defaults to EdDSA.
        jwt({ jwks: { keyPairConfig: { alg: 'RS256' } }, disableSettingJwtHeader: true }),
        withOidcMetadataPolicy(
          oauthProvider({
            loginPage: options.loginPage,
            consentPage: options.consentPage ?? options.loginPage,
            scopes: ['openid', 'email', 'profile'],
            grantTypes: ['authorization_code'],
            allowDynamicClientRegistration: false,
            advertisedMetadata: {
              claims_supported: [
                'iss',
                'sub',
                'aud',
                'exp',
                'iat',
                'auth_time',
                'nonce',
                'acr',
                'sid',
                'at_hash',
                'email',
                'email_verified',
                'name',
              ],
            },
            customTokenResponseFields: async ({ user, scopes, verificationValue }) => {
              if (!user) throw new APIError('UNAUTHORIZED', { message: 'Unauthorized' })
              await assertActive(user.id)
              if (!scopes.includes('openid'))
                throw new APIError('BAD_REQUEST', {
                  error: 'invalid_scope',
                  error_description: 'openid scope is required',
                })
              if (!verificationValue || verificationValue.query.claims !== undefined) {
                throw new APIError('BAD_REQUEST', {
                  error: 'invalid_request',
                  error_description: 'claims requests are not supported',
                })
              }
              if (
                verificationValue.resource?.length ||
                verificationValue.query.resource !== undefined
              ) {
                throw new APIError('BAD_REQUEST', {
                  error: 'invalid_target',
                  error_description: 'resource indicators are not supported',
                })
              }
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
              await userInfoScopes.set(scopes)
              return userClaims(user, scopes)
            },
          }),
        ),
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
      scope: string
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
    scopes?: string[]
    postLogoutRedirectUris?: string[]
    backchannelLogoutUri?: string
  },
) {
  const scopes = input.scopes ?? ['openid', 'email', 'profile']
  if (!scopes.includes('openid')) {
    throw new APIError('BAD_REQUEST', {
      error: 'invalid_scope',
      error_description: 'openid scope is required',
    })
  }
  const api = auth.api as unknown as AdminClientApi
  return api.adminCreateOAuthClient({
    headers: input.headers,
    body: {
      redirect_uris: input.redirectUris,
      client_name: input.name,
      scope: scopes.join(' '),
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
