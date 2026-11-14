import { describe, expect, it } from 'vitest'
import { isLoopbackHostname } from './loopback-host'

describe('isLoopbackHostname', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]'])('accepts %s', (host) => {
    expect(isLoopbackHostname(host)).toBe(true)
  })

  it.each([
    'localhost.',
    'web.localhost',
    '127.0.0.2',
    '0.0.0.0',
    '::',
    '[::]',
    '::ffff:127.0.0.1',
    'localhost.evil.test',
  ])('rejects %s', (host) => {
    expect(isLoopbackHostname(host)).toBe(false)
  })
})
