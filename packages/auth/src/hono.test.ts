import { readFileSync } from 'node:fs'
import { inspect } from 'node:util'
import { AppError } from '@kit/core'
import type { KitD1Database } from '@kit/db'
import { createSqliteD1 } from '@kit/db/testing'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createBetterAuth } from './better-auth-factory'
import { createRequestAuthorization } from './hono'
import { apiKeyPrefix, generateApiKey, hashApiKey } from './keys'
import { type AuthorizationRow, defineAuthorizationFact } from './snapshot'

const origin = 'https://auth.example.test'
const marker = 'product-fixture-label'
const path = '/orgs/alpha/projection'
const migrations = new URL('../../../apps/example-api/migrations/', import.meta.url)
const availability = defineAuthorizationFact({
  table: {
    name: 'organization_modules',
    columns: ['organization_id', 'module_id', 'enabled', 'available'],
  },
  scope: { kind: 'organization', organizationId: 'organization_id' },
  select: ['enabled', 'available'],
  where: { module_id: 'notes' },
  maxRows: 1,
  decode: (rows) => rows[0],
})
const grant = defineAuthorizationFact({
  table: { name: 'organization_role_module_grants', columns: ['role_id', 'module_id', 'access'] },
  scope: { kind: 'organization-role', roleId: 'role_id' },
  select: ['access'],
  where: { module_id: 'notes' },
  maxRows: 1,
  decode: (rows) => rows[0],
})
const projection = {
  table: { name: 'product_cards', columns: ['organization_id', 'label'] },
  scope: { kind: 'organization', organizationId: 'organization_id' } as const,
  select: ['label'],
  maxRows: 1,
}

async function fixture() {
  const sqlite = new Database(':memory:')
  onTestFinished(() => {
    sqlite.close()
  })
  for (const migration of [
    '0001_init.sql',
    '0003_kit_modules.sql',
    '0004_kit_modules_config.sql',
    '0005_better_auth.sql',
    '0006_better_auth_organization.sql',
    '0007_rbac_modules.sql',
    '0008_api_keys_organization.sql',
    '0009_organization_roles_grants.sql',
    '0010_rate_limit_audit.sql',
    '0014_better_auth_1_7_additive.sql',
    '0015_api_keys_org_not_null.sql',
    '0025_account_state.sql',
    '0026_api_keys_scopes.sql',
  ]) {
    sqlite.exec(readFileSync(new URL(migration, migrations), 'utf8'))
  }
  const realDb = createSqliteD1(sqlite)
  const auth = createBetterAuth({
    database: realDb,
    secret: crypto.randomUUID() + crypto.randomUUID(),
    baseURL: origin,
    trustedOrigins: [origin],
    allowPublicSignup: true,
  })
  const signup = await auth.handler(
    new Request(new URL('/api/auth/sign-up/email', origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        name: 'Member',
        email: 'member@example.test',
        password: crypto.randomUUID(),
      }),
    }),
  )
  expect(signup.status).toBe(200)
  const { user } = (await signup.json()) as { user: { id: string } }
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ')
  expect(cookie).not.toBe('')

  sqlite.exec(
    [
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('alpha', 'Alpha', 'alpha', 1)",
      "INSERT INTO organization_roles VALUES ('alpha-member', 'alpha', 'member', 'Member', 0, 1)",
      "INSERT INTO platform_modules (module_id, available, updated_at) VALUES ('notes', 1, 1)",
      "INSERT INTO organization_modules (organization_id, module_id, enabled, updated_at) VALUES ('alpha', 'notes', 1, 1)",
      "INSERT INTO organization_role_module_grants VALUES ('alpha-member', 'notes', 'read')",
      'CREATE TABLE product_cards (organization_id TEXT NOT NULL, label TEXT NOT NULL)',
    ].join('; '),
  )
  sqlite
    .prepare(
      'INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run('membership', 'alpha', user.id, 'member', 1)
  sqlite.prepare('INSERT INTO product_cards VALUES (?, ?)').run('alpha', marker)
  const key = generateApiKey()
  sqlite
    .prepare(
      'INSERT INTO api_keys (id, key_hash, key_prefix, subject, organization_id, scopes, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run('key', await hashApiKey(key), apiKeyPrefix(key), user.id, 'alpha', 'read', 1)

  const failure = { partial: false }
  const batches: { success: boolean; results: unknown[] }[][] = []
  const prepare = vi.fn(realDb.prepare)
  const db: KitD1Database = {
    ...realDb,
    prepare,
    async batch(statements) {
      const results = (await realDb.batch(statements)) as (typeof batches)[number]
      if (failure.partial) {
        // An unsuccessful sibling response does not erase the successful Product result.
        results[0] = { success: false, results: [] }
      }
      batches.push(results)
      return results
    },
  }
  const decode = vi.fn((rows: readonly AuthorizationRow[]) => rows[0]?.label)
  const productFact = defineAuthorizationFact({ ...projection, decode })
  const authorization = createRequestAuthorization({
    db: () => db,
    auth: () => auth,
    moduleFacts: (id) => (id === 'notes' ? { availability, grant } : undefined),
  })
  const app = new Hono()
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json({ message: error.message }, error.status as ContentfulStatusCode)
      : c.json({ message: 'Unexpected error' }, 500),
  )
  app.get(
    '/orgs/:orgId/projection',
    async (c, next) => {
      if (c.req.header('authorization')) {
        const identity = await authorization.authenticateKey(c)
        if (identity.scopes.includes('read')) authorization.admitKeyScope(c)
      }
      await next()
    },
    authorization.requireAuth,
    authorization.requireOrgContext(),
    authorization.requireModule('notes'),
    authorization.includeFacts(productFact),
    async (c) => c.json({ label: await authorization.fact(c, productFact) }),
  )
  app.get(
    '/orgs/:orgId/admin',
    authorization.requireAuth,
    authorization.requireOrgContext(),
    authorization.requireOrgRole('admin'),
    (c) => c.json({ ok: true }),
  )
  app.get('/staff', authorization.requireAuth, authorization.requirePlatformRole('staff'), (c) =>
    c.json({ ok: true }),
  )
  app.post(
    '/orgs/:orgId/write',
    authorization.requireAuth,
    authorization.requireOrgContext({ allowSuperAdmin: true }),
    (c) => c.json({ ok: true }),
  )
  app.delete(
    '/orgs/:orgId',
    authorization.requireAuth,
    authorization.requireOrgContext({ allowSuperAdminWrite: true }),
    authorization.requireOrgCapability('delete_org'),
    (c) => c.json({ ok: true }),
  )
  return { app, batches, cookie, decode, failure, key, prepare, sqlite, userId: user.id }
}

