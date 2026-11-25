import { OpenAPIHono } from '@hono/zod-openapi'
import { hashApiKey } from '@kit/auth'
import { MODULE_DENIAL } from '@kit/auth/hono'
import { deleteGrant, findRoleByKey, listGrantsForRole } from '@kit/auth/repos/org-roles'
import { apiKeys, baMember, baSession, baUser, impersonationSessions } from '@kit/auth/schema'
import type { SqliteD1 } from '@kit/db/testing'
import { countD1RoundTrips } from '@kit/db/testing'
import { FLOWS_MODULE_ID } from '@kit/flows'
import { listRunsForOrg } from '@kit/flows/repos'
import { TASKS_MODULE_ID } from '@kit/tasks'
import { eq } from 'drizzle-orm'
import { expect, it, vi } from 'vitest'
import { authorization, keyScopeRoutes } from '../middleware/authorization'
import { withBetterAuth } from '../middleware/better-auth'
import { withDb } from '../middleware/db'
import { onError } from '../middleware/error-handler'
import { requestIdMiddleware } from '../middleware/request-id'
import { orgsRoutes } from '../routes/orgs'
import { TENANCY_PASSWORD } from '../seed/tenancy-data'
import { mintApiKey } from '../services/auth'
import type { AppEnv } from '../types'
import {
  type ApiApp,
  bearerHeaders,
  createSeededDemoApi,
  loginCookie,
  sessionHeaders,
} from './api-fixture'
import { enableFlowsForOrgs, expectError } from './flows-fixture'

const ORG = 'org_acme'
const OWNER = 'team-owner@kit.local'
const STAFF = 'staff@kit.local'
const PRIVATE_TASK = 'private-request-authorization-row'
const PRIVATE_FAULT = 'private-driver-failure'
const OWNER_PROFILE = 'private-owner-profile@example.test'
const OUTSIDER_PROFILE = 'private-outsider-profile@example.test'
const unavailable = { code: 'INTERNAL_ERROR', message: 'Internal error' }

async function setup() {
  return createSeededDemoApi({ seed: { environment: 'test', notes: false } })
}

function observeRefusal(app: ApiApp) {
  const seen = vi.fn()
  app.onError((error, c) => {
    seen(authorization.view(c), c.get('subject'), c.get('orgId'))
    return onError(error, c)
  })
  return seen
}

function instrumentBatch(binding: SqliteD1, batch: SqliteD1['batch']): SqliteD1 {
  return new Proxy(binding, {
    get(target, name, receiver) {
      if (name === 'batch') return batch
      if (name === 'withSession') throw new Error('Authorization must use the primary D1 binding')
      return Reflect.get(target, name, receiver)
    },
  })
}

it('does not read or disclose admitted task rows on credential, scope, fence, organization, module or partial-batch refusal', async () => {
  const { app, env, db } = await setup()
  const owner = await loginCookie(app, env, OWNER, TENANCY_PASSWORD)
  const outsider = await loginCookie(app, env, 'solo@kit.local', TENANCY_PASSWORD)
  await db.update(baUser).set({ email: OWNER_PROFILE }).where(eq(baUser.id, 'user_team_owner'))
  await db.update(baUser).set({ email: OUTSIDER_PROFILE }).where(eq(baUser.id, 'user_solo'))
  const { key } = await mintApiKey(db, 'user_team_owner', {
    organizationId: ORG,
    scopes: ['write'],
  })
  const keyHash = await hashApiKey(key)
  const headers = sessionHeaders(owner, ORG)
  const created = await app.request(
    '/api/tasks',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: PRIVATE_TASK, boardKey: 'main', visibility: 'shared' }),
    },
    env,
  )
  expect(created.status).toBe(201)
  const admitted = await app.request('/api/tasks', { headers }, env)
  expect(admitted.status).toBe(200)
  expect(await admitted.text()).toContain(PRIVATE_TASK)

  const warn = vi.spyOn(console, 'warn')
  const error = vi.spyOn(console, 'error')
  try {
    for (const [refusal, credentials, status, privateCoreValue] of [
      ['credential', { ...headers, authorization: 'Bearer invalid' }, 401, OWNER_PROFILE],
      ['scope', bearerHeaders(key, ORG), 403, keyHash],
      ['fence', { ...headers, 'X-Impersonation-Id': 'retired-context' }, 409, OWNER_PROFILE],
      ['organization', sessionHeaders(outsider, ORG), 404, OUTSIDER_PROFILE],
      ['partial batch', headers, 503, OWNER_PROFILE],
      ['module', headers, 403, OWNER_PROFILE],
    ] as const) {
      if (refusal === 'module') {
        const role = await findRoleByKey(db, ORG, 'member')
        expect(await deleteGrant(db, ORG, role!.id, TASKS_MODULE_ID)).toBe(true)
      }
      const measured = countD1RoundTrips(env.DB)
      let privateValueRead = false
      const binding = instrumentBatch(measured.db, async (statements) => {
        const results = await measured.db.batch(statements)
        privateValueRead = JSON.stringify(results).includes(privateCoreValue)
        if (refusal !== 'partial batch' || !Array.isArray(results)) return results
        return [...results.slice(0, -1), { success: false, error: PRIVATE_FAULT }]
      })
      const response = await app.request(
        '/api/tasks',
        { headers: credentials },
        { ...env, DB: binding },
      )
      expect(response.status, refusal).toBe(status)
      expect(measured.count, refusal).toBe(1)
      expect(privateValueRead, refusal).toBe(true)
      const body = await response.text()
      expect(body).not.toContain(PRIVATE_TASK)
      expect(body).not.toContain(owner)
      expect(body).not.toContain(key)
      expect(body).not.toContain(privateCoreValue)
      if (refusal === 'partial batch')
        expect(JSON.parse(body)).toMatchObject({ error: unavailable })
    }
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls])
    for (const secret of [
      PRIVATE_TASK,
      PRIVATE_FAULT,
      OWNER_PROFILE,
      OUTSIDER_PROFILE,
      owner,
      key,
      keyHash,
    ]) {
      expect(logged).not.toContain(secret)
    }
  } finally {
    warn.mockRestore()
    error.mockRestore()
  }
})

