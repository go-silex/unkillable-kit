import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createSqliteD1 } from '@kit/db/testing'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createBetterAuth, type KitBetterAuth } from '../better-auth-factory'
import { createOidcProvider, registerOidcClient } from './oidc-provider'

const ORIGIN = 'https://auth.example.test'
const REDIRECT = 'https://client.example.test/callback'
const VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'
const GOOGLE_CLIENT = 'google-client-id'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'google-test-key',
  alg: 'RS256',
  use: 'sig',
}

function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ')
}

function request(auth: KitBetterAuth, path: string, init?: RequestInit) {
  return auth.handler(new Request(new URL(path, ORIGIN), init))
}

async function setup(firstParty: boolean) {
  const sqlite = new Database(':memory:')
  onTestFinished(() => {
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
  const auth = createBetterAuth({
    database: createSqliteD1(sqlite),
    secret: 'test-better-auth-secret-xxxxxxxx32c!!',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    allowPublicSignup: true,
    google: {
      clientId: GOOGLE_CLIENT,
      clientSecret: 'google-client-secret',
      allowedDomains: ['example.test'],
    },
    oidcProvider: createOidcProvider({
      loginPage: '/login',
      consentPage: '/consent',
      waitUntil: () => {},
    }),
  })
  const signup = await request(auth, '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({
      name: 'Example User',
      email: 'user@example.test',
      password: 'example-password-123',
    }),
  })
  expect(signup.ok).toBe(true)
  const client = await registerOidcClient(auth, {
    headers: new Headers({ cookie: cookies(signup) }),
    redirectUris: [REDIRECT],
    firstParty,
  })
  sqlite
    .prepare(
      'INSERT INTO user (id, name, email, email_verified, disabled, created_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?)',
    )
    .run('google-user', 'Google User', 'google@example.test', Date.now(), Date.now())
  if (!client.client_secret) throw new Error('Client registration returned no secret')
  return { auth, client: { ...client, client_secret: client.client_secret } }
}

async function start(auth: KitBetterAuth, clientId: string, method: 'GET' | 'POST') {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(VERIFIER))
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: 'openid email profile',
    state: 'expected-state',
    nonce: 'expected-nonce',
    code_challenge: Buffer.from(hash).toString('base64url'),
    code_challenge_method: 'S256',
  })
  const response = await request(
    auth,
    `/api/auth/oauth2/authorize${method === 'GET' ? `?${params}` : ''}`,
    {
      method,
      headers: {
        accept: 'text/html',
        ...(method === 'POST'
          ? { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN }
          : {}),
      },
      ...(method === 'POST' ? { body: params } : {}),
    },
  )
  expect(response.status).toBe(302)
  const login = new URL(response.headers.get('location') ?? '', ORIGIN)
  expect(login.pathname).toBe('/login')
  expect(login.searchParams.get('sig')).toBeTruthy()
  expect(login.searchParams.get('code')).toBeNull()
  return login.search.slice(1)
}

async function login(auth: KitBetterAuth, oauthQuery: string, password = 'example-password-123') {
  return request(auth, '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email: 'user@example.test', password, oauth_query: oauthQuery }),
  })
}

async function continuation(response: Response) {
  expect(response.ok).toBe(true)
  const result = (await response.json()) as { redirect: boolean; url: string }
  expect(result.redirect).toBe(true)
  return new URL(result.url, ORIGIN)
}

async function complete(
  auth: KitBetterAuth,
  client: { client_id: string; client_secret: string },
  url: URL,
  email: string,
) {
  expect(`${url.origin}${url.pathname}`).toBe(REDIRECT)
  expect(url.searchParams.get('state')).toBe('expected-state')
  const code = url.searchParams.get('code')
  expect(code).toBeTruthy()
  const token = await request(auth, '/api/auth/oauth2/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    }),
  })
  expect(token.status).toBe(200)
  const tokens = (await token.json()) as { access_token: string; id_token: string }
  expect(tokens.id_token).toBeTruthy()
  const userinfo = await request(auth, '/api/auth/oauth2/userinfo', {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  })
  expect(userinfo.status).toBe(200)
  expect(await userinfo.json()).toMatchObject({ sub: expect.any(String), email })
}

