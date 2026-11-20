import { generateKeyPairSync, sign } from 'node:crypto'
import { createSqliteD1 } from '@kit/db/testing'
import { isAPIError } from 'better-auth/api'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createBetterAuth, type KitBetterAuth } from '../better-auth-factory'

const origin = 'https://auth.example.test'
const clientId = 'google-client-id'
const google = { clientId, clientSecret: 'google-client-secret', allowedDomains: ['example.test'] }
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'test-google-key',
  alg: 'RS256',
  use: 'sig',
}

type Profile = {
  email: string
  email_verified: boolean
  hd?: string
  sub?: string
}

function idToken(profile: Profile) {
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const payload = `${encode({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' })}.${encode({
    iss: 'https://accounts.google.com',
    aud: clientId,
    iat: now,
    exp: now + 3600,
    sub: 'google-subject',
    name: 'Existing User',
    ...profile,
  })}`
  return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`
}

function setup(
  options: {
    configured?: boolean
    publicSignup?: boolean
    disabled?: boolean
    existing?: boolean
    allowedDomains?: string[]
  } = {},
) {
  const sqlite = new Database(':memory:')
  onTestFinished(() => {
    sqlite.close()
  })
  sqlite.exec(`
    CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE session (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ip_address TEXT, user_agent TEXT,
      user_id TEXT NOT NULL, active_organization_id TEXT);
    CREATE TABLE account (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL,
      issuer TEXT NOT NULL DEFAULT 'local:credential', user_id TEXT NOT NULL, access_token TEXT,
      refresh_token TEXT, id_token TEXT, access_token_expires_at INTEGER, refresh_token_expires_at INTEGER,
      scope TEXT, password TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (issuer, account_id));
    CREATE TABLE verification (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL,
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  `)
  if (options.existing !== false) {
    sqlite
      .prepare(
        'INSERT INTO user (id, name, email, email_verified, disabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
      )
      .run(
        'existing-user',
        'Existing User',
        'person@example.test',
        options.disabled ? 1 : 0,
        Date.now(),
        Date.now(),
      )
  }
  const auth = createBetterAuth({
    database: createSqliteD1(sqlite),
    secret: 'test-better-auth-secret-xxxxxxxx32c!!',
    baseURL: origin,
    trustedOrigins: [origin],
    useSecureCookies: false,
    allowPublicSignup: options.publicSignup ?? false,
    ...(options.configured === false
      ? {}
      : { google: { ...google, allowedDomains: options.allowedDomains ?? google.allowedDomains } }),
  })
  return { auth, sqlite }
}

function googleBoundary(profile: Profile, invalidSignature = false) {
  const calls: string[] = []
  const token = idToken(profile)
  const sentToken = invalidSignature
    ? `${token.slice(0, token.lastIndexOf('.') + 1)}invalid`
    : token
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      calls.push(url)
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({
          access_token: 'google-access-token',
          refresh_token: 'google-refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: sentToken,
        })
      }
      if (url === 'https://www.googleapis.com/oauth2/v3/certs')
        return Response.json({ keys: [jwk] })
      throw new Error(`Unexpected external request: ${url}`)
    }),
  )
  return { calls, token: sentToken }
}

async function post(auth: KitBetterAuth, path: string, body: object, cookie?: string) {
  try {
    return await auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
    )
  } catch (error) {
    if (!isAPIError(error)) throw error
    return Response.json(error.body, { status: error.statusCode })
  }
}

function responseCookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ')
}

async function callback(auth: KitBetterAuth) {
  const start = await auth.handler(
    new Request(`${origin}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ provider: 'google', callbackURL: `${origin}/done` }),
    }),
  )
  expect(start.status).toBe(200)
  const { url } = (await start.json()) as { url: string }
  const authorization = new URL(url)
  expect(authorization.origin).toBe('https://accounts.google.com')
  const state = authorization.searchParams.get('state')
  expect(state).toBeTruthy()
  const cookies = start.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ')
  let result: Response
  try {
    result = await auth.handler(
      new Request(
        `${origin}/api/auth/callback/google?${new URLSearchParams({ code: 'google-authorization-code', state: state! })}`,
        {
          headers: { cookie: cookies },
        },
      ),
    )
  } catch (error) {
    if (!isAPIError(error)) throw error
    result = new Response(null, { status: error.statusCode })
  }
  return result
}

