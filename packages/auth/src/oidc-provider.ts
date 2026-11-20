import { oauthProvider } from '@better-auth/oauth-provider'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError } from 'better-auth/api'
import { jwt } from 'better-auth/plugins'
import type { KitBetterAuth } from './better-auth-factory'

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

export type OidcProviderConfig = {
  waitUntil: (promise: Promise<unknown>) => void
  plugins: (isActive: (userId: string) => Promise<boolean>) => BetterAuthPlugin[]
}

/** Separate entry point keeps the provider peer out of the default factory import. */
export function createOidcProvider(options: OidcProviderOptions): OidcProviderConfig {
  const claims = options.claims
  const userClaims = async (
    user: { id: string; email: string; emailVerified: boolean; name: string },
    isActive: (userId: string) => Promise<boolean>,
  ) => {
    let active = false
    try {
      active = await isActive(user.id)
    } catch {
      // Fail closed when the account state is unreadable.
    }
    if (!active) throw new APIError('UNAUTHORIZED', { message: 'Unauthorized' })
    return {
      ...(claims ? await claims({ user }) : {}),
      email: user.email,
      email_verified: user.emailVerified,
      name: user.name,
    }
  }
  return {
    waitUntil: options.waitUntil,
    plugins: (isActive) => [
      jwt({ jwks: { keyPairConfig: { alg: 'RS256' } }, disableSettingJwtHeader: true }),
      oauthProvider({
        loginPage: options.loginPage,
        consentPage: options.consentPage ?? options.loginPage,
        scopes: ['openid', 'email', 'profile'],
        grantTypes: ['authorization_code'],
        requireOpenId: true,
        allowDynamicClientRegistration: false,
        customIdTokenClaims: ({ user }) => userClaims(user, isActive),
        customUserInfoClaims: ({ user }) => userClaims(user, isActive),
      }),
    ],
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
