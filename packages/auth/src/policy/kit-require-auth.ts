import { AppError } from '@kit/core'
import { type BetterAuthLike, createBetterAuthSessionPort } from '../better-auth-port'
import type { KitRepoDb } from '../repos/db-type'
import { findActiveOrgApiKeyByPrefix } from '../repos/keys'
import { createRequireAuth, type RequireAuthContext } from '../require-auth'

export type KitRequireAuthContext = RequireAuthContext & {
  get(key: 'db'): KitRepoDb | undefined
  get(key: 'betterAuth'): BetterAuthLike | undefined
}

/** Compose request-scoped session and organization-bound key authentication. */
export function createKitRequireAuth<C extends KitRequireAuthContext>(
  cookieName: (c: C) => string,
) {
  return createRequireAuth<C>((c) => {
    const db = c.get('db')
    if (!db) throw AppError.internal('db not bound — withDb middleware required')
    const auth = c.get('betterAuth')
    if (!auth) {
      throw AppError.internal('betterAuth not bound — withBetterAuth middleware required')
    }
    return {
      sessions: createBetterAuthSessionPort({ cookieName: cookieName(c), getAuth: () => auth }),
      findApiKeyByPrefix: (prefix) => findActiveOrgApiKeyByPrefix(db, prefix),
    }
  })
}