it('distinguishes an Example key-scope decision from a failed hook before projection or Product IO', async () => {
  const { app, env, db } = await setup()
  const observed = observeRefusal(app)
  const read = await mintApiKey(db, 'user_staff', { organizationId: ORG, scopes: ['read'] })
  const write = await mintApiKey(db, 'user_staff', { organizationId: ORG, scopes: ['write'] })
  const path = `/api/orgs/${ORG}`
  const request = (key: string, DB = env.DB) =>
    app.request(path, { headers: bearerHeaders(key) }, { ...env, DB })
  expect((await request(read.key)).status).toBe(200)
  const denied = countD1RoundTrips(env.DB)
  expect((await request(write.key, denied.db)).status).toBe(403)
  expect(denied.count).toBe(1)
  const scope = vi.spyOn(keyScopeRoutes, 'some').mockImplementation(() => {
    throw new Error(PRIVATE_FAULT)
  })
  try {
    const failed = countD1RoundTrips(env.DB)
    const response = await request(read.key, failed.db)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: unavailable })
    expect(failed.count).toBe(1)
    expect(scope).toHaveBeenCalledOnce()
  } finally {
    scope.mockRestore()
  }
  expect(observed.mock.calls).toEqual([
    [{}, undefined, undefined],
    [{}, undefined, undefined],
  ])
})

it('compares path and header Organization IDs exactly; an unavailable Product column cannot mask a Kit refusal', async () => {
  const { app, env, db } = await setup()
  const cookie = await loginCookie(app, env, STAFF, TENANCY_PASSWORD)
  const path = `/api/orgs/${ORG}`
  expect((await app.request(path, { headers: sessionHeaders(cookie, ORG) }, env)).status).toBe(200)
  for (const [address, org, status] of [
    ['/api/orgs/ORG_ACME', undefined, 404],
    [`${path}%20`, undefined, 400],
    [path, 'ORG_ACME', 403],
    [path, `${ORG}\u00a0`, 400],
    [path, `${ORG}, ${ORG}`, 400],
  ] as const) {
    expect(
      (await app.request(address, { headers: sessionHeaders(cookie, org) }, env)).status,
      address,
    ).toBe(status)
  }
  const byHeader = '/api/tasks'
  expect((await app.request(byHeader, { headers: sessionHeaders(cookie, ORG) }, env)).status).toBe(
    200,
  )
  expect(
    (await app.request(byHeader, { headers: sessionHeaders(cookie, 'ORG_ACME') }, env)).status,
  ).toBe(404)

  // The Kit reads only closed core columns. This breaks the handler's Product detail query.
  await env.DB.exec('ALTER TABLE organization RENAME COLUMN logo TO broken_product_logo')
  const request = (address: string) =>
    app.request(address, { headers: sessionHeaders(cookie) }, env)
  expect((await request(path)).status).toBe(503)
  expect((await request('/api/orgs/org_solo')).status).toBe(404)
  await db.run(`UPDATE organization SET status = 'suspended' WHERE id = '${ORG}'`)
  expect((await request(path)).status).toBe(403)
})

