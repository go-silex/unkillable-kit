import { verifyOAuthQueryParams } from '@better-auth/oauth-provider'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { type BetterAuthHandlerEnv, createBetterAuthHandler } from '../policy/better-auth-handler'
import { capsuleField, createOidcProvenance } from './oidc-fresh-login-provenance'
import {
  codeCount,
  complete,
  continuation,
  cookies,
  googleBoundary,
  googleLogin,
  login,
  ORIGIN,
  REDIRECT,
  request,
  sendMagicLink,
  setup,
  start,
  startGoogleLogin,
} from './oidc-login-flow.fixture'

afterEach(() => vi.unstubAllGlobals())

describe('OIDC login method guidance', () => {
  describe.each([
    ['prompt=login', { prompt: 'login' }],
    ['max_age=0', { max_age: '0' }],
    ['max_age=60', { max_age: '60' }],
  ] as const)('%s', (_name, freshness) => {
    it.each([
      ['magic-link send', sendMagicLink],
      ['social sign-in', startGoogleLogin],
    ] as const)('refuses %s for a verified authorization request', async (_path, signIn) => {
      const { auth, client, send } = await setup(true)
      const oauthQuery = await start(auth, client.client_id, 'GET', freshness)
      const response = await signIn(auth, oauthQuery)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        code: 'OIDC_PASSWORD_REQUIRED',
        message: 'Use password sign-in for this authorization request.',
      })
      expect(response.headers.has('location')).toBe(false)
      expect(response.headers.getSetCookie()).toEqual([])
      expect(send).not.toHaveBeenCalled()
    })

    it('completes authorization after password sign-in', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-11-22T12:00:00Z'))
      onTestFinished(() => {
        vi.useRealTimers()
      })
      const { auth, client } = await setup(true)
      const oauthQuery = await start(auth, client.client_id, 'GET', freshness)
      vi.setSystemTime(new Date('2026-11-22T12:00:02Z'))
      const signedIn = await login(auth, oauthQuery)
      await complete(auth, client, await continuation(signedIn), 'user@example.test')
    })
  })

  it.each([
    ['magic-link send', sendMagicLink],
    ['social sign-in', startGoogleLogin],
  ] as const)('rejects a signed oauth_query sent as pairs on %s', async (_path, signIn) => {
    const { auth, client, send } = await setup(true)
    const signed = await start(auth, client.client_id, 'GET', { prompt: 'login' })
    const response = await signIn(auth, [...new URLSearchParams(signed)])
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      code: 'OIDC_INVALID_OAUTH_QUERY',
      message: 'oauth_query must be a string.',
    })
    expect(response.headers.getSetCookie()).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })

  it('lets the provider reject an invalid authorization signature', async () => {
    const { auth, client, send } = await setup(true)
    const query = new URLSearchParams(
      await start(auth, client.client_id, 'GET', { prompt: 'login' }),
    )
    query.set('sig', 'invalid')
    const response = await sendMagicLink(auth, query.toString())
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_signature' })
    expect(send).not.toHaveBeenCalled()
  })

  it('sends a magic link for an authorization request without a freshness constraint', async () => {
    const { auth, client, send } = await setup(true)
    const response = await sendMagicLink(auth, await start(auth, client.client_id, 'GET'))
    expect(response.status).toBe(200)
    expect(send).toHaveBeenCalledTimes(1)
  })
})

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
      expect(cookies(response)).not.toContain('__Secure-kit_session=')
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
      expect(cookies(response)).not.toContain('__Secure-kit_session=')
    })
  }
})

it('discards earlier authorization output and verification rows if final renewal eligibility is denied', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z'))
  const { auth, client, sqlite, database } = await setup(true)
  const password = await login(auth)
  expect(password.status).toBe(200)
  const query = new URLSearchParams(await start(auth, client.client_id, 'GET'))
  for (const name of ['kit_authn_v1', 'sig', 'exp', 'ba_iat', 'ba_param']) query.delete(name)
  query.set('max_age', '200000')
  vi.setSystemTime(new Date('2026-11-03T12:00:00.000Z'))
  const prepare = database.prepare
  const earlierCodes: unknown[] = []
  let readsBySession = 0
  vi.spyOn(database, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql)
    if (!(sql.includes('INNER JOIN oidc_session_authentication') && sql.includes('WHERE s.id =')))
      return statement
    return {
      ...statement,
      bind: (...values) => {
        const bound = statement.bind(...values)
        return {
          ...bound,
          first: async <T = unknown>() => {
            readsBySession++
            if (readsBySession === 3) {
              earlierCodes.push(codeCount(sqlite))
              return null
            }
            return bound.first<T>()
          },
        }
      },
    }
  })
  expect(codeCount(sqlite)).toBe(0)
  const response = await request(auth, `/api/auth/oauth2/authorize?${query}`, {
    headers: { cookie: cookies(password), accept: 'text/html' },
  })
  expect(readsBySession).toBe(3)
  expect(earlierCodes).toEqual([1])
  expect(response.status).toBe(400)
  expect(response.headers.get('location')).toBeNull()
  expect(response.headers.getSetCookie()).toEqual([])
  expect(await response.json()).toEqual({ error: 'invalid_request' })
  expect(codeCount(sqlite)).toBe(0)
})

