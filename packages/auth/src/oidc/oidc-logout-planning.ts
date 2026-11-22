import { D1_IN_ARRAY_CHUNK, type KitD1Database } from '@kit/db'
import type { DBAdapter } from 'better-auth'

const bindings = new WeakMap<object, { d1: KitD1Database; adapter: DBAdapter }>()

export function registerLogoutD1<T extends DBAdapter>(adapter: T, d1: KitD1Database): T {
  bindings.set(adapter, { d1, adapter })
  return adapter
}

export type LogoutRow = {
  id: string
  sessionId: string
  clientId: string
  revoked?: Date | string | null
  scopes?: unknown
}

type D1Rows = { results?: Array<Record<string, unknown>> }

export function logoutD1(adapter: object) {
  return bindings.get(adapter)
}

async function mapSessionChunks<T>(sessionIds: string[], fn: (chunk: string[]) => Promise<T[]>) {
  const out: T[] = []
  for (let i = 0; i < sessionIds.length; i += D1_IN_ARRAY_CHUNK) {
    const rows = await fn(sessionIds.slice(i, i + D1_IN_ARRAY_CHUNK))
    for (const row of rows) out.push(row)
  }
  return out
}

async function d1Rows(d1: KitD1Database, sql: string, chunk: string[]) {
  return ((
    (await d1
      .prepare(sql)
      .bind(...chunk)
      .all()) as D1Rows
  ).results ?? []) as Array<Record<string, unknown>>
}

/*
 * Use the D1 handle registered in the module-private WeakMap for DISTINCT.
 * DBAdapter.findMany has no DISTINCT/GROUP BY and scales with token churn.
 * Upstream prepareBackchannelLogoutPlan (@better-auth/oauth-provider@1.7.27
 * authorize-*.mjs ~2947) needs affectedClientIds from all access∪refresh
 * (revoked or not). Representative access rows are marked revoked so their
 * synthetic IDs never enter a revocation write, even for deferred hooks.
 * Real access rows cascade on session deletion (migration 0027); refresh IDs
 * remain load-bearing (SET NULL — rows survive; applyBackchannelLogoutPlan ~3010).
 */
export async function loadDistinctSessionClients(
  d1: KitD1Database,
  sessionIds: string[],
): Promise<LogoutRow[]> {
  const pairs = new Map<string, LogoutRow>()
  for (const table of ['oauth_access_token', 'oauth_refresh_token'] as const) {
    const rows = await mapSessionChunks(sessionIds, (chunk) =>
      d1Rows(
        d1,
        `SELECT DISTINCT session_id, client_id FROM ${table} WHERE session_id IN (${chunk.map(() => '?').join(',')})`,
        chunk,
      ),
    )
    for (const row of rows) {
      const sessionId = String(row.session_id)
      const clientId = String(row.client_id)
      const key = `${sessionId}\0${clientId}`
      if (!pairs.has(key)) {
        pairs.set(key, {
          id: `notify:${sessionId}:${clientId}`,
          sessionId,
          clientId,
          revoked: new Date(0),
        })
      }
    }
  }
  return [...pairs.values()]
}

export async function loadRevocableRefreshTokens(
  d1: KitD1Database,
  sessionIds: string[],
): Promise<LogoutRow[]> {
  return mapSessionChunks(sessionIds, async (chunk) => {
    const ph = chunk.map(() => '?').join(',')
    // Non-revoked rows must be copied: upstream decides offline_access membership.
    const rows = await d1Rows(
      d1,
      `SELECT id, session_id, client_id, scopes FROM oauth_refresh_token
       WHERE session_id IN (${ph}) AND revoked IS NULL`,
      chunk,
    )
    return rows.map((row) => {
      let scopes = row.scopes
      // Better Auth's adapter factory only JSON-decodes text; D1 BLOBs retain
      // byte-array membership semantics (rather than being coerced to text).
      if (typeof scopes === 'string') {
        try {
          scopes = JSON.parse(scopes, (_key, value: unknown) => {
            if (
              typeof value === 'string' &&
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
            ) {
              const date = new Date(value)
              if (!Number.isNaN(date.getTime())) return date
            }
            return value
          })
        } catch {
          // Better Auth's safeJSONParse returns null for invalid JSON.
          scopes = null
        }
      }
      return {
        id: String(row.id),
        sessionId: String(row.session_id),
        clientId: String(row.client_id),
        scopes,
        revoked: null,
      }
    })
  })
}
