import { generateKeyPairSync, sign } from 'node:crypto'
import { createSqliteD1 } from '@kit/db/testing'
import { isAPIError } from 'better-auth/api'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createBetterAuth, type KitBetterAuth } from '../better-auth-factory'

const origin = 'https://auth.example.test'
const clientId = 'google-client-id'
const google = { clientId, clientSecret: 'google-client-secret', allowedDomains: ['example.com'] }
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
        'person@example.com',
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
    ...(options.configured === false ? {} : { google }),
  })
  return { auth, sqlite }
}

function googleBoundary(profile: Profile, invalidSignature = false) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      calls.push(url)
      if (url === 'https://oauth2.googleapis.com/token') {
        const token = idToken(profile)
        return Response.json({
          access_token: 'google-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: invalidSignature
            ? `${token.slice(0, token.lastIndexOf('.') + 1)}invalid`
            : token,
        })
      }
      if (url === 'https://www.googleapis.com/oauth2/v3/certs')
        return Response.json({ keys: [jwk] })
      throw new Error(`Unexpected external request: ${url}`)
    }),
  )
  return calls
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

function rows(sqlite: Database.Database, table: 'user' | 'account' | 'session') {
  return sqlite.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[]
}

afterEach(() => vi.unstubAllGlobals())

describe('Google sign-in through Better Auth', () => {
  it('links an existing user once and creates sessions on subsequent sign-ins', async () => {
    const logs = ['log', 'warn', 'error', 'debug'].map((level) =>
      vi.spyOn(console, level as 'log' | 'warn' | 'error' | 'debug').mockImplementation(() => {}),
    )
    onTestFinished(() => {
      for (const spy of logs) spy.mockRestore()
    })
    const { auth, sqlite } = setup()
    const calls = googleBoundary({
      email: 'person@example.com',
      email_verified: true,
      hd: 'example.com',
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
      { provider_id: 'google', account_id: 'google-subject', user_id: 'existing-user' },
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
    for (const spy of logs) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain('google-client-secret')
      expect(JSON.stringify(spy.mock.calls)).not.toContain('google-access-token')
    }
  })

  it.each([
    ['missing hosted domain', { email: 'person@example.com', email_verified: true }],
    ['domain not allowed', { email: 'person@other.com', email_verified: true, hd: 'other.com' }],
    [
      'different hosted domain',
      { email: 'person@example.com', email_verified: true, hd: 'other.com' },
    ],
    [
      'hosted-domain suffix spoof',
      { email: 'person@example.com', email_verified: true, hd: 'evil-example.com' },
    ],
    ['unverified email', { email: 'person@example.com', email_verified: false, hd: 'example.com' }],
  ])('rejects %s without issuing a session', async (_reason, profile) => {
    const { auth, sqlite } = setup()
    const calls = googleBoundary(profile)
    const response = await callback(auth)
    expect(calls).toContain('https://oauth2.googleapis.com/token')
    expect(response.headers.get('location')).toBe(`${origin}/login?error=unable_to_get_user_info`)
    expect(rows(sqlite, 'session')).toHaveLength(0)
    expect(rows(sqlite, 'account')).toHaveLength(0)
    expect(rows(sqlite, 'user')).toHaveLength(1)
  })

  it('rejects a Google token whose signature does not match the published key', async () => {
    const { auth, sqlite } = setup()
    const calls = googleBoundary(
      { email: 'person@example.com', email_verified: true, hd: 'example.com' },
      true,
    )
    const response = await callback(auth)
    expect(calls).toContain('https://www.googleapis.com/oauth2/v3/certs')
    expect(response.headers.get('location')).not.toBe(`${origin}/done`)
    expect(rows(sqlite, 'account')).toHaveLength(0)
    expect(rows(sqlite, 'session')).toHaveLength(0)
  })
  it.each([false, true])(
    'never signs up an unknown Google user when public signup is %s',
    async (publicSignup) => {
      const { auth, sqlite } = setup({ existing: false, publicSignup })
      googleBoundary({ email: 'person@example.com', email_verified: true, hd: 'example.com' })
      const response = await callback(auth)
      expect(response.headers.get('location')).toBe(`${origin}/login?error=signup_disabled`)
      expect(rows(sqlite, 'user')).toHaveLength(0)
      expect(rows(sqlite, 'account')).toHaveLength(0)
      expect(rows(sqlite, 'session')).toHaveLength(0)
    },
  )

  it('does not issue a session to a disabled existing user', async () => {
    const { auth, sqlite } = setup({ disabled: true })
    googleBoundary({ email: 'person@example.com', email_verified: true, hd: 'example.com' })
    const response = await callback(auth)
    expect(response.headers.get('location')).toContain('/login?error=account_inactive')
    expect(rows(sqlite, 'user')).toHaveLength(1)
    expect(rows(sqlite, 'account')).toHaveLength(0)
    expect(rows(sqlite, 'session')).toHaveLength(0)
  })

  it('enforces the session guard if the user becomes inactive after the link check', async () => {
    const { auth, sqlite } = setup()
    sqlite.exec(`
      CREATE TRIGGER disable_after_link AFTER INSERT ON account
      BEGIN UPDATE user SET disabled = 1 WHERE id = NEW.user_id; END;
    `)
    googleBoundary({ email: 'person@example.com', email_verified: true, hd: 'example.com' })
    const response = await callback(auth)
    expect(response.headers.get('location')).toContain('/login?error=account_inactive')
    expect(rows(sqlite, 'user')).toHaveLength(1)
    expect(rows(sqlite, 'session')).toHaveLength(0)
  })

  it('refuses a previously linked user after disablement without adding an account or session', async () => {
    const { auth, sqlite } = setup()
    googleBoundary({ email: 'person@example.com', email_verified: true, hd: 'example.com' })
    await callback(auth)
    expect(rows(sqlite, 'account')).toHaveLength(1)
    sqlite.prepare('DELETE FROM session').run()
    sqlite.prepare('UPDATE user SET disabled = 1 WHERE id = ?').run('existing-user')
    const response = await callback(auth)
    expect(response.headers.get('location')).toContain('/login?error=account_inactive')
    expect(rows(sqlite, 'user')).toHaveLength(1)
    expect(rows(sqlite, 'account')).toHaveLength(1)
    expect(rows(sqlite, 'session')).toHaveLength(0)
  })

  it('does not expose Google sign-in when the option is absent', async () => {
    const { auth, sqlite } = setup({ configured: false })
    const calls = googleBoundary({
      email: 'person@example.com',
      email_verified: true,
      hd: 'example.com',
    })
    let response: Response
    try {
      response = await auth.handler(
        new Request(`${origin}/api/auth/sign-in/social`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin },
          body: JSON.stringify({ provider: 'google', callbackURL: `${origin}/done` }),
        }),
      )
    } catch (error) {
      if (!isAPIError(error)) throw error
      response = new Response(null, { status: error.statusCode })
    }
    expect(response.ok).toBe(false)
    expect(calls).toHaveLength(0)
    expect(rows(sqlite, 'session')).toHaveLength(0)
  })
})
