import {
  getCurrentAdapter,
  getCurrentDBAdapterAsyncLocalStorage,
  runWithAdapter,
} from '@better-auth/core/context'
import { createLogger } from '@kit/core'
import { D1_IN_ARRAY_CHUNK, type KitD1Database } from '@kit/db'
import type { DBAdapter } from 'better-auth'
import { createAuthEndpoint } from 'better-auth/api'
import { z } from 'zod'
import type { KitBetterAuth } from '../better-auth-factory'
import {
  type LogoutRow,
  loadDistinctSessionClients,
  loadRevocableRefreshTokens,
  logoutD1,
} from './oidc-logout-planning'

const MAX_NOTIFIED_SESSIONS = 25
const log = createLogger({ component: 'oidc-logout' })

type LogoutResult =
  | { success: true; truncated: boolean; coverage?: never }
  | { success: true; truncated: null; coverage: 'unknown' }

type LogoutClient = { clientId: string }

async function updateLogoutTokens(
  adapter: Pick<DBAdapter, 'updateMany'>,
  query: Parameters<DBAdapter['updateMany']>[0],
) {
  // The access-token rows were removed by the session FK cascade.
  if (query.model === 'oauthAccessToken') return 0
  if (query.model !== 'oauthRefreshToken') return adapter.updateMany(query)
  const index = query.where.findIndex((condition) => condition.operator === 'in')
  const condition = query.where[index]
  if (!(condition && Array.isArray(condition.value))) return adapter.updateMany(query)
  let count = 0
  let failures: unknown[] | undefined
  for (let i = 0; i < condition.value.length; i += D1_IN_ARRAY_CHUNK) {
    const where = [...query.where]
    where[index] = {
      ...condition,
      value: condition.value.slice(i, i + D1_IN_ARRAY_CHUNK) as string[] | number[],
    }
    try {
      count += await adapter.updateMany({ ...query, where })
    } catch (error) {
      failures ??= []
      failures.push(error)
    }
  }
  // The provider logs a failed revocation and still attempts delivery.
  if (failures) throw new AggregateError(failures, 'OIDC refresh revocation chunks failed')
  return count
}

function bindDeferredLogoutHooks(
  pending: Array<() => Promise<void>>,
  queued: Array<() => Promise<void>>,
  live: DBAdapter | undefined,
) {
  if (!pending.length) return true
  if (!live) {
    log.error('OIDC deferred logout skipped: transaction adapter binding is unverified')
    return false
  }
  const postCommit: DBAdapter = {
    ...live,
    updateMany: (query) => updateLogoutTokens(live, query),
  }
  for (const hook of pending) {
    queued.push(async () => {
      await runWithAdapter(postCommit, hook)
    })
  }
  return true
}

function sessionsWithUnsupportedScopes(refresh: LogoutRow[]) {
  let failedSessions: Set<string> | undefined
  for (const { revoked, scopes, sessionId } of refresh) {
    // Match the types that support the provider's scope membership check.
    if (
      !revoked &&
      scopes !== null &&
      scopes !== undefined &&
      typeof scopes !== 'string' &&
      !Array.isArray(scopes) &&
      !(scopes instanceof Uint8Array)
    ) {
      failedSessions ??= new Set()
      failedSessions.add(sessionId)
    }
  }
  return failedSessions
}

// Better Auth snapshots entities for its delete hooks before issuing deleteMany.
// Bound that snapshot, but leave the actual userId deletion untouched so the
// database cascades every session-bound access token in the same statement.
function logoutAdapter(
  adapter: DBAdapter,
  onTruncated: () => void,
  onPlanningFailure: () => void,
  d1: KitD1Database | undefined,
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
        const sessionIds = selected.map((s) => s.id)
        if (d1) {
          ;[access, refresh] = await Promise.all([
            loadDistinctSessionClients(d1, sessionIds),
            loadRevocableRefreshTokens(d1, sessionIds),
          ])
        } else {
          log.warn('OIDC logout planning uses unbounded adapter fallback')
          const where = [{ field: 'sessionId', operator: 'in' as const, value: sessionIds }]
          ;[access, refresh] = await Promise.all([
            adapter.findMany<LogoutRow>({ model: 'oauthAccessToken', where, limit: 2147483647 }),
            adapter.findMany<LogoutRow>({ model: 'oauthRefreshToken', where, limit: 2147483647 }),
          ])
        }
        const failedSessions = sessionsWithUnsupportedScopes(refresh)
        if (failedSessions) {
          onPlanningFailure()
          log.error('OIDC logout notification planning skipped sessions with unsupported scopes')
          access = access.filter(({ sessionId }) => !failedSessions.has(sessionId))
          refresh = refresh.filter(({ sessionId }) => !failedSessions.has(sessionId))
        }
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
    updateMany: (query) => updateLogoutTokens(adapter, query),
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
          const binding = logoutD1(adapter)
          let truncated = false
          let coverageUnknown = false
          const bounded = logoutAdapter(
            binding?.adapter ?? { ...ctx.context.adapter, ...adapter },
            () => {
              truncated = true
            },
            () => {
              coverageUnknown = true
            },
            binding?.d1,
          )
          const removeSessions = () =>
            ctx.context.internalAdapter.deleteUserSessions(ctx.body.userId)
          if (current?.isTransactionActive) {
            const pendingHooks: typeof current.pendingHooks = []
            try {
              await storage.run({ ...current, adapter: bounded, pendingHooks }, removeSessions)
            } finally {
              // Only the exact planning adapter's registration proves a live binding.
              // Neither the endpoint adapter nor the restored outer scope proves it.
              if (!bindDeferredLogoutHooks(pendingHooks, current.pendingHooks, binding?.adapter)) {
                coverageUnknown = true
              }
            }
          } else if (current) {
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
