import { disableAccount, enableAccount } from '@kit/auth/repos/account-state'
import { baSession } from '@kit/auth/schema'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { TENANCY_PASSWORD } from '../seed/tenancy-data'
import { resetIdentityTickets } from '../services/mcp-identity-ticket'
import {
  bearerHeaders,
  createSeededDemoApi,
  loginCookie,
  sessionHeaders,
  TEST_ORIGIN,
} from './api-fixture'
import { captureMail } from './mail-capture'

const target = {
  actorUserId: 'user_staff',
  organizationId: 'org_acme',
  targetUserId: 'user_team_owner',
}
const staff = {
  actorUserId: 'user_team_owner',
  organizationId: 'org_acme',
  targetUserId: 'user_staff',
}

async function setup() {
  const ctx = await createSeededDemoApi({ seed: { notes: false, environment: 'test' } })
  const owner = await loginCookie(ctx.app, ctx.env, 'team-owner@kit.local', TENANCY_PASSWORD)
  const solo = await loginCookie(ctx.app, ctx.env, 'solo@kit.local', TENANCY_PASSWORD)
  return { ...ctx, owner, solo }
}

describe('disabled accounts over HTTP', () => {
  afterEach(() => resetIdentityTickets())

  it('denies the existing session, API key and new login, without affecting another organization; re-enable requires a fresh session', async () => {
    const { app, env, db, owner, solo } = await setup()
    const mint = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: sessionHeaders(owner),
        body: JSON.stringify({ organizationId: 'org_acme' }),
      },
      env,
    )
    expect(mint.status).toBe(200)
    const { key } = (await mint.json()) as { key: string }
    expect(key).toMatch(/^sk_/)
    const me = (headers: Record<string, string>) => app.request('/api/me', { headers }, env)
    expect((await me(sessionHeaders(owner))).status).toBe(200)
    expect((await me(bearerHeaders(key))).status).toBe(200)
    expect((await me(sessionHeaders(solo))).status).toBe(200)

    expect(await disableAccount(db, target)).toBe(true)
    expect((await me(sessionHeaders(owner))).status).toBe(401)
    expect((await me(bearerHeaders(key))).status).toBe(401)
    expect((await me(sessionHeaders(solo))).status).toBe(200)
    const denied = await app.request(
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: TEST_ORIGIN },
        body: JSON.stringify({ email: 'team-owner@kit.local', password: TENANCY_PASSWORD }),
      },
      env,
    )
    expect(denied.status).toBeGreaterThanOrEqual(400)
    expect(denied.headers.get('set-cookie') ?? '').not.toMatch(/kit_session=[^;]+/)

    expect(await enableAccount(db, target)).toBe(true)
    expect((await me(sessionHeaders(owner))).status).toBe(401)
    const fresh = await loginCookie(app, env, 'team-owner@kit.local', TENANCY_PASSWORD)
    expect((await me(sessionHeaders(fresh))).status).toBe(200)
    expect((await me(bearerHeaders(key))).status).toBe(200)
    expect((await me(sessionHeaders(solo))).status).toBe(200)
  })

  it('fails closed when the account state column is missing at runtime', async () => {
    const { app, env, owner } = await setup()
    const mint = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: sessionHeaders(owner),
        body: JSON.stringify({ organizationId: 'org_acme' }),
      },
      env,
    )
    expect(mint.status).toBe(200)
    const { key } = (await mint.json()) as { key: string }
    expect((await app.request('/api/me', { headers: bearerHeaders(key) }, env)).status).toBe(200)
    await env.DB.prepare('ALTER TABLE user DROP COLUMN disabled').run()
    expect((await app.request('/api/me', { headers: bearerHeaders(key) }, env)).status).toBe(401)
    expect((await app.request('/api/me', { headers: sessionHeaders(owner) }, env)).status).toBe(401)
  })

  it('rejects redemption of an identity ticket minted before disabling its user', async () => {
    const { app, env, db, owner } = await setup()
    const resume = 'http://127.0.0.1:8788/authorize?client_id=c1&state=s1'
    const start = await app.request(
      `/api/mcp-identity/ticket?resume=${encodeURIComponent(resume)}`,
      { headers: { cookie: owner } },
      env,
    )
    expect(start.status).toBe(302)
    const ticket = new URL(start.headers.get('location')!).searchParams.get('mcp_identity_ticket')
    expect(ticket).toMatch(/^mct_/)
    expect(await disableAccount(db, target)).toBe(true)
    const redeem = () =>
      app.request(
        '/api/mcp-identity/ticket/redeem',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ticket }),
        },
        env,
      )
    expect((await redeem()).status).toBe(401)
    expect(await enableAccount(db, target)).toBe(true)
    expect((await redeem()).status).toBe(401)
  })

  it('refuses to complete an already delivered magic link without issuing a session', async () => {
    const { app, env, db } = await createSeededDemoApi({
      env: {
        BETTER_AUTH_SECRET: crypto.randomUUID(),
        BETTER_AUTH_URL: 'http://localhost:8787',
        ALLOW_PUBLIC_SIGNUP: 'false',
        ENVIRONMENT: 'test',
        CORS_ORIGINS: TEST_ORIGIN,
        EMAIL_TRANSPORT: 'log',
      },
      seed: { notes: false, environment: 'test' },
    })
    const email = 'team-owner@kit.local'
    const mail = captureMail()
    const sent = await app.request(
      '/api/auth/sign-in/magic-link',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: TEST_ORIGIN },
        body: JSON.stringify({ email, callbackURL: `${TEST_ORIGIN}/app` }),
      },
      env,
    )
    expect(sent.status).toBeLessThan(400)
    const link = mail.link(email, 'Sign-in link')
    expect(link.pathname).toBe('/api/auth/magic-link/verify')
    expect(link.searchParams.get('token')).toBeTruthy()
    expect(await disableAccount(db, target)).toBe(true)
    const before = await db
      .select()
      .from(baSession)
      .where(eq(baSession.userId, target.targetUserId))
    const verify = await app.request(
      `${link.pathname}${link.search}`,
      { headers: { Origin: TEST_ORIGIN } },
      env,
    )
    expect(verify.headers.get('set-cookie') ?? '').not.toMatch(/kit_session=[^;]+/)
    expect(verify.headers.get('location')).not.toBe(`${TEST_ORIGIN}/app`)
    const after = await db.select().from(baSession).where(eq(baSession.userId, target.targetUserId))
    expect(after).toEqual(before)
  })

  it.each([
    ['represented user', target],
    ['actor', staff],
  ])('denies an established impersonation when the %s is disabled', async (_label, disabled) => {
    const { app, env, db } = await setup()
    const superCookie = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD)
    const actorCookie = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD)
    const request = (cookie: string, path: string, method = 'GET', body?: object, fence = 'none') =>
      app.request(
        path,
        {
          method,
          headers: { ...sessionHeaders(cookie, 'org_acme'), 'X-Impersonation-Id': fence },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
        env,
      )
    expect(
      (
        await request(superCookie, '/api/admin/impersonation/permissions', 'PATCH', {
          role: 'staff',
          read: true,
          write: false,
        })
      ).status,
    ).toBe(200)
    const started = await request(actorCookie, '/api/impersonation/start', 'POST', {
      organizationId: 'org_acme',
      subjectUserId: 'user_team_owner',
      mode: 'read',
    })
    expect(started.status).toBe(200)
    const { impersonation } = (await started.json()) as { impersonation: { id: string } }
    expect((await request(actorCookie, '/api/me', 'GET', undefined, impersonation.id)).status).toBe(
      200,
    )
    expect(await disableAccount(db, disabled)).toBe(true)
    expect((await request(actorCookie, '/api/me', 'GET', undefined, impersonation.id)).status).toBe(
      401,
    )
  })
})
