import { readFileSync } from 'node:fs'
import { createSqliteD1 } from '@kit/db/testing'
import Database from 'better-sqlite3'
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createBetterAuth, type KitBetterAuth } from '../better-auth-factory'
import { createOidcProvider, endOidcUserSessions, registerOidcClient } from './oidc-provider'

const ORIGIN = 'https://auth.example.test'
const ISSUER = `${ORIGIN}/api/auth`
const SECRET = 'test-better-auth-secret-xxxxxxxx32c!!'

function setup(enabled: boolean, accountStateFailure?: () => boolean) {
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
        new URL(`../../../../apps/example-api/migrations/${migration}`, import.meta.url),
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
          oidcProvider: (() => {
            const provider = createOidcProvider({
              loginPage: '/login',
              consentPage: '/consent',
              claims: async () => ({
                app_role: 'reader',
                sub: 'forged',
                iss: 'forged',
                aud: 'forged',
                exp: 1,
                iat: 1,
                nonce: 'forged',
                sid: 'forged',
                auth_time: 1,
                email: 'forged',
                email_verified: true,
                name: 'forged',
                given_name: 'forged',
                family_name: 'forged',
                picture: 'forged',
              }),
              waitUntil: (promise) => {
                pending.push(promise)
              },
            })
            return {
              ...provider,
              plugins: (isActive: (userId: string) => Promise<boolean>) =>
                provider.plugins(async (userId) => {
                  if (accountStateFailure?.()) throw new Error('account state unavailable')
                  return isActive(userId)
                }),
            }
          })(),
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

async function codeFor(
  auth: KitBetterAuth,
  clientId: string,
  cookie: string,
  overrides?: Record<string, string>,
) {
  const response = await authorize(auth, clientId, cookie, overrides)
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
  extra?: Record<string, string>,
) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
  })
  if (verifier !== undefined) body.set('code_verifier', verifier)
  for (const [key, value] of Object.entries(extra ?? {})) body.set(key, value)
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

  it('rejects client registrations without the openid scope', async () => {
    const { auth, sqlite } = setup(true)
    const { cookie } = await clientSession(auth)
    for (const scopes of [[], ['email', 'profile']]) {
      await expect(
        registerOidcClient(auth, {
          headers: new Headers({ cookie }),
          redirectUris: [REDIRECT],
          firstParty: true,
          scopes,
        }),
      ).rejects.toMatchObject({
        body: { error: 'invalid_scope', error_description: 'openid scope is required' },
      })
    }
    expect(sqlite.prepare('SELECT count(*) AS count FROM oauth_client').get()).toEqual({
      count: 1,
    })
  })

  it('uses registered scopes when authorization omits scope and issues an ID token', async () => {
    const { auth } = setup(true)
    const { cookie, userId } = await clientSession(auth)
    const registered = await registerOidcClient(auth, {
      headers: new Headers({ cookie }),
      redirectUris: [REDIRECT],
      firstParty: true,
      scopes: ['openid', 'email'],
    })
    if (!registered.client_secret)
      throw new Error('Confidential client registration returned no secret')
    const url = new URL(await authorizationUrl(registered.client_id), ORIGIN)
    url.searchParams.delete('scope')
    const authorization = await request(auth, `${url.pathname}${url.search}`, {
      headers: { cookie, accept: 'text/html' },
    })
    expect(authorization.status).toBe(302)
    const redirect = new URL(authorization.headers.get('location') ?? '', ORIGIN)
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT)
    const code = redirect.searchParams.get('code')
    expect(code).toBeTruthy()
    const response = await exchange(
      auth,
      { ...registered, client_secret: registered.client_secret },
      code as string,
      VERIFIER,
    )
    expect(response.status).toBe(200)
    const tokens = (await response.json()) as { id_token: string; scope: string }
    expect(tokens.scope.split(' ').sort()).toEqual(['email', 'openid'])
    const jwks = await request(auth, '/api/auth/jwks')
    const claims = await verifyJwt(tokens.id_token, (await jwks.json()) as JSONWebKeySet)
    expect(claims).toMatchObject({
      sub: userId,
      aud: registered.client_id,
      email: 'user@example.test',
    })
    expect(claims.name).toBeUndefined()
  })

  it('notifies the registered client with a signed back-channel logout token', async () => {
    const { auth, sqlite, pending } = setup(true)
    const { client, cookie, userId } = await clientSession(auth)
    const code = await codeFor(auth, client.client_id, cookie)
    expect((await exchange(auth, client, code, VERIFIER)).status).toBe(200)
    const accessTokens = sqlite.prepare('SELECT count(*) AS count FROM oauth_access_token')
    expect(accessTokens.get()).toEqual({ count: 1 })
    const delivery = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', delivery)
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    await endOidcUserSessions(auth, userId)
    expect(accessTokens.get()).toEqual({ count: 0 })
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

  it.each([
    ['openid', []],
    ['openid email', ['email', 'email_verified']],
    ['openid profile', ['name']],
    ['openid email profile', ['email', 'email_verified', 'name']],
  ] as [string, string[]][])(
    'restricts ID token and UserInfo claims for %s',
    async (scope, standardClaims) => {
      const { auth } = setup(true)
      const { client, cookie, userId } = await clientSession(auth)
      const session = await request(auth, '/api/auth/get-session', { headers: { cookie } })
      expect(session.status).toBe(200)
      expect(session.headers.get('set-auth-jwt')).toBeNull()
      const code = await codeFor(auth, client.client_id, cookie, { scope })
      const response = await exchange(auth, client, code, VERIFIER)
      expect(response.status).toBe(200)
      const tokens = (await response.json()) as { id_token: string; access_token: string }
      const jwks = await request(auth, '/api/auth/jwks')
      const id = await verifyJwt(tokens.id_token, (await jwks.json()) as JSONWebKeySet)
      expect(Object.keys(id).sort()).toEqual(
        [
          'acr',
          'app_role',
          'at_hash',
          'aud',
          'auth_time',
          'exp',
          'iat',
          'iss',
          'nonce',
          'sid',
          'sub',
          ...standardClaims,
        ].sort(),
      )
      expect(id).toMatchObject({
        sub: userId,
        iss: ISSUER,
        aud: client.client_id,
        nonce: NONCE,
        app_role: 'reader',
      })
      if (standardClaims.includes('email'))
        expect(id).toMatchObject({ email: 'user@example.test', email_verified: false })
      if (standardClaims.includes('name')) expect(id.name).toBe('Example User')
      const userinfo = await request(auth, '/api/auth/oauth2/userinfo', {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      })
      expect(userinfo.status).toBe(200)
      const info = (await userinfo.json()) as Record<string, unknown>
      expect(Object.keys(info).sort()).toEqual(['sub', 'app_role', ...standardClaims].sort())
      expect(info).toMatchObject({ sub: userId, app_role: 'reader' })
      if (standardClaims.includes('email'))
        expect(info).toMatchObject({ email: 'user@example.test', email_verified: false })
      if (standardClaims.includes('name')) expect(info.name).toBe('Example User')
    },
  )

  it('rejects unsupported scopes and individual claims at issuance, and token resource indicators', async () => {
    const { auth } = setup(true)
    const { client, cookie } = await clientSession(auth)
    for (const [overrides, error] of [
      [{ scope: 'email profile' }, 'invalid_scope'],
      [{ claims: JSON.stringify({ userinfo: { email: null } }) }, 'invalid_request'],
    ] as const) {
      const code = await codeFor(auth, client.client_id, cookie, overrides)
      const response = await exchange(auth, client, code, VERIFIER)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error })
    }
    const code = await codeFor(auth, client.client_id, cookie)
    const token = await exchange(auth, client, code, VERIFIER, {
      resource: 'https://resource.example.test/',
    })
    expect(token.status).toBe(400)
    expect(await token.json()).toMatchObject({ error: 'invalid_target' })
  })

  it.each([
    ['userinfo', { userinfo: { email: null } }],
    ['id_token', { id_token: { email: null } }],
    ['empty', {}],
  ])('rejects stored %s individual claims before writing tokens', async (_label, claims) => {
    const { auth, sqlite } = setup(true)
    const { client, cookie, userId } = await clientSession(auth)
    const code = await codeFor(auth, client.client_id, cookie, { scope: 'openid' })
    const updated = sqlite
      .prepare(
        "UPDATE verification SET value = json_set(value, '$.query.claims', json(?)) WHERE json_valid(value) AND json_extract(value, '$.userId') = ?",
      )
      .run(JSON.stringify(claims), userId)
    expect(updated.changes).toBe(1)
    const response = await exchange(auth, client, code, VERIFIER)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_request' })
    expect(sqlite.prepare('SELECT count(*) AS count FROM oauth_access_token').get()).toEqual({
      count: 0,
    })
    expect(sqlite.prepare('SELECT count(*) AS count FROM jwks').get()).toEqual({ count: 0 })
  })

  it('enforces stored scopes on concurrent legacy UserInfo claim requests', async () => {
    const { auth, sqlite } = setup(true)
    const { client, cookie } = await clientSession(auth)
    const cases = [
      { scope: 'openid', expected: [] },
      { scope: 'openid email', expected: ['email', 'email_verified'] },
      { scope: 'openid profile', expected: ['name'] },
      { scope: 'openid email profile', expected: ['email', 'email_verified', 'name'] },
    ]
    const tokens = []
    for (const { scope } of cases) {
      const code = await codeFor(auth, client.client_id, cookie, { scope })
      const response = await exchange(auth, client, code, VERIFIER)
      expect(response.status).toBe(200)
      tokens.push((await response.json()) as { access_token: string })
    }
    const updated = sqlite
      .prepare('UPDATE oauth_access_token SET requested_user_info_claims = ?')
      .run(JSON.stringify(['email', 'email_verified', 'name']))
    expect(updated.changes).toBe(cases.length)
    const responses = await Promise.all(
      tokens.map(({ access_token }) =>
        request(auth, '/api/auth/oauth2/userinfo', {
          headers: { authorization: `Bearer ${access_token}` },
        }),
      ),
    )
    for (const [index, userinfo] of responses.entries()) {
      expect(userinfo.status).toBe(200)
      const info = (await userinfo.json()) as Record<string, unknown>
      expect(Object.keys(info).sort()).toEqual(['sub', 'app_role', ...cases[index].expected].sort())
    }
  })

  it('advertises only implemented standard claims and no individual claims parameter', async () => {
    const { auth } = setup(true)
    const response = await request(auth, '/api/auth/.well-known/openid-configuration')
    expect(response.status).toBe(200)
    const metadata = (await response.json()) as Record<string, unknown>
    expect(metadata.claims_parameter_supported).toBe(false)
    expect(metadata.claims_supported).toEqual([
      'iss',
      'sub',
      'aud',
      'exp',
      'iat',
      'auth_time',
      'nonce',
      'acr',
      'sid',
      'at_hash',
      'email',
      'email_verified',
      'name',
    ])
  })

  it('rejects a previously authorized resource-bound JWT before signing', async () => {
    const { auth, sqlite } = setup(true)
    const { client, cookie, userId } = await clientSession(auth)
    const code = await codeFor(auth, client.client_id, cookie)
    const updated = sqlite
      .prepare(
        "UPDATE verification SET value = json_set(value, '$.resource', json_array(?)) WHERE json_valid(value) AND json_extract(value, '$.userId') = ?",
      )
      .run(`${ISSUER}/oauth2/userinfo`, userId)
    expect(updated.changes).toBe(1)
    const response = await exchange(auth, client, code, VERIFIER)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_target' })
    expect(sqlite.prepare('SELECT count(*) AS count FROM oauth_access_token').get()).toEqual({
      count: 0,
    })
    expect(sqlite.prepare('SELECT count(*) AS count FROM jwks').get()).toEqual({ count: 0 })
  })

  it.each(['missing', 'wrong'])('refuses a %s PKCE verifier', async (reason) => {
    const { auth, sqlite } = setup(true)
    const { client, cookie } = await clientSession(auth)
    const code = await codeFor(auth, client.client_id, cookie)
    const state = sqlite.prepare(
      'SELECT (SELECT count(*) FROM verification) AS codes, (SELECT count(*) FROM oauth_access_token) AS access, (SELECT count(*) FROM oauth_refresh_token) AS refresh, (SELECT count(*) FROM jwks) AS keys',
    )
    const before = state.get()
    const response = await exchange(
      auth,
      client,
      code,
      reason === 'missing' ? undefined : 'x'.repeat(64),
    )
    expect(response.status).toBe(400)
    const error = await response.json()
    expect(error).toMatchObject({
      error: reason === 'missing' ? 'invalid_request' : 'invalid_grant',
      error_description:
        reason === 'missing' ? 'PKCE is required for this client' : 'code verification failed',
    })
    expect(error).not.toHaveProperty('access_token')
    expect(state.get()).toEqual(before)
  })

  it('refuses unknown clients, mismatched redirect URIs and offline access', async () => {
    const { auth, sqlite } = setup(true)
    const { client, cookie } = await clientSession(auth)
    const state = sqlite.prepare(
      'SELECT (SELECT count(*) FROM verification) AS codes, (SELECT count(*) FROM oauth_consent) AS consents, (SELECT count(*) FROM oauth_access_token) AS access, (SELECT count(*) FROM oauth_refresh_token) AS refresh, (SELECT count(*) FROM jwks) AS keys',
    )
    const refusals: {
      overrides: Record<string, string>
      destination: string
      error: string
      description: string
    }[] = [
      {
        overrides: { client_id: 'unknown-client' },
        destination: `${ISSUER}/error`,
        error: 'invalid_client',
        description: 'client not found',
      },
      {
        overrides: { redirect_uri: 'https://client.example.test/other' },
        destination: `${ISSUER}/error`,
        error: 'invalid_redirect',
        description: 'invalid redirect uri',
      },
      {
        overrides: { scope: 'openid email profile offline_access' },
        destination: REDIRECT,
        error: 'invalid_scope',
        description: 'The following scopes are invalid: offline_access',
      },
    ]
    for (const { overrides, destination, error, description } of refusals) {
      const before = state.get()
      const response = await authorize(auth, client.client_id, cookie, overrides)
      expect(response.status).toBe(302)
      const location = new URL(response.headers.get('location') ?? '', ORIGIN)
      expect(`${location.origin}${location.pathname}`).toBe(destination)
      expect(location.searchParams.get('error')).toBe(error)
      expect(location.searchParams.get('error_description')).toBe(description)
      expect(location.searchParams.get('code')).toBeNull()
      expect(location.searchParams.get('state')).toBe(
        destination === REDIRECT ? 'expected-state' : null,
      )
      expect(state.get()).toEqual(before)
    }
  })

  it('refuses a disabled user exchanging a legacy code without openid before token state', async () => {
    const { auth, sqlite } = setup(true)
    const { client, cookie, userId } = await clientSession(auth)
    const code = await codeFor(auth, client.client_id, cookie)
    const updated = sqlite
      .prepare(
        "UPDATE verification SET value = json_set(value, '$.query.scope', ?) WHERE json_valid(value) AND json_extract(value, '$.userId') = ?",
      )
      .run('email profile', userId)
    expect(updated.changes).toBe(1)
    sqlite.prepare('UPDATE user SET disabled = 1 WHERE id = ?').run(userId)
    const response = await exchange(auth, client, code, VERIFIER)
    expect(response.status).toBe(401)
    expect(await response.json()).not.toHaveProperty('access_token')
    expect(sqlite.prepare('SELECT count(*) AS count FROM oauth_access_token').get()).toEqual({
      count: 0,
    })
    expect(sqlite.prepare('SELECT count(*) AS count FROM oauth_refresh_token').get()).toEqual({
      count: 0,
    })
    expect(sqlite.prepare('SELECT count(*) AS count FROM jwks').get()).toEqual({ count: 0 })
  })

  it.each(['openid', 'openid email profile'])(
    'refuses disabled-account exchange for %s before writing tokens',
    async (scope) => {
      const { auth, sqlite } = setup(true)
      const { client, cookie, userId } = await clientSession(auth)
      const code = await codeFor(auth, client.client_id, cookie, { scope })
      sqlite.prepare('UPDATE user SET disabled = 1 WHERE id = ?').run(userId)
      const response = await exchange(auth, client, code, VERIFIER)
      expect(response.status).toBe(401)
      expect(await response.json()).not.toHaveProperty('access_token')
      expect(sqlite.prepare('SELECT count(*) AS count FROM oauth_access_token').get()).toEqual({
        count: 0,
      })
      expect(sqlite.prepare('SELECT count(*) AS count FROM oauth_refresh_token').get()).toEqual({
        count: 0,
      })
    },
  )

  it('fails closed before token state when account lookup throws', async () => {
    let fail = false
    const { auth, sqlite } = setup(true, () => fail)
    const { client, cookie } = await clientSession(auth)
    const code = await codeFor(auth, client.client_id, cookie)
    fail = true
    const response = await exchange(auth, client, code, VERIFIER)
    expect(response.status).toBe(401)
    expect(await response.json()).not.toHaveProperty('access_token')
    expect(sqlite.prepare('SELECT count(*) AS count FROM oauth_access_token').get()).toEqual({
      count: 0,
    })
    expect(sqlite.prepare('SELECT count(*) AS count FROM oauth_refresh_token').get()).toEqual({
      count: 0,
    })
  })

  it('refuses UserInfo after account disablement', async () => {
    const { auth, sqlite } = setup(true)
    const { client, cookie, userId } = await clientSession(auth)
    const code = await codeFor(auth, client.client_id, cookie)
    const response = await exchange(auth, client, code, VERIFIER)
    const tokens = (await response.json()) as { access_token: string }
    sqlite.prepare('UPDATE user SET disabled = 1 WHERE id = ?').run(userId)
    const info = await request(auth, '/api/auth/oauth2/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    expect(info.status).toBe(401)
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
