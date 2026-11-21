import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runWithAdapter, runWithTransaction } from '@better-auth/core/context'
import { createSqliteD1 } from '@kit/db/testing'
import type { DBAdapter } from 'better-auth'
import Database from 'better-sqlite3'
import { decodeJwt } from 'jose'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createBetterAuth } from '../better-auth-factory'
import { createOidcProvider, endOidcUserSessions, registerOidcClient } from './oidc-provider'

const ORIGIN = 'https://auth.example.test'
const USER_ID = 'pagination-user'

function notifiedClients(delivery: ReturnType<typeof vi.fn>): string[] {
  return delivery.mock.calls.map(([url]) => {
    const href = String(url)
    return href.slice(href.lastIndexOf('/') + 1)
  })
}

function setup(
  options: {
    beforeDelete?: (sqlite: Database.Database) => void
    beforeQuery?: (sql: string) => void
  } = {},
) {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  onTestFinished(() => {
    vi.unstubAllGlobals()
    sqlite.close()
  })
  for (const migration of [
    '0005_better_auth.sql',
    '0006_better_auth_organization.sql',
    '0014_better_auth_1_7_additive.sql',
    '0025_account_state.sql',
    '0027_better_auth_oidc_provider.sql',
  ]) {
    sqlite.exec(
      readFileSync(
        new URL(`../../../../apps/example-api/migrations/${migration}`, import.meta.url),
        'utf8',
      ),
    )
  }
  const now = Date.now()
  sqlite
    .prepare(
      'INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
    )
    .run(USER_ID, 'Example User', 'user@example.test', now, now)
  const pending: Promise<unknown>[] = []
  const database = createSqliteD1(sqlite, {
    onBind(count) {
      if (count > 100) throw new Error(`D1 bind limit exceeded: ${count}`)
    },
  })
  const prepare = database.prepare
  let queryCount = 0
  let tokenPlanRows = 0
  database.prepare = (sql) => {
    queryCount++
    options.beforeQuery?.(sql)
    if (/delete\s+from\s+["`]?session["`]?/i.test(sql)) {
      options.beforeDelete?.(sqlite)
    }
    const statement = prepare(sql)
    const planningTokenSelect =
      /^\s*select\b/i.test(sql) &&
      /oauth_(?:access|refresh)_token/i.test(sql) &&
      !/\bcount\s*\(/i.test(sql)
    if (!planningTokenSelect) return statement
    const instrument = (bound: ReturnType<typeof statement.bind>) => ({
      ...bound,
      async all() {
        const result = (await bound.all()) as { results?: unknown[] }
        tokenPlanRows += result.results?.length ?? 0
        return result
      },
      async raw<T = unknown>() {
        const rows = await bound.raw<T>()
        tokenPlanRows += rows.length
        return rows
      },
      async first<T = unknown>() {
        const row = await Promise.resolve(bound.first<T>())
        if (row) tokenPlanRows += 1
        return row
      },
    })
    return {
      ...statement,
      bind(...values: unknown[]) {
        return instrument(statement.bind(...values))
      },
      async all() {
        return instrument(statement).all()
      },
      async raw<T = unknown>() {
        return instrument(statement).raw<T>()
      },
      async first<T = unknown>() {
        return instrument(statement).first<T>()
      },
    }
  }
  const auth = createBetterAuth({
    database,
    secret: 'test-better-auth-secret-xxxxxxxx32c!!',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    allowPublicSignup: true,
    oidcProvider: createOidcProvider({
      loginPage: '/login',
      waitUntil: (promise) => pending.push(promise),
    }),
  })
  const delivery = vi.fn(
    async (_url: string | URL | Request, _options?: RequestInit) =>
      new Response(null, { status: 200 }),
  )
  vi.stubGlobal('fetch', delivery)
  const addSession = (id: string, age = 0) =>
    sqlite
      .prepare(
        'INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, `token-${id}`, USER_ID, now + 3_600_000, now + age, now + age)
  const addClient = (
    id: string,
    opts: { disabled?: boolean; backchannelLogoutUri?: string | null } = {},
  ) =>
    sqlite
      .prepare(
        'INSERT INTO oauth_client (id, client_id, redirect_uris, backchannel_logout_uri, disabled) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        id,
        id,
        JSON.stringify(['https://client.example.test/callback']),
        opts.backchannelLogoutUri === null
          ? null
          : (opts.backchannelLogoutUri ?? `https://client.example.test/logout/${id}`),
        opts.disabled ? 1 : 0,
      )
  const addToken = (
    id: string,
    sessionId: string,
    clientId: string,
    opts: { revoked?: number | null } = {},
  ) =>
    sqlite
      .prepare(
        'INSERT INTO oauth_access_token (id, token, client_id, session_id, user_id, expires_at, created_at, scopes, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        createHash('sha256').update(`access-${id}`).digest('base64url'),
        clientId,
        sessionId,
        USER_ID,
        now + 3_600_000,
        now,
        JSON.stringify(['openid']),
        opts.revoked ?? null,
      )
  const addRefresh = (
    id: string,
    sessionId: string,
    clientId: string,
    opts: { scopes?: string[]; revoked?: number | null } = {},
  ) =>
    sqlite
      .prepare(
        'INSERT INTO oauth_refresh_token (id, token, client_id, session_id, user_id, expires_at, created_at, scopes, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        createHash('sha256').update(`refresh-${id}`).digest('base64url'),
        clientId,
        sessionId,
        USER_ID,
        now + 3_600_000,
        now,
        JSON.stringify(opts.scopes ?? ['openid']),
        opts.revoked ?? null,
      )
  return {
    sqlite,
    auth,
    pending,
    delivery,
    addSession,
    addClient,
    addToken,
    addRefresh,
    now,
    queries: () => queryCount,
    tokenPlanRows: () => tokenPlanRows,
  }
}

it('deletes all sessions and notifies only the 25 most recent', async () => {
  const { sqlite, auth, pending, delivery, addSession, addClient, addToken } = setup()
  const sessionCountsAtDelivery: number[] = []
  delivery.mockImplementation(async () => {
    const row = sqlite.prepare('SELECT count(*) AS count FROM session').get() as { count: number }
    sessionCountsAtDelivery.push(row.count)
    return new Response(null, { status: 200 })
  })
  addClient('client')
  for (let i = 0; i < 101; i++) {
    addSession(`session-${i}`, i)
    addToken(`token-${i}`, `session-${i}`, 'client')
  }
  const userinfo = (i: number) =>
    auth.handler(
      new Request(`${ORIGIN}/api/auth/oauth2/userinfo`, {
        headers: { authorization: `Bearer access-token-${i}` },
      }),
    )
  expect((await userinfo(0)).status).toBe(200)
  expect(await endOidcUserSessions(auth, USER_ID)).toEqual({ success: true, truncated: true })
  await Promise.all(pending)
  expect(sqlite.prepare('SELECT count(*) AS count FROM session').get()).toEqual({ count: 0 })
  expect(sqlite.prepare('SELECT count(*) AS count FROM oauth_access_token').get()).toEqual({
    count: 0,
  })
  for (let i = 0; i < 101; i++) expect((await userinfo(i)).status).toBe(401)
  expect(delivery).toHaveBeenCalledTimes(25)
  expect(sessionCountsAtDelivery).toEqual(Array(25).fill(0))
  const sessions = delivery.mock.calls.map(([, options]) => {
    const token = new URLSearchParams(options?.body as string).get('logout_token')
    return decodeJwt(token as string).sid
  })
  expect(new Set(sessions)).toEqual(
    new Set(Array.from({ length: 25 }, (_, i) => `session-${i + 76}`)),
  )
})

it('uses the same bounded number of queries for 3 and 101 sessions including delivery', async () => {
  const counts: number[] = []
  for (const size of [3, 101]) {
    const { auth, pending, addSession, addClient, addToken, queries } = setup()
    addClient('client')
    for (let i = 0; i < size; i++) {
      addSession(`session-${i}`, i)
      addToken(`token-${i}`, `session-${i}`, 'client')
    }
    const result = await endOidcUserSessions(auth, USER_ID)
    await Promise.all(pending)
    expect(result.truncated).toBe(size > 25)
    counts.push(queries())
  }
  expect(counts[0]).toBeGreaterThan(0)
  expect(counts[0]).toBeLessThanOrEqual(10)
  expect(counts[0]).toBe(counts[1])
})

it('batches more than 100 clients without exceeding D1 bind limits', async () => {
  const { sqlite, auth, pending, delivery, addSession, addClient, addToken } = setup()
  addSession('shared')
  for (let i = 0; i < 101; i++) {
    addClient(`client-${i}`)
    addToken(`token-${i}`, 'shared', `client-${i}`)
  }
  expect(await endOidcUserSessions(auth, USER_ID)).toEqual({ success: true, truncated: false })
  await Promise.all(pending)
  expect(delivery).toHaveBeenCalledTimes(101)
  expect(sqlite.prepare('SELECT count(*) AS count FROM oauth_access_token').get()).toEqual({
    count: 0,
  })
})

it('cascades a token minted between planning and deletion', async () => {
  let insertToken: (() => void) | undefined
  const beforeDelete = vi.fn(() => insertToken?.())
  const { sqlite, auth, pending, addSession, addClient, addToken } = setup({
    beforeDelete,
  })
  addSession('session')
  addClient('client')
  addToken('planned', 'session', 'client')
  addToken('late', 'session', 'client')
  const userinfo = () =>
    auth.handler(
      new Request(`${ORIGIN}/api/auth/oauth2/userinfo`, {
        headers: { authorization: 'Bearer access-late' },
      }),
    )
  expect((await userinfo()).status).toBe(200)
  sqlite.prepare('DELETE FROM oauth_access_token WHERE id = ?').run('late')
  insertToken = () => addToken('late', 'session', 'client')
  await endOidcUserSessions(auth, USER_ID)
  expect(beforeDelete).toHaveBeenCalledTimes(1)
  await Promise.all(pending)
  expect(sqlite.prepare('SELECT count(*) AS count FROM oauth_access_token').get()).toEqual({
    count: 0,
  })
  expect((await userinfo()).status).toBe(401)
})

it.each(['session', 'oauth_access_token'])(
  'reports unknown coverage when %s planning fails, without leaking errors',
  async (table) => {
    const secret = 'sensitive-adapter-error'
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
    onTestFinished(() => {
      errors.mockRestore()
      warnings.mockRestore()
      logs.mockRestore()
    })
    let injected = false
    const { sqlite, auth, pending, delivery, addSession, addClient, addToken } = setup({
      beforeQuery: (sql) => {
        if (!injected && new RegExp(`\\bfrom\\s+["\`]?${table}["\`]?`, 'i').test(sql)) {
          injected = true
          throw new Error(secret)
        }
      },
    })
    addSession('session')
    addClient('client')
    addToken('token', 'session', 'client')

    expect(await endOidcUserSessions(auth, USER_ID)).toEqual({
      success: true,
      truncated: null,
      coverage: 'unknown',
    })
    await Promise.all(pending)
    expect(injected).toBe(true)
    expect(sqlite.prepare('SELECT count(*) AS count FROM session').get()).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT count(*) AS count FROM oauth_access_token').get()).toEqual({
      count: 0,
    })
    expect(delivery).not.toHaveBeenCalled()
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('OIDC logout notification planning failed'),
    )
    expect(JSON.stringify([errors.mock.calls, warnings.mock.calls, logs.mock.calls])).not.toContain(
      secret,
    )
  },
)

