import { readFileSync } from 'node:fs'
import { createSqliteD1 } from '@kit/db/testing'
import Database from 'better-sqlite3'
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createBetterAuth, type KitBetterAuth } from './better-auth-factory'
import { createOidcProvider, endOidcUserSessions, registerOidcClient } from './oidc-provider'

const ORIGIN = 'https://auth.example.test'
const ISSUER = `${ORIGIN}/api/auth`
const SECRET = 'test-better-auth-secret-xxxxxxxx32c!!'

function setup(enabled: boolean) {
  const sqlite = new Database(':memory:')
  const pending: Promise<unknown>[] = []
  onTestFinished(() => {
    sqlite.close()
  })
  for (const migration of [
    '0005_better_auth.sql',
    '0006_better_auth_organization.sql',
    '0014_better_auth_1_7_additive.sql',
    '0025_account_state.sql',
    ...(enabled ? ['0027_better_auth_oidc_provider.sql'] : []),
  ]) {
    sqlite.exec(
      readFileSync(
        new URL(`../../../apps/example-api/migrations/${migration}`, import.meta.url),
        'utf8',
      ),
    )
  }
  const auth = createBetterAuth({
    database: createSqliteD1(sqlite),
    secret: SECRET,
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    allowPublicSignup: true,
    ...(enabled
      ? {
          oidcProvider: createOidcProvider({
            loginPage: '/login',
            consentPage: '/consent',
            claims: async () => ({ app_role: 'reader' }),
            waitUntil: (promise) => {
              pending.push(promise)
            },
          }),
        }
      : {}),
  })
  return { auth, sqlite, pending }
}

function request(auth: KitBetterAuth, path: string, init?: RequestInit) {
  return auth.handler(new Request(`${ORIGIN}${path}`, init))
}

const REDIRECT = 'https://client.example.test/callback'
const VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'
const NONCE = 'nonce-for-client'

async function clientSession(auth: KitBetterAuth) {
  const response = await request(auth, '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({
      name: 'Example User',
      email: 'user@example.test',
      password: 'example-password-123',
    }),
  })
  expect(response.ok).toBe(true)
  const body = (await response.json()) as { user: { id: string } }
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  expect(cookie).not.toBe('')
  const client = await registerOidcClient(auth, {
    headers: new Headers({ cookie }),
    redirectUris: [REDIRECT],
    firstParty: true,
    name: 'Example client',
    backchannelLogoutUri: 'https://client.example.test/backchannel-logout',
  })
  if (!client.client_secret) throw new Error('Confidential client registration returned no secret')
  return {
    cookie,
    userId: body.user.id,
    client: { ...client, client_secret: client.client_secret },
  }
}

async function authorizationUrl(clientId: string, overrides: Record<string, string> = {}) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(VERIFIER))
  const challenge = Buffer.from(hash).toString('base64url')
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: 'openid email profile',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    nonce: NONCE,
    state: 'expected-state',
    ...overrides,
  })
  return `/api/auth/oauth2/authorize?${params}`
}

async function authorize(
  auth: KitBetterAuth,
  clientId: string,
  cookie: string,
  overrides?: Record<string, string>,
) {
  return request(auth, await authorizationUrl(clientId, overrides), {
    headers: { cookie, accept: 'text/html' },
  })
}

async function codeFor(auth: KitBetterAuth, clientId: string, cookie: string) {
  const response = await authorize(auth, clientId, cookie)
  expect(response.status).toBe(302)
  const location = new URL(response.headers.get('location') ?? '', ORIGIN)
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT)
  expect(location.searchParams.get('state')).toBe('expected-state')
  const code = location.searchParams.get('code')
  expect(code).toBeTruthy()
  return code as string
}

async function exchange(
  auth: KitBetterAuth,
  client: { client_id: string; client_secret: string },
  code: string,
  verifier?: string,
) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
  })
  if (verifier !== undefined) body.set('code_verifier', verifier)
  return request(auth, '/api/auth/oauth2/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`,
    },
    body,
  })
}

async function verifyJwt(token: string, jwks: JSONWebKeySet) {
  const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks), {
    algorithms: ['RS256'],
    issuer: ISSUER,
  })
  expect(protectedHeader.alg).toBe('RS256')
  return payload
}

