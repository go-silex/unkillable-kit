import { readFileSync } from 'node:fs'
import { AppError } from '@kit/core'
import type { KitD1Database } from '@kit/db'
import { createSqliteD1 } from '@kit/db/testing'
import Database from 'better-sqlite3'
import { type Context, Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { expect, onTestFinished, vi } from 'vitest'
import { createBetterAuth } from '../better-auth-factory'
import { createRequestAuthorization } from '../hono'
import { apiKeyPrefix, generateApiKey, hashApiKey } from '../keys'
import { type AuthorizationRow, defineAuthorizationFact } from '../snapshot'

const origin = 'https://auth.example.test'
export const marker = 'product-fixture-label'
export const path = '/orgs/alpha/projection'
const migrations = new URL('../../../../apps/example-api/migrations/', import.meta.url)
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
export const projection = {
  table: { name: 'product_cards', columns: ['organization_id', 'label'] },
  scope: { kind: 'organization', organizationId: 'organization_id' } as const,
  select: ['label'],
  maxRows: 1,
}

export async function fixture(invalidModule = false) {
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

  const failure = {
    partial: false,
    productSibling: false,
    malformedPolicy: undefined as 'availability' | 'grant' | undefined,
  }
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
      if (failure.malformedPolicy === 'availability') {
        results[2] = { success: true, results: [{ enabled: 2, available: 1 }] }
      } else if (failure.malformedPolicy === 'grant') {
        results[3] = { success: true, results: [{ access: 'unknown' }] }
      }
      if (failure.productSibling) {
        const index = results.findIndex((result) =>
          result.results.some(
            (row) =>
              typeof row === 'object' && row !== null && Object.hasOwn(row, 'organization_id'),
          ),
        )
        if (index >= 0) results[index] = { success: false, results: [] }
      }
      batches.push(results)
      return results
    },
  }
  const decode = vi.fn((rows: readonly AuthorizationRow[]) => rows[0]?.label)
  const productFact = defineAuthorizationFact({ ...projection, decode })
  const sibling = defineAuthorizationFact({
    ...projection,
    select: ['organization_id'],
    decode: (rows) => rows[0]?.organization_id,
  })
  const authorization = createRequestAuthorization({
    db: () => db,
    auth: () => auth,
    moduleFacts: (id) =>
      id === 'notes' ? { availability, grant: invalidModule ? availability : grant } : undefined,
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
    '/overlap/chosen',
    authorization.requireAuth,
    authorization.requireOrgContext(),
    authorization.includeFacts(productFact),
    async (c) => c.json({ label: await authorization.fact(c, productFact) }),
  )
  app.get(
    '/overlap/:orgId',
    authorization.requireAuth,
    authorization.requireOrgContext(),
    authorization.requireModule('notes'),
    (c) => c.json({ fallback: true }),
  )
  app.get('/conflict/:orgId/tail', authorization.requireAuth, (c) => c.json({ ok: true }))
  app.get('/conflict/start/:name', authorization.requireAuth, (c) => c.json({ ok: true }))
  const productHandler = vi.fn(async (c: Context) =>
    c.json({ label: await authorization.fact(c, productFact) }),
  )
  const rejectedRead = vi.fn<(status: number | string) => void>()
  app.use('/all/*', async (c, next) => {
    await next()
    if (c.res.status !== 503) return
    try {
      await authorization.fact(c, productFact)
      rejectedRead('exposed')
    } catch (error) {
      rejectedRead(error instanceof AppError ? error.status : 'unexpected')
    }
  })
  app.all(
    '/all/:orgId',
    authorization.allEndpoint,
    authorization.requireAuth,
    authorization.requireOrgContext(),
    authorization.includeFacts(productFact, sibling),
    productHandler,
  )
  app.use('/middleware/:orgId/status', authorization.requireAuth)
  app.use('/middleware/:orgId/*', authorization.requireAuth)
  app.get('/middleware/:section/status', authorization.requireOrgContext(), (c) =>
    c.json({ admitted: true }),
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
  const database: {
    exec(sql: string): void
    prepare(sql: string): { run(...values: unknown[]): unknown; readonly: boolean }
  } = sqlite
  return {
    app,
    batches,
    cookie,
    decode,
    failure,
    key,
    prepare,
    productHandler,
    rejectedRead,
    sqlite: database,
    userId: user.id,
  }
}
