import { describe, expect, it } from 'vitest'
import { sessionCookieName } from './cookie-name'
import { apiKeyPrefix, generateApiKey, hashApiKey, parseBearer, verifyApiKey } from './keys'
import { normalizeApiKeyOrganizationId, parseApiKeyScopes } from './require-auth'
import { parseCookie, parseSessionCookie, SESSION_COOKIE } from './session'
import { hashVerificationIdentifier } from './verification-identifier'

describe('verification identifier hashing', () => {
  it('encodes the SHA-256 digest as unpadded base64url', async () => {
    expect(await hashVerificationIdentifier('x')).toBe(
      'LXEWQrcmsEQBYnyp-6wy9chTD7GQPMTbAiWHF5IaSIE',
    )
  })
})

describe('api keys', () => {
  it('hashes and verifies with timing-safe compare', async () => {
    const key = generateApiKey()
    expect(key.startsWith('sk_')).toBe(true)
    const h = await hashApiKey(key)
    expect(h).toHaveLength(64)
    expect(await verifyApiKey(key, h)).toBe(true)
    expect(await verifyApiKey('sk_wrong', h)).toBe(false)
  })

  it('apiKeyPrefix is stable 12-char prefix', () => {
    const key = generateApiKey()
    expect(apiKeyPrefix(key)).toBe(key.slice(0, 12))
    expect(apiKeyPrefix(key)).toHaveLength(12)
    expect(() => apiKeyPrefix('short')).toThrow(/invalid/)
  })

  it('parses Bearer header', () => {
    expect(parseBearer('Bearer sk_abc')).toBe('sk_abc')
    expect(parseBearer(null)).toBeNull()
    expect(parseBearer('Basic x')).toBeNull()
  })
})

describe('API key scope authorization', () => {
  it('fails closed for malformed and unknown stored scopes', () => {
    expect(parseApiKeyScopes('read,write,admin')).toEqual(['read', 'write', 'admin'])
    expect(parseApiKeyScopes('read,unknown')).toEqual([])
    expect(parseApiKeyScopes('')).toEqual([])
    expect(parseApiKeyScopes('read, write')).toEqual([])
  })
})

describe('sessionCookieName SSoT', () => {
  it('defaults to kit_session', () => {
    expect(sessionCookieName()).toBe(SESSION_COOKIE)
    expect(sessionCookieName({ name: '  ' })).toBe(SESSION_COOKIE)
  })
  it('accepts override', () => {
    expect(sessionCookieName({ name: 'ba_session' })).toBe('ba_session')
  })
})

describe('session cookie helpers', () => {
  it('parseCookie extracts name', () => {
    expect(parseCookie('a=1; kit_session=abc; b=2', SESSION_COOKIE)).toBe('abc')
    expect(parseCookie(null, SESSION_COOKIE)).toBeNull()
  })
  it('parseSessionCookie sees BA __Secure- prefix', () => {
    expect(parseSessionCookie('__Secure-kit_session=tok', SESSION_COOKIE)).toBe('tok')
    expect(parseSessionCookie('kit_session=tok', SESSION_COOKIE)).toBe('tok')
    expect(parseSessionCookie('a=1', SESSION_COOKIE)).toBeNull()
  })
})

it('normalizes organization ids and rejects absent or blank values', () => {
  expect(normalizeApiKeyOrganizationId(null)).toBeNull()
  expect(normalizeApiKeyOrganizationId(undefined)).toBeNull()
  expect(normalizeApiKeyOrganizationId('')).toBeNull()
  expect(normalizeApiKeyOrganizationId('  ')).toBeNull()
  expect(normalizeApiKeyOrganizationId(' org_x ')).toBe('org_x')
})
