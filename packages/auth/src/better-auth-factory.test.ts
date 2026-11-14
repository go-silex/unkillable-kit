import { AppError } from '@kit/core'
import type { EmailPort } from '@kit/email'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { MAGIC_LINK_EXPIRES_IN_SEC, RESET_PASSWORD_TOKEN_EXPIRES_IN_SEC } from './auth-email'
import { getBetterAuthSecret } from './better-auth-env'
import { createBetterAuth } from './better-auth-factory'
import { betterAuthDrizzleSchema } from './better-auth-schema'
import * as accountState from './repos/account-state'

const SECRET = 'test-better-auth-secret-xxxxxxxx32c!!'
const emailConfig = {
  productName: 'Acme',
  fallbackLocale: 'en' as const,
  resolveRecipientLocale: () => undefined,
}

type BaAuth = ReturnType<typeof createBetterAuth> & {
  options: {
    emailAndPassword?: {
      disableSignUp?: boolean
      resetPasswordTokenExpiresIn?: number
      sendResetPassword?: (i: { user: { email: string }; url: string }) => Promise<void>
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
      url: 'http://localhost:8787/api/auth/reset-password/tok',
    } as never)
    const magic = auth.options.plugins?.find((p: { id: string }) => p.id === 'magic-link') as {
      options?: { sendMagicLink?: (i: { email: string; url: string }) => Promise<void> }
    }
    await magic?.options?.sendMagicLink?.({
      email: 'a@b.c',
      url: 'http://localhost:8787/api/auth/magic-link/verify?token=x',
    })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('requires the email port and configuration together at runtime', () => {
    expect(() => factory({ emailConfig: undefined })).toThrow(/emailConfig is required/)
    expect(() => factory({ emailPort: undefined })).toThrow(/emailPort is required/)
  })

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
      url: 'http://localhost:8787/api/auth/reset-password/tok',
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
