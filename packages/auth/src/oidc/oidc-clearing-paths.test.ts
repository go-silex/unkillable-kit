import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KitBetterAuth } from '../better-auth-factory'
import {
  codeCount,
  continuation,
  cookies,
  exchange,
  googleBoundary,
  googleLogin,
  login,
  ORIGIN,
  PASSWORD,
  request,
  setup,
  start,
} from './oidc-login-flow.fixture'

const EMAIL = 'user@example.test'
const GOOGLE_EMAIL = 'google@example.test'
const START_TIME = Date.parse('2026-11-22T12:00:00Z')

function atSecond(second: number) {
  vi.setSystemTime(START_TIME + second * 1_000)
}

function post(auth: KitBetterAuth, path: string, body: object, cookie = '') {
  return request(auth, `/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
}

function continueAfterLogin(auth: KitBetterAuth, oauthQuery: string, cookie: string) {
  return post(auth, '/oauth2/continue', { postLogin: true, oauth_query: oauthQuery }, cookie)
}

function acceptConsent(auth: KitBetterAuth, consent: URL, cookie: string) {
  return post(
    auth,
    '/oauth2/consent',
    { accept: true, oauth_query: consent.search.slice(1) },
    cookie,
  )
}

function sessionCookie(response: Response) {
  const cookie = cookies(response)
  expect(cookie).toContain('__Secure-kit_session=')
  return cookie
}

async function expectPasswordRequired(response: Response, sqlite: Parameters<typeof codeCount>[0]) {
  const next = await continuation(response)
  expect(next.origin).toBe(ORIGIN)
  expect(next.pathname).toBe('/login')
  expect(next.searchParams.get('code')).toBeNull()
  expect(codeCount(sqlite)).toBe(0)
}

async function consentPage(response: Response) {
  const next = await continuation(response)
  expect(next.origin).toBe(ORIGIN)
  expect(next.pathname).toBe('/consent')
  expect(next.searchParams.get('sig')).toBeTruthy()
  expect(next.searchParams.get('code')).toBeNull()
  return next
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  atSecond(0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('OIDC freshness across session and continuation paths', () => {
  it.each([
    ['prompt=login', { prompt: 'login' }, 2],
    ['max_age=0', { max_age: '0' }, 2],
    ['max_age=60', { max_age: '60' }, 65],
  ] as const)(
    'enforces %s when /update-user refreshes a session cookie',
    async (_name, freshness, second) => {
      const { auth, client, sqlite } = await setup(true)
      const oldCookie = sessionCookie(await login(auth))
      atSecond(second)
      const oauthQuery = await start(auth, client.client_id, 'GET', freshness)
      const updateProfile = (cookie: string) =>
        post(auth, '/update-user', { name: 'Updated Name', oauth_query: oauthQuery }, cookie)

      await expectPasswordRequired(await updateProfile(oldCookie), sqlite)

      atSecond(second + 2)
      const newCookie = sessionCookie(await login(auth))
      await exchange(auth, client, await continuation(await updateProfile(newCookie)), EMAIL)
    },
  )

  it('requires a fresh password session on /oauth2/continue with postLogin', async () => {
    const { auth, client, sqlite } = await setup(true)
    const oldCookie = sessionCookie(await login(auth))
    atSecond(2)
    const oauthQuery = await start(auth, client.client_id, 'GET', { prompt: 'login' })
    await expectPasswordRequired(await continueAfterLogin(auth, oauthQuery, oldCookie), sqlite)

    atSecond(4)
    const freshCookie = sessionCookie(await login(auth))
    const resumed = await continueAfterLogin(auth, oauthQuery, freshCookie)
    await exchange(auth, client, await continuation(resumed), EMAIL)
  })

  it('allows a redeemed magic-link session to continue and consent only without a freshness constraint', async () => {
    const { auth, client, send, sqlite } = await setup(false)
    const constrained = await start(auth, client.client_id, 'GET', { max_age: '60' })
    atSecond(2)
    const constrainedConsent = await consentPage(await login(auth, constrained))

    const callback = `${ORIGIN}/signed-in`
    const sent = await post(auth, '/sign-in/magic-link', { email: EMAIL, callbackURL: callback })
    expect(sent.status).toBe(200)
    expect(send).toHaveBeenCalledTimes(1)
    const href = send.mock.lastCall?.[0].text.match(/^Sign-in link: (\S+)$/m)?.[1]
    if (!href) throw new Error('Magic-link email did not contain a sign-in URL')
    const link = new URL(href)
    expect(link.origin).toBe(ORIGIN)
    expect(link.pathname).toBe('/api/auth/magic-link/verify')
    atSecond(4)
    const redeemed = await request(auth, link.href, { headers: { origin: ORIGIN } })
    expect(redeemed.status).toBe(302)
    expect(redeemed.headers.get('location')).toBe(callback)
    const magicCookie = sessionCookie(redeemed)

    await expectPasswordRequired(await continueAfterLogin(auth, constrained, magicCookie), sqlite)
    await expectPasswordRequired(await acceptConsent(auth, constrainedConsent, magicCookie), sqlite)

    const ordinary = await start(auth, client.client_id, 'GET')
    const pending = await consentPage(await continueAfterLogin(auth, ordinary, magicCookie))
    const accepted = await acceptConsent(auth, pending, magicCookie)
    await exchange(auth, client, await continuation(accepted), EMAIL)
  })

  it('does not treat a session rotated by password change as a fresh password sign-in', async () => {
    const { auth, client, sqlite } = await setup(true)
    const oldCookie = sessionCookie(await login(auth))
    atSecond(2)
    const oauthQuery = await start(auth, client.client_id, 'GET', { max_age: '0' })
    atSecond(4)
    const replacement = crypto.randomUUID()
    const changed = await post(
      auth,
      '/change-password',
      {
        currentPassword: PASSWORD,
        newPassword: replacement,
        revokeOtherSessions: true,
      },
      oldCookie,
    )
    expect(changed.status).toBe(200)
    const rotatedCookie = sessionCookie(changed)
    expect(rotatedCookie).not.toBe(oldCookie)
    await expectPasswordRequired(await continueAfterLogin(auth, oauthQuery, rotatedCookie), sqlite)

    atSecond(6)
    const newCookie = sessionCookie(await login(auth, undefined, replacement))
    const resumed = await continueAfterLogin(auth, oauthQuery, newCookie)
    await exchange(auth, client, await continuation(resumed), EMAIL)
  })

  it('requires password renewal even after consent was completed, then reuses the stored consent', async () => {
    const { auth, client, sqlite, database } = await setup(false)
    const oauthQuery = await start(auth, client.client_id, 'GET', { max_age: '60' })
    atSecond(2)
    const signedIn = await login(auth, oauthQuery)
    const oldCookie = sessionCookie(signedIn)
    const pending = await consentPage(signedIn)
    const prepare = vi.spyOn(database, 'prepare')
    const accepted = await acceptConsent(auth, pending, oldCookie)
    await exchange(auth, client, await continuation(accepted), EMAIL)
    const queries = prepare.mock.calls.map(([sql]) => sql)
    const write = queries.findIndex((sql) => /insert into "oauth_consent"/i.test(sql))
    const proof = queries.findIndex((sql) => sql.includes('INNER JOIN oidc_session_authentication'))
    expect(proof).toBeGreaterThanOrEqual(0)
    expect(write).toBeGreaterThan(proof)

    atSecond(65)
    await expectPasswordRequired(await acceptConsent(auth, pending, oldCookie), sqlite)
    const completedQuery = pending.search.slice(1)
    await expectPasswordRequired(await continueAfterLogin(auth, completedQuery, oldCookie), sqlite)

    atSecond(67)
    const newCookie = sessionCookie(await login(auth))
    const resumed = await continueAfterLogin(auth, completedQuery, newCookie)
    await exchange(auth, client, await continuation(resumed), EMAIL)
  })

  it('declines constrained continuation for a verified Google session but allows ordinary continuation', async () => {
    const { auth, client, sqlite } = await setup(false)
    const constrained = await start(auth, client.client_id, 'GET', { max_age: '60' })
    const ordinary = await start(auth, client.client_id, 'GET')
    atSecond(2)
    googleBoundary(true)
    const google = await googleLogin(auth, ordinary)
    const googleCookie = sessionCookie(google)
    const pending = await consentPage(google)

    await expectPasswordRequired(await continueAfterLogin(auth, constrained, googleCookie), sqlite)

    const resumed = await consentPage(
      await continueAfterLogin(auth, pending.search.slice(1), googleCookie),
    )
    const accepted = await acceptConsent(auth, resumed, googleCookie)
    await exchange(auth, client, await continuation(accepted), GOOGLE_EMAIL)
  })
})