it('leaves sessions and tokens intact and sends no notifications if deletion fails', async () => {
  const { sqlite, auth, pending, delivery, addSession, addClient, addToken } = setup()
  addSession('session')
  addClient('client')
  addToken('token', 'session', 'client')
  sqlite.exec(`CREATE TRIGGER reject_deletion BEFORE DELETE ON session
    BEGIN SELECT RAISE(ABORT, 'deletion failed'); END`)
  await expect(endOidcUserSessions(auth, USER_ID)).rejects.toThrow()
  await Promise.all(pending)
  expect(sqlite.prepare('SELECT count(*) AS count FROM session').get()).toEqual({ count: 1 })
  expect(sqlite.prepare('SELECT count(*) AS count FROM oauth_access_token').get()).toEqual({
    count: 1,
  })
  expect(delivery).not.toHaveBeenCalled()
})

it('refuses an issued bearer at userinfo after logout', async () => {
  const { auth, pending } = setup()
  const signup = await auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({
        name: 'Bearer User',
        email: 'bearer@example.test',
        password: 'example-password-123',
      }),
    }),
  )
  expect(signup.status).toBe(200)
  const { user } = (await signup.json()) as { user: { id: string } }
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  const redirectUri = 'https://client.example.test/callback'
  const client = await registerOidcClient(auth, {
    headers: new Headers({ cookie }),
    redirectUris: [redirectUri],
    firstParty: true,
    name: 'Bearer client',
  })
  if (!client.client_secret) throw new Error('Missing client secret')
  const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    scope: 'openid email profile',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    nonce: 'logout-test-nonce',
    state: 'logout-test-state',
  })
  const authorization = await auth.handler(
    new Request(`${ORIGIN}/api/auth/oauth2/authorize?${params}`, {
      headers: { cookie, accept: 'text/html' },
    }),
  )
  expect(authorization.status).toBe(302)
  const code = new URL(authorization.headers.get('location') ?? '', ORIGIN).searchParams.get('code')
  expect(code).toBeTruthy()
  const tokenResponse = await auth.handler(
    new Request(`${ORIGIN}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    }),
  )
  expect(tokenResponse.status).toBe(200)
  const { access_token: bearer } = (await tokenResponse.json()) as { access_token: string }
  const userinfo = () =>
    auth.handler(
      new Request(`${ORIGIN}/api/auth/oauth2/userinfo`, {
        headers: { authorization: `Bearer ${bearer}` },
      }),
    )
  expect((await userinfo()).status).toBe(200)

  await endOidcUserSessions(auth, user.id)
  await Promise.all(pending)

  expect((await userinfo()).status).toBe(401)
})

it('does not scale planning row volume with duplicate tokens per client', async () => {
  const { auth, pending, delivery, addSession, addClient, addToken, tokenPlanRows } = setup()
  addClient('alpha')
  addClient('beta')
  for (const session of ['s1', 's2', 's3']) {
    addSession(session)
    for (let i = 0; i < 200; i++) {
      addToken(`${session}-alpha-${i}`, session, 'alpha')
      addToken(`${session}-beta-${i}`, session, 'beta')
    }
  }
  expect(await endOidcUserSessions(auth, USER_ID)).toEqual({ success: true, truncated: false })
  await Promise.all(pending)
  expect(new Set(notifiedClients(delivery))).toEqual(new Set(['alpha', 'beta']))
  // 3 sessions × 2 clients × 200 tokens = 1200 access rows. Distinct planning must
  // stay near the destination count, not the token count.
  expect(tokenPlanRows()).toBeLessThan(50)
  expect(tokenPlanRows()).toBeGreaterThan(0)
})

it('revokes only non-revoked refresh tokens without offline_access', async () => {
  const { sqlite, auth, pending, delivery, addSession, addClient, addRefresh, now } = setup()
  addSession('session')
  addClient('client')
  addRefresh('live', 'session', 'client')
  addRefresh('already', 'session', 'client', { revoked: now - 1_000 })
  addRefresh('offline', 'session', 'client', { scopes: ['openid', 'offline_access'] })
  expect(await endOidcUserSessions(auth, USER_ID)).toEqual({ success: true, truncated: false })
  await Promise.all(pending)
  expect(notifiedClients(delivery)).toEqual(['client'])
  const rows = sqlite
    .prepare('SELECT id, revoked IS NOT NULL AS is_revoked FROM oauth_refresh_token ORDER BY id')
    .all() as Array<{ id: string; is_revoked: 0 | 1 }>
  expect(rows).toEqual([
    { id: 'already', is_revoked: 1 },
    { id: 'live', is_revoked: 1 },
    { id: 'offline', is_revoked: 0 },
  ])
})

it('notifies a client that only has revoked tokens', async () => {
  const { auth, pending, delivery, addSession, addClient, addToken, addRefresh, now } = setup()
  addSession('session')
  addClient('ghost')
  addToken('access-revoked', 'session', 'ghost', { revoked: now - 1_000 })
  addRefresh('refresh-revoked', 'session', 'ghost', { revoked: now - 1_000 })
  expect(await endOidcUserSessions(auth, USER_ID)).toEqual({ success: true, truncated: false })
  await Promise.all(pending)
  expect(notifiedClients(delivery)).toEqual(['ghost'])
})

it('skips disabled clients and clients without backchannelLogoutUri', async () => {
  const { auth, pending, delivery, addSession, addClient, addToken } = setup()
  addSession('session')
  addClient('ok')
  addClient('disabled', { disabled: true })
  addClient('silent', { backchannelLogoutUri: null })
  addToken('t-ok', 'session', 'ok')
  addToken('t-disabled', 'session', 'disabled')
  addToken('t-silent', 'session', 'silent')
  expect(await endOidcUserSessions(auth, USER_ID)).toEqual({ success: true, truncated: false })
  await Promise.all(pending)
  expect(notifiedClients(delivery)).toEqual(['ok'])
})

it('truncates notifications beyond 25 sessions while deleting all', async () => {
  const { sqlite, auth, pending, delivery, addSession, addClient, addToken } = setup()
  addClient('client')
  for (let i = 0; i < 30; i++) {
    addSession(`session-${i}`, i)
    addToken(`token-${i}`, `session-${i}`, 'client')
  }
  expect(await endOidcUserSessions(auth, USER_ID)).toEqual({ success: true, truncated: true })
  await Promise.all(pending)
  expect(delivery).toHaveBeenCalledTimes(25)
  expect(sqlite.prepare('SELECT count(*) AS count FROM session').get()).toEqual({ count: 0 })
})

it('reports unknown coverage when refresh planning fails', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => errors.mockRestore())
  let injected = false
  const { auth, pending, delivery, addSession, addClient, addRefresh } = setup({
    beforeQuery: (sql) => {
      if (!injected && /oauth_refresh_token/i.test(sql) && /select/i.test(sql)) {
        injected = true
        throw new Error('refresh-plan-failed')
      }
    },
  })
  addSession('session')
  addClient('client')
  addRefresh('refresh', 'session', 'client')
  expect(await endOidcUserSessions(auth, USER_ID)).toEqual({
    success: true,
    truncated: null,
    coverage: 'unknown',
  })
  await Promise.all(pending)
  expect(injected).toBe(true)
  expect(delivery).not.toHaveBeenCalled()
})

it('never forwards notification-only IDs after a queued hook', async () => {
  const accessUpdates: string[] = []
  const { auth, pending, delivery, addSession, addClient, addRefresh } = setup({
    beforeQuery(sql) {
      if (/^\s*update\s+["`]?oauth_access_token\b/i.test(sql)) accessUpdates.push(sql)
    },
  })
  addSession('session')
  addClient('refresh-only')
  addRefresh('historical', 'session', 'refresh-only', { scopes: ['offline_access'] })
  // The public KitBetterAuth type omits Better Auth's in-process context.
  const contextAuth = auth as unknown as { $context: Promise<{ adapter: DBAdapter }> }
  const { adapter } = await contextAuth.$context
  const writes = vi.spyOn(adapter, 'updateMany')
  await runWithTransaction(adapter, () => endOidcUserSessions(auth, USER_ID))
  await Promise.all(pending)
  expect(notifiedClients(delivery)).toEqual(['refresh-only'])
  expect(accessUpdates).toEqual([])
  expect(writes.mock.calls.map(([query]) => query.model)).not.toContain('oauthAccessToken')
})

