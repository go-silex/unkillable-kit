import { afterEach, describe, expect, it, vi } from 'vitest'
import { rateLimitBuckets } from '../tenancy-schema'
import {
  BA_THROTTLE_LIMIT,
  type BaThrottleInput,
  isBaThrottleExempt,
  throttleBetterAuthRequest,
} from './ba-throttle'
import type { KitRepoDb } from './db-type'
import { createMemoryD1, createMemoryD1Binding } from './memory-d1'
import { clientIp } from './rate-limit'

const BASE = 'http://localhost:8787/api/auth'

function pinThrottleClock() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.UTC(2026, 0, 1, 0, 1))
}

function req(method: string, path: string, init: { body?: string; type?: string } = {}): Request {
  const headers = new Headers()
  if (init.type !== undefined) headers.set('content-type', init.type)
  return new Request(`${BASE}${path}`, { method, headers, body: init.body })
}

const emailPost = (path: string, email: unknown) =>
  req('POST', path, { type: 'application/json', body: JSON.stringify({ email }) })

function input(request: Request, over: Partial<BaThrottleInput> = {}): BaThrottleInput {
  return { request, ip: '203.0.113.1', sessionId: async () => null, ...over }
}

async function counts(db: KitRepoDb): Promise<Record<string, number>> {
  const rows = await db.select().from(rateLimitBuckets)
  return Object.fromEntries(rows.map((r) => [r.bucketKey, r.count]))
}

const rejectsWith = (p: Promise<unknown>, code: string, status: number) =>
  expect(p).rejects.toMatchObject({ code, status })

describe('isBaThrottleExempt', () => {
  it.each([
    ['GET', '/api/auth/get-session', true],
    ['GET', '/api/auth/ok', true],
    ['POST', '/api/auth/get-session', false],
    ['HEAD', '/api/auth/get-session', false],
    ['get', '/api/auth/get-session', false],
    ['GET', '/api/auth/get-session/', false],
    ['GET', '/api/auth//get-session', false],
    ['GET', '/api/auth/GET-SESSION', false],
    ['GET', '/api/auth/get-session%2F', false],
    ['GET', '/api/auth/verify-password', false],
    ['GET', '/api/auth/toString', false],
  ])('%s %s → %s', (method, path, exempt) => {
    expect(isBaThrottleExempt(method, path)).toBe(exempt)
  })
})

