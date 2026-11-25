import { OAuthError, type TokenExchangeCallbackOptions } from '@cloudflare/workers-oauth-provider'
import { authorizeHostedPrincipal } from '@kit/auth/snapshot'
import { type HostedMcpEnv, stripOauthHelper } from './env'

export type GrantPrincipal = { userId: string; grantId: string; clientId: string }
type GrantType = 'authorization_code' | 'refresh_token'
type GrantAdmissionInput = GrantPrincipal &
  ({ phase: 'request' } | { phase: 'token'; grantType: GrantType })

export type GrantAdmission<Env extends HostedMcpEnv> = (
  input: GrantAdmissionInput,
  env: Env,
) => Promise<boolean>

export async function runGrantAdmission<Env extends HostedMcpEnv>(
  admission: GrantAdmission<Env>,
  input: GrantAdmissionInput,
  env: Env,
): Promise<'allowed' | 'denied' | 'unavailable'> {
  try {
    const result = await admission(input, env)
    if (result === true) return 'allowed'
    if (result === false) return 'denied'
    return 'unavailable'
  } catch {
    return 'unavailable'
  }
}

function unavailable(): OAuthError {
  return new OAuthError('temporarily_unavailable', {
    description: 'Service unavailable',
    statusCode: 503,
    headers: { 'Cache-Control': 'no-store' },
  })
}

export function tokenAdmission<Env extends HostedMcpEnv>(
  admission: GrantAdmission<Env> | undefined,
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
    const account = await authorizeHostedPrincipal({ db: env.DB, principal })
    const status =
      account.status === 'allowed' && admission
        ? await runGrantAdmission(
            admission,
            { phase: 'token', grantType, ...principal },
            stripOauthHelper(env),
          )
        : account.status
    if (status === 'denied') {
      throw new OAuthError('invalid_grant', { description: 'Authorization revoked' })
    }
    if (status === 'unavailable') throw unavailable()
  }
}
