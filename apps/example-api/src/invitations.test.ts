import { baUser } from '@kit/auth/schema'
import { createDb } from '@kit/db'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createApp } from './app'
import { schema } from './db/schema'

import { seedDemoDatabase } from './seed/seed-db'
import { TENANCY_PASSWORD } from './seed/tenancy-data'
import { createSeededDemoApi, loginCookie, sessionHeaders } from './test/api-fixture'
import { hashFixtureCredential } from './test/fixture-credential'
import { createMemoryEnv } from './test/memory-env'

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

describe('org invitations (B3 S2)', () => {
  it('S3: invite unknown email creates BA user shell + pending invite', async () => {
    const app = createApp()
    const env = createMemoryEnv({
      ...BA_ENV,
      ALLOW_PUBLIC_SIGNUP: 'false',
    })
    const db = createDb(env.DB as unknown as D1Database, schema)
    await seedDemoDatabase(db, { notes: false, environment: 'test' }, hashFixtureCredential)
    const cookie = await loginCookie(app, env, 'team-owner@kit.local', TENANCY_PASSWORD, ORIGIN)
    const res = await app.request(
      '/api/orgs/org_team/invitations',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ email: 'brand-new@kit.local', role: 'member' }),
      },
      env,
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { invitation: { email: string; status: string } }
    expect(body.invitation.email).toBe('brand-new@kit.local')
    expect(body.invitation.status).toBe('pending')
    const { baUser } = await import('@kit/auth/schema')
    const { eq } = await import('drizzle-orm')
    const users = await db.select().from(baUser).where(eq(baUser.email, 'brand-new@kit.local'))
    expect(users.length).toBe(1)
    // public signup still off — sign-up should fail
    const signup = await app.request(
      '/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({
          email: 'another-public@kit.local',
          password: TENANCY_PASSWORD,
          name: 'Nope',
        }),
      },
      env,
    )
    expect(signup.status).toBeGreaterThanOrEqual(400)
  })

  it('team-owner invites solo@ as member → pending', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'team-owner@kit.local', TENANCY_PASSWORD, ORIGIN)
    const res = await app.request(
      '/api/orgs/org_team/invitations',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ email: 'solo@kit.local', role: 'member' }),
      },
      env,
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      invitation: { id: string; email: string; role: string; status: string }
    }
    expect(body.invitation.email).toBe('solo@kit.local')
    expect(body.invitation.role).toBe('member')
    expect(body.invitation.status).toBe('pending')
    expect(body.invitation.id.startsWith('inv_')).toBe(true)
  })

  it('invitee accepts with matching email → membership', async () => {
    const { app, env } = await seedEnv()
    const ownerCookie = await loginCookie(
      app,
      env,
      'team-owner@kit.local',
      TENANCY_PASSWORD,
      ORIGIN,
    )
    const create = await app.request(
      '/api/orgs/org_team/invitations',
      {
        method: 'POST',
        headers: sessionHeaders(ownerCookie, undefined, ORIGIN),
        body: JSON.stringify({ email: 'solo@kit.local', role: 'member' }),
      },
      env,
    )
    expect(create.status).toBe(201)
    const { invitation } = (await create.json()) as { invitation: { id: string } }

    const soloCookie = await loginCookie(app, env, 'solo@kit.local', TENANCY_PASSWORD, ORIGIN)
    const accept = await app.request(
      `/api/invitations/${invitation.id}/accept`,
      { method: 'POST', headers: sessionHeaders(soloCookie, undefined, ORIGIN), body: '{}' },
      env,
    )
    expect(accept.status).toBe(200)
    const acc = (await accept.json()) as {
      membership: { role: string; organizationId: string }
      org: { id: string }
    }
    expect(acc.org.id).toBe('org_team')
    expect(acc.membership.role).toBe('member')
    expect(acc.membership.organizationId).toBe('org_team')

    // second accept fails
    const again = await app.request(
      `/api/invitations/${invitation.id}/accept`,
      { method: 'POST', headers: sessionHeaders(soloCookie, undefined, ORIGIN), body: '{}' },
      env,
    )
    expect(again.status).toBe(404)
  })

  it('accept with mismatched email → 403', async () => {
    const { app, env } = await seedEnv()
    const ownerCookie = await loginCookie(
      app,
      env,
      'team-owner@kit.local',
      TENANCY_PASSWORD,
      ORIGIN,
    )
    const create = await app.request(
      '/api/orgs/org_team/invitations',
      {
        method: 'POST',
        headers: sessionHeaders(ownerCookie, undefined, ORIGIN),
        body: JSON.stringify({ email: 'solo@kit.local', role: 'reader' }),
      },
      env,
    )
    const { invitation } = (await create.json()) as { invitation: { id: string } }

    const staffCookie = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD, ORIGIN)
    const accept = await app.request(
      `/api/invitations/${invitation.id}/accept`,
      { method: 'POST', headers: sessionHeaders(staffCookie, undefined, ORIGIN), body: '{}' },
      env,
    )
    expect(accept.status).toBe(403)
    const body = (await accept.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toMatch(/email/i)
  })

  it('reader cannot create invite → 403', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'team-reader@kit.local', TENANCY_PASSWORD, ORIGIN)
    const res = await app.request(
      '/api/orgs/org_team/invitations',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ email: 'solo@kit.local', role: 'member' }),
      },
      env,
    )
    expect(res.status).toBe(403)
  })

  it('invite owner role → 400', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'team-owner@kit.local', TENANCY_PASSWORD, ORIGIN)
    const res = await app.request(
      '/api/orgs/org_team/invitations',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ email: 'solo@kit.local', role: 'owner' }),
      },
      env,
    )
    expect(res.status).toBe(400)
  })

  it('admin cannot invite admin (ceiling) → 400', async () => {
    const { app, env } = await seedEnv()
    // staff is admin on acme
    const cookie = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD, ORIGIN)
    const res = await app.request(
      '/api/orgs/org_acme/invitations',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ email: 'solo@kit.local', role: 'admin' }),
      },
      env,
    )
    // Phase B assertAssignableRole uses 403 for ceiling (forbidden), not validation 400
    expect(res.status).toBe(403)
  })

  it('cross-org delete invite → 404', async () => {
    const { app, env } = await seedEnv()
    const ownerCookie = await loginCookie(
      app,
      env,
      'team-owner@kit.local',
      TENANCY_PASSWORD,
      ORIGIN,
    )
    const create = await app.request(
      '/api/orgs/org_team/invitations',
      {
        method: 'POST',
        headers: sessionHeaders(ownerCookie, undefined, ORIGIN),
        body: JSON.stringify({ email: 'solo@kit.local', role: 'member' }),
      },
      env,
    )
    const { invitation } = (await create.json()) as { invitation: { id: string } }

    // solo owns org_solo but not team invite management
    const soloCookie = await loginCookie(app, env, 'solo@kit.local', TENANCY_PASSWORD, ORIGIN)
    const del = await app.request(
      `/api/orgs/org_solo/invitations/${invitation.id}`,
      { method: 'DELETE', headers: sessionHeaders(soloCookie, undefined, ORIGIN) },
      env,
    )
    expect(del.status).toBe(404)
  })

  it('sk_ cannot create or accept invites', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'team-owner@kit.local', TENANCY_PASSWORD, ORIGIN)
    const mint = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ organizationId: 'org_team', scopes: ['read', 'write', 'admin'] }),
      },
      env,
    )
    expect(mint.status).toBe(200)
    const { key } = (await mint.json()) as { key: string }

    const create = await app.request(
      '/api/orgs/org_team/invitations',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          Origin: ORIGIN,
          'X-Org-Id': 'org_team',
        },
        body: JSON.stringify({ email: 'solo@kit.local', role: 'member' }),
      },
      env,
    )
    expect(create.status).toBe(403)

    // create with session then try accept with sk_
    const okCreate = await app.request(
      '/api/orgs/org_team/invitations',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ email: 'solo@kit.local', role: 'member' }),
      },
      env,
    )
    const { invitation } = (await okCreate.json()) as { invitation: { id: string } }
    const accept = await app.request(
      `/api/invitations/${invitation.id}/accept`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          Origin: ORIGIN,
        },
        body: '{}',
      },
      env,
    )
    expect(accept.status).toBe(403)
  })

  it('already member → 409 on create', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'team-owner@kit.local', TENANCY_PASSWORD, ORIGIN)
    const res = await app.request(
      '/api/orgs/org_team/invitations',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ email: 'team-reader@kit.local', role: 'member' }),
      },
      env,
    )
    expect(res.status).toBe(409)
  })

  it('super_admin without membership cannot create invite', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'super@kit.local', TENANCY_PASSWORD, ORIGIN)
    const res = await app.request(
      '/api/orgs/org_team/invitations',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ email: 'solo@kit.local', role: 'member' }),
      },
      env,
    )
    // no membership → requireOrgContext 404 (not break-glass write)
    expect([403, 404]).toContain(res.status)
  })

  it('list pending + cancel works for owner', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'team-owner@kit.local', TENANCY_PASSWORD, ORIGIN)
    const create = await app.request(
      '/api/orgs/org_team/invitations',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ email: 'solo@kit.local', role: 'member' }),
      },
      env,
    )
    const { invitation } = (await create.json()) as { invitation: { id: string } }

    const list = await app.request(
      '/api/orgs/org_team/invitations',
      { headers: { cookie, Origin: ORIGIN } },
      env,
    )
    expect(list.status).toBe(200)
    const listed = (await list.json()) as { invitations: { id: string }[] }
    expect(listed.invitations.some((i) => i.id === invitation.id)).toBe(true)

    const del = await app.request(
      `/api/orgs/org_team/invitations/${invitation.id}`,
      { method: 'DELETE', headers: sessionHeaders(cookie, undefined, ORIGIN) },
      env,
    )
    expect(del.status).toBe(200)
  })

  it('BA native invite path remains DENY', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'team-owner@kit.local', TENANCY_PASSWORD, ORIGIN)
    const res = await app.request(
      '/api/auth/organization/invite-member',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ email: 'x@y.z', role: 'member' }),
      },
      env,
    )
    expect(res.status).toBe(404)
  })

  it('accept rejects invitationId that is not inv_ + 32 hex', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'solo@kit.local', TENANCY_PASSWORD, ORIGIN)
    for (const id of ['../keys', 'inv_short', 'not-an-id', `inv_${'A'.repeat(32)}`]) {
      const res = await app.request(
        `/api/invitations/${encodeURIComponent(id)}/accept`,
        { method: 'POST', headers: sessionHeaders(cookie, undefined, ORIGIN), body: '{}' },
        env,
      )
      expect(res.status, id).toBe(400)
    }
  })

  it('accept limiter keys on the subject without a platform address, never a shared bucket', async () => {
    const { app, env, db } = await seedEnv()
    const solo = await loginCookie(app, env, 'solo@kit.local', TENANCY_PASSWORD, ORIGIN)
    const staff = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD, ORIGIN)
    const missing = `inv_${'0'.repeat(32)}`
    const accept = (cookie: string, ip?: string) =>
      app.request(
        `/api/invitations/${missing}/accept`,
        {
          method: 'POST',
          headers: {
            ...sessionHeaders(cookie, undefined, ORIGIN),
            ...(ip ? { 'cf-connecting-ip': ip } : {}),
          },
          body: '{}',
        },
        env,
      )
    for (let i = 0; i < 30; i++) expect((await accept(solo)).status).toBe(404)
    expect((await accept(solo)).status).toBe(429)
    expect((await accept(staff)).status).toBe(404)
    // A caller-chosen header naming another subject never reaches that subject's bucket.
    const [soloUser] = await db.select().from(baUser).where(eq(baUser.email, 'solo@kit.local'))
    expect((await accept(staff, soloUser!.id)).status).toBe(404)
    expect((await accept(staff, `sub:${soloUser!.id}`)).status).toBe(404)
    // With a platform address, the address is the key.
    expect((await accept(solo, '203.0.113.80')).status).toBe(404)
  })
})
