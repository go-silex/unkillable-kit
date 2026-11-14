import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiKeyPrefix, generateApiKey, hashApiKey } from '@kit/auth'
import { baMember } from '@kit/auth/schema'
import { describe, expect, it } from 'vitest'
import { keyScopeRoutes } from './middleware/key-scopes'
import { TENANCY_PASSWORD } from './seed/tenancy-data'
import { mintApiKey } from './services/auth'
import {
  type ApiApp,
  bearerHeaders,
  createSeededDemoApi,
  loginCookie,
  sessionHeaders,
} from './test/api-fixture'

const ORG = 'org_acme'
const full = ['read', 'write', 'admin'] as const

function undeclaredRoutes(app: ApiApp): Set<string> {
  const routes = new Set<string>()
  for (const route of app.routes) {
    if (route.method === 'ALL' || route.method === 'OPTIONS' || route.method === 'HEAD') continue
    if (!route.path.startsWith('/')) continue
    if (keyScopeRoutes.some((entry) => entry.method === route.method && entry.path === route.path))
      continue
    const path = route.path.replace(/:[^/]+/g, 'scope-probe').replace(/\*/g, 'scope-probe')
    routes.add(`${route.method} ${path}`)
  }
  return routes
}

describe('API key scopes over HTTP', () => {
  it('requires explicit valid scopes when creating a key', async () => {
    const { app, env } = await createSeededDemoApi({ seed: { notes: true, environment: 'test' } })
    const cookie = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD)
    const create = (scopes?: unknown) =>
      app.request(
        '/api/keys',
        {
          method: 'POST',
          headers: sessionHeaders(cookie),
          body: JSON.stringify({
            organizationId: ORG,
            ...(scopes === undefined ? {} : { scopes }),
          }),
        },
        env,
      )
    for (const invalid of [undefined, [], ['unknown'], ['read', 'unknown']]) {
      expect((await create(invalid)).status).toBe(400)
    }
    expect((await create(['read'])).status).toBe(200)
  })

  it('enforces independent read, write and admin scopes and organization binding', async () => {
    const { app, env, db } = await createSeededDemoApi({
      seed: { notes: true, environment: 'test' },
    })
    const key = async (scopes: ('read' | 'write' | 'admin')[]) =>
      (await mintApiKey(db, 'user_staff', { organizationId: ORG, scopes })).key
    const read = await key(['read'])
    const write = await key(['write'])
    const admin = await key(['admin'])
    const all = await key([...full])
    const get = (token: string, org = ORG) =>
      app.request(`/api/orgs/${org}`, { headers: bearerHeaders(token) }, env)
    const post = (token: string, org = ORG) =>
      app.request(
        '/api/tasks',
        {
          method: 'POST',
          headers: bearerHeaders(token, org),
          body: JSON.stringify({ title: 'Scoped task', boardKey: 'main', visibility: 'shared' }),
        },
        env,
      )
    const patch = (token: string) =>
      app.request(
        '/api/orgs/org_acme/modules/tasks',
        {
          method: 'PATCH',
          headers: bearerHeaders(token),
          body: JSON.stringify({ enabled: true }),
        },
        env,
      )

    expect((await get(read)).status).toBe(200)
    expect((await get(write)).status).toBe(403)
    expect((await get(admin)).status).toBe(403)
    expect((await post(read)).status).toBe(403)
    expect((await post(admin)).status).toBe(403)
    expect((await post(write)).status).toBe(201)
    expect((await patch(read)).status).toBe(403)
    expect((await patch(write)).status).toBe(403)
    expect((await patch(admin)).status).toBe(200)
    expect((await get(all, 'org_beta')).status).toBe(403)
    expect((await post(all, 'org_beta')).status).toBe(403)
  })

  it('does not let scopes elevate the subject beyond its organization role', async () => {
    const { app, env, db } = await createSeededDemoApi({
      seed: { notes: true, environment: 'test' },
    })
    await db.insert(baMember).values({
      id: 'scope_reader_acme',
      organizationId: ORG,
      userId: 'user_team_reader',
      role: 'reader',
      createdAt: new Date(),
    })
    const { key } = await mintApiKey(db, 'user_team_reader', {
      organizationId: ORG,
      scopes: [...full],
    })
    const headers = bearerHeaders(key, ORG)
    expect((await app.request('/api/orgs/org_acme', { headers }, env)).status).toBe(200)
    expect(
      (
        await app.request(
          '/api/tasks',
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ title: 'Forbidden', boardKey: 'main', visibility: 'shared' }),
          },
          env,
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await app.request(
          '/api/orgs/org_acme/modules/tasks',
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ enabled: true }),
          },
          env,
        )
      ).status,
    ).toBe(403)
  })

  it('refuses an organization delete with an admin-scoped member key without changing the organization', async () => {
    const { app, env, db } = await createSeededDemoApi({
      seed: { notes: true, environment: 'test' },
    })
    const membership = await env.DB.prepare(
      'SELECT role FROM member WHERE organization_id = ? AND user_id = ?',
    )
      .bind(ORG, 'user_team_owner')
      .first()
    expect(membership).toEqual({ role: 'member' })
    const before = await env.DB.prepare('SELECT * FROM organization WHERE id = ?').bind(ORG).first()
    expect(before).toBeTruthy()
    const { key } = await mintApiKey(db, 'user_team_owner', {
      organizationId: ORG,
      scopes: ['admin'],
    })
    const response = await app.request(
      '/api/auth/organization/delete',
      {
        method: 'POST',
        headers: bearerHeaders(key, ORG),
        body: JSON.stringify({ organizationId: ORG }),
      },
      env,
    )
    expect(response.status).toBe(403)
    const after = await env.DB.prepare('SELECT * FROM organization WHERE id = ?').bind(ORG).first()
    expect(after).toEqual(before)
  })

  it('denies every registered route without a key scope declaration', async () => {
    const { app, env, db } = await createSeededDemoApi({
      seed: { notes: true, environment: 'test' },
    })
    const { key } = await mintApiKey(db, 'user_staff', { organizationId: ORG, scopes: [...full] })
    const routes = undeclaredRoutes(app)
    expect(routes.size).toBeGreaterThan(0)
    for (const route of routes) {
      const [method, path] = route.split(' ') as [string, string]
      const response = await app.request(
        path,
        {
          method,
          headers: bearerHeaders(key, ORG),
          ...(method === 'GET' ? {} : { body: '{}' }),
        },
        env,
      )
      expect(response.status, route).toBe(403)
    }
  })
})

