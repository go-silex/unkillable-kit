import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createSqliteD1 } from '@kit/db/testing'
import Database from 'better-sqlite3'
import { decodeJwt } from 'jose'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createBetterAuth } from '../better-auth-factory'
import { createOidcProvider, endOidcUserSessions, registerOidcClient } from './oidc-provider'

const ORIGIN = 'https://auth.example.test'
const USER_ID = 'pagination-user'

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
  database.prepare = (sql) => {
    queryCount++
    options.beforeQuery?.(sql)
    if (/delete\s+from\s+["`]?session["`]?/i.test(sql)) {
      options.beforeDelete?.(sqlite)
    }
    return prepare(sql)
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
  const addClient = (id: string) =>
    sqlite
      .prepare(
        'INSERT INTO oauth_client (id, client_id, redirect_uris, backchannel_logout_uri) VALUES (?, ?, ?, ?)',
      )
      .run(
        id,
        id,
        JSON.stringify(['https://client.example.test/callback']),
        `https://client.example.test/logout/${id}`,
      )
  const addToken = (id: string, sessionId: string, clientId: string) =>
    sqlite
      .prepare(
        'INSERT INTO oauth_access_token (id, token, client_id, session_id, user_id, expires_at, created_at, scopes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
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
      )
  return {
    sqlite,
    auth,
    pending,
    delivery,
    addSession,
    addClient,
    addToken,
    queries: () => queryCount,
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

it.each([
  { table: 'session', truncated: null },
  { table: 'oauth_access_token', truncated: false },
])(
  'reports unknown coverage when $table planning fails, without leaking errors',
  async ({ table, truncated }) => {
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
      truncated,
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
