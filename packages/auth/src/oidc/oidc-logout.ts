import {
  getCurrentAdapter,
  getCurrentDBAdapterAsyncLocalStorage,
  runWithAdapter,
} from '@better-auth/core/context'
import { createLogger } from '@kit/core'
import { D1_IN_ARRAY_CHUNK } from '@kit/db'
import type { DBAdapter } from 'better-auth'
import { createAuthEndpoint } from 'better-auth/api'
import { z } from 'zod'
import type { KitBetterAuth } from '../better-auth-factory'

const MAX_NOTIFIED_SESSIONS = 25
const log = createLogger({ component: 'oidc-logout' })

type LogoutResult =
  | { success: true; truncated: boolean; coverage?: never }
  | { success: true; truncated: null; coverage: 'unknown' }

type LogoutRow = { id: string; sessionId: string; clientId: string }
type LogoutClient = { clientId: string }

// Better Auth snapshots entities for its delete hooks before issuing deleteMany.
// Bound that snapshot, but leave the actual userId deletion untouched so the
// database cascades every session-bound access token in the same statement.
function logoutAdapter(
  adapter: DBAdapter,
  onTruncated: () => void,
  onPlanningFailure: () => void,
): DBAdapter {
  let access: LogoutRow[] = []
  let refresh: LogoutRow[] = []
  let clients: LogoutClient[] = []
  let snapshotReady = false
  let jwks: Promise<unknown[]> | undefined
  let createdJwk: Promise<unknown> | undefined
  type FindQuery = Parameters<DBAdapter['findMany']>[0]

  async function snapshotSessions<T>(query: FindQuery): Promise<T[]> {
    let selected: { id: string }[] = []
    try {
      const sessions = await adapter.findMany<{ id: string }>({
        ...query,
        sortBy: { field: 'createdAt', direction: 'desc' },
        limit: MAX_NOTIFIED_SESSIONS + 1,
      })
      if (sessions.length > MAX_NOTIFIED_SESSIONS) onTruncated()
      selected = sessions.slice(0, MAX_NOTIFIED_SESSIONS)
      if (selected.length) {
        const where = [
          { field: 'sessionId', operator: 'in' as const, value: selected.map((s) => s.id) },
        ]
        ;[access, refresh] = await Promise.all([
          adapter.findMany<LogoutRow>({ model: 'oauthAccessToken', where, limit: 2147483647 }),
          adapter.findMany<LogoutRow>({ model: 'oauthRefreshToken', where, limit: 2147483647 }),
        ])
        const ids = [...new Set([...access, ...refresh].map((token) => token.clientId))]
        for (let i = 0; i < ids.length; i += D1_IN_ARRAY_CHUNK) {
          clients.push(
            ...(await adapter.findMany<LogoutClient>({
              model: 'oauthClient',
              where: [
                {
                  field: 'clientId',
                  operator: 'in',
                  value: ids.slice(i, i + D1_IN_ARRAY_CHUNK),
                },
              ],
              limit: D1_IN_ARRAY_CHUNK,
            })),
          )
        }
      }
    } catch {
      // Notifications are best-effort; deletion remains the security barrier.
      onPlanningFailure()
      log.error('OIDC logout notification planning failed')
      access = []
      refresh = []
      clients = []
    }
    snapshotReady = true
    return selected as T[]
  }

  function findSnapshot<T>(query: FindQuery): T[] | undefined {
    if (!snapshotReady) return
    if (query.model === 'oauthAccessToken' || query.model === 'oauthRefreshToken') {
      const sessionId = query.where?.find((condition) => condition.field === 'sessionId')?.value
      return (query.model === 'oauthAccessToken' ? access : refresh).filter(
        (token) => token.sessionId === sessionId,
      ) as T[]
    }
    if (query.model === 'oauthClient') {
      const ids = query.where?.find((condition) => condition.field === 'clientId')?.value
      if (Array.isArray(ids))
        return clients.filter((client) => (ids as unknown[]).includes(client.clientId)) as T[]
    }
  }

  return {
    ...adapter,
    async findMany<T>(query: FindQuery): Promise<T[]> {
      if (query.model === 'session' && query.limit === undefined) return snapshotSessions<T>(query)
      if (query.model === 'jwks' && !query.where && !query.select && !query.limit) {
        jwks ??= adapter.findMany(query)
        return (await jwks) as T[]
      }
      const snapshot = findSnapshot<T>(query)
      if (snapshot) return snapshot
      return adapter.findMany<T>(query)
    },
    async create<T extends Record<string, unknown>, R = T>(query: {
      model: string
      data: Omit<T, 'id'>
      select?: string[]
      forceAllowId?: boolean
    }): Promise<R> {
      if (query.model !== 'jwks') return adapter.create<T, R>(query)
      createdJwk ??= adapter.create<T, R>(query)
      const key = await createdJwk
      jwks = Promise.resolve([key])
      return key as R
    },
    async updateMany(query) {
      if (query.model === 'oauthAccessToken') return 0
      // The access-token rows were removed by the session FK cascade.
      // Chunk any remaining provider writes (e.g. historical refresh tokens).
      const index = query.where.findIndex((condition) => condition.operator === 'in')
      const condition = query.where[index]
      if (!(condition && Array.isArray(condition.value))) return adapter.updateMany(query)
      let count = 0
      for (let i = 0; i < condition.value.length; i += D1_IN_ARRAY_CHUNK) {
        const where = [...query.where]
        where[index] = {
          ...condition,
          value: condition.value.slice(i, i + D1_IN_ARRAY_CHUNK) as string[] | number[],
        }
        count += await adapter.updateMany({ ...query, where })
      }
      return count
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
          let truncated = false
          let coverageUnknown = false
          const bounded = logoutAdapter(
            { ...ctx.context.adapter, ...adapter },
            () => {
              truncated = true
            },
            () => {
              coverageUnknown = true
            },
          )
          const removeSessions = () =>
            ctx.context.internalAdapter.deleteUserSessions(ctx.body.userId)
          if (current) {
            await storage.run({ ...current, adapter: bounded }, removeSessions)
          } else {
            await runWithAdapter(bounded, removeSessions)
          }
          if (truncated)
            ctx.context.logger.warn('OIDC logout notifications truncated to 25 sessions')
          return ctx.json(
            coverageUnknown
              ? { success: true as const, truncated: null, coverage: 'unknown' as const }
              : { success: true as const, truncated },
          )
        },
      ),
    },
  }
}

/** Server-side API surface supplied by an auth instance with the logout plugin. */
type OidcLogoutAuth = {
  api: {
    endOidcUserSessions: (input: { body: { userId: string } }) => Promise<LogoutResult>
  }
}

/** End all Better Auth sessions for a user, including provider logout hooks. */
export async function endOidcUserSessions(
  auth: KitBetterAuth,
  userId: string,
): Promise<LogoutResult> {
  return (auth as unknown as OidcLogoutAuth).api.endOidcUserSessions({ body: { userId } })
}
