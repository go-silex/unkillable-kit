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

function setup(options: { beforeSecondSessionPage?: (sqlite: Database.Database) => void } = {}) {
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
  const now = Math.floor(Date.now() / 1000)
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
  let removedEarlyRow = false
  database.prepare = (sql) => {
    if (
      !removedEarlyRow &&
      options.beforeSecondSessionPage &&
      /from\s+["`]?session["`]?/i.test(sql) &&
      /["`]?id["`]?\s*>/i.test(sql)
    ) {
      removedEarlyRow = true
      options.beforeSecondSessionPage(sqlite)
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
  const addSession = (id: string) =>
    sqlite
      .prepare(
        'INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, `token-${id}`, USER_ID, now + 3600, now, now)
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
        `access-${id}`,
        clientId,
        sessionId,
        USER_ID,
        now + 3600,
        now,
        JSON.stringify(['openid']),
      )
  return { sqlite, auth, pending, delivery, addSession, addClient, addToken }
}

it('notifies the relying party on the last of more than 100 sessions', async () => {
  const { sqlite, auth, pending, delivery, addSession, addClient, addToken } = setup()
  for (let i = 0; i < 101; i++) addSession(`session-${String(i).padStart(3, '0')}`)
  addClient('last-client')
  addToken('last-token', 'session-100', 'last-client')

  await endOidcUserSessions(auth, USER_ID)
  await Promise.all(pending)

  expect(
    sqlite.prepare('SELECT count(*) AS count FROM session WHERE user_id = ?').get(USER_ID),
  ).toEqual({ count: 0 })
  expect(delivery).toHaveBeenCalledTimes(1)
  const [url, options] = delivery.mock.calls[0]
  expect(url).toBe('https://client.example.test/logout/last-client')
  const token = new URLSearchParams(options?.body as string).get('logout_token')
  expect(token).toBeTruthy()
  expect(decodeJwt(token as string)).toMatchObject({
    aud: 'last-client',
    sub: USER_ID,
    sid: 'session-100',
  })
})

it('notifies and revokes tokens for more than 100 relying parties on one session', async () => {
  const { sqlite, auth, pending, delivery, addSession, addClient, addToken } = setup()
  addSession('shared-session')
  for (let i = 0; i < 101; i++) {
    const id = `client-${String(i).padStart(3, '0')}`
    addClient(id)
    addToken(`token-${id}`, 'shared-session', id)
  }

  await endOidcUserSessions(auth, USER_ID)
  await Promise.all(pending)

  expect(delivery).toHaveBeenCalledTimes(101)
  expect(delivery.mock.calls.map(([url]) => url)).toContain(
    'https://client.example.test/logout/client-100',
  )
  expect(
    sqlite
      .prepare('SELECT count(*) AS count FROM oauth_access_token WHERE revoked IS NOT NULL')
      .get(),
  ).toEqual({ count: 101 })
})

it('revokes every non-offline refresh token without revoking offline access', async () => {
  const { sqlite, auth, pending, addSession, addClient } = setup()
  addSession('refresh-session')
  addClient('refresh-client')
  const now = Math.floor(Date.now() / 1000)
  const insert = sqlite.prepare(
    'INSERT INTO oauth_refresh_token (id, token, client_id, session_id, user_id, expires_at, created_at, scopes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  for (let i = 0; i < 102; i++) {
    insert.run(
      `refresh-${i}`,
      `refresh-token-${i}`,
      'refresh-client',
      'refresh-session',
      USER_ID,
      now + 3600,
      now,
      JSON.stringify(i === 101 ? ['offline_access'] : ['openid']),
    )
  }

  await endOidcUserSessions(auth, USER_ID)
  await Promise.all(pending)

  expect(
    sqlite
      .prepare('SELECT count(*) AS count FROM oauth_refresh_token WHERE revoked IS NOT NULL')
      .get(),
  ).toEqual({ count: 101 })
  expect(
    sqlite.prepare('SELECT revoked FROM oauth_refresh_token WHERE id = ?').get('refresh-101'),
  ).toEqual({ revoked: null })
})

it('uses a stable cursor if an earlier session disappears between pages', async () => {
  const beforeSecondSessionPage = vi.fn((db: Database.Database) => {
    db.prepare('DELETE FROM session WHERE id = ?').run('session-000')
  })
  const { sqlite, auth, pending, delivery, addSession, addClient, addToken } = setup({
    beforeSecondSessionPage,
  })
  for (let i = 0; i < 101; i++) addSession(`session-${String(i).padStart(3, '0')}`)
  addClient('last-client')
  addToken('last-token', 'session-100', 'last-client')

  await endOidcUserSessions(auth, USER_ID)
  await Promise.all(pending)
  expect(beforeSecondSessionPage).toHaveBeenCalledOnce()

  expect(sqlite.prepare('SELECT count(*) AS count FROM session').get()).toEqual({ count: 0 })
  expect(delivery).toHaveBeenCalledTimes(1)
  expect(
    sqlite.prepare('SELECT revoked FROM oauth_access_token WHERE id = ?').get('last-token'),
  ).toMatchObject({ revoked: expect.any(Number) })
})

it('keeps every session if a revocation write fails', async () => {
  const { sqlite, auth, addSession, addClient, addToken } = setup()
  addSession('session-one')
  addClient('client-one')
  addToken('token-one', 'session-one', 'client-one')
  sqlite.exec(`CREATE TRIGGER reject_revocation BEFORE UPDATE OF revoked ON oauth_access_token
    BEGIN SELECT RAISE(ABORT, 'revocation failed'); END`)

  await expect(endOidcUserSessions(auth, USER_ID)).rejects.toThrow()
  expect(sqlite.prepare('SELECT count(*) AS count FROM session').get()).toEqual({ count: 1 })
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
