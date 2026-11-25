import type { KitD1Database } from '@kit/db'
import type { BetterAuthLike } from './better-auth-port'
import { requestSessionCookie } from './request/effective-session-cookie'
import { loadCore } from './snapshot/core-load'
import type { SessionIdentity } from './snapshot/core-rows'
import {
  type HostedPrincipal,
  type HostedPrincipalInput,
  readHostedPrincipal,
  sealHostedPrincipal,
} from './snapshot/hosted-principal'

export type { HostedPrincipal, HostedPrincipalInput }
export type HostedAdmission =
  | Readonly<{ status: 'allowed'; principal: HostedPrincipal }>
  | Readonly<{ status: 'denied' }>
  | Readonly<{ status: 'unavailable' }>

/** Probe the actual issuer's read-only session path without a refresh or cookie write. */
export async function resolveRequestSession(input: {
  db: KitD1Database
  headers: Headers
  auth: BetterAuthLike
}): Promise<SessionIdentity | null> {
  const { identity } = await loadCore({
    db: () => input.db,
    cookie: requestSessionCookie(input.auth, input.headers.get('cookie')),
  })
  return identity?.method === 'session' ? identity : null
}

/** The OAuth shell supplies provider-verified IDs; Kit checks live User state and seals the tuple. */
export async function authorizeHostedPrincipal(input: {
  db: KitD1Database
  principal: HostedPrincipalInput
}): Promise<HostedAdmission> {
  try {
    const hosted = readHostedPrincipal(input.principal)
    if (!hosted) return { status: 'denied' }
    const { identity } = await loadCore({ db: () => input.db, hosted })
    if (identity?.method !== 'mcp') return { status: 'denied' }
    return Object.freeze({ status: 'allowed', principal: sealHostedPrincipal(hosted) })
  } catch {
    return { status: 'unavailable' }
  }
}
