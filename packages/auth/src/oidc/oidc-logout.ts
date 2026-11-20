import {
  getCurrentAdapter,
  getCurrentDBAdapterAsyncLocalStorage,
  runWithAdapter,
} from '@better-auth/core/context'
import { D1_IN_ARRAY_CHUNK } from '@kit/db'
import type { DBAdapter } from 'better-auth'
import { createAuthEndpoint } from 'better-auth/api'
import { z } from 'zod'
import type { KitBetterAuth } from '../better-auth-factory'

// Better Auth catches planner errors and applies revocations after deletion.
// Keep the snapshot and revocation barrier in this endpoint's adapter.
function logoutAdapter(adapter: DBAdapter): DBAdapter {
  const models: Record<string, true> = {
    session: true,
    oauthAccessToken: true,
    oauthRefreshToken: true,
    oauthClient: true,
  }
  let failure: unknown
  let failed = false
  let sessionIds: string[] = []
  const chunks = <T>(values: T[]) => {
    const result: T[][] = []
    for (let i = 0; i < values.length; i += D1_IN_ARRAY_CHUNK) {
      result.push(values.slice(i, i + D1_IN_ARRAY_CHUNK))
    }
    return result
  }
  type FindQuery = Parameters<DBAdapter['findMany']>[0]
  async function readPages<T>(query: FindQuery): Promise<T[]> {
    const rows: T[] = []
    let lastId: string | undefined
    while (true) {
      const where = [...(query.where ?? [])]
      if (lastId !== undefined) where.push({ field: 'id', operator: 'gt', value: lastId })
      const page = await adapter.findMany<T & { id: string }>({
        ...query,
        where,
        sortBy: { field: 'id', direction: 'asc' },
        limit: 100,
        offset: 0,
      })
      rows.push(...page)
      if (page.length < 100) return rows
      lastId = page[page.length - 1].id
    }
  }
  function finishLimited<T>(query: FindQuery, rows: T[], select: string[] | undefined): T[] {
    const sortField = query.sortBy?.field
    if (sortField) {
      const direction = query.sortBy?.direction === 'desc' ? -1 : 1
      rows.sort((a, b) => {
        const left = (a as Record<string, unknown>)[sortField] as string | number
        const right = (b as Record<string, unknown>)[sortField] as string | number
        return left < right ? -direction : left > right ? direction : 0
      })
    }
    const offset = query.offset ?? 0
    const result = rows.slice(offset, offset + (query.limit ?? 0))
    if (select !== query.select && sortField) {
      for (const row of result) delete (row as Record<string, unknown>)[sortField]
    }
    return result
  }
  function includeSortField(query: FindQuery): string[] | undefined {
    const field = query.sortBy?.field
    if (query.select && field && !query.select.includes(field)) return [...query.select, field]
    return query.select
  }
  async function readGroup<T>(query: FindQuery): Promise<T[]> {
    if (query.limit === undefined) return readPages<T>(query)
    return adapter.findMany<T>({
      ...query,
      offset: 0,
      limit: query.limit + (query.offset ?? 0),
    })
  }
  async function readChunked<T>(query: FindQuery): Promise<T[]> {
    const index = query.where?.findIndex((condition) => condition.operator === 'in') ?? -1
    const condition = index < 0 ? undefined : query.where?.[index]
    if (!(condition && Array.isArray(condition.value))) {
      return query.limit === undefined ? readPages<T>(query) : adapter.findMany<T>(query)
    }
    const groups = chunks([...new Set(condition.value as (string | number)[])])
    const rows: T[] = []
    const select = includeSortField(query)
    for (const group of groups) {
      const where = [...(query.where ?? [])]
      where[index] = { ...condition, value: group as string[] | number[] }
      rows.push(...(await readGroup<T>({ ...query, where, select })))
    }
    if (query.limit === undefined) return rows
    return finishLimited(query, rows, select)
  }
  const paginated: DBAdapter = {
    ...adapter,
    async findMany<T>(query: Parameters<DBAdapter['findMany']>[0]): Promise<T[]> {
      if (!models[query.model]) return adapter.findMany<T>(query)
      try {
        const rows = await readChunked<T>(query)
        if (query.model === 'session' && query.limit === undefined)
          sessionIds = (rows as { id: string }[]).map((row) => row.id)
        return rows
      } catch (error) {
        failed = true
        failure = error
        throw error
      }
    },
    async updateMany(query) {
      const index = query.where.findIndex((condition) => condition.operator === 'in')
      const condition = query.where[index]
      if (!(condition && Array.isArray(condition.value))) return adapter.updateMany(query)
      let count = 0
      for (const group of chunks(condition.value as (string | number)[])) {
        const where = [...query.where]
        where[index] = { ...condition, value: group as string[] | number[] }
        count += await adapter.updateMany({ ...query, where })
      }
      return count
    },
    async deleteMany(query) {
      if (query.model !== 'session') return adapter.deleteMany(query)
      if (failed) throw failure
      // Foreign keys clear sessionId on deletion; upstream's after-hook writes
      // are best-effort and can run in the background, not a revocation barrier.
      for (const ids of chunks(sessionIds)) {
        const where = [{ field: 'sessionId', operator: 'in' as const, value: ids }]
        const access = await paginated.findMany<{ id: string; revoked?: Date }>({
          model: 'oauthAccessToken',
          where,
        })
        const refresh = await paginated.findMany<{ id: string; revoked?: Date; scopes?: string[] }>(
          {
            model: 'oauthRefreshToken',
            where,
          },
        )
        const revoked = new Date()
        for (const [model, tokenIds] of [
          ['oauthAccessToken', access.filter((token) => !token.revoked).map((token) => token.id)],
          [
            'oauthRefreshToken',
            refresh
              .filter((token) => !(token.revoked || token.scopes?.includes('offline_access')))
              .map((token) => token.id),
          ],
        ] as const) {
          if (tokenIds.length)
            await paginated.updateMany({
              model,
              where: [{ field: 'id', operator: 'in', value: tokenIds }],
              update: { revoked },
            })
        }
      }
      let count = 0
      for (const ids of chunks(sessionIds)) {
        count += await adapter.deleteMany({
          ...query,
          where: [...query.where, { field: 'id', operator: 'in', value: ids }],
        })
      }
      return count
    },
  }
  return paginated
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