describe('throttleBetterAuthRequest', () => {
  afterEach(() => vi.useRealTimers())

  it('exempt reads spend nothing and never look the session up', async () => {
    const db = createMemoryD1()
    const sessionId = vi.fn(async () => 'sess-1')
    for (let i = 0; i < 30; i++) {
      await throttleBetterAuthRequest(db, input(req('GET', '/get-session'), { sessionId }))
    }
    expect(sessionId).not.toHaveBeenCalled()
    expect(await counts(db)).toEqual({})
  })

  it('every other request spends the address bucket; no platform address shares one', async () => {
    pinThrottleClock()

    const db = createMemoryD1()
    for (let i = 0; i < BA_THROTTLE_LIMIT; i++) {
      await throttleBetterAuthRequest(db, input(req('GET', '/list-sessions'), { ip: null }))
    }
    await rejectsWith(
      throttleBetterAuthRequest(db, input(req('POST', '/update-user'), { ip: null })),
      'RATE_LIMITED',
      429,
    )
    expect(await counts(db)).toEqual({ 'ba-auth:no-platform-ip': BA_THROTTLE_LIMIT + 1 })
  })

  it('charges normalized IPv6 prefixes, mapped IPv4 and invalid addresses to their real D1 budgets', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    try {
      const binding = createMemoryD1Binding()
      const first = createMemoryD1(binding)
      const second = createMemoryD1(binding)
      const at = (db: KitRepoDb, address: string | undefined) =>
        throttleBetterAuthRequest(
          db,
          input(req('GET', '/list-sessions'), {
            ip: clientIp({ header: (name) => (name === 'cf-connecting-ip' ? address : undefined) }),
          }),
        )

      for (let i = 0; i < BA_THROTTLE_LIMIT; i++) await at(first, '2001:db8:abcd:12::1')
      await rejectsWith(at(second, '2001:0DB8:ABCD:0012:0000:0000:0000:0002'), 'RATE_LIMITED', 429)
      await expect(at(second, '2001:db8:abcd:13::1')).resolves.toBeUndefined()
      for (let i = 1; i < BA_THROTTLE_LIMIT; i++) await at(second, '2001:db8:abcd:13::2')
      await rejectsWith(at(first, '2001:db8:abcd:13::3'), 'RATE_LIMITED', 429)

      for (let i = 0; i < BA_THROTTLE_LIMIT; i++) await at(first, '203.0.113.9')
      await rejectsWith(at(second, '::ffff:203.0.113.9'), 'RATE_LIMITED', 429)
      await rejectsWith(at(second, '::FFFF:cb00:7109'), 'RATE_LIMITED', 429)
      await expect(at(second, '203.0.113.10')).resolves.toBeUndefined()
      await expect(at(second, '::ffff:203.0.113.10')).resolves.toBeUndefined()

      for (let i = 0; i < BA_THROTTLE_LIMIT; i++) await at(first, undefined)
      await rejectsWith(at(second, '2001:db8:::1'), 'RATE_LIMITED', 429)
      await rejectsWith(at(second, '999.1.2.3'), 'RATE_LIMITED', 429)
    } finally {
      now.mockRestore()
    }
  })

  it('one session rotating addresses ends on 429', async () => {
    pinThrottleClock()

    const db = createMemoryD1()
    const at = (n: number) =>
      throttleBetterAuthRequest(
        db,
        input(req('POST', '/verify-password'), {
          ip: `198.51.100.${n}`,
          sessionId: async () => 'sess-1',
        }),
      )
    for (let n = 1; n <= BA_THROTTLE_LIMIT; n++) await at(n)
    await rejectsWith(at(21), 'RATE_LIMITED', 429)
    const c = await counts(db)
    expect(c['ba-auth-session:sess-1']).toBe(21)
    expect(c['ba-auth:198.51.100.21']).toBe(1)
  })

  it('session-ending POSTs never charge or look up the session', async () => {
    pinThrottleClock()

    const db = createMemoryD1()
    const sessionId = vi.fn(async () => 'sess-1')
    for (let i = 0; i < BA_THROTTLE_LIMIT; i++) {
      await throttleBetterAuthRequest(
        db,
        input(req('GET', '/list-sessions'), { ip: null, sessionId }),
      )
    }
    sessionId.mockClear()
    for (const path of [
      '/sign-out',
      '/revoke-session',
      '/revoke-sessions',
      '/revoke-other-sessions',
      '/sign-out/',
    ]) {
      await throttleBetterAuthRequest(db, input(req('POST', path), { sessionId }))
    }
    expect(sessionId).not.toHaveBeenCalled()
    await rejectsWith(
      throttleBetterAuthRequest(db, input(req('POST', '/change-password'), { sessionId })),
      'RATE_LIMITED',
      429,
    )
  })

  it('a failing session lookup fails closed', async () => {
    const db = createMemoryD1()
    const sessionId = async () => {
      throw new Error('session store down')
    }
    await expect(
      throttleBetterAuthRequest(db, input(req('POST', '/update-user'), { sessionId })),
    ).rejects.toThrow('session store down')
  })

  it('one e-mail budget across sign-in, magic link, reset and verification mail', async () => {
    pinThrottleClock()

    const db = createMemoryD1()
    const paths = [
      '/sign-in/email',
      '/sign-in/magic-link',
      '/request-password-reset',
      '/send-verification-email',
      '/sign-in/email/',
    ]
    const variants = ['victim@example.com', 'Victim@Example.com', 'VICTIM@EXAMPLE.COM']
    for (let n = 1; n <= BA_THROTTLE_LIMIT; n++) {
      const request = emailPost(paths[n % paths.length]!, variants[n % variants.length])
      await throttleBetterAuthRequest(db, input(request, { ip: `198.51.100.${n}` }))
    }
    await rejectsWith(
      throttleBetterAuthRequest(
        db,
        input(emailPost('/sign-in/email', 'victim@example.com'), { ip: '198.51.100.99' }),
      ),
      'RATE_LIMITED',
      429,
    )
    await throttleBetterAuthRequest(
      db,
      input(emailPost('/sign-in/email', 'other@example.com'), { ip: '198.51.100.100' }),
    )
    const keys = Object.keys(await counts(db)).filter((k) => k.startsWith('ba-auth-email:'))
    expect(keys).toHaveLength(2)
    for (const k of keys) expect(k).toMatch(/^ba-auth-email:[0-9a-f]{64}$/)
  })

  it('an e-mail is not trimmed: a padded address is another bucket', async () => {
    const db = createMemoryD1()
    await throttleBetterAuthRequest(db, input(emailPost('/sign-in/email', 'a@example.com')))
    await throttleBetterAuthRequest(db, input(emailPost('/sign-in/email', ' a@example.com')))
    const keys = Object.keys(await counts(db)).filter((k) => k.startsWith('ba-auth-email:'))
    expect(keys).toHaveLength(2)
  })

  it('the e-mail budget is POST-only and only on the e-mail paths', async () => {
    const db = createMemoryD1()
    await throttleBetterAuthRequest(db, input(req('GET', '/sign-in/email')))
    await throttleBetterAuthRequest(db, input(emailPost('/sign-up/email', 'x@example.com')))
    expect(Object.keys(await counts(db))).toEqual(['ba-auth:203.0.113.1'])
  })

  it.each([
    ['no content type', req('POST', '/sign-in/email', { body: '{"email":"a@example.com"}' })],
    [
      'urlencoded form',
      req('POST', '/sign-in/magic-link', {
        type: 'application/x-www-form-urlencoded',
        body: 'email=a%40example.com',
      }),
    ],
    [
      'JSON-gated form (parsed as a form by better-call)',
      req('POST', '/request-password-reset', {
        type: 'x/application/json; application/x-www-form-urlencoded',
        body: 'email=a%40example.com',
      }),
    ],
    ['malformed JSON', req('POST', '/sign-in/email', { type: 'application/json', body: '{' })],
    ['empty body', req('POST', '/sign-in/email', { type: 'application/json' })],
    ['array body', req('POST', '/sign-in/email', { type: 'application/json', body: '[]' })],
    ['non-string e-mail', emailPost('/sign-in/email', 42)],
    ['empty e-mail', emailPost('/sign-in/email', '')],
    ['over-long e-mail', emailPost('/sign-in/email', `${'a'.repeat(250)}@x.io`)],
  ])(
    'unreadable e-mail (%s) is a 400 before Better Auth, after the address charge',
    async (_, request) => {
      const db = createMemoryD1()
      await rejectsWith(throttleBetterAuthRequest(db, input(request)), 'VALIDATION_ERROR', 400)
      expect(await counts(db)).toEqual({ 'ba-auth:203.0.113.1': 1 })
    },
  )

  it('leaves the body readable for Better Auth', async () => {
    const db = createMemoryD1()
    const request = emailPost('/sign-in/email', 'a@example.com')
    await throttleBetterAuthRequest(db, input(request))
    expect(await request.json()).toEqual({ email: 'a@example.com' })
  })

  it('a D1 failure fails closed with INTERNAL_ERROR', async () => {
    const db = createMemoryD1()
    vi.spyOn(db, 'insert').mockImplementation(() => {
      throw new Error('d1 down')
    })
    await rejectsWith(
      throttleBetterAuthRequest(db, input(req('POST', '/verify-password'))),
      'INTERNAL_ERROR',
      500,
    )
  })

  it('the count lives in D1: a fresh module and handle on the same binding still 429', async () => {
    pinThrottleClock()

    const binding = createMemoryD1Binding()
    const first = createMemoryD1(binding)
    for (let i = 0; i < BA_THROTTLE_LIMIT; i++) {
      await throttleBetterAuthRequest(first, input(req('POST', '/verify-password')))
    }
    vi.resetModules()
    // Dynamic on purpose: a second isolate starts from freshly evaluated modules, so no
    // module-level state can carry the count.
    const fresh = await import('./ba-throttle')
    const second = createMemoryD1(binding)
    expect(fresh.throttleBetterAuthRequest).not.toBe(throttleBetterAuthRequest)
    expect(second).not.toBe(first)
    // The re-imported module has its own @kit/core class: match the shape, not the identity.
    await expect(
      fresh.throttleBetterAuthRequest(second, input(req('POST', '/verify-password'))),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 })
    expect((await counts(second))['ba-auth:203.0.113.1']).toBe(BA_THROTTLE_LIMIT + 1)
  })
})
