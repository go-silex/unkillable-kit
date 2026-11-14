import { describe, expect, it } from 'vitest'
import { type BetterAuthLike, createBetterAuthSessionPort } from './better-auth-port'
import { sessionCookieName } from './cookie-name'
import { apiKeyPrefix, generateApiKey, hashApiKey, parseBearer, verifyApiKey } from './keys'
import { createRequireAuth, normalizeApiKeyOrganizationId, resolveDualAuth } from './require-auth'
import {
  clearSessionCookieHeader,
  parseCookie,
  parseSessionCookie,
  SESSION_COOKIE,
  sessionCookieHeader,
} from './session'
import { hashVerificationIdentifier } from './verification-identifier'

function baPort(
  user: { id: string; email?: string } | null,
  expMs = 60_000,
): ReturnType<typeof createBetterAuthSessionPort> {
  if (!user) {
    return createBetterAuthSessionPort({
      isAccountActive: async () => true,
      getAuth: () => ({ api: { getSession: async () => null } }),
    })
  }
  return createBetterAuthSessionPort({
    isAccountActive: async () => true,
    getAuth: () => ({
      api: {
        getSession: async () => ({
          user: { id: user.id, email: user.email ?? 'x@y.z' },
          session: { id: 'sess-1', expiresAt: new Date(Date.now() + expMs) },
        }),
      },
    }),
  })
}

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

