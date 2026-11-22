import { readFileSync } from 'node:fs'
import type { KitD1Database } from '@kit/db'
import { createSqliteD1 } from '@kit/db/testing'
import Database from 'better-sqlite3'
import { expect, type Mock, onTestFinished, vi } from 'vitest'
import type { AuthEmailPort } from '../auth-email'
import { createBetterAuth, type KitBetterAuth } from '../better-auth-factory'
import { GOOGLE_CLIENT, googleIdToken, googleJwk } from './oidc-google.fixture'
import { createOidcProvider, registerOidcClient } from './oidc-provider'

const ORIGIN = 'https://auth.example.test'
const REDIRECT = 'https://client.example.test/callback'
const VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'

function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ')
}

function request(auth: KitBetterAuth, path: string, init?: RequestInit) {
  return auth.handler(new Request(new URL(path, ORIGIN), init))
}

type LoginFlowFixture = {
  auth: KitBetterAuth
  createAuth(): KitBetterAuth
  client: { client_id: string; client_secret: string }
  send: Mock<AuthEmailPort['send']>
  sqlite: Database.Database
  database: KitD1Database
  secret: string
  signupCookie: string
}

async function setup(firstParty: boolean, baseURL = ORIGIN): Promise<LoginFlowFixture> {
  const sqlite = new Database(':memory:')
  onTestFinished(() => {
    sqlite.close()
  })
  for (const migration of [
    '0005_better_auth.sql',
    '0006_better_auth_organization.sql',
    '0010_rate_limit_audit.sql',
    '0014_better_auth_1_7_additive.sql',
    '0025_account_state.sql',
    '0027_better_auth_oidc_provider.sql',
    '0028_better_auth_oidc_fresh_login.sql',
  ]) {
    sqlite.exec(
      readFileSync(
        new URL(`../../../../apps/example-api/migrations/${migration}`, import.meta.url),
        'utf8',
      ),
    )
  }
  const send = vi.fn<AuthEmailPort['send']>(async () => ({ ok: true, transport: 'log' }))
  const database = createSqliteD1(sqlite)
  const secret = crypto.randomUUID() + crypto.randomUUID()
  const createAuth = () =>
    createBetterAuth({
      database,
      secret,
      baseURL,
      trustedOrigins: [ORIGIN],
      allowPublicSignup: true,
      emailPort: { send },
      emailConfig: {
        productName: 'Example',
        fallbackLocale: 'en',
        resolveRecipientLocale: () => null,
      },
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
  const auth = createAuth()
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
  return {
    auth,
    createAuth,
    client: { ...client, client_secret: client.client_secret },
    send,
    sqlite,
    database,
    secret,
    signupCookie: cookies(signup),
  }
}

async function start(
  auth: KitBetterAuth,
  clientId: string,
  method: 'GET' | 'POST',
  freshness?: { prompt: string } | { max_age: string },
) {
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
    ...freshness,
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

async function login(auth: KitBetterAuth, oauthQuery?: string, password = PASSWORD) {
  return request(auth, '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email: 'user@example.test', password, oauth_query: oauthQuery }),
  })
}

async function continuation(response: Response) {
  if (response.status === 302) {
    const location = response.headers.get('location')
    if (location) return new URL(location, ORIGIN)
  }
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
  const token = googleIdToken(emailVerified)
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
        return Response.json({ keys: [googleJwk] })
      throw new Error(`Unexpected external request: ${url}`)
    }),
  )
}

function startGoogleLogin(auth: KitBetterAuth, oauthQuery: unknown) {
  return request(auth, '/api/auth/sign-in/social', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({
      provider: 'google',
      callbackURL: `${ORIGIN}/done`,
      oauth_query: oauthQuery,
    }),
  })
}

function sendMagicLink(auth: KitBetterAuth, oauthQuery: unknown) {
  return request(auth, '/api/auth/sign-in/magic-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email: 'user@example.test', oauth_query: oauthQuery }),
  })
}

async function googleLogin(auth: KitBetterAuth, oauthQuery: string) {
  const start = await startGoogleLogin(auth, oauthQuery)
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
function codeCount(sqlite: Database.Database) {
  return sqlite
    .prepare(
      "SELECT count(*) FROM verification WHERE json_valid(value) AND json_extract(value, '$.type') = 'authorization_code'",
    )
    .pluck()
    .get()
}

const PASSWORD = ['example', 'password', '123'].join('-')

export {
  codeCount,
  complete,
  complete as exchange,
  continuation,
  cookies,
  googleBoundary,
  googleLogin,
  login,
  ORIGIN,
  PASSWORD,
  REDIRECT,
  request,
  sendMagicLink,
  setup,
  start,
  startGoogleLogin,
  VERIFIER,
}
