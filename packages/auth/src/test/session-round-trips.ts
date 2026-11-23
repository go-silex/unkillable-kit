import type { KitD1Database } from '@kit/db'
import { describe, expect, it } from 'vitest'
import { BA_BASE_PATH } from '../better-auth-base-path'
import { isBaOrganizationRoute } from '../org-route-deny'

type Route = `${string} /${string}`
type Options = { path?: string; body?: unknown; status?: number }
type Credentials = { email: string; password: string }
type Fixture = {
  db: KitD1Database
  cookie: string
  credentials: Credentials
  request: (path: string, init?: RequestInit) => Response | Promise<Response>
  measure: (route: Route, ceiling: number, options?: Options) => Promise<Response>
}

type Session = {
  session: { token: string; userId: string; expiresAt: string }
  user: { name: string }
}
type Account = { id: string; providerId: string }

const getSession = 'GET /api/auth/get-session'
const listAccounts = 'GET /api/auth/list-accounts'
const listSessions = 'GET /api/auth/list-sessions'
const passwordChangeRoute = 'POST /api/auth/change-password'
const day = 24 * 60 * 60 * 1000

async function readSession(f: Fixture, cookie = f.cookie): Promise<Session | null> {
  const response = await f.request('/api/auth/get-session', { headers: { cookie } })
  expect(response.status).toBe(200)
  return (await response.json()) as Session | null
}

async function requireSession(f: Fixture, cookie?: string) {
  const session = await readSession(f, cookie)
  if (!session) throw new Error('Expected a signed-in fixture session')
  return session
}

async function readAccounts(f: Fixture): Promise<Account[]> {
  const response = await f.request('/api/auth/list-accounts', { headers: { cookie: f.cookie } })
  expect(response.status).toBe(200)
  return (await response.json()) as Account[]
}

async function signIn(f: Fixture, password = f.credentials.password) {
  const response = await f.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: f.credentials.email, password }),
  })
  expect(response.status).toBe(200)
  return sessionCookie(response)
}

function sessionCookie(response: Response) {
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error('Expected a session cookie')
  return cookie
}

async function makeRefreshDue(f: Fixture) {
  const current = await requireSession(f)
  // Default expiry is seven days and update age one day. Keep this session fresh but due for refresh.
  await f.db
    .prepare('UPDATE session SET expires_at = ? WHERE token = ?')
    .bind(Date.now() + 5 * day, current.session.token)
    .run()
}

async function credentialAccount(f: Fixture) {
  const account = (await readAccounts(f)).find((row) => row.providerId === 'credential')
  if (!account) throw new Error('Expected a credential account')
  return account.id
}

type Send = (options?: Options) => Promise<Response>

function scenario(route: Route, run: (f: Fixture, send: Send) => Promise<void>) {
  return { route, run }
}

function unavailable(route: Route, status: number, options?: Options) {
  return scenario(route, async (_f, send) => {
    await send({ ...options, status })
  })
}

