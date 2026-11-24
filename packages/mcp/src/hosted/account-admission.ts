import { authorizeHostedPrincipal } from '@kit/auth/snapshot'
import type { HostedMcpEnv } from './env'

export async function accountAdmissionResponse(
  userId: string,
  env: HostedMcpEnv,
): Promise<Response | null> {
  const { status } = await authorizeHostedPrincipal({ db: env.DB, principal: { userId } })
  if (status === 'allowed') return null
  if (status === 'denied') return new Response('Unauthorized', { status: 401 })
  return new Response('Service unavailable', {
    status: 503,
    headers: { 'Cache-Control': 'no-store' },
  })
}
