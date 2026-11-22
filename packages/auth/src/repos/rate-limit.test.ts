import { AppError } from '@kit/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryD1 } from './memory-d1'
import { assertRateLimit, clientIp, resetRateLimits } from './rate-limit'

function pinRateLimitClock() {
  vi.useFakeTimers({ toFake: ['Date'] })
  // Pin the midpoint of the 60-second window.
  vi.setSystemTime(Date.UTC(2026, 0, 1, 0, 0, 30))
}

describe('D1 rate limit (B-auth-harden go-silex/silex-boilerplate#61)', () => {
  afterEach(() => vi.useRealTimers())

  it('allows up to limit then 429 with retryAfterSeconds', async () => {
    pinRateLimitClock()

    const db = createMemoryD1()
    await assertRateLimit(db, 'k:a', 3, 60_000)
    await assertRateLimit(db, 'k:a', 3, 60_000)
    await assertRateLimit(db, 'k:a', 3, 60_000)
    await expect(assertRateLimit(db, 'k:a', 3, 60_000)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      details: { retryAfterSeconds: 30 },
    })
  })

  it('isolates keys', async () => {
    pinRateLimitClock()

    const db = createMemoryD1()
    for (let i = 0; i < 3; i++) await assertRateLimit(db, 'k:1', 3, 60_000)
    await expect(assertRateLimit(db, 'k:1', 3, 60_000)).rejects.toBeInstanceOf(AppError)
    await expect(assertRateLimit(db, 'k:2', 3, 60_000)).resolves.toBeUndefined()
  })

  it('resetRateLimits clears buckets', async () => {
    pinRateLimitClock()

    const db = createMemoryD1()
    for (let i = 0; i < 3; i++) await assertRateLimit(db, 'k:r', 3, 60_000)
    await resetRateLimits(db)
    await expect(assertRateLimit(db, 'k:r', 3, 60_000)).resolves.toBeUndefined()
  })

  it('concurrent awaits on same key do not under-count past limit', async () => {
    pinRateLimitClock()

    const db = createMemoryD1()
    const limit = 5
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => assertRateLimit(db, 'k:race', limit, 60_000)),
    )
    const ok = results.filter((r) => r.status === 'fulfilled').length
    const limited = results.filter(
      (r) =>
        r.status === 'rejected' && r.reason instanceof AppError && r.reason.code === 'RATE_LIMITED',
    ).length
    expect(ok).toBeLessThanOrEqual(limit)
    expect(ok + limited).toBe(20)
    expect(limited).toBeGreaterThan(0)
  })

  it('D1 failure fail-closes with INTERNAL_ERROR (no pass-through)', async () => {
    const db = createMemoryD1()
    const spy = vi.spyOn(db, 'insert').mockImplementation(() => {
      throw new Error('d1 down')
    })
    await expect(assertRateLimit(db, 'k:fail', 10, 60_000)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 500,
    })
    spy.mockRestore()
  })

  it('rejects invalid limit configuration', async () => {
    const db = createMemoryD1()
    await expect(assertRateLimit(db, 'k:bad', 0, 60_000)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    })
  })

  it('clientIp groups IPv6 by /64 and preserves IPv4 identity', () => {
    const from = (value: string | undefined) =>
      clientIp({ header: (name) => (name === 'cf-connecting-ip' ? value : undefined) })
    const prefix = from('2001:db8:abcd:12::1')
    expect(prefix).not.toBeNull()
    expect(from(' 2001:0DB8:ABCD:0012:0000:0000:0000:0002 ')).toBe(prefix)
    expect(from('2001:db8:abcd:13::1')).not.toBe(prefix)
    expect(from('203.0.113.9')).toBe('203.0.113.9')
    expect(from('::ffff:203.0.113.9')).toBe('203.0.113.9')
    expect(from('::FFFF:cb00:7109')).toBe('203.0.113.9')
    expect(from('::ffff:203.0.113.10')).toBe('203.0.113.10')
  })

  it('clientIp rejects absent and malformed addresses, never trusting forwarded headers', () => {
    const from = (value: string | undefined) =>
      clientIp({ header: (name) => (name === 'cf-connecting-ip' ? value : undefined) })
    for (const value of [
      undefined,
      '   ',
      'sub:victim-user-id',
      '1'.repeat(46),
      '999.1.2.3',
      '2001:db8:::1',
      '2001:db8::1, 2001:db8::2',
      '[2001:db8::1]',
    ]) {
      expect(from(value)).toBeNull()
    }
    expect(
      clientIp({ header: (name) => (name === 'x-forwarded-for' ? '203.0.113.9' : undefined) }),
    ).toBeNull()
  })
})
