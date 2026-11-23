import { verifyOAuthQueryParams } from '@better-auth/oauth-provider'
import { makeSignature } from 'better-auth/crypto'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { KitBetterAuth } from '../better-auth-factory'
import { type BetterAuthHandlerEnv, createBetterAuthHandler } from '../policy/better-auth-handler'
import { capsuleField, createOidcProvenance } from './oidc-fresh-login-provenance'
import {
  codeCount,
  complete,
  continuation,
  cookies,
  login,
  ORIGIN,
  PASSWORD,
  request,
  setup,
  start,
} from './oidc-login-flow.fixture'

const EPOCH = Date.UTC(2026, 10, 1)
const AUTHORIZE = '/api/auth/oauth2/authorize?'

function clock() {
  vi.useFakeTimers({ toFake: ['Date'] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const at = (elapsed: number) => vi.setSystemTime(EPOCH + elapsed)
  at(0)
  return at
}

function authorize(auth: KitBetterAuth, pending: string | URLSearchParams, cookie: string) {
  return request(auth, `${AUTHORIZE}${pending}`, { headers: { cookie, accept: 'text/html' } })
}

function directFields(pending: string) {
  const params = new URLSearchParams(pending)
  for (const name of [capsuleField, 'sig', 'exp', 'ba_iat', 'ba_param', 'prompt', 'max_age'])
    params.delete(name)
  return params
}

it.each([false, true])(
  'enforces the inclusive positive age limit, prompt=none=%s',
  async (silent) => {
    const at = clock()
    const { auth, client, sqlite } = await setup(true)
    const pending = await start(auth, client.client_id, 'GET')
    const password = await login(auth)
    const params = directFields(pending)
    params.set('max_age', '3')
    if (silent) params.set('prompt', 'none')
    for (const elapsed of [2999, 3000]) {
      at(elapsed)
      const dest = await continuation(await authorize(auth, params, cookies(password)))
      await complete(auth, client, dest, 'user@example.test')
    }
    at(3001)
    const dest = await continuation(await authorize(auth, params, cookies(password)))
    if (silent) expect(dest.searchParams.get('error')).toBe('login_required')
    else expect(dest.pathname).toBe('/login')
    expect(dest.searchParams.has('code')).toBe(false)
    expect(codeCount(sqlite)).toBe(0)
  },
)

it('denies a mint when the password crosses the age limit after the early check', async () => {
  const at = clock()
  const { auth, client, sqlite, database } = await setup(true)
  const password = await login(auth)
  const params = directFields(await start(auth, client.client_id, 'GET'))
  params.set('max_age', '3')
  at(3000)
  const prepare = database.prepare
  let reads = 0
  vi.spyOn(database, 'prepare').mockImplementation((sql) => {
    if (sql.includes('INNER JOIN oidc_session_authentication') && ++reads === 2) at(3001)
    return prepare(sql)
  })
  const response = await authorize(auth, params, cookies(password))
  expect(response.status).toBe(400)
  expect(response.headers.get('location')).toBeNull()
  expect(await response.json()).toEqual({ error: 'invalid_request' })
  expect(reads).toBe(2)
  expect(codeCount(sqlite)).toBe(0)
})

it('combines fresh-start and age constraints across overlapping transactions', async () => {
  const at = clock()
  const { auth, client, sqlite } = await setup(true)
  const previous = await login(auth)
  at(1)
  const fields = directFields(await start(auth, client.client_id, 'GET'))
  fields.set('prompt', 'login')
  fields.set('max_age', '3')
  const combined = await continuation(await authorize(auth, fields, cookies(previous)))
  const unconstrained = await start(auth, client.client_id, 'GET')
  expect(combined.searchParams.get('code_challenge')).toBe(
    new URLSearchParams(unconstrained).get('code_challenge'),
  )
  expect(combined.searchParams.get(capsuleField)).not.toBe(
    new URLSearchParams(unconstrained).get(capsuleField),
  )
  expect(combined.pathname).toBe('/login')
  const fresh = await login(auth, combined.search.slice(1))
  await complete(auth, client, await continuation(fresh), 'user@example.test')
  at(5000)
  const update = (oauth_query: string) =>
    request(auth, '/api/auth/update-user', {
      method: 'POST',
      headers: { cookie: cookies(fresh), origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Updated', oauth_query }),
    })
  expect((await continuation(await update(combined.search.slice(1)))).pathname).toBe('/login')
  expect(codeCount(sqlite)).toBe(0)
  await complete(auth, client, await continuation(await update(unconstrained)), 'user@example.test')
})

it.each(['future', 'mismatched'])('refuses %s password evidence', async (fault) => {
  const at = clock()
  const { auth, client, sqlite } = await setup(true)
  const password = await login(auth)
  const params = directFields(await start(auth, client.client_id, 'GET'))
  params.set('max_age', '3')
  at(1000)
  const observed = EPOCH + 2000
  sqlite.prepare('UPDATE oidc_session_authentication SET authenticated_at = ?').run(observed)
  if (fault === 'future') {
    sqlite
      .prepare(
        'UPDATE session SET created_at = ? WHERE id IN (SELECT session_id FROM oidc_session_authentication)',
      )
      .run(observed)
  }
  const denied = await continuation(await authorize(auth, params, cookies(password)))
  expect(denied.pathname).toBe('/login')
  expect(codeCount(sqlite)).toBe(0)
  at(2500)
  sqlite
    .prepare(
      'UPDATE session SET created_at = ? WHERE id IN (SELECT session_id FROM oidc_session_authentication)',
    )
    .run(observed)
  await complete(
    auth,
    client,
    await continuation(await authorize(auth, params, cookies(password))),
    'user@example.test',
  )
})

it('restarts direct navigation with its own policy and replaces client capsule values', async () => {
  const at = clock()
  const { auth, client } = await setup(true)
  const oldLogin = await login(auth)
  at(1000)
  const ordinary = await start(auth, client.client_id, 'GET')
  await complete(
    auth,
    client,
    await continuation(await authorize(auth, ordinary, cookies(oldLogin))),
    'user@example.test',
  )
  const strict = await start(auth, client.client_id, 'GET', { prompt: 'login' })
  const supplied = new URLSearchParams(strict)
  supplied.set(capsuleField, 'not-a-kit-capsule')
  at(2000)
  for (const [query, original] of [
    [strict, new URLSearchParams(strict).get(capsuleField)],
    [supplied.toString(), 'not-a-kit-capsule'],
  ]) {
    const dest = await continuation(await authorize(auth, query!, cookies(oldLogin)))
    expect(dest.pathname).toBe('/login')
    expect(dest.searchParams.get(capsuleField)).not.toBe(original)
    await complete(
      auth,
      client,
      await continuation(await login(auth, dest.search.slice(1))),
      'user@example.test',
    )
  }
  supplied.append(capsuleField, 'second-value')
  expect((await authorize(auth, supplied, cookies(oldLogin))).status).toBe(400)
})

it('retains the strictest authenticated policy at re-entry even after expiry', async () => {
  const at = clock()
  const provenance = createOidcProvenance()
  const secret = crypto.randomUUID() + crypto.randomUUID()
  const query = { client_id: 'fixture' }
  const first = await provenance.issue(query, ORIGIN, secret, EPOCH, {
    sinceStart: true,
    maxAge: 60,
  })
  expect(first).toBeTruthy()
  const before = { ...query, [capsuleField]: first }
  at(601_000)
  expect(await provenance.read(before, ORIGIN, secret)).toBeUndefined()
  for (const [rawAge, expectedAge] of [
    [null, 60],
    [120, 60],
    [30, 30],
  ] as const) {
    const raw = rawAge === null ? null : { sinceStart: false, maxAge: rawAge }
    const next = await provenance.issue(before, ORIGIN, secret, Date.now(), raw)
    const result = await provenance.read({ ...query, [capsuleField]: next }, ORIGIN, secret)
    expect(result).toMatchObject({
      startedAt: EPOCH + 601_000,
      freshness: { sinceStart: true, maxAge: expectedAge },
    })
  }
})

it('uses retained keys only to tighten a newly signed capsule', async () => {
  const provenance = createOidcProvenance()
  const current = crypto.randomUUID() + crypto.randomUUID()
  const previous = crypto.randomUUID() + crypto.randomUUID()
  const legacy = crypto.randomUUID() + crypto.randomUUID()
  const secretConfig = {
    currentVersion: 2,
    keys: new Map([
      [2, current],
      [1, previous],
    ]),
    legacySecret: legacy,
  }
  const query = { client_id: 'fixture' }
  const freshness = { sinceStart: false, maxAge: 60 }
  const now = Date.now()
  for (const oldKey of [previous, legacy]) {
    const before = await provenance.issue(query, ORIGIN, oldKey, now, freshness)
    const reentered = { ...query, [capsuleField]: before }
    expect(await provenance.read(reentered, ORIGIN, current)).toBeUndefined()
    const capsule = await provenance.issue(reentered, ORIGIN, current, now, null, secretConfig)
    const replacement = { ...query, [capsuleField]: capsule }
    expect(await provenance.read(replacement, ORIGIN, current)).toMatchObject({ freshness })
    expect(await provenance.read(replacement, ORIGIN, oldKey)).toBeUndefined()
  }
})

it('requires password renewal when a pre-rotation consent URL is re-entered', async () => {
  const at = clock()
  const previous = crypto.randomUUID() + crypto.randomUUID()
  const current = crypto.randomUUID() + crypto.randomUUID()
  vi.stubEnv('BETTER_AUTH_SECRETS', `1:${previous}`)
  onTestFinished(() => {
    vi.unstubAllEnvs()
  })
  const { auth, client, createAuth, sqlite } = await setup(false)
  const initial = await start(auth, client.client_id, 'GET', { max_age: '60' })
  at(1000)
  const consent = await continuation(await login(auth, initial))
  expect(consent.pathname).toBe('/consent')
  expect(consent.searchParams.has('max_age')).toBe(false)
  expect(await verifyOAuthQueryParams(consent.search.slice(1), previous)).toBe(true)

  vi.stubEnv('BETTER_AUTH_SECRETS', `2:${current},1:${previous}`)
  const rotated = createAuth()
  // Use a session cookie signed with the current key so the result tests
  // freshness rather than rejection of a pre-rotation cookie.
  const signedIn = await login(rotated)
  expect(signedIn.status).toBe(200)
  const cookie = cookies(signedIn)
  expect(cookie).toContain('__Secure-kit_session=')
  at(300_000)
  const response = await request(rotated, '/api/auth/get-session', { headers: { cookie } })
  expect(await response.json()).toMatchObject({ user: { email: 'user@example.test' } })
  const next = await continuation(await authorize(rotated, consent.searchParams, cookie))
  expect(next.pathname).toBe('/login')
  expect(next.searchParams.has('code')).toBe(false)
  expect(await verifyOAuthQueryParams(next.search.slice(1), current)).toBe(true)
  expect(codeCount(sqlite)).toBe(0)
})

it.each([300_000, 601_000])(
  'requires another password on consent re-entry at +%dms',
  async (elapsed) => {
    const at = clock()
    const { auth, client, sqlite } = await setup(false)
    const initial = await start(auth, client.client_id, 'GET', { max_age: '60' })
    at(1000)
    const signedIn = await login(auth, initial)
    const consent = await continuation(signedIn)
    expect(consent.pathname).toBe('/consent')
    expect(consent.searchParams.has('max_age')).toBe(false)
    at(elapsed)
    const result = await continuation(
      await authorize(auth, consent.searchParams, cookies(signedIn)),
    )
    expect(result.pathname).toBe('/login')
    expect(result.searchParams.has('code')).toBe(false)
    expect(codeCount(sqlite)).toBe(0)
  },
)

it('keeps prompt=login on consent re-entry with a signup session', async () => {
  const at = clock()
  const { auth, client, sqlite, signupCookie } = await setup(false)
  const initial = await start(auth, client.client_id, 'GET', { prompt: 'login' })
  at(1000)
  const consent = await continuation(await login(auth, initial))
  expect(consent.pathname).toBe('/consent')
  expect(consent.searchParams.has('prompt')).toBe(false)
  const result = await continuation(await authorize(auth, consent.searchParams, signupCookie))
  expect(result.pathname).toBe('/login')
  expect(result.searchParams.has('code')).toBe(false)
  expect(codeCount(sqlite)).toBe(0)
})

it('allows consent re-entry while the required password proof is still fresh', async () => {
  const at = clock()
  const { auth, client } = await setup(false)
  const initial = await start(auth, client.client_id, 'GET', { max_age: '60' })
  at(1000)
  const password = await login(auth, initial)
  const cookie = cookies(password)
  const first = await continuation(password)
  expect(first.pathname).toBe('/consent')
  at(30_000)
  const next = await continuation(await authorize(auth, first.searchParams, cookie))
  expect(next.pathname).toBe('/consent')
  expect(next.searchParams.get(capsuleField)).not.toBe(first.searchParams.get(capsuleField))
  const accepted = await request(auth, '/api/auth/oauth2/consent', {
    method: 'POST',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ accept: true, oauth_query: next.search.slice(1) }),
  })
  await complete(auth, client, await continuation(accepted), 'user@example.test')
})

it('replaces a wrong-key capsule without applying its policy', async () => {
  const at = clock()
  const { auth, client, secret, signupCookie } = await setup(false)
  const ordinary = directFields(await start(auth, client.client_id, 'GET'))
  const provenance = createOidcProvenance()
  const issuer = `${ORIGIN}/api/auth`
  const wrong = await provenance.issue(
    Object.fromEntries(ordinary),
    issuer,
    crypto.randomUUID() + crypto.randomUUID(),
    EPOCH,
    { sinceStart: true, maxAge: 1 },
  )
  if (!wrong) throw new Error('Expected a signed fixture capsule')
  ordinary.set(capsuleField, wrong)
  at(1000)
  const consent = await continuation(await authorize(auth, ordinary, signupCookie))
  expect(consent.pathname).toBe('/consent')
  expect(consent.searchParams.get(capsuleField)).not.toBe(wrong)
  expect(
    await provenance.read(Object.fromEntries(consent.searchParams), issuer, secret),
  ).toMatchObject({ freshness: null })
})

async function legacyEnvelope(raw: string, secret: string, invalidCapsule: boolean) {
  const params = new URLSearchParams(raw)
  params.delete('sig')
  const names = params.getAll('ba_param')
  params.delete('ba_param')
  if (invalidCapsule) params.set(capsuleField, 'malformed')
  else params.delete(capsuleField)
  for (const name of names.filter((name) => name !== capsuleField || invalidCapsule).sort()) {
    params.append('ba_param', name)
  }
  params.sort()
  params.set('sig', await makeSignature(params.toString(), secret))
  expect(await verifyOAuthQueryParams(params.toString(), secret)).toBe(true)
  return params.toString()
}

it.each(['legacy none', 'legacy login', 'invalid capsule'])(
  'restarts for %s with valid upstream consent signature',
  async (kind) => {
    const at = clock()
    const { auth, client, sqlite, secret } = await setup(false)
    const pending = await start(
      auth,
      client.client_id,
      'GET',
      kind === 'legacy none' ? undefined : { prompt: 'login' },
    )
    at(1000)
    const signedIn = await login(auth, pending)
    const consent = await continuation(signedIn)
    const oauth_query = await legacyEnvelope(
      consent.search.slice(1),
      secret,
      kind === 'invalid capsule',
    )
    const response = await request(auth, '/api/auth/oauth2/consent', {
      method: 'POST',
      headers: { cookie: cookies(signedIn), origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ accept: true, oauth_query }),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'OIDC_RESTART_REQUIRED' })
    expect(sqlite.prepare('SELECT count(*) FROM oauth_consent').pluck().get()).toBe(0)
    expect(codeCount(sqlite)).toBe(0)
  },
)