it('returns a restart signal on the mounted handler before distinguishing credentials', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
  const { auth, client, database, sqlite } = await setup(true)
  const pending = await start(auth, client.client_id, 'GET', { prompt: 'login' })
  const app = new Hono<BetterAuthHandlerEnv>()
  app.use('*', async (c, next) => {
    c.set('db', drizzle(database as never))
    c.set('betterAuth', auth)
    await next()
  })
  app.all('/api/auth/*', createBetterAuthHandler())
  vi.setSystemTime(new Date('2026-11-01T12:10:01Z'))
  for (const [email, password] of [
    ['user@example.test', ['example', 'password', '123'].join('-')],
    ['missing@example.test', 'wrong-password'],
  ]) {
    const response = await app.request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email, password, oauth_query: pending }),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'OIDC_RESTART_REQUIRED' } })
    expect(response.headers.getSetCookie()).toEqual([])
  }
  expect(codeCount(sqlite)).toBe(0)
})

it.each([ORIGIN, `${ORIGIN}/api/auth`])(
  'uses the form body and tracks an independently constructed Request at %s',
  async (baseURL) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const epoch = Date.UTC(2026, 10, 1)
    vi.setSystemTime(epoch)
    const { auth, client, sqlite, signupCookie } = await setup(true, baseURL)
    const query = new URLSearchParams(await start(auth, client.client_id, 'GET'))
    for (const name of ['kit_authn_v1', 'sig', 'exp', 'ba_iat', 'ba_param']) query.delete(name)
    query.set('prompt', 'login')
    vi.setSystemTime(epoch + 1000)
    const init = new Request(`${ORIGIN}/api/auth/oauth2/authorize?prompt=none`, {
      method: 'POST',
      headers: { origin: ORIGIN, accept: 'text/html' },
      body: query,
    })
    const response = await auth.handler(new Request(init))
    expect(response.status).toBe(302)
    const destination = new URL(response.headers.get('location') ?? '', ORIGIN)
    expect(destination.pathname).toBe('/login')
    expect(destination.searchParams.get('prompt')).toBe('login')
    const oauth_query = destination.search.slice(1)
    const continued = await request(auth, '/api/auth/update-user', {
      method: 'POST',
      headers: { cookie: signupCookie, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Still signed in', oauth_query }),
    })
    expect((await continuation(continued)).pathname).toBe('/login')
    expect(codeCount(sqlite)).toBe(0)
    const password = await login(auth, oauth_query)
    await complete(auth, client, await continuation(password), 'user@example.test')
    const json = await request(auth, '/api/auth/oauth2/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: '{}',
    })
    expect(json.status).toBe(415)
    const duplicate = await request(auth, '/api/auth/oauth2/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
      body: `${query}&pr%6fmpt=none`,
    })
    expect(duplicate.status).toBe(400)
    expect(await duplicate.json()).toMatchObject({ error: 'invalid_request' })
  },
)

it('allows verified consent through the server API but does not admit raw API authorization', async () => {
  const { auth, client, database } = await setup(false)
  const oauthQuery = await start(auth, client.client_id, 'GET')
  const signedIn = await login(auth, oauthQuery)
  const consent = await continuation(signedIn)
  expect(consent.pathname).toBe('/consent')
  const api = auth.api as typeof auth.api & {
    oauth2Authorize(input: { query: Record<string, string>; headers: Headers }): Promise<unknown>
    oauth2Consent(input: {
      body: { accept: boolean; oauth_query: string }
      headers: Headers
      asResponse: true
    }): Promise<Response>
  }
  const headers = new Headers({ cookie: cookies(signedIn), accept: 'application/json' })
  await expect(
    api.oauth2Authorize({ query: Object.fromEntries(consent.searchParams), headers }),
  ).rejects.toMatchObject({ statusCode: 400 })
  const prepare = vi.spyOn(database, 'prepare')
  const response = await api.oauth2Consent({
    body: { accept: true, oauth_query: consent.search.slice(1) },
    headers,
    asResponse: true,
  })
  expect((await continuation(response)).searchParams.has('code')).toBe(true)
  expect(
    prepare.mock.calls.filter(([sql]) => sql.includes('oidc_session_authentication')),
  ).toHaveLength(0)
})

