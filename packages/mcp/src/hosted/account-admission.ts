import { isAccountActive } from '@kit/auth/repos/account-state'
import { drizzle } from 'drizzle-orm/d1'
import type { HostedMcpEnv } from './env'

export function accountIsActive(userId: string, env: HostedMcpEnv): Promise<boolean> {
  return isAccountActive(drizzle(env.DB), userId)
}

export async function accountAdmissionResponse(
  userId: string,
  env: HostedMcpEnv,
): Promise<Response | null> {
  try {
    if (await accountIsActive(userId, env)) return null
    return new Response('Unauthorized', { status: 401 })
  } catch {
    return new Response('Service unavailable', {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
}
