import { EventEmitter, once } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose'
import { Miniflare, Response as MiniflareResponse } from 'miniflare'
import { expect, it } from 'vitest'

const ORIGIN = 'https://auth.example.test'
const ISSUER = `${ORIGIN}/api/auth`
const REDIRECT = 'https://client.example.test/callback'
const LOGOUT_URI = 'https://client.example.test/backchannel-logout'
const VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'
const CREDENTIALS = { email: 'user@example.test', password: crypto.randomUUID() }
type Client = { client_id: string; client_secret: string }
type OutboundRequest = Pick<Request, 'url' | 'method' | 'text'>
const root = dirname(fileURLToPath(import.meta.url))

async function withWorker(
  oidc: boolean,
  run: (worker: Miniflare) => Promise<void>,
  {
    onOutbound,
    secondary = false,
  }: {
    onOutbound?: (request: OutboundRequest) => Promise<void>
    secondary?: boolean
  } = {},
) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./oidc-worker.fixture.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    external: ['node:*'],
  })
  const name = 'oidc-worker-test'
  const miniflare = new Miniflare({
    workers: [
      {
        config: {
          name,
          compatibilityDate: '2026-07-01',
          compatibilityFlags: ['nodejs_compat'],
          env: {
            OIDC_ENABLED: { type: 'json', value: oidc },
            DB: { type: 'd1', name, id: '00000000-0000-0000-0000-000000000001' },
            DB_SECONDARY: {
              type: 'd1',
              name: `${name}-secondary`,
              id: '00000000-0000-0000-0000-000000000002',
            },
          },
          manifest: {
            mainModule: 'worker.mjs',
            modulesRoot: root,
            modules: { 'worker.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } },
          },
        },
        dev: {
          outboundService: {
            type: 'fetcher',
            handler: async (request) => {
              await onOutbound?.(request)
              return new MiniflareResponse(null, { status: 200 })
            },
          },
        },
      },
    ],
  })
  try {
    const databases = [await miniflare.getD1Database('DB')]
    if (secondary) databases.push(await miniflare.getD1Database('DB_SECONDARY'))
    for (const migration of [
      '0005_better_auth.sql',
      '0006_better_auth_organization.sql',
      '0014_better_auth_1_7_additive.sql',
      '0025_account_state.sql',
      ...(oidc
        ? ['0027_better_auth_oidc_provider.sql', '0028_better_auth_oidc_fresh_login.sql']
        : []),
    ]) {
      const sql = readFileSync(
        new URL(`../../../../apps/example-api/migrations/${migration}`, import.meta.url),
        'utf8',
      )
      const statements = sql
        .replace(/^\s*--.*$/gm, '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
      for (const db of databases) {
        for (const statement of statements) await db.prepare(statement).run()
      }
    }
    await run(miniflare)
  } finally {
    await miniflare.dispose()
  }
}

function postJson(worker: Miniflare, path: string, body: object) {
  return worker.dispatchFetch(`${ISSUER}/${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(body),
  })
}

function sessionCookie(response: MiniflareResponse) {
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  expect(cookie).not.toBe('')
  return cookie
}

async function signup(worker: Miniflare) {
  const response = await postJson(worker, 'sign-up/email', { name: 'Example User', ...CREDENTIALS })
  expect(response.status).toBe(200)
  const { user } = (await response.json()) as { user: { id: string } }
  return { user, cookie: sessionCookie(response) }
}

async function register(worker: Miniflare, cookie: string, headers?: Record<string, string>) {
  const response = await worker.dispatchFetch(`${ORIGIN}/__test/register`, {
    headers: { cookie, ...headers },
  })
  expect(response.status).toBe(200)
  const client = (await response.json()) as Client
  expect(client.client_secret).toBeTruthy()
  return client
}

async function authorize(
  worker: Miniflare,
  clientId: string,
  cookie: string,
  freshness?: { prompt: 'login' } | { max_age: string },
  headers?: Record<string, string>,
) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(VERIFIER))
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: 'openid email profile',
    code_challenge: Buffer.from(hash).toString('base64url'),
    code_challenge_method: 'S256',
    nonce: 'worker-test-nonce',
    state: 'worker-test-state',
    ...freshness,
  })
  return worker.dispatchFetch(`${ISSUER}/oauth2/authorize?${query}`, {
    headers: { cookie, accept: 'text/html', ...headers },
    redirect: 'manual',
  })
}

async function continuation(response: MiniflareResponse) {
  if (response.status === 302) {
    const location = response.headers.get('location')
    expect(location).toBeTruthy()
    return new URL(location!, ORIGIN)
  }
  expect(response.status).toBe(200)
  const body = (await response.json()) as { redirect: boolean; url: string }
  expect(body.redirect).toBe(true)
  return new URL(body.url, ORIGIN)
}

async function exchangeCode(worker: Miniflare, client: Client, callback: URL) {
  expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT)
  expect(callback.searchParams.get('state')).toBe('worker-test-state')
  const code = callback.searchParams.get('code')
  expect(code).toBeTruthy()
  const token = await worker.dispatchFetch(`${ISSUER}/oauth2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code as string,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    }),
  })
  expect(token.status).toBe(200)
  expect(await token.json()).toMatchObject({
    access_token: expect.any(String),
    id_token: expect.any(String),
  })
}