describe('resolveDualAuth', () => {
  it('returns null without credentials', async () => {
    const r = await resolveDualAuth(null, null, {
      sessions: baPort(null),
      isAccountActive: async () => true,
      findApiKeyByPrefix: async () => null,
    })
    expect(r).toBeNull()
  })

  it('throws unauthorized for unknown bearer', async () => {
    const key = generateApiKey()
    await expect(
      resolveDualAuth(`Bearer ${key}`, null, {
        sessions: baPort(null),
        isAccountActive: async () => true,
        findApiKeyByPrefix: async () => null,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('CP-AUTH-DUAL: invalid Bearer fails closed even with valid session', async () => {
    await expect(
      resolveDualAuth('Bearer sk_deadbeef0001', 'kit_session=opaque', {
        sessions: baPort({ id: 'u1', email: 'a@b.c' }),
        isAccountActive: async () => true,
        findApiKeyByPrefix: async () => null,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('CP-AUTH-DUAL: valid BA session alone succeeds', async () => {
    const r = await resolveDualAuth(null, 'kit_session=x', {
      sessions: baPort({ id: 'u1', email: 'a@b.c' }),
      isAccountActive: async () => true,
      findApiKeyByPrefix: async () => null,
    })
    expect(r).toEqual({ subject: 'u1', method: 'session', sessionId: 'sess-1' })
  })

  it('accepts a live org-bound key (hash match, not revoked, not expired)', async () => {
    const key = generateApiKey()
    const keyHash = await hashApiKey(key)
    const r = await resolveDualAuth(`Bearer ${key}`, null, {
      sessions: baPort(null),
      isAccountActive: async () => true,
      findApiKeyByPrefix: async () => ({
        subject: 'u-live',
        keyHash,
        revokedAt: null,
        expiresAt: Date.now() + 60_000,
        organizationId: 'org_1',
      }),
    })
    expect(r).toMatchObject({ subject: 'u-live', method: 'api_key', organizationId: 'org_1' })
  })

  it('checks the verified key subject and fails closed when account state is disabled or unavailable', async () => {
    const key = generateApiKey()
    const keyHash = await hashApiKey(key)
    const subjects: string[] = []
    const ports = {
      sessions: baPort({ id: 'session-user' }),
      findApiKeyByPrefix: async () => ({
        subject: 'key-user',
        keyHash,
        revokedAt: null,
        expiresAt: null,
        organizationId: 'org_1',
      }),
      isAccountActive: async (subject: string) => {
        subjects.push(subject)
        return true
      },
    }
    expect(await resolveDualAuth(`Bearer ${key}`, null, ports)).toEqual({
      subject: 'key-user',
      method: 'api_key',
      organizationId: 'org_1',
    })
    expect(subjects).toEqual(['key-user'])
    for (const isAccountActive of [
      async () => false,
      async (): Promise<boolean> => {
        throw new Error('state unavailable')
      },
      undefined as unknown as (subject: string) => Promise<boolean>,
    ]) {
      await expect(
        resolveDualAuth(`Bearer ${key}`, 'kit_session=opaque', { ...ports, isAccountActive }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    }
  })

  it('rejects a revoked key even when hash matches', async () => {
    const key = generateApiKey()
    const keyHash = await hashApiKey(key)
    await expect(
      resolveDualAuth(`Bearer ${key}`, 'kit_session=opaque', {
        sessions: baPort({ id: 'u1', email: 'a@b.c' }),
        isAccountActive: async () => true,
        findApiKeyByPrefix: async () => ({
          subject: 'u-rev',
          keyHash,
          revokedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          organizationId: 'org_1',
        }),
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('rejects an expired key even when hash matches', async () => {
    const key = generateApiKey()
    const keyHash = await hashApiKey(key)
    await expect(
      resolveDualAuth(`Bearer ${key}`, 'kit_session=opaque', {
        sessions: baPort({ id: 'u1', email: 'a@b.c' }),
        isAccountActive: async () => true,
        findApiKeyByPrefix: async () => ({
          subject: 'u-exp',
          keyHash,
          revokedAt: null,
          expiresAt: Date.now() - 1_000,
          organizationId: 'org_1',
        }),
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
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

describe('SessionPort (Better Auth adapter)', () => {
  it('resolveSession maps getSession user to SessionPayload', async () => {
    const exp = new Date(Date.now() + 3600_000)
    const mockAuth: BetterAuthLike = {
      api: {
        getSession: async () => ({
          user: { id: 'ba-user-1', email: 'ba@kit.local' },
          session: { id: 'sess-1', expiresAt: exp },
        }),
      },
    }
    const port = createBetterAuthSessionPort({
      getAuth: () => mockAuth,
      isAccountActive: async () => true,
    })
    const payload = await port.resolveSession({
      cookieHeader: 'kit_session=opaque',
    })
    expect(payload).toMatchObject({ sub: 'ba-user-1', email: 'ba@kit.local', sessionId: 'sess-1' })
    expect(payload!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('checks each session subject and fails closed for disabled or unavailable account state', async () => {
    const subjects: string[] = []
    const getAuth = () => ({
      api: {
        getSession: async () => ({
          user: { id: 'session-user' },
          session: { id: 'sess-1', expiresAt: new Date(Date.now() + 60_000) },
        }),
      },
    })
    const port = createBetterAuthSessionPort({
      getAuth,
      isAccountActive: async (subject) => {
        subjects.push(subject)
        return true
      },
    })
    expect(await port.resolveSession({})).toMatchObject({ sub: 'session-user' })
    expect(await port.resolveSession({})).toMatchObject({ sub: 'session-user' })
    expect(subjects).toEqual(['session-user', 'session-user'])
    for (const isAccountActive of [
      async () => false,
      async (): Promise<boolean> => {
        throw new Error('state unavailable')
      },
      undefined as unknown as (subject: string) => Promise<boolean>,
    ]) {
      const denied = createBetterAuthSessionPort({ getAuth, isAccountActive })
      expect(await denied.resolveSession({})).toBeNull()
    }
  })

  it('resolveDualAuth works with BA port (cookie resolve only)', async () => {
    const mockAuth: BetterAuthLike = {
      api: {
        getSession: async () => ({
          user: { id: 'ba-2', email: 'x@y.z' },
          session: { id: 'sess-1', expiresAt: new Date(Date.now() + 60_000) },
        }),
      },
    }
    const port = createBetterAuthSessionPort({
      getAuth: () => mockAuth,
      isAccountActive: async () => true,
    })
    const r = await resolveDualAuth(null, 'kit_session=x', {
      sessions: port,
      isAccountActive: async () => true,
      findApiKeyByPrefix: async () => null,
    })
    expect(r).toEqual({ subject: 'ba-2', method: 'session', sessionId: 'sess-1' })
  })

  it('resolveSession returns null for missing session / missing expiresAt / expired / throw', async () => {
    const nullPort = createBetterAuthSessionPort({
      isAccountActive: async () => true,
      getAuth: () => ({ api: { getSession: async () => null } }),
    })
    expect(await nullPort.resolveSession({ cookieHeader: 'x=1' })).toBeNull()

    const noExp = createBetterAuthSessionPort({
      isAccountActive: async () => true,
      getAuth: () => ({
        api: {
          getSession: async () => ({
            user: { id: 'u', email: 'a@b.c' },
            session: { id: 'sess-1' },
          }),
        },
      }),
    })
    expect(await noExp.resolveSession({ cookieHeader: 'x=1' })).toBeNull()

    const noId = createBetterAuthSessionPort({
      isAccountActive: async () => true,
      getAuth: () => ({
        api: {
          getSession: async () => ({
            user: { id: 'u', email: 'a@b.c' },
            session: { id: '  ', expiresAt: new Date(Date.now() + 60_000) },
          }),
        },
      }),
    })
    expect(await noId.resolveSession({ cookieHeader: 'x=1' })).toBeNull()

    const expired = createBetterAuthSessionPort({
      isAccountActive: async () => true,
      getAuth: () => ({
        api: {
          getSession: async () => ({
            user: { id: 'u', email: 'a@b.c' },
            session: { id: 'sess-1', expiresAt: new Date(Date.now() - 60_000) },
          }),
        },
      }),
    })
    expect(await expired.resolveSession({ cookieHeader: 'x=1' })).toBeNull()

    const throws = createBetterAuthSessionPort({
      isAccountActive: async () => true,
      getAuth: () => ({
        api: {
          getSession: async () => {
            throw new Error('boom')
          },
        },
      }),
    })
    expect(await throws.resolveSession({ cookieHeader: 'x=1' })).toBeNull()
  })

  it('resolveSession forwards cookie headers into getSession', async () => {
    let seenCookie: string | null = null
    let seenQuery: { disableRefresh?: boolean; disableCookieCache?: boolean } | undefined
    const port = createBetterAuthSessionPort({
      isAccountActive: async () => true,
      getAuth: () => ({
        api: {
          getSession: async ({ headers, query }) => {
            seenCookie = headers.get('cookie')
            seenQuery = query
            return {
              user: { id: 'hdr', email: 'h@x.y' },
              session: { id: 'sess-1', expiresAt: new Date(Date.now() + 60_000) },
            }
          },
        },
      }),
    })
    await port.resolveSession({
      cookieHeader: 'kit_session=opaque-token',
    })
    expect(seenCookie).toBe('kit_session=opaque-token')
    expect(seenQuery).toEqual({ disableRefresh: true, disableCookieCache: true })
  })
})

describe('resolveDualAuth session cookie', () => {
  it('resolves BA session regardless of cookie name string', async () => {
    const port = baPort({ id: 'cust', email: 'c@d.e' })
    const r = await resolveDualAuth(null, 'my_sess=opaque', {
      sessions: port,
      isAccountActive: async () => true,
      findApiKeyByPrefix: async () => null,
    })
    expect(r).toMatchObject({ subject: 'cust', method: 'session' })
  })
})

describe('session cookie helpers', () => {
  it('sessionCookieHeader defaults Secure on and uses BA __Secure- wire name', () => {
    const h = sessionCookieHeader('tok', { maxAge: 60 })
    expect(h).toMatch(/^__Secure-kit_session=tok;/)
    expect(h).toMatch(/HttpOnly/)
    expect(h).toMatch(/Secure/)
    expect(h).toMatch(/SameSite=Lax/i)
    expect(h).toMatch(/Max-Age=60/)
  })
  it('sessionCookieHeader omits Secure and prefix only when opted out', () => {
    const h = sessionCookieHeader('tok', { secure: false })
    expect(h).toMatch(/^kit_session=tok;/)
    expect(h).not.toMatch(/__Secure-/)
    expect(h).not.toMatch(/Secure/)
  })
  it('sessionCookieHeader honors name and does not double-prefix', () => {
    expect(sessionCookieHeader('tok', { name: 'custom_sess' })).toMatch(
      /^__Secure-custom_sess=tok;/,
    )
    expect(sessionCookieHeader('tok', { name: '__Secure-custom_sess' })).toMatch(
      /^__Secure-custom_sess=tok;/,
    )
  })
  it('clearSessionCookieHeader zeroes Max-Age and defaults Secure wire name', () => {
    const h = clearSessionCookieHeader()
    expect(h).toMatch(/^__Secure-kit_session=;/)
    expect(h).toMatch(/Max-Age=0/)
    expect(h).toMatch(/HttpOnly/)
    expect(h).toMatch(/Secure/)
    const http = clearSessionCookieHeader({ secure: false })
    expect(http).toMatch(/^kit_session=;/)
    expect(http).not.toMatch(/Secure/)
  })
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

describe('createRequireAuth', () => {
  it('sets subject from BA session and calls next', async () => {
    const mw = createRequireAuth(() => ({
      sessions: baPort({ id: 'req-user', email: 'r@x.y' }),
      isAccountActive: async () => true,
      findApiKeyByPrefix: async () => null,
    }))
    const store: Record<string, string> = {}
    let nextCalled = false
    await mw(
      {
        req: {
          header: (n: string) => (n.toLowerCase() === 'cookie' ? 'kit_session=x' : undefined),
        },
        set: (k, v) => {
          store[k] = v
        },
      },
      async () => {
        nextCalled = true
      },
    )
    expect(nextCalled).toBe(true)
    expect(store.subject).toBe('req-user')
    expect(store.authMethod).toBe('session')
    expect(store.sessionId).toBe('sess-1')
  })

  it('throws unauthorized without credentials', async () => {
    const mw = createRequireAuth(() => ({
      sessions: baPort(null),
      isAccountActive: async () => true,
      findApiKeyByPrefix: async () => null,
    }))
    await expect(
      mw(
        {
          req: { header: () => undefined },
          set: () => {},
        },
        async () => {},
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('Bearer valid key wins and sets organizationId', async () => {
    const key = generateApiKey()
    const hash = await hashApiKey(key)
    const mw = createRequireAuth(() => ({
      sessions: baPort({ id: 'ignored' }),
      isAccountActive: async () => true,
      findApiKeyByPrefix: async () => ({
        subject: 'key-user',
        keyHash: hash,
        revokedAt: null,
        expiresAt: null,
        organizationId: 'org_x',
      }),
    }))
    const store: Record<string, string> = {}
    await mw(
      {
        req: {
          header: (n: string) =>
            n.toLowerCase() === 'authorization' ? `Bearer ${key}` : undefined,
        },
        set: (k, v) => {
          store[k] = v
        },
      },
      async () => {},
    )
    expect(store.subject).toBe('key-user')
    expect(store.authMethod).toBe('api_key')
    expect(store.keyOrganizationId).toBe('org_x')
    expect(store.sessionId).toBeUndefined()
  })

  it('D11: rejects null organizationId after verified credentials', async () => {
    const key = generateApiKey()
    const hash = await hashApiKey(key)
    await expect(
      resolveDualAuth(`Bearer ${key}`, null, {
        sessions: baPort(null),
        isAccountActive: async () => true,
        findApiKeyByPrefix: async () => ({
          subject: 'legacy',
          keyHash: hash,
          revokedAt: null,
          expiresAt: null,
          organizationId: null,
        }),
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('D11: rejects missing organizationId after verified credentials', async () => {
    const key = generateApiKey()
    const hash = await hashApiKey(key)
    await expect(
      resolveDualAuth(`Bearer ${key}`, null, {
        sessions: baPort(null),
        isAccountActive: async () => true,
        findApiKeyByPrefix: async () => ({
          subject: 'legacy',
          keyHash: hash,
          revokedAt: null,
          expiresAt: null,
        }),
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('D11: rejects empty or whitespace organizationId after verified credentials', async () => {
    const key = generateApiKey()
    const hash = await hashApiKey(key)
    for (const organizationId of ['', '   ', '\t']) {
      await expect(
        resolveDualAuth(`Bearer ${key}`, null, {
          sessions: baPort(null),
          isAccountActive: async () => true,
          findApiKeyByPrefix: async () => ({
            subject: 'legacy',
            keyHash: hash,
            revokedAt: null,
            expiresAt: null,
            organizationId,
          }),
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    }
  })

  it('D11: normalizeApiKeyOrganizationId rejects blank values', () => {
    expect(normalizeApiKeyOrganizationId(null)).toBeNull()
    expect(normalizeApiKeyOrganizationId(undefined)).toBeNull()
    expect(normalizeApiKeyOrganizationId('')).toBeNull()
    expect(normalizeApiKeyOrganizationId('  ')).toBeNull()
    expect(normalizeApiKeyOrganizationId(' org_x ')).toBe('org_x')
  })
})

describe('BA SessionPort cookie helpers', () => {
  it('clearCookieHeader honors cookie name override and defaults Secure', () => {
    const port = createBetterAuthSessionPort({
      isAccountActive: async () => true,
      cookieName: 'custom_sess',
      getAuth: () => ({ api: { getSession: async () => null } }),
    })
    const clear = port.clearCookieHeader()
    expect(clear).toMatch(/^__Secure-custom_sess=;/)
    expect(clear).toMatch(/Max-Age=0/)
    expect(clear).toMatch(/Secure/)
    expect(port.clearCookieHeader({ secure: false })).toMatch(/^custom_sess=;/)
  })
})
