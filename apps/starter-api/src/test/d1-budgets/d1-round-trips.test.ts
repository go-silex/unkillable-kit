import { apiKeyPrefix, generateApiKey, hashApiKey } from '@kit/auth'
import { insertApiKey } from '@kit/auth/repos/keys'
import { insertMember, insertOrganization } from '@kit/auth/repos/orgs'
import { setPlatformRole } from '@kit/auth/repos/platform-roles'
import { createDb } from '@kit/db'
import { expect, it } from 'vitest'
import { createApp } from '../../app'
import { schema } from '../../platform/types'
import { createRouteFixture } from '../d1-route-fixture'

const orgId = 'org-route-budget'
// One authorization batch, plus two profile reads or one member-list read.
const budgets = [
  { route: 'GET /api/me', session: 3, apiKey: 3 },
  {
    route: 'GET /api/orgs/:orgId/members',
    path: `/api/orgs/${orgId}/members`,
    session: 2,
    apiKey: 2,
  },
] as const

it('budgets every protected Starter Hono registration', () => {
  // Multiple handlers for a method/path (for example, guards) are one HTTP route.
  const routes = createApp().routes
  expect(routes.filter(({ method }) => method === 'ALL').map(({ path }) => path)).toEqual([
    ...Array<string>(6).fill('/*'), // global middleware
    '/api/auth/*', // separately budgeted Better Auth mount
  ])
  const registered = new Set(
    routes.filter(({ method }) => method !== 'ALL').map(({ method, path }) => `${method} ${path}`),
  )
  expect([...registered].sort()).toEqual(
    [
      'GET /health', // public health check
      ...budgets.map(({ route }) => route),
    ].sort(),
  )
})

it.each(budgets)('$route uses its exact session and API key budgets', async (budget) => {
  const { env, request, cookie, measure } = await createRouteFixture()
  const session = await request('/api/auth/get-session', { headers: { cookie } })
  expect(session.status).toBe(200)
  const { user } = (await session.json()) as { user: { id: string } }
  const db = createDb(env.DB, schema)
  if (budget.route === 'GET /api/me') await setPlatformRole(db, user.id, 'staff')
  const createdAt = new Date()
  await insertOrganization(db, {
    id: orgId,
    name: 'Route Budget Organization',
    slug: orgId,
    kind: 'client',
    status: 'active',
    createdAt,
  })
  await insertMember(db, {
    id: 'member-route-budget',
    organizationId: orgId,
    userId: user.id,
    role: 'member',
    createdAt,
  })
  const key = generateApiKey()
  await insertApiKey(db, {
    id: 'key-route-budget',
    keyHash: await hashApiKey(key),
    keyPrefix: apiKeyPrefix(key),
    subject: user.id,
    organizationId: orgId,
    scopes: 'read',
    createdAt: createdAt.getTime(),
  })

  const path = 'path' in budget ? budget.path : undefined
  const fromSession = await measure(budget.route, budget.session, { path, exact: true })
  const fromKey = await measure(budget.route, budget.apiKey, {
    path,
    exact: true,
    headers: { authorization: `Bearer ${key}` },
  })
  if (budget.route === 'GET /api/me') {
    const expected = { subject: user.id, platformRole: 'staff' }
    expect(await fromSession.json()).toMatchObject({ ...expected, authMethod: 'session' })
    expect(await fromKey.json()).toMatchObject({ ...expected, authMethod: 'api_key' })
  } else {
    for (const response of [fromSession, fromKey]) {
      expect(await response.json()).toMatchObject({
        members: expect.arrayContaining([expect.objectContaining({ userId: user.id })]),
      })
    }
  }
})