function rows(sqlite: Database.Database, table: 'user' | 'account' | 'session' | 'verification') {
  return sqlite.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[]
}

function snapshot(sqlite: Database.Database) {
  return {
    user: rows(sqlite, 'user'),
    account: rows(sqlite, 'account'),
    session: rows(sqlite, 'session'),
    verification: rows(sqlite, 'verification'),
  }
}

function captureLogs() {
  const spies = ['log', 'warn', 'error', 'debug'].map((level) =>
    vi.spyOn(console, level as 'log' | 'warn' | 'error' | 'debug').mockImplementation(() => {}),
  )
  onTestFinished(() => {
    for (const spy of spies) spy.mockRestore()
  })
  return (token: string) => {
    for (const spy of spies) {
      const output = JSON.stringify(spy.mock.calls)
      for (const secret of [
        google.clientSecret,
        'google-access-token',
        'google-refresh-token',
        token,
      ])
        expect(output).not.toContain(secret)
    }
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('Google sign-in through Better Auth', () => {
  it('links an existing user once and creates sessions on subsequent sign-ins', async () => {
    const assertSecret = captureLogs()
    const { auth, sqlite } = setup()
    const { calls, token } = googleBoundary({
      email: 'person@example.test',
      email_verified: true,
      hd: 'example.test',
    })
    for (let i = 0; i < 2; i++) {
      const response = await callback(auth)
      expect(response.headers.get('location')).toBe(`${origin}/done`)
      expect(
        response.headers.getSetCookie().some((cookie) => cookie.startsWith('kit_session=')),
      ).toBe(true)
    }
    expect(calls.filter((url) => url === 'https://oauth2.googleapis.com/token')).toHaveLength(2)
    expect(rows(sqlite, 'user')).toHaveLength(1)
    expect(rows(sqlite, 'account')).toMatchObject([
      {
        provider_id: 'google',
        issuer: 'https://accounts.google.com',
        account_id: 'google-subject',
        user_id: 'existing-user',
      },
    ])
    expect(rows(sqlite, 'session')).toHaveLength(2)
    expect(rows(sqlite, 'account')[0]).toMatchObject({
      access_token: null,
      refresh_token: null,
      id_token: null,
    })
    expect(rows(sqlite, 'session').every((session) => session.user_id === 'existing-user')).toBe(
      true,
    )
    assertSecret(token)
  })

  it.each([
    ['missing hosted domain', { email: 'person@example.test', email_verified: true }],
    ['domain not allowed', { email: 'person@other.test', email_verified: true, hd: 'other.test' }],
    [
      'different hosted domain',
      { email: 'person@example.test', email_verified: true, hd: 'other.test' },
    ],
    [
      'hosted-domain suffix spoof',
      { email: 'person@example.test', email_verified: true, hd: 'evil-example.test' },
    ],
    [
      'unverified email',
      { email: 'person@example.test', email_verified: false, hd: 'example.test' },
    ],
  ])('rejects %s without issuing a session', async (_reason, profile) => {
    const assertSecret = captureLogs()
    const { auth, sqlite } = setup()
    const before = snapshot(sqlite)
    const { calls, token } = googleBoundary(profile)
    const response = await callback(auth)
    expect(calls).toContain('https://oauth2.googleapis.com/token')
    expect(response.headers.get('location')).toBe(`${origin}/login?error=unable_to_get_user_info`)
    expect(snapshot(sqlite)).toEqual(before)
    assertSecret(token)
  })

  it('rejects a Google token whose signature does not match the published key', async () => {
    const assertSecret = captureLogs()
    const { auth, sqlite } = setup()
    const before = snapshot(sqlite)
    const { calls, token } = googleBoundary(
      { email: 'person@example.test', email_verified: true, hd: 'example.test' },
      true,
    )
    const response = await callback(auth)
    expect(calls).toContain('https://www.googleapis.com/oauth2/v3/certs')
    expect(response.headers.get('location')).toBe(`${origin}/login?error=unable_to_get_user_info`)
    expect(snapshot(sqlite)).toEqual(before)
    assertSecret(token)
  })
  it.each([false, true])(
    'never signs up an unknown Google user when public signup is %s',
    async (publicSignup) => {
      const { auth, sqlite } = setup({ existing: false, publicSignup })
      const before = snapshot(sqlite)
      googleBoundary({ email: 'person@example.test', email_verified: true, hd: 'example.test' })
      const response = await callback(auth)
      expect(response.headers.get('location')).toBe(`${origin}/login?error=signup_disabled`)
      expect(snapshot(sqlite)).toEqual(before)
    },
  )

  it('does not issue a session to a disabled existing user', async () => {
    const { auth, sqlite } = setup({ disabled: true })
    const before = snapshot(sqlite)
    googleBoundary({ email: 'person@example.test', email_verified: true, hd: 'example.test' })
    const response = await callback(auth)
    expect(response.headers.get('location')).toContain('/login?error=account_inactive')
    expect(snapshot(sqlite)).toEqual(before)
  })

  it('enforces the session guard if the user becomes inactive after the link check', async () => {
    const { auth, sqlite } = setup()
    sqlite.exec(`
      CREATE TRIGGER disable_after_link AFTER INSERT ON account
      BEGIN UPDATE user SET disabled = 1 WHERE id = NEW.user_id; END;
    `)
    const before = snapshot(sqlite)
    googleBoundary({ email: 'person@example.test', email_verified: true, hd: 'example.test' })
    const response = await callback(auth)
    expect(response.headers.get('location')).toContain('/login?error=account_inactive')
    const after = snapshot(sqlite)
    expect(after.user).toEqual([{ ...before.user[0], disabled: 1 }])
    expect(after.account).toHaveLength(1)
    expect(after.account[0]).toMatchObject({
      provider_id: 'google',
      issuer: 'https://accounts.google.com',
      account_id: 'google-subject',
      user_id: 'existing-user',
      access_token: null,
      refresh_token: null,
      id_token: null,
    })
    expect(after.session).toEqual(before.session)
    expect(after.verification).toEqual(before.verification)
  })

  it('refuses a previously linked user after disablement without adding an account or session', async () => {
    const { auth, sqlite } = setup()
    googleBoundary({ email: 'person@example.test', email_verified: true, hd: 'example.test' })
    await callback(auth)
    expect(rows(sqlite, 'account')).toHaveLength(1)
    sqlite.prepare('DELETE FROM session').run()
    sqlite.prepare('UPDATE user SET disabled = 1 WHERE id = ?').run('existing-user')
    const before = snapshot(sqlite)
    const response = await callback(auth)
    expect(response.headers.get('location')).toContain('/login?error=account_inactive')
    expect(snapshot(sqlite)).toEqual(before)
  })

  it('refuses implicit linking to a real unverified password signup', async () => {
    const { auth, sqlite } = setup({ existing: false, publicSignup: true })
    const signup = await post(auth, '/sign-up/email', {
      name: 'Existing User',
      email: 'person@example.test',
      password: 'test-password-123',
    })
    expect(signup.status).toBe(200)
    expect(rows(sqlite, 'user')).toMatchObject([
      { email: 'person@example.test', email_verified: 0 },
    ])
    expect(rows(sqlite, 'account')).toMatchObject([{ provider_id: 'credential' }])
    const before = snapshot(sqlite)
    googleBoundary({ email: 'person@example.test', email_verified: true, hd: 'example.test' })
    const response = await callback(auth)
    expect(response.headers.get('location')).toBe(`${origin}/login?error=account_not_linked`)
    expect(snapshot(sqlite)).toEqual(before)
  })

  it('keeps a credential and Google subject with the same account ID in distinct issuer namespaces', async () => {
    const { auth, sqlite } = setup()
    sqlite
      .prepare(`
      INSERT INTO account (id, account_id, provider_id, issuer, user_id, password, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        'credential-id',
        'google-subject',
        'credential',
        'local:credential',
        'existing-user',
        'password-hash',
        Date.now(),
        Date.now(),
      )
    googleBoundary({ email: 'person@example.test', email_verified: true, hd: 'example.test' })
    expect((await callback(auth)).headers.get('location')).toBe(`${origin}/done`)
    expect(rows(sqlite, 'account')).toHaveLength(2)
    expect(rows(sqlite, 'account')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider_id: 'credential',
          account_id: 'google-subject',
          issuer: 'local:credential',
        }),
        expect.objectContaining({
          provider_id: 'google',
          account_id: 'google-subject',
          issuer: 'https://accounts.google.com',
        }),
      ]),
    )
  })

  it('refuses changed-email redirect sign-in and both direct routes without modifying any rows', async () => {
    const assertSecret = captureLogs()
    const { auth, sqlite } = setup()
    googleBoundary({ email: 'person@example.test', email_verified: true, hd: 'example.test' })
    const initial = await callback(auth)
    expect(initial.headers.get('location')).toBe(`${origin}/done`)
    const cookie = responseCookies(initial)
    expect(cookie).toContain('kit_session=')
    const before = snapshot(sqlite)
    const { token } = googleBoundary({
      email: 'changed@example.test',
      email_verified: true,
      hd: 'example.test',
    })
    const redirect = await callback(auth)
    expect(redirect.headers.get('location')).toContain('/login?error=google_email_mismatch')
    expect(snapshot(sqlite)).toEqual(before)
    for (const path of ['/sign-in/social', '/link-social']) {
      const response = await post(
        auth,
        path,
        {
          provider: 'google',
          idToken: { token },
          callbackURL: `${origin}/done`,
        },
        cookie,
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'GOOGLE_REDIRECT_ONLY' })
      expect(snapshot(sqlite)).toEqual(before)
    }
    assertSecret(token)
  })

  it.each([
    ['hosted domain', 'person@example.kest.test', 'example.Kest.test'],
    ['email domain', 'person@example.Kest.test', 'example.kest.test'],
  ])(
    'rejects a non-ASCII raw %s even if case folding matches the allowlist',
    async (_label, email, hd) => {
      const { auth, sqlite } = setup({ allowedDomains: ['example.kest.test'] })
      const before = snapshot(sqlite)
      googleBoundary({ email, email_verified: true, hd })
      expect((await callback(auth)).headers.get('location')).toBe(
        `${origin}/login?error=unable_to_get_user_info`,
      )
      expect(snapshot(sqlite)).toEqual(before)
    },
  )

  it('accepts mixed-case ASCII domain claims', async () => {
    const { auth } = setup({ allowedDomains: ['ExAmPlE.TeSt'] })
    googleBoundary({ email: 'person@EXAMPLE.TEST', email_verified: true, hd: 'ExAmPlE.TeSt' })
    expect((await callback(auth)).headers.get('location')).toBe(`${origin}/done`)
  })

  it('rejects non-ASCII configured domains before case folding', () => {
    expect(() => setup({ allowedDomains: ['example.Kest.test'] })).toThrow(
      'Invalid Google sign-in domain',
    )
  })

  it('does not expose Google sign-in when the option is absent', async () => {
    const { auth, sqlite } = setup({ configured: false, existing: false })
    const calls = googleBoundary({
      email: 'person@example.test',
      email_verified: true,
      hd: 'example.test',
    })
    const callbackResponse = await auth.handler(
      new Request(`${origin}/api/auth/callback/google?code=x&state=y`),
    )
    expect(callbackResponse.status).toBe(302)
    expect(callbackResponse.headers.get('location')).toBe(
      `${origin}/api/auth/error?error=state_mismatch`,
    )
    const signInResponse = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ provider: 'google', callbackURL: `${origin}/done` }),
      }),
    )
    expect(signInResponse.status).toBe(404)
    expect(await signInResponse.json()).toMatchObject({
      code: 'PROVIDER_NOT_FOUND',
      message: 'Provider not found',
    })
    expect(calls.calls).toHaveLength(0)
    expect(rows(sqlite, 'session')).toHaveLength(0)
    expect(rows(sqlite, 'user')).toHaveLength(0)
    expect(rows(sqlite, 'account')).toHaveLength(0)
    expect(rows(sqlite, 'verification')).toHaveLength(0)
  })
})