describe('legacy API key scope migration', () => {
  it('backfills existing keys with all three independent scopes', async () => {
    const { app, env } = await createSeededDemoApi({
      env: { through: '0024_impersonation.sql' },
      seed: { notes: true, environment: 'test' },
    })
    const key = generateApiKey()
    await env.DB.prepare(`INSERT INTO api_keys
      (id, key_hash, key_prefix, subject, organization_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind('legacy', await hashApiKey(key), apiKeyPrefix(key), 'user_staff', ORG, 1)
      .run()
    const migrations = join(dirname(fileURLToPath(import.meta.url)), '../migrations')
    await env.DB.exec(readFileSync(join(migrations, '0025_api_keys_scopes.sql'), 'utf8'))
    const row = await env.DB.prepare('SELECT scopes FROM api_keys WHERE id = ?')
      .bind('legacy')
      .first()
    expect(row).toEqual({ scopes: 'read,write,admin' })
    const headers = bearerHeaders(key, ORG)
    expect((await app.request('/api/orgs/org_acme', { headers }, env)).status).toBe(200)
    expect(
      (
        await app.request(
          '/api/tasks',
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ title: 'Migrated key', boardKey: 'main', visibility: 'shared' }),
          },
          env,
        )
      ).status,
    ).toBe(201)
    expect(
      (
        await app.request(
          '/api/orgs/org_acme/modules/tasks',
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ enabled: true }),
          },
          env,
        )
      ).status,
    ).toBe(200)
  })
})
