import type { KitD1Database } from '@kit/db'
import type { Authorization } from './oidc-fresh-login-provenance'

type SessionIdentity = { id: string; userId: string; createdAt: Date | string | number }
type Proof = {
  method: unknown
  authenticated_at: unknown
  created_at: unknown
  expires_at: unknown
  user_id: unknown
}

export function createOidcSessionAuthentication(db: KitD1Database) {
  return {
    async record({ id, createdAt }: SessionIdentity) {
      const timestamp = new Date(createdAt).getTime()
      if (!(id && Number.isSafeInteger(timestamp)) || timestamp <= 0)
        throw new Error('Invalid password session')
      await db
        .prepare(
          'INSERT INTO oidc_session_authentication (session_id, method, authenticated_at) VALUES (?, ?, ?)',
        )
        .bind(id, 'password', timestamp)
        .run()
    },
    async qualifies(
      identity: { id?: string; userId?: string; authTime?: number; token?: string },
      authorization: Authorization,
    ) {
      const { freshness, expiresAt, startedAt } = authorization
      if (!freshness) return true
      const lookup = identity.id ? 's.id' : 's.token'
      const match = identity.id ?? identity.token
      if (!match) return false
      const proof = await db
        .prepare(`SELECT p.method, p.authenticated_at, s.created_at, s.expires_at, s.user_id
        FROM session s INNER JOIN oidc_session_authentication p ON p.session_id = s.id WHERE ${lookup} = ?`)
        .bind(match)
        .first<Proof>()
      const now = Date.now()
      if (
        proof?.method !== 'password' ||
        typeof proof.authenticated_at !== 'number' ||
        !Number.isSafeInteger(proof.authenticated_at) ||
        proof.authenticated_at <= 0 ||
        proof.authenticated_at !== proof.created_at ||
        proof.authenticated_at > now ||
        typeof proof.expires_at !== 'number' ||
        !Number.isSafeInteger(proof.expires_at) ||
        proof.expires_at <= now ||
        (identity.userId !== undefined && proof.user_id !== identity.userId) ||
        (identity.authTime !== undefined && proof.authenticated_at !== identity.authTime) ||
        expiresAt === null ||
        now >= expiresAt
      )
        return false
      return (
        (!freshness.sinceStart || proof.authenticated_at >= startedAt) &&
        (freshness.maxAge === null || (now - proof.authenticated_at) / 1000 <= freshness.maxAge)
      )
    },
  }
}
