import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { apiKeyPrefix, generateApiKey, hashApiKey } from '@kit/auth'
import { insertApiKey } from '@kit/auth/repos/keys'
import { createDb } from '@kit/db'
import { createSqliteD1 } from '@kit/db/testing'
import Database from 'better-sqlite3'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createApp } from '../../app'
import { type Env, schema } from '../../platform/types'

const origin = 'http://localhost:5173'
function fixture(signup = true) {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const directory = fileURLToPath(new URL('../../../migrations/', import.meta.url))
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    sqlite.exec(readFileSync(`${directory}/${file}`, 'utf8'))
  }
  onTestFinished(() => {
    sqlite.close()
  })
  const env: Env = {
    DB: createSqliteD1(sqlite) as unknown as D1Database,
    ENVIRONMENT: 'test',
    BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
    BETTER_AUTH_URL: 'http://localhost:8787',
    ALLOW_PUBLIC_SIGNUP: signup ? 'true' : 'false',
  }
  const app = createApp()
  const request = (path: string, init: RequestInit = {}) =>
    app.request(
      `http://localhost:8787${path}`,
      {
        ...init,
        headers: { origin, ...init.headers },
      },
      env,
    )
  const post = (path: string, data: object, cookie?: string) =>
    request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(data),
    })
  return { sqlite, env, request, post }
}
const credentials = { email: 'alice@example.test', password: crypto.randomUUID(), name: 'Alice' }

