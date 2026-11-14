import { baMember, baOrganization } from '@kit/auth/schema'
import { createDb } from '@kit/db'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createApp } from './app'
import { apiKeys, schema } from './db/schema'
import { seedTenancyDemo } from './seed/seed-tenancy'
import { loginCookie } from './test/api-fixture'
import { hashFixtureCredential } from './test/fixture-credential'
import { createMemoryEnv } from './test/memory-env'

const BA_ENV = {
  BETTER_AUTH_SECRET: 'test-better-auth-secret-at-least-32!!',
  BETTER_AUTH_URL: 'http://localhost:8787',
  ALLOW_PUBLIC_SIGNUP: 'true',
  ENVIRONMENT: 'test',
}

const ORIGIN = 'http://localhost:5173'

async function seedEnv() {
  const app = createApp()
  const env = createMemoryEnv(BA_ENV)
  const db = createDb(env.DB as unknown as D1Database, schema)
  await seedTenancyDemo(db, { environment: 'test', force: true }, hashFixtureCredential)
  return { app, env, db }
}

describe('org RBAC (ADR-0003 Phase A) — IDOR matrix', () => {
  it('org routes require auth (no anonymous list)', async () => {
    const app = createApp()
    const env = createMemoryEnv(BA_ENV)
    const res = await app.request('/api/orgs', {}, env)
    expect(res.status).toBe(401)
  })

  it('BA org mutation paths are denied (Phase A seed-only)', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'staff@kit.local', 'demo-password-change-me', ORIGIN)
    const res = await app.request(
      '/api/auth/organization/create',
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          Origin: ORIGIN,
        },
        body: JSON.stringify({ name: 'Evil', slug: 'evil' }),
      },
      env,
    )
    expect(res.status).toBe(404)
  })

  it('staff can open acme membership org', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'staff@kit.local', 'demo-password-change-me', ORIGIN)
    const res = await app.request(
      '/api/orgs/org_acme',
      { headers: { cookie, Origin: ORIGIN } },
      env,
    )
    expect(res.status).toBe(200)
  })

  it('staff without membership gets 404 on solo org', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'staff@kit.local', 'demo-password-change-me', ORIGIN)
    const res = await app.request(
      '/api/orgs/org_solo',
      { headers: { cookie, Origin: ORIGIN } },
      env,
    )
    expect(res.status).toBe(404)
  })

  it('team reader cannot PATCH org modules', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(
      app,
      env,
      'team-reader@kit.local',
      'demo-password-change-me',
      ORIGIN,
    )
    const res = await app.request(
      '/api/orgs/org_team/modules/demo',
      {
        method: 'PATCH',
        headers: {
          cookie,
          'content-type': 'application/json',
          Origin: ORIGIN,
        },
        body: JSON.stringify({ enabled: true }),
      },
      env,
    )
    expect(res.status).toBe(403)
  })

  it('non-super platform PATCH modules is 403', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'staff@kit.local', 'demo-password-change-me', ORIGIN)
    const res = await app.request(
      '/api/platform/modules/demo',
      {
        method: 'PATCH',
        headers: {
          cookie,
          'content-type': 'application/json',
          Origin: ORIGIN,
        },
        body: JSON.stringify({ available: true }),
      },
      env,
    )
    expect(res.status).toBe(403)
  })

  it('path vs X-Org-Id mismatch returns 403', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'staff@kit.local', 'demo-password-change-me', ORIGIN)
    const res = await app.request(
      '/api/orgs/org_acme',
      {
        headers: {
          cookie,
          Origin: ORIGIN,
          'X-Org-Id': 'org_beta',
        },
      },
      env,
    )
    expect(res.status).toBe(403)
  })

  it('BA mint requires organizationId', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'staff@kit.local', 'demo-password-change-me', ORIGIN)
    const res = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          Origin: ORIGIN,
        },
        body: JSON.stringify({ scopes: ['read', 'write', 'admin'] }),
      },
      env,
    )
    expect(res.status).toBe(400)
  })

  it('mint for non-member org is forbidden', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'staff@kit.local', 'demo-password-change-me', ORIGIN)
    const res = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          Origin: ORIGIN,
        },
        body: JSON.stringify({ organizationId: 'org_solo', scopes: ['read', 'write', 'admin'] }),
      },
      env,
    )
    expect(res.status).toBe(403)
  })

  it('org-bound key cannot hop to another membership org', async () => {
    const { app, env, db } = await seedEnv()
    const cookie = await loginCookie(app, env, 'staff@kit.local', 'demo-password-change-me', ORIGIN)
    const mint = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          Origin: ORIGIN,
        },
        body: JSON.stringify({ organizationId: 'org_acme', scopes: ['read', 'write', 'admin'] }),
      },
      env,
    )
    expect(mint.status).toBe(200)
    const { key } = (await mint.json()) as { key: string }

    // positive control: key works on its org
    const okAcme = await app.request(
      '/api/orgs/org_acme',
      { headers: { authorization: `Bearer ${key}`, Origin: ORIGIN } },
      env,
    )
    expect(okAcme.status).toBe(200)

    // staff is also member of beta — key must not authorize beta routes
    const hop = await app.request(
      '/api/orgs/org_beta',
      {
        headers: {
          authorization: `Bearer ${key}`,
          Origin: ORIGIN,
        },
      },
      env,
    )
    expect(hop.status).toBe(403)

    // membership removed → key dead
    await db.delete(baMember).where(eq(baMember.id, 'mem_org_acme_user_staff'))
    const dead = await app.request('/api/me', { headers: { authorization: `Bearer ${key}` } }, env)
    expect(dead.status).toBe(401)
  })

  /**
   * ADR-0003 D11 + INV-04 / 0015: organization_id is NOT NULL.
   * Legacy nullable rows are deleted by 0015; the column cannot be nulled again.
   */
  it('api_keys.organization_id cannot be nulled after 0015', async () => {
    const { app, env, db } = await seedEnv()
    const cookie = await loginCookie(app, env, 'staff@kit.local', 'demo-password-change-me', ORIGIN)
    const mint = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ organizationId: 'org_acme', scopes: ['read', 'write', 'admin'] }),
      },
      env,
    )
    expect(mint.status).toBe(200)
    const { key, keyPrefix } = (await mint.json()) as { key: string; keyPrefix: string }

    const ok = await app.request('/api/me', { headers: { authorization: `Bearer ${key}` } }, env)
    expect(ok.status).toBe(200)

    // `set({ organizationId: null })` is rejected by drizzle's types (column is NOT NULL);
    // raw SQL NULL is the only way to make the attempt the DB must refuse.
    await expect(
      db.update(apiKeys).set({ organizationId: sql`NULL` }).where(eq(apiKeys.keyPrefix, keyPrefix)),
    ).rejects.toThrow()

    const still = await app.request('/api/me', { headers: { authorization: `Bearer ${key}` } }, env)
    expect(still.status).toBe(200)
  })

  it('suspended org is denied', async () => {
    const { app, env, db } = await seedEnv()
    await db
      .update(baOrganization)
      .set({ status: 'suspended' })
      .where(eq(baOrganization.id, 'org_acme'))
    const cookie = await loginCookie(app, env, 'staff@kit.local', 'demo-password-change-me', ORIGIN)
    const res = await app.request(
      '/api/orgs/org_acme',
      { headers: { cookie, Origin: ORIGIN } },
      env,
    )
    expect(res.status).toBe(403)
  })

  it('super_admin cannot write tenant modules without break-glass', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'super@kit.local', 'demo-password-change-me', ORIGIN)
    // super is not a member of org_solo; write default off → 404 (no membership leak path)
    const res = await app.request(
      '/api/orgs/org_solo/modules/demo',
      {
        method: 'PATCH',
        headers: {
          cookie,
          'content-type': 'application/json',
          Origin: ORIGIN,
        },
        body: JSON.stringify({ enabled: true }),
      },
      env,
    )
    expect(res.status).toBe(404)
  })

  it('super_admin can read foreign org with allowSuperAdmin route', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'super@kit.local', 'demo-password-change-me', ORIGIN)
    // GET /api/orgs/:id uses allowSuperAdmin: true
    const res = await app.request(
      '/api/orgs/org_solo',
      { headers: { cookie, Origin: ORIGIN } },
      env,
    )
    expect(res.status).toBe(200)
  })

  it('team owner can list own org members', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(
      app,
      env,
      'team-owner@kit.local',
      'demo-password-change-me',
      ORIGIN,
    )
    const res = await app.request(
      '/api/orgs/org_team/members',
      { headers: { cookie, Origin: ORIGIN } },
      env,
    )
    expect(res.status).toBe(200)
  })

  it('super_admin can list platform modules; staff can list too', async () => {
    const { app, env } = await seedEnv()
    const superCookie = await loginCookie(
      app,
      env,
      'super@kit.local',
      'demo-password-change-me',
      ORIGIN,
    )
    const staffCookie = await loginCookie(
      app,
      env,
      'staff@kit.local',
      'demo-password-change-me',
      ORIGIN,
    )
    const s = await app.request(
      '/api/platform/modules',
      { headers: { cookie: superCookie, Origin: ORIGIN } },
      env,
    )
    expect(s.status).toBe(200)
    const st = await app.request(
      '/api/platform/modules',
      { headers: { cookie: staffCookie, Origin: ORIGIN } },
      env,
    )
    expect(st.status).toBe(200)
  })

  it('GET /api/platform/modules rejects an org-bound staff API key', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'staff@kit.local', 'demo-password-change-me', ORIGIN)
    const mint = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          Origin: ORIGIN,
        },
        body: JSON.stringify({ organizationId: 'org_acme', scopes: ['read', 'write', 'admin'] }),
      },
      env,
    )
    expect(mint.status).toBe(200)
    const { key } = (await mint.json()) as { key: string }

    const denied = await app.request(
      '/api/platform/modules',
      { headers: { authorization: `Bearer ${key}`, Origin: ORIGIN } },
      env,
    )
    expect(denied.status).toBe(403)
    const body = (await denied.json()) as { error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('team owner can GET org modules effective shape', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(
      app,
      env,
      'team-owner@kit.local',
      'demo-password-change-me',
      ORIGIN,
    )
    const res = await app.request(
      '/api/orgs/org_team/modules',
      { headers: { cookie, Origin: ORIGIN } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      modules: { demo: { available: boolean; effective: boolean } }
    }
    expect(body.modules.demo).toHaveProperty('available')
    expect(body.modules.demo).toHaveProperty('effective')
  })

  it('key list includes organizationId; org list scoped for bound key', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'staff@kit.local', 'demo-password-change-me', ORIGIN)
    const mint = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          Origin: ORIGIN,
        },
        body: JSON.stringify({
          organizationId: 'org_acme',
          name: 'acme-bot',
          scopes: ['read', 'write', 'admin'],
        }),
      },
      env,
    )
    expect(mint.status).toBe(200)
    const { key } = (await mint.json()) as { key: string }
    const list = await app.request('/api/keys', { headers: { cookie, Origin: ORIGIN } }, env)
    expect(list.status).toBe(200)
    const listBody = (await list.json()) as {
      keys: { organizationId: string | null; name: string | null }[]
    }
    expect(listBody.keys.some((k) => k.organizationId === 'org_acme')).toBe(true)

    const orgs = await app.request(
      '/api/orgs',
      { headers: { authorization: `Bearer ${key}`, Origin: ORIGIN } },
      env,
    )
    expect(orgs.status).toBe(200)
    const orgsBody = (await orgs.json()) as { orgs: { id: string }[] }
    expect(orgsBody.orgs.every((o) => o.id === 'org_acme')).toBe(true)
    expect(orgsBody.orgs.map((o) => o.id)).toEqual(['org_acme'])

    // D11 me.orgs: multi-membership staff key bound to acme must not list beta
    const me = await app.request(
      '/api/me',
      { headers: { authorization: `Bearer ${key}`, Origin: ORIGIN } },
      env,
    )
    expect(me.status).toBe(200)
    const meBody = (await me.json()) as { orgs: { id: string }[]; authMethod: string }
    expect(meBody.authMethod).toBe('api_key')
    expect(meBody.orgs.map((o) => o.id).sort()).toEqual(['org_acme'])
  })

  it('D11: Bearer listApiKeys scopes to key org (staff multi-org)', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'staff@kit.local', 'demo-password-change-me', ORIGIN)

    const mintAcme = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({
          organizationId: 'org_acme',
          name: 'acme-only',
          scopes: ['read', 'write', 'admin'],
        }),
      },
      env,
    )
    expect(mintAcme.status).toBe(200)
    const { key: acmeKey } = (await mintAcme.json()) as { key: string }

    const mintBeta = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({
          organizationId: 'org_beta',
          name: 'beta-only',
          scopes: ['read', 'write', 'admin'],
        }),
      },
      env,
    )
    expect(mintBeta.status).toBe(200)

    // Session still sees all subject keys
    const sessionList = await app.request('/api/keys', { headers: { cookie, Origin: ORIGIN } }, env)
    expect(sessionList.status).toBe(200)
    const sessionBody = (await sessionList.json()) as {
      keys: { organizationId: string | null; name: string | null }[]
    }
    const orgsOnSession = new Set(sessionBody.keys.map((k) => k.organizationId))
    expect(orgsOnSession.has('org_acme')).toBe(true)
    expect(orgsOnSession.has('org_beta')).toBe(true)

    // Bearer acme key: only acme keys, never beta
    const bearerList = await app.request(
      '/api/keys',
      { headers: { authorization: `Bearer ${acmeKey}`, Origin: ORIGIN } },
      env,
    )
    expect(bearerList.status).toBe(200)
    const bearerBody = (await bearerList.json()) as {
      keys: { organizationId: string | null; name: string | null }[]
    }
    expect(bearerBody.keys.length).toBeGreaterThan(0)
    expect(bearerBody.keys.every((k) => k.organizationId === 'org_acme')).toBe(true)
    expect(bearerBody.keys.some((k) => k.name === 'acme-only')).toBe(true)
    expect(bearerBody.keys.some((k) => k.organizationId === 'org_beta')).toBe(false)
  })
})