it('requires password eligibility when a Google session reaches constrained consent', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
  const { auth, client, sqlite } = await setup(false)
  const googleStart = await start(auth, client.client_id, 'GET')
  const constrained = await start(auth, client.client_id, 'GET', { max_age: '60' })
  vi.setSystemTime(new Date('2026-11-01T12:00:02Z'))
  googleBoundary(true)
  const google = await googleLogin(auth, googleStart)
  expect(new URL(google.headers.get('location') ?? '', ORIGIN).pathname).toBe('/consent')
  const password = await login(auth, constrained)
  const pending = await continuation(password)
  expect(pending.pathname).toBe('/consent')
  const response = await request(auth, '/api/auth/oauth2/consent', {
    method: 'POST',
    headers: { cookie: cookies(google), origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ accept: true, oauth_query: pending.search.slice(1) }),
  })
  expect((await continuation(response)).pathname).toBe('/login')
  expect(sqlite.prepare('SELECT count(*) FROM oauth_consent').pluck().get()).toBe(0)
  expect(codeCount(sqlite)).toBe(0)
})

it('keeps whole-envelope replay distinct from current-key rotation', async () => {
  const previous = crypto.randomUUID() + crypto.randomUUID()
  const current = crypto.randomUUID() + crypto.randomUUID()
  vi.stubEnv('BETTER_AUTH_SECRETS', `1:${previous}`)
  onTestFinished(() => {
    vi.unstubAllEnvs()
  })
  const { auth, createAuth, client } = await setup(true)
  const pending = await start(auth, client.client_id, 'GET')
  expect(await verifyOAuthQueryParams(pending, previous)).toBe(true)
  for (let attempt = 0; attempt < 2; attempt++) {
    expect((await continuation(await login(auth, pending))).searchParams.has('code')).toBe(true)
  }
  vi.stubEnv('BETTER_AUTH_SECRETS', `2:${current},1:${previous}`)
  expect(await verifyOAuthQueryParams(pending, current)).toBe(false)
  const rotated = createAuth()
  const stale = await login(rotated, pending)
  expect(stale.status).toBe(409)
  expect(await stale.json()).toMatchObject({ code: 'OIDC_RESTART_REQUIRED' })
  const restarted = await start(rotated, client.client_id, 'GET')
  expect(await verifyOAuthQueryParams(restarted, current)).toBe(true)
  expect((await continuation(await login(rotated, restarted))).searchParams.has('code')).toBe(true)
})

it('uses the final successful proof read as the authorization decision', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
  const { auth, client, sqlite, database } = await setup(true)
  const password = await login(auth)
  const query = new URLSearchParams(await start(auth, client.client_id, 'GET'))
  for (const name of ['kit_authn_v1', 'sig', 'exp', 'ba_iat', 'ba_param']) query.delete(name)
  query.set('max_age', '60')
  const prepare = database.prepare
  let checked = 0
  let interruptedAt: number | undefined
  vi.spyOn(database, 'prepare').mockImplementation((sql) => {
    if (sql.includes('INNER JOIN oidc_session_authentication')) checked++
    if (/insert into "verification"/i.test(sql)) {
      interruptedAt = checked
      sqlite.exec('DELETE FROM oidc_session_authentication')
    }
    return prepare(sql)
  })
  const authorize = () =>
    request(auth, `/api/auth/oauth2/authorize?${query}`, {
      headers: { cookie: cookies(password), accept: 'text/html' },
    })
  expect((await continuation(await authorize())).searchParams.has('code')).toBe(true)
  expect(interruptedAt).toBe(2)
  expect((await continuation(await authorize())).pathname).toBe('/login')
  expect(codeCount(sqlite)).toBe(1)
})