const cases = {
  getSession: scenario(getSession, async (f, send) => {
    expect(await (await send()).json()).toMatchObject({ user: { email: f.credentials.email } })
  }),
  getSessionRefresh: scenario(getSession, async (f, send) => {
    await makeRefreshDue(f)
    const response = await send()
    expect(sessionCookie(response)).toBe(f.cookie)
    const result = (await response.json()) as Session
    expect(Date.parse(result.session.expiresAt)).toBeGreaterThan(Date.now() + 6 * day)
  }),
  listSessions: scenario(listSessions, async (f, send) => {
    const second = await signIn(f)
    const current = await requireSession(f)
    const other = await requireSession(f, second)
    const sessions = (await (await send()).json()) as Array<{ token: string }>
    const tokens = sessions.map(({ token }) => token).sort()
    expect(tokens).toEqual([current.session.token, other.session.token].sort())
  }),
  listSessionsRefresh: scenario(listSessions, async (f, send) => {
    await makeRefreshDue(f)
    const response = await send()
    expect(sessionCookie(response)).toBe(f.cookie)
    expect(await response.json()).toHaveLength(1)
  }),
  listAccounts: scenario(listAccounts, async (_f, send) => {
    expect(await (await send()).json()).toMatchObject([{ providerId: 'credential' }])
  }),
  updateUser: scenario('POST /api/auth/update-user', async (f, send) => {
    const name = 'Updated Fixture'
    expect(await (await send({ body: { name } })).json()).toEqual({ status: true })
    expect((await readSession(f))?.user.name).toBe(name)
  }),
  changePassword: scenario(passwordChangeRoute, async (f, send) => {
    const newPassword = crypto.randomUUID()
    const body = { currentPassword: f.credentials.password, newPassword }
    expect(await (await send({ body })).json()).toMatchObject({ token: null })
    expect(await readSession(f, await signIn(f, newPassword))).not.toBeNull()
  }),
  changePasswordRevoke: scenario(passwordChangeRoute, async (f, send) => {
    const other = await signIn(f)
    const body = {
      currentPassword: f.credentials.password,
      newPassword: crypto.randomUUID(),
      revokeOtherSessions: true,
    }
    const response = await send({ body })
    expect(await response.json()).toMatchObject({ token: expect.any(String) })
    expect(await readSession(f)).toBeNull()
    expect(await readSession(f, other)).toBeNull()
    expect(await readSession(f, sessionCookie(response))).not.toBeNull()
  }),
  verifyPassword: scenario('POST /api/auth/verify-password', async (f, send) => {
    const body = { password: f.credentials.password }
    expect(await (await send({ body })).json()).toEqual({ status: true })
  }),
  signOut: scenario('POST /api/auth/sign-out', async (f, send) => {
    expect(await (await send({ body: {} })).json()).toMatchObject({ success: true })
    expect(await readSession(f)).toBeNull()
  }),
  revokeSession: scenario('POST /api/auth/revoke-session', async (f, send) => {
    const other = await signIn(f)
    const session = await requireSession(f, other)
    expect(await (await send({ body: { token: session.session.token } })).json()).toEqual({
      status: true,
    })
    expect(await readSession(f, other)).toBeNull()
    expect(await readSession(f)).not.toBeNull()
  }),
  revokeSessions: scenario('POST /api/auth/revoke-sessions', async (f, send) => {
    const other = await signIn(f)
    expect(await (await send({ body: {} })).json()).toEqual({ status: true })
    expect(await readSession(f)).toBeNull()
    expect(await readSession(f, other)).toBeNull()
  }),
  revokeOtherSessions: scenario('POST /api/auth/revoke-other-sessions', async (f, send) => {
    const other = await signIn(f)
    expect(await (await send({ body: {} })).json()).toEqual({ status: true })
    expect(await readSession(f, other)).toBeNull()
    expect(await readSession(f)).not.toBeNull()
  }),
  unlinkAccount: scenario('POST /api/auth/unlink-account', async (f, send) => {
    const current = await requireSession(f)
    const accountId = 'fixture-linked-account'
    const now = Date.now()
    await f.db
      .prepare(
        `INSERT INTO account (id, account_id, provider_id, issuer, user_id, created_at, updated_at)
         VALUES (?, ?, 'google', 'https://accounts.google.com', ?, ?, ?)`,
      )
      .bind(accountId, 'fixture-provider-subject', current.session.userId, now, now)
      .run()
    expect(await (await send({ body: { accountId } })).json()).toEqual({ status: true })
    expect(await readAccounts(f)).toMatchObject([{ providerId: 'credential' }])
  }),
  // These are mounted and get a valid cookie/body, but the Apps leave the required feature off.
  postGetSession: unavailable('POST /api/auth/get-session', 405),
  updateSession: unavailable('POST /api/auth/update-session', 400, { body: {} }),
  changeEmail: unavailable('POST /api/auth/change-email', 400, {
    body: { newEmail: 'updated@example.test' },
  }),
  deleteUser: unavailable('POST /api/auth/delete-user', 404, { body: {} }),
  deleteUserCallback: unavailable('GET /api/auth/delete-user/callback', 404, {
    path: `/api/auth/delete-user/callback?${new URLSearchParams({ token: crypto.randomUUID() })}`,
  }),
  linkSocial: unavailable('POST /api/auth/link-social', 404, { body: { provider: 'google' } }),
  getAccessToken: scenario('POST /api/auth/get-access-token', async (f, send) => {
    const accountId = await credentialAccount(f)
    expect(await (await send({ body: { accountId }, status: 400 })).json()).toMatchObject({
      code: 'PROVIDER_NOT_SUPPORTED',
    })
  }),
  refreshToken: scenario('POST /api/auth/refresh-token', async (f, send) => {
    const accountId = await credentialAccount(f)
    expect(await (await send({ body: { accountId }, status: 400 })).json()).toMatchObject({
      code: 'PROVIDER_NOT_SUPPORTED',
    })
  }),
  accountInfo: scenario('GET /api/auth/account-info', async (f, send) => {
    const accountId = await credentialAccount(f)
    const path = `/api/auth/account-info?accountId=${encodeURIComponent(accountId)}`
    expect(await (await send({ path, status: 400 })).json()).toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
    })
  }),
}