function googleBoundary(emailVerified: boolean) {
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const payload = `${encode({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' })}.${encode({
    iss: 'https://accounts.google.com',
    aud: GOOGLE_CLIENT,
    iat: now,
    exp: now + 3600,
    sub: 'google-subject',
    name: 'Google User',
    email: 'google@example.test',
    email_verified: emailVerified,
    hd: 'example.test',
  })}`
  const token = `${payload}.${sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === 'https://oauth2.googleapis.com/token')
        return Response.json({
          access_token: 'google-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: token,
        })
      if (url === 'https://www.googleapis.com/oauth2/v3/certs')
        return Response.json({ keys: [jwk] })
      throw new Error(`Unexpected external request: ${url}`)
    }),
  )
}

async function googleLogin(auth: KitBetterAuth, oauthQuery: string) {
  const start = await request(auth, '/api/auth/sign-in/social', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({
      provider: 'google',
      callbackURL: `${ORIGIN}/done`,
      oauth_query: oauthQuery,
    }),
  })
  expect(start.status).toBe(200)
  const body = (await start.json()) as { url: string }
  const authorization = new URL(body.url)
  expect(authorization.origin).toBe('https://accounts.google.com')
  const state = authorization.searchParams.get('state')
  expect(state).toBeTruthy()
  return request(
    auth,
    `/api/auth/callback/google?${new URLSearchParams({ code: 'google-authorization-code', state: state! })}`,
    {
      headers: { cookie: cookies(start), accept: 'text/html' },
    },
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('signed-out OIDC authorization', () => {
  for (const method of ['GET', 'POST'] as const) {
    it(`${method} resumes after password login and first-party consent skip`, async () => {
      const { auth, client } = await setup(true)
      const oauthQuery = await start(auth, client.client_id, method)
      const signedIn = await login(auth, oauthQuery)
      await complete(auth, client, await continuation(signedIn), 'user@example.test')
    })

    it(`${method} resumes after password login and explicit consent`, async () => {
      const { auth, client } = await setup(false)
      const signedIn = await login(auth, await start(auth, client.client_id, method))
      const consent = await continuation(signedIn)
      expect(consent.pathname).toBe('/consent')
      expect(consent.searchParams.get('sig')).toBeTruthy()
      const accepted = await request(auth, '/api/auth/oauth2/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: cookies(signedIn) },
        body: JSON.stringify({ accept: true, oauth_query: consent.search.slice(1) }),
      })
      await complete(auth, client, await continuation(accepted), 'user@example.test')
    })

    it(`${method} refuses invalid credentials without issuing a code`, async () => {
      const { auth, client } = await setup(true)
      const response = await login(
        auth,
        await start(auth, client.client_id, method),
        'wrong-password',
      )
      expect(response.ok).toBe(false)
      expect(response.headers.get('location') ?? '').not.toContain('code=')
      expect(await response.text()).not.toContain('code=')
      expect(cookies(response)).not.toContain('session_token=')
    })

    it(`${method} completes authorization after Google sign-in`, async () => {
      const { auth, client } = await setup(true)
      googleBoundary(true)
      const response = await googleLogin(auth, await start(auth, client.client_id, method))
      expect(response.status).toBe(302)
      await complete(
        auth,
        client,
        new URL(response.headers.get('location') ?? '', ORIGIN),
        'google@example.test',
      )
    })

    it(`${method} refuses an unverified Google identity without issuing a code`, async () => {
      const { auth, client } = await setup(true)
      googleBoundary(false)
      const response = await googleLogin(auth, await start(auth, client.client_id, method))
      expect(response.headers.get('location')).toContain('error=unable_to_get_user_info')
      expect(response.headers.get('location') ?? '').not.toContain('code=')
      expect(await response.text()).not.toContain('code=')
      expect(cookies(response)).not.toContain('session_token=')
    })
  }
})
