import {
  getCurrentAdapter,
  getCurrentDBAdapterAsyncLocalStorage,
  runWithAdapter,
} from '@better-auth/core/context'
import type { DBAdapter } from 'better-auth'
import { createAuthEndpoint } from 'better-auth/api'
import { z } from 'zod'
import type { KitBetterAuth } from '../better-auth-factory'

// The bulk-delete hooks and provider planner omit a limit; the adapter's
// default would otherwise silently truncate the session and token snapshots.
function logoutAdapter(adapter: DBAdapter): DBAdapter {
  const models: Record<string, true> = {
    session: true,
    oauthAccessToken: true,
    oauthRefreshToken: true,
    oauthClient: true,
  }
  let enumerationError: unknown
  let enumerationFailed = false
  return {
    ...adapter,
    async findMany<T>(query: Parameters<DBAdapter['findMany']>[0]): Promise<T[]> {
      if (!models[query.model] || query.limit !== undefined) return adapter.findMany<T>(query)
      try {
        const rows: T[] = []
        const limit = 100
        while (true) {
          const page = await adapter.findMany<T>({
            ...query,
            sortBy: query.sortBy ?? { field: 'id', direction: 'asc' },
            limit,
            offset: (query.offset ?? 0) + rows.length,
          })
          rows.push(...page)
          if (page.length < limit) return rows
        }
      } catch (error) {
        enumerationFailed = true
        enumerationError = error
        throw error
      }
    },
    async deleteMany(query) {
      // Core and provider hooks catch enumeration errors; do not delete after
      // an incomplete snapshot, even when those catches hide the error.
      if (query.model === 'session' && enumerationFailed) throw enumerationError
      return adapter.deleteMany(query)
    },
  }
}

/** Deletes user sessions inside an auth endpoint so Better Auth's database hooks run. */
export function createOidcLogoutPlugin() {
  return {
    id: 'kit-oidc-logout',
    endpoints: {
      endOidcUserSessions: createAuthEndpoint.serverOnly(
        {
          method: 'POST',
          body: z.object({ userId: z.string().min(1) }),
        },
        async (ctx) => {
          const storage = await getCurrentDBAdapterAsyncLocalStorage()
          const current = storage.getStore()
          const adapter = await getCurrentAdapter(ctx.context.adapter)
          const paginated = logoutAdapter({ ...ctx.context.adapter, ...adapter })
          const removeSessions = () =>
            ctx.context.internalAdapter.deleteUserSessions(ctx.body.userId)
          if (current) {
            await storage.run({ ...current, adapter: paginated }, removeSessions)
          } else {
            await runWithAdapter(paginated, removeSessions)
          }
          return ctx.json({ success: true })
        },
      ),
    },
  }
}

/** Server-side API surface supplied by an auth instance with the logout plugin. */
type OidcLogoutAuth = {
  api: {
    endOidcUserSessions: (input: { body: { userId: string } }) => Promise<unknown>
  }
}

/** End all Better Auth sessions for a user, including provider logout hooks. */
export async function endOidcUserSessions(auth: KitBetterAuth, userId: string): Promise<void> {
  await (auth as unknown as OidcLogoutAuth).api.endOidcUserSessions({ body: { userId } })
}