describe('starter HTTP composition', () => {
  it('signs up, signs in, audits first login and refuses cross-organization access', async () => {
    const { sqlite, env, request, post } = fixture()
    const signup = await post('/api/auth/sign-up/email', credentials)
    expect(signup.status).toBeLessThan(400)
    const signupCookie = signup.headers.get('set-cookie')!.split(';')[0]!
    const me = await request('/api/me', { headers: { cookie: signupCookie } })
    expect(me.status).toBe(200)
    const profile = (await me.json()) as { subject: string; email: string; orgs: unknown[] }
    expect(profile.email).toBe(credentials.email)
    expect(profile.orgs).toEqual([])
    expect(
      sqlite
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action = 'first_login' AND target_id = ?",
        )
        .get(profile.subject),
    ).toEqual({ count: 1 })
    sqlite
      .prepare(
        "INSERT INTO organization (id, name, slug, created_at, kind, status) VALUES (?, ?, ?, ?, 'client', 'active')",
      )
      .run('org-a', 'A', 'a', Date.now())
    sqlite
      .prepare(
        "INSERT INTO organization (id, name, slug, created_at, kind, status) VALUES (?, ?, ?, ?, 'client', 'active')",
      )
      .run('org-b', 'B', 'b', Date.now())
    sqlite
      .prepare(
        "INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
      )
      .run('member-a', 'org-a', profile.subject, Date.now())
    const own = await request('/api/orgs/org-a/members', { headers: { cookie: signupCookie } })
    expect(own.status).toBe(200)
    expect(await own.json()).toEqual({
      members: [{ id: 'member-a', userId: profile.subject, role: 'member' }],
    })
    expect(
      (await request('/api/orgs/org-b/members', { headers: { cookie: signupCookie } })).status,
    ).toBe(404)
    expect(
      (
        await request('/api/orgs/org-a/members', {
          headers: { cookie: signupCookie, 'x-org-id': 'org-b' },
        })
      ).status,
    ).toBe(403)
    const scoped = await request('/api/me', { headers: { cookie: signupCookie } })
    expect(((await scoped.json()) as { orgs: { id: string }[] }).orgs.map((o) => o.id)).toEqual([
      'org-a',
    ])
    sqlite
      .prepare(
        "INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
      )
      .run('member-b', 'org-b', profile.subject, Date.now())
    const key = generateApiKey()
    await insertApiKey(createDb(env.DB, schema), {
      id: 'key-a',
      keyHash: await hashApiKey(key),
      keyPrefix: apiKeyPrefix(key),
      subject: profile.subject,
      organizationId: 'org-a',
      scopes: 'read',
      createdAt: Date.now(),
    })
    const keyHeaders = { authorization: `Bearer ${key}` }
    const keyMe = await request('/api/me', { headers: keyHeaders })
    expect(keyMe.status).toBe(200)
    expect(((await keyMe.json()) as { orgs: { id: string }[] }).orgs.map((o) => o.id)).toEqual([
      'org-a',
    ])
    expect((await request('/api/orgs/org-a/members', { headers: keyHeaders })).status).toBe(200)
    expect((await request('/api/orgs/org-b/members', { headers: keyHeaders })).status).toBe(403)
    const writeKey = generateApiKey()
    await insertApiKey(createDb(env.DB, schema), {
      id: 'key-write',
      keyHash: await hashApiKey(writeKey),
      keyPrefix: apiKeyPrefix(writeKey),
      subject: profile.subject,
      organizationId: 'org-a',
      scopes: 'write',
      createdAt: Date.now(),
    })
    const writeHeaders = { authorization: `Bearer ${writeKey}` }
    expect((await request('/api/me', { headers: writeHeaders })).status).toBe(403)
    expect((await request('/api/orgs/org-a/members', { headers: writeHeaders })).status).toBe(403)
    expect((await request('/api/unknown', { headers: keyHeaders })).status).toBe(403)
    expect((await request('/api/auth/session', { headers: keyHeaders })).status).toBe(403)
    expect((await request('/health', { headers: keyHeaders })).status).toBe(403)
    expect((await request('/api/me', { method: 'POST', headers: keyHeaders })).status).toBe(403)
    expect((await post('/api/auth/sign-out', {}, signupCookie)).status).toBeLessThan(400)
    expect((await request('/api/me', { headers: { cookie: signupCookie } })).status).toBe(401)
    const signin = await post('/api/auth/sign-in/email', credentials)
    expect(signin.status).toBeLessThan(400)
    const cookie = signin.headers.get('set-cookie')!.split(';')[0]!
    expect((await request('/api/me', { headers: { cookie } })).status).toBe(200)
    expect(
      sqlite
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action = 'first_login' AND target_id = ?",
        )
        .get(profile.subject),
    ).toEqual({ count: 1 })
  })
  it('enforces disabled account state for existing sessions and organization-bound keys', async () => {
    const { sqlite, env, request, post } = fixture()
    const signup = await post('/api/auth/sign-up/email', credentials)
    expect(signup.status).toBeLessThan(400)
    const cookie = signup.headers.get('set-cookie')!.split(';')[0]!
    const profileResponse = await request('/api/me', { headers: { cookie } })
    expect(profileResponse.status).toBe(200)
    const profile = (await profileResponse.json()) as { subject: string }

    sqlite
      .prepare(
        "INSERT INTO organization (id, name, slug, created_at, kind, status) VALUES (?, ?, ?, ?, 'client', 'active')",
      )
      .run('org-a', 'A', 'a', Date.now())
    sqlite
      .prepare(
        "INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
      )
      .run('member-a', 'org-a', profile.subject, Date.now())
    const keyHeaders: Record<string, Record<string, string>> = {}
    for (const [id, scopes] of [
      ['read', 'read'],
      ['write', 'write'],
      ['unscoped', ''],
      ['malformed', 'read,unknown'],
    ] as const) {
      const key = generateApiKey()
      await insertApiKey(createDb(env.DB, schema), {
        id: `key-${id}`,
        keyHash: await hashApiKey(key),
        keyPrefix: apiKeyPrefix(key),
        subject: profile.subject,
        organizationId: 'org-a',
        scopes,
        createdAt: Date.now(),
      })
      keyHeaders[id] = { authorization: `Bearer ${key}` }
    }
    const sessionHeaders: Record<string, string> = { cookie }
    const memberPath = '/api/orgs/org-a/members'
    for (const headers of [sessionHeaders, keyHeaders.read!]) {
      expect((await request('/api/me', { headers })).status).toBe(200)
      expect((await request(memberPath, { headers })).status).toBe(200)
    }
    for (const headers of [keyHeaders.write!, keyHeaders.unscoped!, keyHeaders.malformed!]) {
      expect((await request('/api/me', { headers })).status).toBe(403)
      expect((await request(memberPath, { headers })).status).toBe(403)
    }
    expect((await request('/api/auth/get-session', { headers: sessionHeaders })).status).toBe(200)

    // Keep the existing session to exercise the per-request guard independently of revocation.
    sqlite.prepare('UPDATE user SET disabled = 1 WHERE id = ?').run(profile.subject)
    for (const headers of [sessionHeaders, ...Object.values(keyHeaders)]) {
      expect((await request('/api/me', { headers })).status).toBe(401)
      expect((await request(memberPath, { headers })).status).toBe(401)
    }
    expect((await request('/api/auth/get-session', { headers: sessionHeaders })).status).toBe(401)
    const deniedSignin = await post('/api/auth/sign-in/email', credentials)
    expect(deniedSignin.status).toBeGreaterThanOrEqual(400)
    expect(deniedSignin.headers.get('set-cookie')).toBeNull()

    sqlite.prepare('UPDATE user SET disabled = 0 WHERE id = ?').run(profile.subject)
    for (const headers of [sessionHeaders, keyHeaders.read!]) {
      expect((await request('/api/me', { headers })).status).toBe(200)
      expect((await request(memberPath, { headers })).status).toBe(200)
    }
    for (const headers of [keyHeaders.write!, keyHeaders.unscoped!, keyHeaders.malformed!]) {
      expect((await request('/api/me', { headers })).status).toBe(403)
      expect((await request(memberPath, { headers })).status).toBe(403)
    }
    expect((await request('/api/auth/get-session', { headers: sessionHeaders })).status).toBe(200)
    const signin = await post('/api/auth/sign-in/email', credentials)
    expect(signin.status).toBeLessThan(400)
    expect(signin.headers.get('set-cookie')).not.toBeNull()
  })
  it('denies unauthenticated requests and signup unless explicitly enabled', async () => {
    const { request, post } = fixture(false)
    const allowed = await request('/health', { headers: { origin } })
    expect(allowed.headers.get('access-control-allow-origin')).toBe(origin)
    const denied = await request('/health', { headers: { origin: 'https://untrusted.example' } })
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
    expect((await request('/api/me')).status).toBe(401)
    expect((await request('/api/orgs/org-a/members')).status).toBe(401)
    expect((await post('/api/auth/sign-up/email', credentials)).status).toBe(403)
    expect((await post('/api/auth/sign-in/email', credentials)).status).toBeGreaterThanOrEqual(400)
    expect(
      (await post('/api/auth/organization/create', { name: 'Forbidden', slug: 'forbidden' }))
        .status,
    ).toBe(404)
  })
})