it('does not normalize a routed identifier or equate TEXT to BLOB or numeric lookalikes', async () => {
  const { app, env } = await setup()
  const cookie = await loginCookie(app, env, STAFF, TENANCY_PASSWORD)
  const composed = 'org_café'
  for (const id of [composed, '02']) {
    await env.DB.prepare(
      'INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, 1)',
    )
      .bind(id, id, id)
      .run()
    await env.DB.prepare(
      'INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, 1)',
    )
      .bind(`test-member-${id}`, id, 'user_staff', 'admin')
      .run()
  }
  await env.DB.exec(`
    INSERT INTO organization (id, name, slug, created_at)
      VALUES (CAST('org_blob' AS BLOB), 'Noncanonical', 'noncanonical-org', 1);
    INSERT INTO member (id, organization_id, user_id, role, created_at)
      VALUES ('test-member-blob', CAST('org_blob' AS BLOB), 'user_staff', 'admin', 1);
  `)
  const get = (id: string) =>
    app.request(`/api/orgs/${encodeURIComponent(id)}`, { headers: sessionHeaders(cookie) }, env)
  expect((await get(composed)).status).toBe(200)
  expect((await get('02')).status).toBe(200)
  for (const id of [composed.normalize('NFD'), '2', 'org_blob']) {
    expect((await get(id)).status, id).toBe(404)
  }
})

it('lets Hono resolve overlapping OpenAPI routes, ALL fall-through, and unknown addresses', async () => {
  const { app, env, db } = await setup()
  const fallThrough = vi.fn()
  app.all('/api/tasks/stages', async (_c, next) => {
    fallThrough()
    await next()
  })
  app.all('/route-probe', async (_c, next) => {
    fallThrough()
    await next()
  })
  app.get('/route-probe', (c) => c.json({ next: true }))
  const cookie = await loginCookie(app, env, STAFF, TENANCY_PASSWORD)
  const { key } = await mintApiKey(db, 'user_staff', { organizationId: ORG, scopes: ['read'] })
  const browser = sessionHeaders(cookie, ORG)
  const machine = bearerHeaders(key, ORG)
  const get = (path: string, headers = browser) => app.request(path, { headers }, env)
  // Both /links and /:id match. The static endpoint should win even with key-scope enabled.
  const links = await get('/api/tasks/links', machine)
  expect(links.status).toBe(200)
  expect(await links.json()).toMatchObject({ links: expect.any(Array) })
  expect((await get('/api/tasks/stages')).status).toBe(200)
  expect((await get('/api/tasks/stages', machine)).status).toBe(403)
  expect(fallThrough).not.toHaveBeenCalled()
  expect(await (await get('/route-probe')).json()).toEqual({ next: true })
  expect(fallThrough).toHaveBeenCalledOnce()
  expect((await get('/api/tasks/unknown/address')).status).toBe(404)
  expect((await get('/api/tasks/unknown/address', machine)).status).toBe(403)
  const measured = countD1RoundTrips(env.DB)
  const counted = (path: string) =>
    app.request(path, { headers: machine }, { ...env, DB: measured.db })
  expect((await counted('/api/orgs/unknown/address')).status).toBe(404)
  const health = await counted('/health')
  expect(health.status).toBe(200)
  expect(await health.json()).not.toHaveProperty('subject')
  expect(measured.count).toBe(0)
})

