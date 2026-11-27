import { AppError } from '@kit/core'
import type { EmailPort } from '@kit/email'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { MAGIC_LINK_EXPIRES_IN_SEC, RESET_PASSWORD_TOKEN_EXPIRES_IN_SEC } from './auth-email'
import { getBetterAuthSecret } from './better-auth-env'
import { createBetterAuth } from './better-auth-factory'
import { betterAuthDrizzleSchema } from './better-auth-schema'
import type { OidcProviderConfig } from './oidc/oidc-config'
import * as accountState from './repos/account-state'
import { requestSessionCookie } from './request/effective-session-cookie'

const SECRET = 'test-better-auth-secret-xxxxxxxx32c!!'
const emailConfig = {
  productName: 'Acme',
  fallbackLocale: 'en' as const,
  resolveRecipientLocale: () => undefined,
}

type BaAuth = ReturnType<typeof createBetterAuth> & {
  options: {
    secret?: string
    baseURL?: string
    emailAndPassword?: {
      disableSignUp?: boolean
      resetPasswordTokenExpiresIn?: number
      sendResetPassword?: (i: {
        user: { email: string }
        url: string
        token: string
      }) => Promise<void>
    }
    advanced?: {
      useSecureCookies?: boolean
      cookies?: { session_token?: unknown }
    }
    plugins?: { id: string; options?: Record<string, unknown> }[]
    rateLimit?: { enabled?: boolean }
    databaseHooks: {
      session: {
        create: {
          before: (session: { userId: string }) => Promise<void>
          after: (session: { userId: string }) => Promise<void>
        }
      }
    }
  }
}

function stubD1() {
  const stmt = {
    bind: (..._values: unknown[]) => stmt,
    first: async () => null,
    run: async () => ({}),
    all: async () => ({}),
    raw: async <T = unknown>(): Promise<T[][]> => [],
  }
  return { prepare: (_query: string) => stmt }
}

function factory(overrides: Partial<Parameters<typeof createBetterAuth>[0]> = {}): BaAuth {
  return createBetterAuth({
    database: stubD1(),
    secret: SECRET,
    baseURL: 'http://localhost:8787',
    trustedOrigins: ['http://localhost:5173'],
    allowLoopbackOrigins: true,
    emailConfig,
    emailPort: { send: vi.fn(async () => ({ ok: true, transport: 'log' })) },
    schema: betterAuthDrizzleSchema,
    ...overrides,
  } as Parameters<typeof createBetterAuth>[0]) as BaAuth
}

