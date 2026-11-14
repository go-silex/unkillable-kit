import type * as BetterAuth from 'better-auth'
import type * as BetterAuthApi from 'better-auth/api'
import { drizzle } from 'drizzle-orm/d1'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { describe, expect, it, vi } from 'vitest'
import { createBetterAuth } from '../better-auth-factory'
import { betterAuthDrizzleSchema } from '../better-auth-schema'
import { createSessionAccountGuard, InactiveSessionError } from './better-auth-session-guard'

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }))

vi.mock('better-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof BetterAuth>()),
  betterAuth: () => ({ api: { getSession }, handler: vi.fn(), fetch: vi.fn() }),
}))

vi.mock('better-auth/api', async (importOriginal) => ({
  ...(await importOriginal<typeof BetterAuthApi>()),
  createAuthMiddleware: (callback: unknown) => callback,
}))

const user = sqliteTable('guard_custom_user', {
  id: text('id').primaryKey(),
  disabled: integer('disabled', { mode: 'boolean' }).notNull(),
}) as unknown as typeof betterAuthDrizzleSchema.user
const session = sqliteTable('guard_custom_session', {
  token: text('token').notNull(),
  userId: text('user_id').notNull(),
}) as unknown as typeof betterAuthDrizzleSchema.session
const schema = { ...betterAuthDrizzleSchema, user, session }

type Scenario = {
  token?: string
  sessionRows?: unknown[][]
  userRows?: unknown[][]
  sessionError?: Error
  userError?: Error
}
function queryRows(sql: string, scenario: Scenario) {
  if (sql.includes('"guard_custom_session"')) {
    if (scenario.sessionError) throw scenario.sessionError
    return scenario.sessionRows ?? []
  }
  if (sql.includes('"guard_custom_user"')) {
    if (scenario.userError) throw scenario.userError
    return scenario.userRows ?? []
  }
  throw new Error(`Unexpected query: ${sql}`)
}

function setup(scenario: Scenario = {}) {
  const queries: { sql: string; params: unknown[] }[] = []
  const database = {
    prepare(sql: string) {
      const query = { sql, params: [] as unknown[] }
      queries.push(query)
      const statement = {
        bind(...params: unknown[]) {
          query.params = params
          return statement
        },
        async raw() {
          return queryRows(sql, scenario)
        },
      }
      return statement
    },
  }
  const getSignedCookie = vi.fn(async () => scenario.token)
  const guard = createSessionAccountGuard(drizzle(database as never), schema) as unknown as (
    context: unknown,
  ) => Promise<void>
  const signingKey = crypto.randomUUID()
  const run = () =>
    guard({
      getSignedCookie,
      context: { authCookies: { sessionToken: { name: 'custom.session' } }, secret: signingKey },
    })
  return { run, queries, getSignedCookie, signingKey }
}

describe('Better Auth session dispatch account guard', () => {
  it('does not query the database when no signed session cookie exists', async () => {
    const { run, queries, getSignedCookie, signingKey } = setup()
    await expect(run()).resolves.toBeUndefined()
    expect(getSignedCookie).toHaveBeenCalledWith('custom.session', signingKey)
    expect(queries).toHaveLength(0)
  })

  it('lets Better Auth handle an unknown session without reading account state', async () => {
    const value = crypto.randomUUID()
    const { run, queries } = setup({ token: value })
    await expect(run()).resolves.toBeUndefined()
    expect(queries).toHaveLength(1)
    expect(queries[0]?.sql).toContain('"guard_custom_session"')
    expect(queries[0]?.params).toContain(value)
  })

  it('checks the session owner in the supplied custom user and session tables', async () => {
    const value = crypto.randomUUID()
    const { run, queries } = setup({ token: value, sessionRows: [['user-123']], userRows: [[0]] })
    await expect(run()).resolves.toBeUndefined()
    expect(queries).toHaveLength(2)
    expect(queries[0]?.sql).toContain('"guard_custom_session"')
    expect(queries[0]?.params).toContain(value)
    expect(queries[1]?.sql).toContain('"guard_custom_user"')
    expect(queries[1]?.params).toContain('user-123')
  })

  it.each([
    ['disabled', [[1]]],
    ['missing', []],
  ])('denies a %s session owner', async (_state, userRows) => {
    const { run } = setup({ token: crypto.randomUUID(), sessionRows: [['user-123']], userRows })
    await expect(run()).rejects.toMatchObject({
      status: 'UNAUTHORIZED',
      body: { message: 'Unauthorized' },
    })
    await expect(run()).rejects.toBeInstanceOf(InactiveSessionError)
  })

  it('denies when account state cannot be read without leaking the database error', async () => {
    const { run } = setup({
      token: crypto.randomUUID(),
      sessionRows: [['user-123']],
      userError: new Error('private account database detail'),
    })
    await expect(run()).rejects.toMatchObject({
      status: 'UNAUTHORIZED',
      body: { message: 'Unauthorized' },
    })
    await expect(run()).rejects.toBeInstanceOf(InactiveSessionError)
  })

  it('propagates an unrelated session lookup failure rather than treating it as inactive', async () => {
    const failure = new Error('session database unavailable')
    const { run, queries } = setup({ token: crypto.randomUUID(), sessionError: failure })
    const error = await run().catch((caught: unknown) => caught)
    expect(error).not.toBeInstanceOf(InactiveSessionError)
    expect(error).toMatchObject({ cause: failure })
    expect(queries).toHaveLength(1)
  })
})

describe('Better Auth session API proxy', () => {
  function sessionApi() {
    const statement = {
      bind: () => statement,
      first: async () => null,
      run: async () => ({}),
      all: async () => ({}),
      raw: async () => [],
    }
    const auth = createBetterAuth({
      database: { prepare: () => statement },
      secret: crypto.randomUUID() + crypto.randomUUID(),
      baseURL: 'https://example.com',
      trustedOrigins: ['https://example.com'],
    })
    return auth.api.getSession as unknown as (options: Record<string, unknown>) => Promise<unknown>
  }

  it('normalizes an inactive account denial to null for direct session reads', async () => {
    getSession.mockRejectedValueOnce(new InactiveSessionError())
    await expect(sessionApi()({ headers: new Headers() })).resolves.toBeNull()
  })

  it.each(['asResponse', 'returnHeaders', 'returnStatus'])(
    'preserves the inactive account error for %s mode',
    async (mode) => {
      const failure = new InactiveSessionError()
      getSession.mockRejectedValueOnce(failure)
      await expect(sessionApi()({ headers: new Headers(), [mode]: true })).rejects.toBe(failure)
    },
  )

  it('propagates unrelated errors from direct session reads', async () => {
    const failure = new Error('unrelated session error')
    getSession.mockRejectedValueOnce(failure)
    await expect(sessionApi()({ headers: new Headers() })).rejects.toBe(failure)
  })
})