it('fails a password proof write and never attributes proof to another session of the same user', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
  const { auth, client, sqlite, database, signupCookie } = await setup(true)
  const pending = await start(auth, client.client_id, 'GET', { max_age: '60' })
  const prepare = database.prepare
  const spy = vi.spyOn(database, 'prepare').mockImplementation((sql) => {
    if (sql.startsWith('INSERT INTO oidc_session_authentication'))
      throw new Error('test rejected proof')
    return prepare(sql)
  })
  vi.setSystemTime(new Date('2026-11-01T12:00:01Z'))
  const failed = await login(auth, pending)
  expect(failed.status).toBe(500)
  expect(failed.headers.getSetCookie()).toEqual([])
  expect(codeCount(sqlite)).toBe(0)
  expect(sqlite.prepare('SELECT count(*) FROM session').pluck().get()).toBe(2)
  expect(sqlite.prepare('SELECT count(*) FROM oidc_session_authentication').pluck().get()).toBe(0)
  spy.mockRestore()
  const password = await login(auth)
  expect(password.status).toBe(200)
  const query = new URLSearchParams(pending)
  for (const name of ['kit_authn_v1', 'sig', 'exp', 'ba_iat', 'ba_param']) query.delete(name)
  query.delete('prompt')
  const authorize = (cookie: string) =>
    request(auth, `/api/auth/oauth2/authorize?${query}`, {
      headers: { cookie, accept: 'text/html' },
    })
  expect((await continuation(await authorize(signupCookie))).pathname).toBe('/login')
  expect((await continuation(await authorize(cookies(password)))).searchParams.has('code')).toBe(
    true,
  )
})

it('does not renew the capsule lifetime when Better Auth re-signs consent', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
  const { auth, client, sqlite } = await setup(false)
  const pending = await start(auth, client.client_id, 'GET', { max_age: '60' })
  vi.setSystemTime(new Date('2026-11-01T12:09:55Z'))
  const password = await login(auth, pending)
  const consent = await continuation(password)
  expect(consent.pathname).toBe('/consent')
  expect(consent.searchParams.get('kit_authn_v1')).toBe(
    new URLSearchParams(pending).get('kit_authn_v1'),
  )
  vi.setSystemTime(new Date('2026-11-01T12:10:01Z'))
  expect(Number(consent.searchParams.get('exp'))).toBeGreaterThan(Math.floor(Date.now() / 1000))
  const response = await request(auth, '/api/auth/oauth2/consent', {
    method: 'POST',
    headers: { cookie: cookies(password), origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ accept: true, oauth_query: consent.search.slice(1) }),
  })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'OIDC_RESTART_REQUIRED' })
  expect(sqlite.prepare('SELECT count(*) FROM oauth_consent').pluck().get()).toBe(0)
  expect(codeCount(sqlite)).toBe(0)
})

it('rejects capsule substitution across authorization bindings and accepts the unchanged binding', async () => {
  const provenance = createOidcProvenance()
  const secret = crypto.randomUUID() + crypto.randomUUID()
  const issuer = `${ORIGIN}/api/auth`
  const binding = {
    client_id: 'client',
    redirect_uri: REDIRECT,
    code_challenge: 'challenge',
    code_challenge_method: 'S256',
    state: 'state',
    nonce: 'nonce',
  }
  const freshness = { sinceStart: true, maxAge: null }
  const capsule = await provenance.issue(binding, issuer, secret, Date.now(), freshness)
  expect(capsule).toBeTruthy()
  const query = { ...binding, [capsuleField]: capsule }
  expect(await provenance.read(query, issuer, secret)).toMatchObject({ freshness })
  for (const name of Object.keys(binding)) {
    expect(
      await provenance.read({ ...query, [name]: 'another-transaction' }, issuer, secret),
    ).toBeUndefined()
  }
  expect(
    await provenance.read(query, 'https://other.example.test/api/auth', secret),
  ).toBeUndefined()
})

it('requires an authentic capsule even when the issuer and binding match', async () => {
  const provenance = createOidcProvenance()
  const secret = crypto.randomUUID() + crypto.randomUUID()
  const otherSecret = crypto.randomUUID() + crypto.randomUUID()
  const issuer = `${ORIGIN}/api/auth`
  const binding = { client_id: 'fixture', redirect_uri: REDIRECT }
  const signed = await provenance.issue(binding, issuer, secret, Date.now(), null)
  expect(
    await provenance.read({ ...binding, [capsuleField]: signed }, issuer, secret),
  ).toMatchObject({ freshness: null })
  expect(await provenance.read(binding, issuer, secret)).toBeUndefined()
  expect(
    await provenance.read({ ...binding, [capsuleField]: signed }, issuer, otherSecret),
  ).toBeUndefined()
})