export type SessionRoundTripCeilings = Record<keyof typeof cases, number>

// These routes establish a session, use independent proof, or provide a public utility. Sending
// verification email is disabled and would not require an established session even if enabled.
const publicRoutes: readonly Route[] = [
  'POST /api/auth/sign-up/email',
  'POST /api/auth/sign-in/email',
  'POST /api/auth/sign-in/social',
  'GET /api/auth/callback/:id',
  'POST /api/auth/callback/:id',
  'POST /api/auth/request-password-reset',
  'GET /api/auth/reset-password/:token',
  'POST /api/auth/reset-password',
  'POST /api/auth/send-verification-email',
  'GET /api/auth/verify-email',
  'GET /api/auth/ok',
  'GET /api/auth/error',
]
const magicLinkRoutes: readonly Route[] = [
  'POST /api/auth/sign-in/magic-link',
  'GET /api/auth/magic-link/verify',
]

function mountedEndpoint(value: unknown) {
  if (typeof value !== 'function') return
  const { path, options } = value as {
    path?: string
    options?: { method?: unknown; metadata?: { SERVER_ONLY?: boolean } }
  }
  // Better Call excludes pathless and SERVER_ONLY endpoints, not `scope: 'server'`.
  if (!(path && options) || options.metadata?.SERVER_ONLY) return
  return { path, method: options.method }
}

function sessionOrPublicRoutes(api: object) {
  const routes = new Set<Route>()
  for (const value of Object.values(api)) {
    const endpoint = mountedEndpoint(value)
    if (!endpoint) continue
    const path: `/${string}` = `${BA_BASE_PATH}${endpoint.path}`
    // The Kit rejects the BA organization subtree before the vendor handler.
    if (isBaOrganizationRoute(path)) continue
    for (const method of Array.isArray(endpoint.method) ? endpoint.method : [endpoint.method]) {
      if (typeof method !== 'string') throw new Error(`Missing HTTP method for ${path}`)
      routes.add(`${method} ${path}`)
    }
  }
  return routes
}

export function sessionRoundTripTests(opts: {
  createFixture: () => Promise<Fixture>
  readMountedApi: () => Promise<object>
  magicLinks: boolean
  ceilings: SessionRoundTripCeilings
  organizationDenyCeiling: number
}) {
  describe('mounted Better Auth session D1 round trips', () => {
    it('classifies every mounted Better Auth endpoint', async () => {
      const actual = sessionOrPublicRoutes(await opts.readMountedApi())
      const expected = new Set([
        ...Object.values(cases).map(({ route }) => route),
        ...publicRoutes,
        ...(opts.magicLinks ? magicLinkRoutes : []),
      ])
      expect([...actual].sort()).toEqual([...expected].sort())
    })

    it('denies the Better Auth organization subtree within its D1 ceiling', async () => {
      const f = await opts.createFixture()
      const route = 'GET /api/auth/organization/list-organizations'
      await f.measure(route, opts.organizationDenyCeiling, { status: 404 })
    })

    for (const name of Object.keys(cases) as (keyof typeof cases)[]) {
      const { route, run } = cases[name]
      it(`${route} (${name})`, async () => {
        const f = await opts.createFixture()
        await run(f, (options) => f.measure(route, opts.ceilings[name], options))
      })
    }
  })
}
