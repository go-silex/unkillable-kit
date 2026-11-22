import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rateLimitBuckets } from '../tenancy-schema'
import {
  BA_THROTTLE_LIMIT,
  throttleBetterAuthActorRequest,
  throttleBetterAuthRequest,
} from './ba-throttle'
import type { KitRepoDb } from './db-type'
import { createMemoryD1, createMemoryD1Binding } from './memory-d1'

const BASE = 'http://localhost:8787/api/auth'

function req(method: string, path: string, init: { body?: string; type?: string } = {}): Request {
  const headers = new Headers()
  if (init.type !== undefined) headers.set('content-type', init.type)
  return new Request(`${BASE}${path}`, { method, headers, body: init.body })
}

const emailPost = (path: string, email: unknown) =>
  req('POST', path, { type: 'application/json', body: JSON.stringify({ email }) })

function input(request: Request, over: { ip?: string | null } = {}) {
  return {
    request,
    ip: over.ip === undefined ? '203.0.113.1' : over.ip,
    sessionId: async () => null,
  }
}

async function counts(db: KitRepoDb): Promise<Record<string, number>> {
  const rows = await db.select().from(rateLimitBuckets)
  return Object.fromEntries(rows.map((r) => [r.bucketKey, r.count]))
}

const rejectsWith = (p: Promise<unknown>, code: string, status: number) =>
  expect(p).rejects.toMatchObject({ code, status })
describe('throttleBetterAuthActorRequest', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('isolates actor sources while sharing each actor budget across requests and handles', async () => {
    const binding = createMemoryD1Binding()
    const first = createMemoryD1(binding)
    const second = createMemoryD1(binding)
    for (let i = 0; i < BA_THROTTLE_LIMIT; i++) {
      await throttleBetterAuthActorRequest(i % 2 ? first : second, {
        request: req('POST', i % 2 ? '/sign-out' : '/verify-password'),
        actorId: 'actor-a',
      })
    }
    await rejectsWith(
      throttleBetterAuthActorRequest(second, {
        request: req('POST', '/sign-out'),
        actorId: 'actor-a',
      }),
      'RATE_LIMITED',
      429,
    )
    await throttleBetterAuthActorRequest(second, {
      request: req('POST', '/verify-password'),
      actorId: 'actor-b',
    })
    await throttleBetterAuthRequest(second, input(req('POST', '/verify-password'), { ip: null }))
    expect(await counts(first)).toEqual({
      'ba-auth-actor:actor-a': BA_THROTTLE_LIMIT + 1,
      'ba-auth-actor:actor-b': 1,
      'ba-auth:no-platform-ip': 1,
    })
  })

  it('shares normalized e-mail budgets across native and actor calls and all budgeted paths', async () => {
    const db = createMemoryD1()
    const paths = [
      '/sign-in/email',
      '/sign-in/magic-link',
      '/request-password-reset',
      '/send-verification-email/',
    ]
    for (let i = 0; i < BA_THROTTLE_LIMIT; i++) {
      const request = emailPost(
        paths[i % paths.length]!,
        i % 2 ? 'VICTIM@example.com' : 'victim@EXAMPLE.com',
      )
      if (i % 2) {
        await throttleBetterAuthActorRequest(db, { request, actorId: `actor-${i}` })
      } else {
        await throttleBetterAuthRequest(db, input(request, { ip: `198.51.100.${i}` }))
      }
    }
    await rejectsWith(
      throttleBetterAuthActorRequest(db, {
        request: emailPost('/request-password-reset', 'victim@example.com'),
        actorId: 'other-actor',
      }),
      'RATE_LIMITED',
      429,
    )
    const emailCounts = Object.entries(await counts(db)).filter(([key]) =>
      key.startsWith('ba-auth-email:'),
    )
    expect(emailCounts).toHaveLength(1)
    expect(emailCounts[0]![1]).toBe(BA_THROTTLE_LIMIT + 1)
  })

  it('exempts only exact session reads and applies email policy only to listed POSTs', async () => {
    const db = createMemoryD1()
    await throttleBetterAuthActorRequest(db, { request: req('GET', '/get-session'), actorId: 'a' })
    await throttleBetterAuthActorRequest(db, { request: req('GET', '/ok'), actorId: 'a' })
    await throttleBetterAuthActorRequest(db, { request: req('GET', '/get-session/'), actorId: 'a' })
    await throttleBetterAuthActorRequest(db, {
      request: req('GET', '/sign-in/email'),
      actorId: 'a',
    })
    await throttleBetterAuthActorRequest(db, {
      request: emailPost('/sign-up/email', 'a@example.com'),
      actorId: 'a',
    })
    expect(await counts(db)).toEqual({ 'ba-auth-actor:a': 3 })
  })

  it.each([undefined, null, '', '   ', 42])(
    'rejects unusable actor %s before even exempt reads',
    async (actorId) => {
      const db = createMemoryD1()
      await rejectsWith(
        throttleBetterAuthActorRequest(db, {
          request: req('GET', '/get-session'),
          actorId: actorId as string,
        }),
        'VALIDATION_ERROR',
        400,
      )
      expect(await counts(db)).toEqual({})
    },
  )

  it.each([
    req('POST', '/request-password-reset', { type: 'application/json', body: '{' }),
    emailPost('/sign-in/email', ''),
    emailPost('/send-verification-email', 42),
    emailPost('/sign-in/magic-link', `${'a'.repeat(250)}@x.io`),
  ])('rejects unreadable e-mail after charging the actor', async (request) => {
    const db = createMemoryD1()
    await rejectsWith(
      throttleBetterAuthActorRequest(db, { request, actorId: 'a' }),
      'VALIDATION_ERROR',
      400,
    )
    expect(await counts(db)).toEqual({ 'ba-auth-actor:a': 1 })
  })

  it('preserves the body and fails closed on D1 failure', async () => {
    const db = createMemoryD1()
    const request = emailPost('/request-password-reset', 'a@example.com')
    await throttleBetterAuthActorRequest(db, { request, actorId: 'a' })
    expect(await request.json()).toEqual({ email: 'a@example.com' })
    vi.spyOn(db, 'insert').mockImplementation(() => {
      throw new Error('d1 down')
    })
    await rejectsWith(
      throttleBetterAuthActorRequest(db, {
        request: req('POST', '/verify-password'),
        actorId: 'a',
      }),
      'INTERNAL_ERROR',
      500,
    )
  })
})
