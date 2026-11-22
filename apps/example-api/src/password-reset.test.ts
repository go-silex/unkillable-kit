import { resetPasswordIdentifier } from '@kit/auth/factory'
import { baAccount, baVerification } from '@kit/auth/schema'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEMO_EMAIL, DEMO_PASSWORD } from './services/auth'
import { createSeededDemoApi, loginCookie } from './test/api-fixture'
import {
  captureMail,
  expectTokenAbsentFromVerification,
  resetTokenFromLink,
} from './test/mail-capture'

const ORIGIN = 'http://localhost:5173'

const BA_ENV = {
  BETTER_AUTH_SECRET: 'test-better-auth-secret-at-least-32!!',
  BETTER_AUTH_URL: 'http://localhost:8787',
  ALLOW_PUBLIC_SIGNUP: 'true',
  ENVIRONMENT: 'test',
  CORS_ORIGINS: ORIGIN,
}

async function seedEnv() {
  return createSeededDemoApi({ env: BA_ENV, seed: { notes: false, environment: 'test' } })
}

describe('password reset (B3 S3)', () => {
  afterEach(() => vi.useRealTimers())

  it('request for known email returns generic success and stores token', async () => {
    const { app, env, db } = await seedEnv()
    const mail = captureMail()
    const res = await app.request(
      '/api/auth/request-password-reset',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({
          email: DEMO_EMAIL,
          redirectTo: `${ORIGIN}/reset-password`,
        }),
      },
      env,
    )
    expect(res.status).toBeLessThan(400)
    const body = (await res.json()) as { status?: boolean; message?: string }
    expect(body.status).toBe(true)
    const token = resetTokenFromLink(mail.link(DEMO_EMAIL, 'Reset link'))
    await expectTokenAbsentFromVerification(db, token)
    const rows = await db.select().from(baVerification)
    const identifier = await resetPasswordIdentifier(token)
    expect(rows.some((row) => row.identifier === identifier)).toBe(true)
  })

  it('request for unknown email still returns generic success (no enumeration)', async () => {
    const { app, env } = await seedEnv()
    const res = await app.request(
      '/api/auth/request-password-reset',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({
          email: 'nobody-exists@kit.local',
          redirectTo: `${ORIGIN}/reset-password`,
        }),
      },
      env,
    )
    expect(res.status).toBeLessThan(400)
    const body = (await res.json()) as { status?: boolean; message?: string }
    expect(body.status).toBe(true)
    expect(body.message).toMatch(/email/i)
  })

  it('reset with token → new password works; old fails; token single-use', async () => {
    const { app, env, db } = await seedEnv()
    const mail = captureMail()
    const oldCookie = await loginCookie(app, env, DEMO_EMAIL, DEMO_PASSWORD, ORIGIN)
    expect(
      (await app.request('/api/me', { headers: { cookie: oldCookie, Origin: ORIGIN } }, env))
        .status,
    ).toBe(200)
    const other = await seedEnv()
    const otherCredential = await other.db
      .select()
      .from(baAccount)
      .where(eq(baAccount.userId, 'user_demo'))
      .get()
    const req = await app.request(
      '/api/auth/request-password-reset',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({
          email: DEMO_EMAIL,
          redirectTo: `${ORIGIN}/reset-password`,
        }),
      },
      env,
    )
    expect(req.status).toBeLessThan(400)
    const token = resetTokenFromLink(mail.link(DEMO_EMAIL, 'Reset link'))
    await expectTokenAbsentFromVerification(db, token)

    const newPassword = 'new-demo-password-xyz'
    const reset = await app.request(
      '/api/auth/reset-password',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ newPassword, token }),
      },
      env,
    )
    expect(reset.status).toBeLessThan(400)
    expect(
      (await app.request('/api/me', { headers: { cookie: oldCookie, Origin: ORIGIN } }, env))
        .status,
    ).toBe(401)
    const oldSession = await app.request(
      '/api/auth/get-session',
      { headers: { cookie: oldCookie, Origin: ORIGIN } },
      env,
    )
    expect(await oldSession.json()).toBeNull()

    const oldLogin = await app.request(
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
      },
      env,
    )
    expect(oldLogin.status).toBeGreaterThanOrEqual(400)

    const newLogin = await app.request(
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ email: DEMO_EMAIL, password: newPassword }),
      },
      env,
    )
    expect(newLogin.status).toBeLessThan(400)
    const newCookie = newLogin.headers.get('set-cookie')
    expect(newCookie).toBeTruthy()
    expect(
      (await app.request('/api/me', { headers: { cookie: newCookie!, Origin: ORIGIN } }, env))
        .status,
    ).toBe(200)

    const otherLogin = await other.app.request(
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
      },
      other.env,
    )
    expect(otherLogin.status).toBeLessThan(400)
    const otherCredentialAfter = await other.db
      .select()
      .from(baAccount)
      .where(eq(baAccount.userId, 'user_demo'))
      .get()
    expect(otherCredentialAfter?.password).toBe(otherCredential?.password)

    const reuse = await app.request(
      '/api/auth/reset-password',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ newPassword: 'another-password-1', token }),
      },
      env,
    )
    expect(reuse.status).toBeGreaterThanOrEqual(400)
  })

  it('request-password-reset is rate limited', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 0, 1, 0, 1))

    const { app, env } = await seedEnv()
    let lastStatus = 200
    for (let i = 0; i < 25; i++) {
      const res = await app.request(
        '/api/auth/request-password-reset',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Origin: ORIGIN,
            'cf-connecting-ip': '203.0.113.50',
          },
          body: JSON.stringify({
            email: DEMO_EMAIL,
            redirectTo: `${ORIGIN}/reset-password`,
          }),
        },
        env,
      )
      lastStatus = res.status
      if (res.status === 429) break
    }
    expect(lastStatus).toBe(429)
  })
})
