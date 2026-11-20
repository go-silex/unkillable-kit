import { readFileSync } from 'node:fs'
import { createSqliteD1 } from '@kit/db/testing'
import Database from 'better-sqlite3'
import { decodeJwt } from 'jose'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createBetterAuth } from '../better-auth-factory'
import { createOidcProvider, endOidcUserSessions } from './oidc-provider'

const ORIGIN = 'https://auth.example.test'
const USER_ID = 'pagination-user'

function setup() {
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
  const auth = createBetterAuth({
    database: createSqliteD1(sqlite),
    secret: 'test-better-auth-secret-xxxxxxxx32c!!',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
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