it('restarts mounted sign-up before account creation for expired and pre-upgrade envelopes', async () => {
  const at = clock()
  const { auth, client, sqlite, database, secret } = await setup(false)
  const pending = await start(auth, client.client_id, 'GET', { prompt: 'login' })
  at(595_000)
  const consent = await continuation(await login(auth, pending))
  const legacy = await legacyEnvelope(consent.search.slice(1), secret, false)
  at(601_000)
  expect(await verifyOAuthQueryParams(consent.search.slice(1), secret)).toBe(true)
  const app = new Hono<BetterAuthHandlerEnv>()
  app.use('*', async (c, next) => {
    c.set('db', drizzle(database as never))
    c.set('betterAuth', auth)
    await next()
  })
  app.all('/api/auth/*', createBetterAuthHandler())
  const count = () => sqlite.prepare('SELECT count(*) FROM user').pluck().get()
  const initial = count()
  for (const [i, oauth_query] of [consent.search.slice(1), legacy].entries()) {
    for (const email of ['user@example.test', `new-user-${i}@example.test`]) {
      const response = await app.request(`${ORIGIN}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'New User', email, password: PASSWORD, oauth_query }),
      })
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: { code: 'OIDC_RESTART_REQUIRED' } })
      expect(response.headers.getSetCookie()).toEqual([])
      expect(count()).toBe(initial)
    }
  }
  expect(codeCount(sqlite)).toBe(0)
})