it('delivers signed back-channel logout and revokes legacy BLOB-scoped refresh tokens on Workers', async () => {
  const deliveries: { url: string; method: string; body: string }[] = []
  const events = new EventEmitter()
  const deliveryReceived = once(events, 'delivered')
  async function onOutbound(request: OutboundRequest) {
    if (new URL(request.url).pathname === '/__test/background-complete') {
      events.emit('delivered')
    } else {
      deliveries.push({ url: request.url, method: request.method, body: await request.text() })
    }
  }
  await withWorker(
    true,
    async (miniflare) => {
      const db = await miniflare.getD1Database('DB')
      const { user, cookie } = await signup(miniflare)
      expect(
        await db.prepare('SELECT session_id FROM oidc_session_authentication').first(),
      ).toBeNull()
      const client = await register(miniflare, cookie)
      const authorization = await authorize(miniflare, client.client_id, cookie)
      await exchangeCode(miniflare, client, await continuation(authorization))
      const storedClient = await db
        .prepare('SELECT disabled, backchannel_logout_uri FROM oauth_client WHERE client_id = ?')
        .bind(client.client_id)
        .first<{ disabled: number | null; backchannel_logout_uri: string | null }>()
      expect(storedClient).toMatchObject({ backchannel_logout_uri: LOGOUT_URI })
      expect(storedClient?.disabled ?? 0).toBe(0)
      // D1 returns a BLOB as bytes. String coercion of this one-byte value parses as a JSON number.
      await db
        .prepare(
          `INSERT INTO oauth_refresh_token
           (id, token, client_id, session_id, user_id, expires_at, created_at, scopes)
         SELECT 'legacy-refresh', 'legacy-refresh-value', client_id, session_id, user_id,
                expires_at, created_at, X'31'
         FROM oauth_access_token WHERE user_id = ? AND client_id = ? AND session_id IS NOT NULL`,
        )
        .bind(user.id, client.client_id)
        .run()
      const logout = await miniflare.dispatchFetch(`${ORIGIN}/__test/logout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      })
      expect(await logout.json()).toEqual({ success: true, truncated: false, backgroundTasks: 1 })
      expect(logout.status).toBe(200)
      await deliveryReceived
      const refresh = await db
        .prepare(
          "SELECT typeof(scopes) AS storage, revoked FROM oauth_refresh_token WHERE id = 'legacy-refresh'",
        )
        .first<{ storage: string; revoked: number | null }>()
      expect(refresh).toMatchObject({ storage: 'blob', revoked: expect.any(Number) })
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]).toMatchObject({ url: LOGOUT_URI, method: 'POST' })
      const logoutToken = new URLSearchParams(deliveries[0].body).get('logout_token')
      expect(logoutToken).toBeTruthy()
      const jwksResponse = await miniflare.dispatchFetch(`${ISSUER}/jwks`)
      const jwks = (await jwksResponse.json()) as JSONWebKeySet
      const { payload, protectedHeader } = await jwtVerify(
        logoutToken as string,
        createLocalJWKSet(jwks),
        {
          issuer: ISSUER,
          audience: client.client_id,
          algorithms: ['RS256'],
        },
      )
      expect(protectedHeader.alg).toBe('RS256')
      expect(payload).toMatchObject({
        sub: user.id,
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      })
      expect(payload.jti).toEqual(expect.any(String))
      expect(payload.nonce).toBeUndefined()
    },
    { onOutbound },
  )
}, 30_000)

it('completes fresh authorization in the password request and cascades proof on session deletion', async () => {
  await withWorker(true, async (worker) => {
    const db = await worker.getD1Database('DB')
    const { user, cookie } = await signup(worker)
    const signupSession = await db.prepare('SELECT id FROM session').first<string>('id')
    expect(signupSession).toBeTruthy()
    const client = await register(worker, cookie)
    const login = await continuation(
      await authorize(worker, client.client_id, cookie, { prompt: 'login' }),
    )
    expect(`${login.origin}${login.pathname}`).toBe(`${ORIGIN}/login`)
    expect(login.searchParams.get('sig')).toBeTruthy()
    expect(login.searchParams.has('code')).toBe(false)
    const signedIn = await postJson(worker, 'sign-in/email', {
      ...CREDENTIALS,
      oauth_query: login.search.slice(1),
    })
    // Sign-in itself returns the RP callback; there is no follow-up authorize or consent request.
    await exchangeCode(worker, client, await continuation(signedIn))
    const selected = await db
      .prepare(
        `SELECT session.id, session.created_at FROM oauth_access_token
         JOIN session ON session.id = oauth_access_token.session_id
         WHERE oauth_access_token.user_id = ? AND oauth_access_token.client_id = ?`,
      )
      .bind(user.id, client.client_id)
      .first<{ id: string; created_at: number }>()
    if (!selected) throw new Error('No live session linked to the exchanged access token')
    expect(selected.id).not.toBe(signupSession)
    const evidence = await db.prepare('SELECT * FROM oidc_session_authentication').all()
    expect(evidence.results).toEqual([
      { session_id: selected.id, method: 'password', authenticated_at: selected.created_at },
    ])
    // Delete through D1, not an auth endpoint, to exercise the migration's foreign key.
    await db.prepare('DELETE FROM session WHERE id = ?').bind(selected.id).run()
    expect(
      await db.prepare('SELECT session_id FROM oidc_session_authentication').first(),
    ).toBeNull()
  })
}, 30_000)

it('creates ordinary signup and password sessions on Workers with only base auth migrations', async () => {
  await withWorker(false, async (worker) => {
    const { user, cookie } = await signup(worker)
    const signedIn = await postJson(worker, 'sign-in/email', CREDENTIALS)
    expect(signedIn.status).toBe(200)
    for (const session of [cookie, sessionCookie(signedIn)]) {
      const response = await worker.dispatchFetch(`${ISSUER}/get-session`, {
        headers: { cookie: session },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ user: { id: user.id } })
    }
  })
}, 30_000)

it('uses only the selected D1 binding’s authentication evidence for identical password sessions', async () => {
  await withWorker(
    true,
    async (worker) => {
      const primary = await worker.getD1Database('DB')
      const secondary = await worker.getD1Database('DB_SECONDARY')
      const onSecondary = { 'x-test-database': 'secondary' }

      const { user } = await signup(worker)
      const signedIn = await postJson(worker, 'sign-in/email', CREDENTIALS)
      expect(signedIn.status).toBe(200)
      const cookie = sessionCookie(signedIn)
      const client = await register(worker, cookie)

      // Give the same signed cookie the same user and session identity in both databases.
      // Only the primary binding saw the password sign-in and has its proof.
      const [userRow] = await primary
        .prepare(
          'SELECT id, name, email, email_verified, created_at, updated_at FROM user WHERE id = ?',
        )
        .bind(user.id)
        .raw()
      const [sessionRow] = await primary
        .prepare(
          `SELECT s.id, s.user_id, s.token, s.created_at, s.updated_at, s.expires_at
         FROM session s JOIN oidc_session_authentication p ON p.session_id = s.id
         WHERE s.user_id = ?`,
        )
        .bind(user.id)
        .raw()
      if (!(userRow && sessionRow)) throw new Error('Missing user or password session')
      await secondary.batch([
        secondary
          .prepare(
            'INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .bind(...userRow),
        secondary
          .prepare(
            'INSERT INTO session (id, user_id, token, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .bind(...sessionRow),
      ])
      expect(
        await secondary.prepare('SELECT session_id FROM oidc_session_authentication').first(),
      ).toBeNull()

      const secondaryClient = await register(worker, cookie, onSecondary)
      // Keep the authorization request identical; the client secret is not used on this endpoint.
      await secondary
        .prepare('UPDATE oauth_client SET client_id = ? WHERE client_id = ?')
        .bind(client.client_id, secondaryClient.client_id)
        .run()

      for (const headers of [undefined, onSecondary]) {
        const ordinary = await continuation(
          await authorize(worker, client.client_id, cookie, undefined, headers),
        )
        expect(`${ordinary.origin}${ordinary.pathname}`).toBe(REDIRECT)
        expect(ordinary.searchParams.get('code')).toBeTruthy()
      }

      const freshness = { max_age: '60' }
      const proven = await continuation(
        await authorize(worker, client.client_id, cookie, freshness),
      )
      expect(`${proven.origin}${proven.pathname}`).toBe(REDIRECT)
      expect(proven.searchParams.get('code')).toBeTruthy()

      const unproven = await continuation(
        await authorize(worker, client.client_id, cookie, freshness, onSecondary),
      )
      expect(`${unproven.origin}${unproven.pathname}`).toBe(`${ORIGIN}/login`)
      expect(unproven.searchParams.get('sig')).toBeTruthy()
      expect(unproven.searchParams.has('code')).toBe(false)
    },
    { secondary: true },
  )
}, 30_000)
