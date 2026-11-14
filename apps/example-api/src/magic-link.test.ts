import { assertRateLimit } from '@kit/auth/repos/rate-limit'
import { baUser, baVerification } from '@kit/auth/schema'
import { createDb } from '@kit/db'
import { eq } from 'drizzle-orm'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createApp } from './app'
import { schema } from './db/schema'
import { emailConfig } from './lib/email-config'
import { DEMO_EMAIL } from './services/auth'
import { createSeededDemoApi } from './test/api-fixture'
import { captureMail, expectTokenAbsentFromVerification } from './test/mail-capture'
import { createMemoryEnv } from './test/memory-env'

const ORIGIN = 'http://localhost:5173'

const BA_ENV = {
  BETTER_AUTH_SECRET: 'test-better-auth-secret-at-least-32!!',
  BETTER_AUTH_URL: 'http://localhost:8787',
  // Default kit: no public signup — magic must not mint accounts
  ALLOW_PUBLIC_SIGNUP: 'false',
  ENVIRONMENT: 'test',
  CORS_ORIGINS: ORIGIN,
  EMAIL_TRANSPORT: 'log',
}

async function seedEnv() {
  return createSeededDemoApi({ env: BA_ENV, seed: { notes: false, environment: 'test' } })
}

async function verificationCount(db: ReturnType<typeof createDb>): Promise<number> {
  const rows = await db.select().from(baVerification)
  return rows.length
}

async function userCountByEmail(db: ReturnType<typeof createDb>, email: string): Promise<number> {
  const rows = await db.select().from(baUser).where(eq(baUser.email, email))
  return rows.length
}

describe('magic link (B-magic go-silex/silex-boilerplate#59)', () => {
  it('uses the recipient locale for authentication mail, not the request language', async () => {
    const { app, env } = await seedEnv()
    const mail = captureMail()
    const locale = vi.spyOn(emailConfig, 'resolveRecipientLocale').mockReturnValue('en')
    onTestFinished(() => locale.mockRestore())
    const res = await app.request(
      '/api/auth/sign-in/magic-link',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN, 'Accept-Language': 'fr' },
        body: JSON.stringify({ email: DEMO_EMAIL, callbackURL: `${ORIGIN}/app` }),
      },
      env,
    )
    expect(res.status).toBeLessThan(400)
    expect(locale).toHaveBeenCalledWith(DEMO_EMAIL)
    expect(mail.message(DEMO_EMAIL).subject).toBe('Sign in — App')
    expect(mail.message(DEMO_EMAIL).text).toContain('You requested')
  })

  it('request for known email returns success and stores a verification row', async () => {
    const { app, env, db } = await seedEnv()
    const before = await verificationCount(db)
    const res = await app.request(
      '/api/auth/sign-in/magic-link',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({
          email: DEMO_EMAIL,
          callbackURL: `${ORIGIN}/app`,
        }),
      },
      env,
    )
    expect(res.status, await res.clone().text()).toBeLessThan(400)
    const bodyText = await res.text()
    // Never dump raw tokens in assertions beyond presence checks
    expect(bodyText).not.toMatch(/password/i)
    const after = await verificationCount(db)
    expect(after).toBeGreaterThan(before)
  })

  it('verify known-email token sets session cookie and /api/me works', async () => {
    const { app, env, db } = await seedEnv()
    const mail = captureMail()
    const sent = await app.request(
      '/api/auth/sign-in/magic-link',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({
          email: DEMO_EMAIL,
          callbackURL: `${ORIGIN}/app`,
        }),
      },
      env,
    )
    expect(sent.status, await sent.clone().text()).toBeLessThan(400)

    const link = mail.link(DEMO_EMAIL, 'Sign-in link')
    expect(link.pathname).toBe('/api/auth/magic-link/verify')
    const token = link.searchParams.get('token')
    expect(token).toBeTruthy()
    await expectTokenAbsentFromVerification(db, token!)
    const evilLink = new URL(link)
    evilLink.searchParams.set('callbackURL', 'https://evil.example/')
    const evil = await app.request(
      `${evilLink.pathname}${evilLink.search}`,
      { headers: { Origin: ORIGIN } },
      env,
    )
    expect(evil.status).toBe(403)
    expect(evil.headers.get('set-cookie')).toBeNull()
    const verifyPath = `${link.pathname}${link.search}`

    const verify = await app.request(
      verifyPath,
      {
        method: 'GET',
        headers: { Origin: ORIGIN },
      },
      env,
    )
    const location = verify.headers.get('location')
    expect({ status: verify.status, location }).toEqual({ status: 302, location: `${ORIGIN}/app` })
    const cookie = verify.headers.get('set-cookie') ?? ''
    expect(cookie.toLowerCase()).toMatch(/httponly/)
    expect(cookie).toMatch(/Path=\//i)
    expect(cookie).toMatch(/SameSite=Lax/i)

    const me = await app.request('/api/me', { headers: { cookie, Origin: ORIGIN } }, env)
    expect(me.status).toBe(200)
    const meBody = (await me.json()) as { subject?: string }
    expect(meBody.subject).toBeTruthy()
    const replay = await app.request(verifyPath, { headers: { Origin: ORIGIN } }, env)
    expect(replay.status).toBe(302)
    expect(new URL(replay.headers.get('location')!).searchParams.get('error')).toBe('INVALID_TOKEN')
    expect(replay.headers.get('set-cookie')).toBeNull()
  })

  it('request for unknown email does not create a user when signup disabled', async () => {
    const { app, env, db } = await seedEnv()
    const unknown = 'nobody-magic@kit.local'
    expect(await userCountByEmail(db, unknown)).toBe(0)

    const res = await app.request(
      '/api/auth/sign-in/magic-link',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({
          email: unknown,
          callbackURL: `${ORIGIN}/app`,
        }),
      },
      env,
    )
    // BA may return 2xx (email “sent”) even when user missing; user must not appear
    expect(res.status).toBeLessThan(500)
    expect(await userCountByEmail(db, unknown)).toBe(0)
  })

  it('magic-link path is rate-limited by the kit BA throttle', async () => {
    const app = createApp()
    const env = createMemoryEnv(BA_ENV)
    const db = createDb(env.DB as unknown as D1Database, schema)
    const windowMs = 15 * 60 * 1000
    for (let i = 0; i < 20; i++) {
      await assertRateLimit(db, 'ba-auth:198.51.100.10', 20, windowMs)
    }
    const blocked = await app.request(
      '/api/auth/sign-in/magic-link',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: ORIGIN,
          'cf-connecting-ip': '198.51.100.10',
        },
        body: JSON.stringify({ email: 'rate@example.com', callbackURL: `${ORIGIN}/app` }),
      },
      env,
    )
    expect(blocked.status).toBe(429)
    const body = (await blocked.json()) as { error: { code: string } }
    expect(body.error.code).toBe('RATE_LIMITED')
  })

  it('magic-link/verify path is rate-limited by the kit BA throttle', async () => {
    const app = createApp()
    const env = createMemoryEnv(BA_ENV)
    const db = createDb(env.DB as unknown as D1Database, schema)
    const windowMs = 15 * 60 * 1000
    for (let i = 0; i < 20; i++) {
      await assertRateLimit(db, 'ba-auth:198.51.100.11', 20, windowMs)
    }
    const blocked = await app.request(
      '/api/auth/magic-link/verify?token=not-a-real-token',
      {
        method: 'GET',
        headers: {
          Origin: ORIGIN,
          'cf-connecting-ip': '198.51.100.11',
        },
      },
      env,
    )
    expect(blocked.status).toBe(429)
  })
})