describe('opt-in OpenID Provider', () => {
  it('does not expose OIDC discovery or the provider token endpoint by default', async () => {
    const { auth } = setup(false)
    expect((await request(auth, '/api/auth/.well-known/openid-configuration')).status).toBe(404)
    expect((await request(auth, '/api/auth/oauth2/token', { method: 'POST' })).status).toBe(404)
  })

  it('notifies the registered client with a signed back-channel logout token', async () => {
    const { auth, pending } = setup(true)
    const { client, cookie, userId } = await clientSession(auth)
    const code = await codeFor(auth, client.client_id, cookie)
    expect((await exchange(auth, client, code, VERIFIER)).status).toBe(200)
    const delivery = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', delivery)
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    await endOidcUserSessions(auth, userId)
    await Promise.all(pending)
    expect(delivery).toHaveBeenCalledTimes(1)
    const [url, options] = delivery.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://client.example.test/backchannel-logout')
    const logoutToken = new URLSearchParams(options.body as string).get('logout_token')
    expect(logoutToken).toBeTruthy()
    const jwksResponse = await request(auth, '/api/auth/jwks')
    const claims = await verifyJwt(
      logoutToken as string,
      (await jwksResponse.json()) as JSONWebKeySet,
    )
    expect(claims).toMatchObject({
      iss: ISSUER,
      aud: client.client_id,
      sub: userId,
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    })
    expect(claims.nonce).toBeUndefined()
    expect(claims.jti).toEqual(expect.any(String))
  })

  it('issues a verifiable ID token and matching UserInfo for a confidential PKCE client', async () => {
    const { auth } = setup(true)
    const { client, cookie, userId } = await clientSession(auth)
    const code = await codeFor(auth, client.client_id, cookie)
    const response = await exchange(auth, client, code, VERIFIER)
    expect(response.status).toBe(200)
    expect(response.headers.get('set-auth-jwt')).toBeNull()
    const tokens = (await response.json()) as {
      id_token: string
      access_token: string
      refresh_token?: string
    }
    expect(tokens.refresh_token).toBeUndefined()
    const jwksResponse = await request(auth, '/api/auth/jwks')
    expect(jwksResponse.ok).toBe(true)
    const claims = await verifyJwt(tokens.id_token, (await jwksResponse.json()) as JSONWebKeySet)
    expect(claims).toMatchObject({
      iss: ISSUER,
      aud: client.client_id,
      sub: userId,
      nonce: NONCE,
      email: 'user@example.test',
      email_verified: false,
      name: 'Example User',
      app_role: 'reader',
    })
    expect(claims.exp).toEqual(expect.any(Number))
    expect(claims.exp as number).toBeGreaterThan(Date.now() / 1000)
    const userinfo = await request(auth, '/api/auth/oauth2/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    expect(userinfo.status).toBe(200)
    expect(await userinfo.json()).toMatchObject({
      sub: userId,
      email: 'user@example.test',
      email_verified: false,
      name: 'Example User',
      app_role: 'reader',
    })
  })

  it.each(['missing', 'wrong'])('refuses a %s PKCE verifier', async (reason) => {
    const { auth } = setup(true)
    const { client, cookie } = await clientSession(auth)
    const code = await codeFor(auth, client.client_id, cookie)
    const response = await exchange(
      auth,
      client,
      code,
      reason === 'missing' ? undefined : 'x'.repeat(64),
    )
    expect(response.ok).toBe(false)
    expect(await response.json()).not.toHaveProperty('access_token')
  })

  it('refuses unknown clients, mismatched redirect URIs and offline access', async () => {
    const { auth } = setup(true)
    const { client, cookie } = await clientSession(auth)
    const refusals: Record<string, string>[] = [
      { client_id: 'unknown-client' },
      { redirect_uri: 'https://client.example.test/other' },
      { scope: 'openid email profile offline_access' },
    ]
    for (const overrides of refusals) {
      const response = await authorize(auth, client.client_id, cookie, overrides)
      const location = response.headers.get('location')
      expect(location ? new URL(location, ORIGIN).searchParams.get('code') : null).toBeNull()
      expect(response.ok && !location).toBe(false)
    }
  })

  it('refuses a code exchange when the user was disabled after authorization', async () => {
    const { auth, sqlite } = setup(true)
    const { client, cookie, userId } = await clientSession(auth)
    const code = await codeFor(auth, client.client_id, cookie)
    sqlite.prepare('UPDATE user SET disabled = 1 WHERE id = ?').run(userId)
    const response = await exchange(auth, client, code, VERIFIER)
    expect(response.ok).toBe(false)
    expect(await response.json()).not.toHaveProperty('access_token')
  })

  it('sends signed-out users to login and refuses inactive sessions', async () => {
    const { auth, sqlite } = setup(true)
    const { client, cookie, userId } = await clientSession(auth)
    const signedOut = await authorize(auth, client.client_id, '')
    expect(new URL(signedOut.headers.get('location') ?? '', ORIGIN).pathname).toBe('/login')
    sqlite.prepare('UPDATE user SET disabled = 1 WHERE id = ?').run(userId)
    try {
      const inactive = await authorize(auth, client.client_id, cookie)
      expect(inactive.status).toBe(401)
      expect(inactive.headers.get('location')?.includes('code=') ?? false).toBe(false)
    } catch (error) {
      expect(error).toMatchObject({ status: 'UNAUTHORIZED' })
    }
  })

  it('publishes OIDC discovery under the auth issuer without exposing dynamic registration', async () => {
    const { auth } = setup(true)
    const response = await request(auth, '/api/auth/.well-known/openid-configuration')
    expect(response.status).toBe(200)
    const metadata = (await response.json()) as Record<string, unknown>
    expect(metadata.issuer).toBe(ISSUER)
    expect(metadata.authorization_endpoint).toBe(`${ISSUER}/oauth2/authorize`)
    expect(metadata.token_endpoint).toBe(`${ISSUER}/oauth2/token`)
    expect(metadata.jwks_uri).toBe(`${ISSUER}/jwks`)
    expect(metadata.registration_endpoint).toBeUndefined()
    const registration = await request(auth, '/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://client.example.test/callback'] }),
    })
    expect(registration.ok).toBe(false)
    expect((await request(auth, '/api/auth/token')).status).toBe(404)
  })
})