describe('HTTP authorization facts', () => {
  it.each([
    ['unverified credential', 401, 'Unauthorized'],
    ['missing key scope', 403, 'Forbidden'],
    ['missing Module grant', 403, 'Insufficient module grant'],
    ['unavailable Module', 404, 'Module not available'],
    ['partially failed load', 503, 'Authorization unavailable'],
  ] as const)(
    'does not expose a returned Product row after %s',
    async (reason, status, message) => {
      const { app, batches, cookie, decode, failure, key, prepare, sqlite } = await fixture()
      const headers = new Headers({ cookie })
      if (reason === 'unverified credential' || reason === 'missing key scope') {
        headers.set('authorization', 'Bearer ' + key)
      }

      const admitted = await app.request(path, { headers })
      expect(admitted.status).toBe(200)
      expect(batches).toHaveLength(1)
      expect(await admitted.json()).toEqual({ label: marker })
      expect(decode).toHaveBeenCalledExactlyOnceWith([{ label: marker }])
      decode.mockClear()
      batches.length = 0

      switch (reason) {
        case 'unverified credential':
          headers.set('authorization', 'Bearer ' + key + 'invalid')
          break
        case 'missing key scope':
          sqlite.exec("UPDATE api_keys SET scopes = 'write'")
          break
        case 'missing Module grant':
          sqlite.exec('DELETE FROM organization_role_module_grants')
          break
        case 'unavailable Module':
          sqlite.exec('UPDATE platform_modules SET available = 0')
          break
        case 'partially failed load':
          failure.partial = true
          break
      }
      const output = (['info', 'warn', 'error', 'log', 'debug'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation(() => {}),
      )
      onTestFinished(() => {
        for (const spy of output) spy.mockRestore()
      })

      const refused = await app.request(path, { headers })
      expect(refused.status).toBe(status)
      expect(await refused.json()).toEqual({ message })
      expect(batches).toHaveLength(1)
      expect(batches[0]).toContainEqual({ success: true, results: [{ label: marker }] })
      for (const [sql] of prepare.mock.calls) expect(sqlite.prepare(sql).readonly).toBe(true)
      expect(decode).not.toHaveBeenCalled()
      for (const spy of output)
        expect(inspect(spy.mock.calls, { depth: null })).not.toContain(marker)
    },
  )

  it('refuses absent or malformed credentials without a fact read or cookie fallback', async () => {
    const { app, batches, cookie, decode, prepare } = await fixture()
    expect((await app.request(path)).status).toBe(401)
    const malformed = await app.request(path, {
      headers: { cookie, authorization: 'Bearer short' },
    })
    expect(malformed.status).toBe(401)
    expect(batches).toHaveLength(0)
    expect(prepare).not.toHaveBeenCalled()
    expect(decode).not.toHaveBeenCalled()
  })

  it('rejects invalid or private fact declarations', () => {
    const decode = vi.fn()
    expect(() => defineAuthorizationFact({ ...projection, maxRows: 0, decode })).toThrow(TypeError)
    expect(() =>
      defineAuthorizationFact({
        ...projection,
        table: { ...projection.table, name: 'session' },
        decode,
      }),
    ).toThrow(TypeError)
    expect(decode).not.toHaveBeenCalled()
  })

  it('enforces organization and platform roles and limits break-glass actions', async () => {
    const { app, cookie, sqlite, userId } = await fixture()
    const headers = { cookie }
    expect((await app.request('/orgs/alpha/admin', { headers })).status).toBe(403)
    sqlite.exec("UPDATE member SET role = 'admin'")
    expect((await app.request('/orgs/alpha/admin', { headers })).status).toBe(200)
    expect((await app.request('/staff', { headers })).status).toBe(403)
    sqlite
      .prepare('INSERT INTO user_platform_roles (user_id, role, updated_at) VALUES (?, ?, ?)')
      .run(userId, 'staff', 1)
    expect((await app.request('/staff', { headers })).status).toBe(200)

    sqlite.exec("DELETE FROM member; UPDATE user_platform_roles SET role = 'super_admin';")
    expect((await app.request('/orgs/alpha/write', { method: 'POST', headers })).status).toBe(403)
    expect((await app.request('/orgs/alpha', { method: 'DELETE', headers })).status).toBe(403)
  })
})