it('matches adapter scope decoding for legacy refresh rows', async () => {
  const { sqlite, auth, pending, delivery, addSession, addClient, addRefresh } = setup()
  addSession('session')
  addClient('client')
  addRefresh('quoted', 'session', 'client', { scopes: ['openid', 'legacy"offline_access'] })
  addRefresh('legacy', 'session', 'client')
  addRefresh('offline', 'session', 'client', { scopes: ['offline_access'] })
  sqlite
    .prepare('UPDATE oauth_refresh_token SET scopes = ? WHERE id = ?')
    .run('openid offline_access', 'legacy')
  await endOidcUserSessions(auth, USER_ID)
  await Promise.all(pending)
  expect(notifiedClients(delivery)).toEqual(['client'])
  expect(
    sqlite
      .prepare('SELECT id, revoked IS NOT NULL AS revoked FROM oauth_refresh_token ORDER BY id')
      .all(),
  ).toEqual([
    { id: 'legacy', revoked: 1 },
    { id: 'offline', revoked: 0 },
    { id: 'quoted', revoked: 1 },
  ])
})

it('preserves logout with a forwarding adapter without a D1 handle', async () => {
  const { sqlite, auth, pending, delivery, addSession, addClient, addRefresh } = setup()
  addSession('session')
  addClient('client')
  addRefresh('refresh', 'session', 'client')
  const contextAuth = auth as unknown as { $context: Promise<{ adapter: DBAdapter }> }
  const ctx = await contextAuth.$context
  const { __kitOidcLogoutD1: _binding, ...wrapper } = ctx.adapter as DBAdapter & {
    __kitOidcLogoutD1?: unknown
  }
  ctx.adapter = wrapper
  expect(await runWithAdapter(wrapper, () => endOidcUserSessions(auth, USER_ID))).toEqual({
    success: true,
    truncated: false,
  })
  await Promise.all(pending)
  expect(notifiedClients(delivery)).toEqual(['client'])
  expect(
    sqlite.prepare('SELECT revoked IS NOT NULL AS revoked FROM oauth_refresh_token').get(),
  ).toEqual({
    revoked: 1,
  })
})

it('bounds returned refresh rows when most tokens are revoked', async () => {
  const { auth, pending, addSession, addClient, addRefresh, now, tokenPlanRows } = setup()
  addSession('session')
  addClient('client')
  for (let i = 0; i < 600; i++) addRefresh(`old-${i}`, 'session', 'client', { revoked: now })
  addRefresh('live', 'session', 'client')
  await endOidcUserSessions(auth, USER_ID)
  await Promise.all(pending)
  expect(tokenPlanRows()).toBeLessThan(10)
})
