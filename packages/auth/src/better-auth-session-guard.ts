import { APIError, createAuthMiddleware } from 'better-auth/api'
import { eq } from 'drizzle-orm'
import type { BetterAuthTables } from './better-auth-schema'
import { isAccountActive } from './repos/account-state'
import type { KitRepoDb } from './repos/db-type'
/** Distinguishes this denial from unrelated Better Auth errors without exposing details. */
export class InactiveSessionError extends APIError {
  constructor() {
    super('UNAUTHORIZED', { message: 'Unauthorized' })
  }
}

/** Check the signed session on every Better Auth endpoint before it can authorize work. */
export function createSessionAccountGuard(db: KitRepoDb, schema: BetterAuthTables) {
  return createAuthMiddleware(async (ctx) => {
    const token = await ctx.getSignedCookie(
      ctx.context.authCookies.sessionToken.name,
      ctx.context.secret,
    )
    if (!token) return
    // Resolve only the session table: a join would read a missing User-state column first.
    const sessions = await db
      .select({ userId: schema.session.userId })
      .from(schema.session)
      .where(eq(schema.session.token, token))
      .limit(1)
    const session = sessions[0]
    if (!session) return
    let active = false
    try {
      active = await isAccountActive(db, session.userId, schema.user)
    } catch {
      // Unreadable account state is not authorization.
    }
    if (!active) throw new InactiveSessionError()
  })
}