it.each(['organization role', 'key scopes', 'delegation'] as const)(
  'honors a %s change between the identity and routed Organization loads',
  async (change) => {
    const { app, env, db } = await setup()
    const cookie = await loginCookie(app, env, STAFF, TENANCY_PASSWORD)
    const key = await mintApiKey(db, 'user_staff', { organizationId: ORG, scopes: ['read'] })
    // Require identity in a prefix before the mounted Example endpoint can see :orgId.
    const edge = new OpenAPIHono<AppEnv>()
    edge.use('*', requestIdMiddleware, withDb, withBetterAuth)
    edge.onError(onError)
    edge.use('/api/orgs/*', authorization.requireAuth)
    edge.route('/', orgsRoutes)
    const request = (DB = env.DB) =>
      edge.request(
        `/api/orgs/${ORG}${change === 'organization role' ? '/members' : ''}`,
        { headers: change === 'key scopes' ? bearerHeaders(key.key) : sessionHeaders(cookie) },
        { ...env, DB },
      )
    const control = countD1RoundTrips(env.DB)
    expect((await request(control.db)).status).toBe(200)
    expect(control.count).toBe(3)
    const [session] = await db
      .select({ id: baSession.id })
      .from(baSession)
      .where(eq(baSession.userId, 'user_staff'))
    const refused = countD1RoundTrips(env.DB)
    const batch = vi.fn(async (statements: object[]) => {
      const result = await refused.db.batch(statements)
      if (batch.mock.calls.length === 1) {
        if (change === 'organization role') {
          await db
            .update(baMember)
            .set({ role: 'reader' })
            .where(eq(baMember.id, 'mem_org_acme_user_staff'))
        } else if (change === 'key scopes') {
          await db.update(apiKeys).set({ scopes: 'write' }).where(eq(apiKeys.id, key.id))
        } else {
          await db.insert(impersonationSessions).values({
            id: 'between-loads-delegation',
            sessionId: session!.id,
            actorUserId: 'user_staff',
            subjectUserId: 'user_team_owner',
            organizationId: ORG,
            mode: 'read',
            createdAt: 1,
          })
        }
      }
      return result
    })
    const binding = instrumentBatch(refused.db, batch)
    const response = await request(binding)
    expect(response.status).toBe(change === 'organization role' ? 403 : 503)
    if (change !== 'organization role')
      expect(await response.json()).toMatchObject({ error: unavailable })
    expect(batch).toHaveBeenCalledTimes(2)
    expect(refused.count).toBe(2)
  },
)

it('refuses to mint a Capability Grant after the Kit batch without repairing the Role–module grant or queuing a run', async () => {
  const { app, env, db } = await setup()
  await enableFlowsForOrgs(db, [ORG])
  const cookie = await loginCookie(app, env, STAFF, TENANCY_PASSWORD)
  const headers = sessionHeaders(cookie, ORG)
  const published = await app.request(
    '/api/flows/plans',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        yaml: `flows: v0
plan:
  id: grant-race
permits:
  tools: []
tasks:
  gate:
    approve: {}
`,
      }),
    },
    env,
  )
  expect(published.status).toBe(201)
  const { plan } = (await published.json()) as { plan: { id: string } }
  const role = await findRoleByKey(db, ORG, 'admin')
  expect(role).not.toBeNull()
  const observed = observeRefusal(app)
  const schedule = vi.fn(env.FLOW_RUN.create)
  const batch = vi.fn(async (statements: object[]) => {
    const result = await env.DB.batch(statements)
    if (batch.mock.calls.length === 1) {
      // The Kit snapshot still has the grant; the Product mint must read current policy.
      expect(await deleteGrant(db, ORG, role!.id, FLOWS_MODULE_ID)).toBe(true)
    }
    return result
  })

  const refused = await app.request(
    `/api/flows/plans/${plan.id}/runs`,
    { method: 'POST', headers, body: '{}' },
    {
      ...env,
      DB: instrumentBatch(env.DB, batch),
      FLOW_RUN: { ...env.FLOW_RUN, create: schedule },
    },
  )
  await expectError(refused, 403, 'FORBIDDEN', MODULE_DENIAL.insufficientGrant)
  expect(batch).toHaveBeenCalledTimes(1)
  const modules = observed.mock.calls[0]?.[0].organization?.modules
  expect(modules?.get(FLOWS_MODULE_ID)).toMatchObject({ available: true, access: 'write' })
  expect((await listGrantsForRole(db, role!.id)).map((grant) => grant.moduleId)).not.toContain(
    FLOWS_MODULE_ID,
  )
  expect(await listRunsForOrg(db, ORG)).toEqual([])
  expect(schedule).not.toHaveBeenCalled()
})

it('shares one failed primary load between two concurrent identity callers without projecting or dispatching', async () => {
  const { app, env } = await setup()
  const observed = observeRefusal(app)
  const entered = vi.fn()
  app.get('/test/concurrent-identity', async (c) => {
    const [first, second] = await Promise.allSettled([
      authorization.session(c),
      authorization.session(c),
    ])
    if (
      first.status === 'rejected' &&
      second.status === 'rejected' &&
      first.reason === second.reason
    ) {
      throw first.reason
    }
    entered()
    return c.json({ entered: true })
  })
  const cookie = await loginCookie(app, env, STAFF, TENANCY_PASSWORD)
  const batch = vi.fn(async () => {
    throw new Error(PRIVATE_FAULT)
  })
  const response = await app.request(
    '/test/concurrent-identity',
    { headers: sessionHeaders(cookie) },
    { ...env, DB: instrumentBatch(env.DB, batch) },
  )
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ error: unavailable })
  expect(batch).toHaveBeenCalledOnce()
  expect(entered).not.toHaveBeenCalled()
  expect(observed.mock.calls).toEqual([[{}, undefined, undefined]])
})