describe('createBetterAuth', () => {
  it('queries account state through the custom schema on the supplied D1 binding', async () => {
    const queries: string[] = []
    const values: unknown[][] = []
    const statement = {
      bind: (...params: unknown[]) => {
        values.push(params)
        return statement
      },
      first: async () => null,
      run: async () => ({}),
      all: async () => ({}),
      raw: async <T = unknown>(): Promise<T[][]> => [[0 as T]],
    }
    const database = {
      prepare: (query: string) => {
        queries.push(query)
        return statement
      },
    }
    const user = sqliteTable('custom_user', {
      id: text('id').primaryKey(),
      disabled: integer('disabled', { mode: 'boolean' }).notNull(),
    }) as unknown as typeof betterAuthDrizzleSchema.user
    const auth = factory({ database, schema: { ...betterAuthDrizzleSchema, user } })
    await expect(
      auth.options.databaseHooks.session.create.before({ userId: 'user-custom' }),
    ).resolves.toBeUndefined()
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('"custom_user"')
    expect(values[0]).toContain('user-custom')
  })

  it('checks each session against the bound database and exact custom user table', async () => {
    const database = stubD1()
    const user = sqliteTable('custom_user', {
      id: text('id').primaryKey(),
    }) as unknown as typeof betterAuthDrizzleSchema.user
    const lookup = vi.spyOn(accountState, 'isAccountActive').mockResolvedValue(true)
    try {
      const onFirstSession = vi.fn(async () => {})
      const auth = factory({
        database,
        schema: { ...betterAuthDrizzleSchema, user },
        onFirstSession,
      })
      const hook = auth.options.databaseHooks.session.create
      await expect(hook.before({ userId: 'user-1' })).resolves.toBeUndefined()
      expect(lookup).toHaveBeenCalledWith(
        expect.objectContaining({ $client: database }),
        'user-1',
        user,
      )
      await hook.after({ userId: 'user-1' })
      expect(onFirstSession).toHaveBeenCalledWith({ userId: 'user-1' })
    } finally {
      lookup.mockRestore()
    }
  })

  it.each(['disabled or missing', 'database failure'])(
    'rejects session creation generically when account state is %s',
    async (reason) => {
      const lookup = vi.spyOn(accountState, 'isAccountActive')
      if (reason === 'database failure')
        lookup.mockRejectedValue(new Error('private database detail'))
      else lookup.mockResolvedValue(false)
      try {
        const before = factory().options.databaseHooks.session.create.before
        await expect(before({ userId: 'user-1' })).rejects.toMatchObject({
          status: 'UNAUTHORIZED',
          body: { message: 'Invalid email or password' },
        })
      } finally {
        lookup.mockRestore()
      }
    },
  )

  it('fail-closed defaults: signup off, secure cookies, kit TTLs, org+magic plugins', () => {
    const send = vi.fn(async () => ({ ok: true, transport: 'log' }))
    const auth = factory({ emailPort: { send } })
    expect(auth.options.emailAndPassword?.disableSignUp).toBe(true)
    expect(auth.options.emailAndPassword?.resetPasswordTokenExpiresIn).toBe(
      RESET_PASSWORD_TOKEN_EXPIRES_IN_SEC,
    )
    expect(auth.options.advanced?.useSecureCookies).toBe(true)
    expect(auth.options.advanced?.cookies?.session_token).toEqual({
      name: 'kit_session',
      attributes: { httpOnly: true, sameSite: 'lax', path: '/', secure: true },
    })
    const ids = auth.options.plugins?.map((p: { id: string }) => p.id)
    expect(ids).toEqual(['organization', 'magic-link'])
    const magic = auth.options.plugins?.find((p: { id: string }) => p.id === 'magic-link') as {
      options?: { expiresIn?: number; disableSignUp?: boolean }
    }
    expect(magic?.options?.expiresIn).toBe(MAGIC_LINK_EXPIRES_IN_SEC)
    expect(magic?.options?.disableSignUp).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  it('omits magic-link and reset send when emailPort is absent', () => {
    const auth = factory({ emailPort: undefined, emailConfig: undefined })
    expect(auth.options.plugins?.map((p: { id: string }) => p.id)).toEqual(['organization'])
    expect(auth.options.emailAndPassword?.sendResetPassword).toBeUndefined()
  })

  it('allowPublicSignup true enables password + magic-link sign-up', () => {
    const auth = factory({ allowPublicSignup: true })
    expect(auth.options.emailAndPassword?.disableSignUp).toBe(false)
    const magic = auth.options.plugins?.find((p: { id: string }) => p.id === 'magic-link') as {
      options?: { disableSignUp?: boolean }
    }
    expect(magic?.options?.disableSignUp).toBe(false)
  })

  it('rejects short and kit-placeholder secrets', () => {
    expect(() => factory({ secret: 'short' })).toThrow(AppError)
    expect(() => factory({ secret: 'dev-better-auth-secret-change-me-32c!!' })).toThrow(AppError)
  })

  it('accepts kit placeholder only when allowKitPlaceholderSecret is set', () => {
    const secret = getBetterAuthSecret({ ENVIRONMENT: 'development' })
    expect(() => factory({ secret })).toThrow(AppError)
    const auth = factory({ secret, allowKitPlaceholderSecret: true })
    expect(typeof auth.handler).toBe('function')
  })

  it('rejects wildcard / glob / null / empty trustedOrigins even if corsAllowlist is skipped', () => {
    expect(() => factory({ trustedOrigins: ['*'] })).toThrow(/glob|\*/)
    expect(() => factory({ trustedOrigins: ['https://*'] })).toThrow(/glob/)
    expect(() => factory({ trustedOrigins: ['https://*.example.com'] })).toThrow(/glob/)
    expect(() => factory({ trustedOrigins: ['https://app.example.com', 'null'] })).toThrow(/null/)
    expect(() => factory({ trustedOrigins: [] })).toThrow(/never empty/)
    expect(() => factory({ trustedOrigins: ['  ', ''] })).toThrow(/never empty/)
  })

  it('rejects loopback trustedOrigins unless allowLoopbackOrigins is set', () => {
    expect(() =>
      factory({
        trustedOrigins: ['http://localhost:5173'],
        allowLoopbackOrigins: false,
      }),
    ).toThrow(/loopback/)
    expect(() =>
      createBetterAuth({
        database: stubD1(),
        secret: SECRET,
        baseURL: 'https://api.example.com',
        trustedOrigins: ['http://127.0.0.1:5173'],
        emailConfig,
        emailPort: { send: vi.fn(async () => ({ ok: true, transport: 'log' })) },
        schema: betterAuthDrizzleSchema,
      }),
    ).toThrow(/loopback/)
    expect(() =>
      factory({
        trustedOrigins: ['https://app.example.com', 'http://localhost:5173'],
        allowLoopbackOrigins: false,
      }),
    ).toThrow(/loopback/)
    expect(() =>
      factory({
        trustedOrigins: ['http://127.0.0.2:5173'],
        allowLoopbackOrigins: false,
      }),
    ).toThrow(/loopback/)
    const auth = factory({
      trustedOrigins: ['https://app.example.com'],
      allowLoopbackOrigins: false,
    })
    expect(typeof auth.handler).toBe('function')
  })

  it('invokes emailPort.send from reset + magic handlers', async () => {
    const send = vi.fn(async () => ({ ok: true, transport: 'log' }))
    const auth = factory({ emailPort: { send } })
    await auth.options.emailAndPassword?.sendResetPassword?.({
      user: { email: 'a@b.c' },
      url: 'http://localhost:8787/api/auth/reset-password/tok?callbackURL=http%3A%2F%2Flocalhost%3A8787%2Freset-password',
      token: 'tok',
    })
    const magic = auth.options.plugins?.find((p: { id: string }) => p.id === 'magic-link') as {
      options?: { sendMagicLink?: (i: { email: string; url: string }) => Promise<void> }
    }
    await magic?.options?.sendMagicLink?.({
      email: 'a@b.c',
      url: 'http://localhost:8787/api/auth/magic-link/verify?token=x',
    })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('emails the redirect page with the token in its query, preserving other parameters', async () => {
    const send = vi.fn(async (_message: Parameters<EmailPort['send']>[0]) => ({
      ok: true,
      transport: 'log',
    }))
    const auth = factory({ emailPort: { send } })
    const redirectTo = 'http://localhost:8787/reset-password?next=%2Fhome&token=old#section'
    await auth.options.emailAndPassword?.sendResetPassword?.({
      user: { email: 'a@b.c' },
      url: `http://localhost:8787/api/auth/reset-password/secret?callbackURL=${encodeURIComponent(redirectTo)}`,
      token: 'secret',
    })
    const message = send.mock.calls[0]?.[0]
    expect(message?.text).toContain(
      'http://localhost:8787/reset-password?next=%2Fhome&token=secret#section',
    )
    expect(message?.text).not.toContain('/reset-password/secret')
  })

  it('silently skips reset email when redirectTo is missing', async () => {
    const send = vi.fn(async () => ({ ok: true, transport: 'log' }))
    const auth = factory({ emailPort: { send } })
    await expect(
      auth.options.emailAndPassword?.sendResetPassword?.({
        user: { email: 'a@b.c' },
        url: 'http://localhost:8787/api/auth/reset-password/secret?callbackURL=',
        token: 'secret',
      }),
    ).resolves.toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })

  it('does not email an untrusted redirect target', async () => {
    const send = vi.fn(async () => ({ ok: true, transport: 'log' }))
    const auth = factory({ emailPort: { send } })
    await expect(
      auth.options.emailAndPassword?.sendResetPassword?.({
        user: { email: 'a@b.c' },
        url: 'http://localhost:8787/api/auth/reset-password/secret?callbackURL=https%3A%2F%2Fevil.test%2Freset',
        token: 'secret',
      }),
    ).rejects.toThrow(/EMAIL_TOKEN_HREF_INVALID/)
    expect(send).not.toHaveBeenCalled()
  })

  it('requires the email port and configuration together at runtime', () => {
    expect(() => factory({ emailConfig: undefined })).toThrow(/emailConfig is required/)
    expect(() => factory({ emailPort: undefined })).toThrow(/emailPort is required/)
  })

  it.each([null, false, 'template'])(
    'rejects a non-function email renderer (%s) at startup',
    (render) => {
      expect(() => factory({ emailConfig: { ...emailConfig, render: render as never } })).toThrow(
        'emailConfig.render must be a function when configured',
      )
    },
  )

  it('requires the email port and configuration together in the options type', () => {
    const base = {
      database: stubD1(),
      secret: SECRET,
      baseURL: 'https://api.example.com',
      trustedOrigins: [],
    }
    const emailPort = { send: vi.fn(async () => ({ ok: true, transport: 'log' })) }
    type Options = Parameters<typeof createBetterAuth>[0]
    type Base = typeof base
    type Port = typeof emailPort
    type Config = typeof emailConfig
    expectTypeOf<Base extends Options ? true : false>().toEqualTypeOf<true>()
    expectTypeOf<
      Base & { emailPort: Port; emailConfig: Config } extends Options ? true : false
    >().toEqualTypeOf<true>()
    expectTypeOf<Base & { emailPort: Port } extends Options ? true : false>().toEqualTypeOf<false>()
    expectTypeOf<
      Base & { emailConfig: Config } extends Options ? true : false
    >().toEqualTypeOf<false>()
  })

  it('uses the recipient locale resolver in both handlers', async () => {
    const send = vi.fn(async (_message: Parameters<EmailPort['send']>[0]) => ({
      ok: true,
      transport: 'log',
    }))
    const resolveRecipientLocale = vi.fn((email: string) =>
      email === 'fr@example.com' ? ('fr' as const) : undefined,
    )
    const auth = factory({
      emailPort: { send },
      emailConfig: { productName: 'Acme', fallbackLocale: 'en', resolveRecipientLocale },
    })
    await auth.options.emailAndPassword?.sendResetPassword?.({
      user: { email: 'fr@example.com' },
      url: 'http://localhost:8787/api/auth/reset-password/tok?callbackURL=http%3A%2F%2Flocalhost%3A8787%2Freset-password',
      token: 'tok',
    })
    const magic = auth.options.plugins?.find((p: { id: string }) => p.id === 'magic-link') as {
      options?: { sendMagicLink?: (i: { email: string; url: string }) => Promise<void> }
    }
    await magic?.options?.sendMagicLink?.({
      email: 'en@example.com',
      url: 'http://localhost:8787/api/auth/magic-link/verify?token=x',
    })
    expect(resolveRecipientLocale.mock.calls).toEqual([['fr@example.com'], ['en@example.com']])
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      to: 'fr@example.com',
      subject: expect.stringContaining('Acme'),
    })
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      to: 'en@example.com',
      subject: expect.stringMatching(/sign in/i),
    })
  })

  it('passes the configured lifetimes and validated links to the renderer in both handlers', async () => {
    const message = { subject: 'Custom subject', text: 'Custom text', html: '<p>Custom HTML</p>' }
    const render = vi.fn(async () => message)
    const send = vi.fn(async () => ({ ok: true, transport: 'log' }))
    const auth = factory({
      emailPort: { send },
      emailConfig: {
        ...emailConfig,
        resolveRecipientLocale: async (email) => (email === 'fr@example.com' ? 'fr' : 'de'),
        render,
      },
      magicLinkExpiresIn: 120,
      resetPasswordTokenExpiresIn: 900,
    })
    await auth.options.emailAndPassword?.sendResetPassword?.({
      user: { email: 'fr@example.com' },
      url: 'http://localhost:8787/api/auth/reset-password/tok?callbackURL=http%3A%2F%2Flocalhost%3A5173%2Freset-password',
      token: 'tok',
    })
    const magic = auth.options.plugins?.find((plugin) => plugin.id === 'magic-link') as {
      options?: { sendMagicLink?: (input: { email: string; url: string }) => Promise<void> }
    }
    const magicUrl = 'http://localhost:8787/api/auth/magic-link/verify?token=x'
    await magic?.options?.sendMagicLink?.({ email: 'en@example.com', url: magicUrl })

    expect(render.mock.calls).toEqual([
      [
        {
          kind: 'reset-password',
          to: 'fr@example.com',
          url: 'http://localhost:5173/reset-password?token=tok',
          locale: 'fr',
          productName: 'Acme',
          expiresInSec: 900,
        },
      ],
      [
        {
          kind: 'magic-link',
          to: 'en@example.com',
          url: magicUrl,
          locale: 'en',
          productName: 'Acme',
          expiresInSec: 120,
        },
      ],
    ])
    expect(send.mock.calls).toEqual([
      [{ to: 'fr@example.com', ...message }],
      [{ to: 'en@example.com', ...message }],
    ])
  })

  it('uses default token lifetimes for zero overrides in both renderer calls', async () => {
    const render = vi.fn(() => ({ subject: 'Subject', text: 'Text', html: '' }))
    const auth = factory({
      emailConfig: { ...emailConfig, render },
      magicLinkExpiresIn: 0,
      resetPasswordTokenExpiresIn: 0,
    })
    await auth.options.emailAndPassword?.sendResetPassword?.({
      user: { email: 'recipient@example.com' },
      url: 'http://localhost:8787/api/auth/reset-password/tok?callbackURL=http%3A%2F%2Flocalhost%3A5173%2Freset-password',
      token: 'tok',
    })
    const magic = auth.options.plugins?.find((plugin) => plugin.id === 'magic-link') as {
      options?: {
        expiresIn?: number
        sendMagicLink?: (input: { email: string; url: string }) => Promise<void>
      }
    }
    await magic?.options?.sendMagicLink?.({
      email: 'recipient@example.com',
      url: 'http://localhost:8787/api/auth/magic-link/verify?token=x',
    })

    expect(render.mock.calls).toEqual([
      [expect.objectContaining({ kind: 'reset-password', expiresInSec: 3600 })],
      [expect.objectContaining({ kind: 'magic-link', expiresInSec: 300 })],
    ])
    expect(auth.options.emailAndPassword?.resetPasswordTokenExpiresIn).toBe(3600)
    expect(magic.options?.expiresIn).toBe(300)
  })

  it('does not allowlist a request-derived baseURL host', async () => {
    const send = vi.fn(async () => ({ ok: true, transport: 'log' }))
    const auth = factory({
      baseURL: 'https://evil.test',
      trustedOrigins: ['https://app.example.com'],
      allowLoopbackOrigins: false,
      requestDerivedBaseURL: true,
      emailPort: { send },
    })
    const magic = auth.options.plugins?.find((p: { id: string }) => p.id === 'magic-link') as {
      options?: { sendMagicLink?: (i: { email: string; url: string }) => Promise<void> }
    }
    await expect(
      magic?.options?.sendMagicLink?.({
        email: 'a@b.c',
        url: 'https://evil.test/api/auth/magic-link/verify?token=SECRET',
      }),
    ).rejects.toThrow(/EMAIL_TOKEN_HREF_INVALID/)
    await magic?.options?.sendMagicLink?.({
      email: 'a@b.c',
      url: 'https://app.example.com/api/auth/magic-link/verify?token=ok',
    })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('pins Better Auth limiter off: the kit D1 throttle is the only one', () => {
    // Unset, Better Auth enables a per-isolate memory limiter when NODE_ENV is 'production'.
    expect(factory().options.rateLimit?.enabled).toBe(false)
  })

  it('refuses a baseURL path other than / or the kit mount, which the throttle would not match', async () => {
    for (const baseURL of ['http://localhost:8787/auth', 'http://localhost:8787/api/auth/v2']) {
      expect(() => factory({ baseURL }), baseURL).toThrow('BETTER_AUTH_URL path')
    }
    for (const baseURL of ['http://localhost:8787/', 'http://localhost:8787/api/auth/']) {
      const res = await factory({ baseURL }).handler(
        new Request('http://localhost:8787/api/auth/ok'),
      )
      expect(res.status, baseURL).toBe(200)
    }
  })
})

describe('createBetterAuth construction', () => {
  // The provider composition runs inside the Better Auth build: it counts constructions.
  function counted() {
    const compose = vi.fn<OidcProviderConfig['compose']>(() => ({ plugins: [] }))
    return { compose, oidcProvider: { waitUntil: vi.fn(), compose } }
  }

  it('reads the session cookie issuer without building Better Auth, then builds it once', () => {
    const { compose, oidcProvider } = counted()
    const auth = factory({ oidcProvider, cookieName: 'kit_session', useSecureCookies: true })
    expect(requestSessionCookie(auth, 'kit=1')).toEqual({
      header: 'kit=1',
      name: '__Secure-kit_session',
      secret: SECRET,
    })
    expect(compose).not.toHaveBeenCalled()
    expect(auth.api.getSession).toBe(auth.api.getSession)
    expect(auth.options.plugins?.map((p) => p.id)).toContain('organization')
    expect(compose).toHaveBeenCalledTimes(1)
  })

  it('builds each handle from its own options and database, in any order', () => {
    const first = counted()
    const second = counted()
    const [databaseA, databaseB] = [stubD1(), stubD1()]
    const a = factory({ database: databaseA, oidcProvider: first.oidcProvider, cookieName: 'a' })
    const b = factory({
      database: databaseB,
      oidcProvider: second.oidcProvider,
      cookieName: 'b',
      secret: `${SECRET}b`,
      useSecureCookies: false,
    })
    expect(b.options.advanced?.cookies?.session_token).toMatchObject({ name: 'b' })
    expect(a.options.advanced?.cookies?.session_token).toMatchObject({ name: 'a' })
    expect(first.compose).toHaveBeenCalledWith(expect.any(Function), databaseA)
    expect(second.compose).toHaveBeenCalledWith(expect.any(Function), databaseB)
    expect(a.api).not.toBe(b.api)
    expect(requestSessionCookie(a, null)).toMatchObject({ name: '__Secure-a', secret: SECRET })
    expect(requestSessionCookie(b, null)).toMatchObject({ name: 'b', secret: `${SECRET}b` })
  })

  it('builds each handle from its options as they were at its call', () => {
    const first = counted()
    const second = counted()
    const [databaseA, databaseB] = [stubD1(), stubD1()]
    const options = {
      database: databaseA,
      secret: SECRET,
      baseURL: 'http://localhost:8787',
      trustedOrigins: ['http://localhost:5173'],
      allowLoopbackOrigins: true,
      oidcProvider: first.oidcProvider,
    }
    const a = createBetterAuth(options) as BaAuth
    Object.assign(options, {
      database: databaseB,
      secret: `${SECRET}b`,
      baseURL: 'http://localhost:8788',
      oidcProvider: second.oidcProvider,
    })
    first.oidcProvider.compose = second.compose
    const b = createBetterAuth(options) as BaAuth
    expect([a.options.secret, a.options.baseURL]).toEqual([SECRET, 'http://localhost:8787'])
    expect([b.options.secret, b.options.baseURL]).toEqual([`${SECRET}b`, 'http://localhost:8788'])
    expect(first.compose).toHaveBeenCalledExactlyOnceWith(expect.any(Function), databaseA)
    expect(second.compose).toHaveBeenCalledExactlyOnceWith(expect.any(Function), databaseB)
    expect(requestSessionCookie(a, null).secret).toBe(SECRET)
  })

  it('rejects configuration when called, before any use', () => {
    const { compose, oidcProvider } = counted()
    expect(() => factory({ oidcProvider, baseURL: 'not a url' })).toThrow('BETTER_AUTH_URL')
    expect(() =>
      factory({ oidcProvider, google: { clientId: '', clientSecret: '', allowedDomains: [] } }),
    ).toThrow('Invalid Google sign-in configuration')
    expect(() => factory({ oidcProvider, googleErrorURL: 'https://evil.test/login' })).toThrow(
      'googleErrorURL',
    )
    expect(compose).not.toHaveBeenCalled()
  })
})
