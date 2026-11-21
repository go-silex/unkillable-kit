import { D1_IN_ARRAY_CHUNK, type KitD1Database } from '@kit/db'

/** Stamped onto the Better Auth drizzle adapter by `createBetterAuth`. */
export const KIT_OIDC_LOGOUT_D1 = '__kitOidcLogoutD1'

export type LogoutRow = {
  id: string
  sessionId: string
  clientId: string
  revoked?: Date | string | null
  scopes?: string[] | string | null
}

type D1Rows = { results?: Array<Record<string, unknown>> }

export function logoutD1(adapter: object): KitD1Database | undefined {
  const stamped = (adapter as Record<string, unknown>)[KIT_OIDC_LOGOUT_D1]
  if (stamped && typeof stamped === 'object' && 'prepare' in stamped) {
    return stamped as KitD1Database
  }
}

async function mapSessionChunks<T>(sessionIds: string[], fn: (chunk: string[]) => Promise<T[]>) {
  const out: T[] = []
  for (let i = 0; i < sessionIds.length; i += D1_IN_ARRAY_CHUNK) {
    out.push(...(await fn(sessionIds.slice(i, i + D1_IN_ARRAY_CHUNK))))
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
 * Choice (a): DB-level DISTINCT via stamped D1 — DBAdapter.findMany has no
 * DISTINCT/GROUP BY, so (b) adapter-only still scales with token churn.
 * Upstream prepareBackchannelLogoutPlan (@better-auth/oauth-provider@1.7.27
 * authorize-*.mjs ~2947) needs affectedClientIds from all access∪refresh
 * (revoked or not); accessTokenIds unused here (updateMany no-ops access:
 * session_id ON DELETE CASCADE, migration 0027); refreshTokenIds for
 * non-revoked non-offline_access remain load-bearing (session_id ON DELETE
 * SET NULL — rows survive; applyBackchannelLogoutPlan ~3010).
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
        pairs.set(key, { id: `notify:${sessionId}:${clientId}`, sessionId, clientId })
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
    // scopes JSON string[]; quoted token matches upstream scopes.includes('offline_access').
    const rows = await d1Rows(
      d1,
      `SELECT id, session_id, client_id, scopes FROM oauth_refresh_token
       WHERE session_id IN (${ph}) AND revoked IS NULL AND instr(scopes, '"offline_access"') = 0`,
      chunk,
    )
    return rows.map((row) => {
      let scopes: string[] | string | null = row.scopes == null ? null : String(row.scopes)
      if (typeof scopes === 'string') {
        try {
          const parsed = JSON.parse(scopes) as unknown
          if (Array.isArray(parsed)) scopes = parsed.map(String)
        } catch {
          /* raw string still substring-matches offline_access */
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
