import { OAuthError, type TokenExchangeCallbackOptions } from '@cloudflare/workers-oauth-provider'
import { type AuthorizationFact, authorizeHostedPrincipal } from '@kit/auth/snapshot'
import { type HostedMcpEnv, stripOauthHelper } from './env'

export type GrantPrincipal = { userId: string; grantId: string; clientId: string }
type GrantType = 'authorization_code' | 'refresh_token'

export type GrantAdmission<Env extends HostedMcpEnv> = (
  input: GrantPrincipal & ({ phase: 'request' } | { phase: 'token'; grantType: GrantType }),
  env: Env,
) => Promise<boolean>

function unavailable(): OAuthError {
  return new OAuthError('temporarily_unavailable', {
    description: 'Service unavailable',
    statusCode: 503,
    headers: { 'Cache-Control': 'no-store' },
  })
}

export function tokenAdmission<Env extends HostedMcpEnv>(
  admission: GrantAdmission<Env> | undefined,
  denyFact: AuthorizationFact<unknown> | undefined,
) {
  return async ({
    grantType,
    userId,
    grantId,
    clientId,
    env,
  }: TokenExchangeCallbackOptions<Env>) => {
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') throw unavailable()
    const principal = { userId, grantId, clientId }
    const outcome = await authorizeHostedPrincipal({
      db: env.DB,
      principal,
      ...(denyFact ? { denyFact } : {}),
      ...(admission
        ? {
            admit: () =>
              admission({ phase: 'token', grantType, ...principal }, stripOauthHelper(env)),
          }
        : {}),
    })
    if (outcome.status === 'denied') {
      throw new OAuthError('invalid_grant', { description: 'Authorization revoked' })
    }
    if (outcome.status === 'unavailable') throw unavailable()
  }
}
