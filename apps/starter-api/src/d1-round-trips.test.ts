import { apiKeyPrefix, generateApiKey, hashApiKey } from '@kit/auth'
import { insertApiKey } from '@kit/auth/repos/keys'
import { insertMember, insertOrganization } from '@kit/auth/repos/orgs'
import { createDb } from '@kit/db'
import { expect, it } from 'vitest'
import { createApp } from './app'
import { createRouteFixture } from './d1-route-fixture'
import { schema } from './platform/types'

const orgId = 'org-route-budget'
const budgets = [
  { route: 'GET /api/me', session: 7, apiKey: 11 },
  {
    route: 'GET /api/orgs/:orgId/members',
    path: `/api/orgs/${orgId}/members`,
    session: 6,
    apiKey: 10,
  },
] as const

it('budgets every protected Starter Hono registration', () => {
  // Multiple handlers for a method/path (for example, guards) are one HTTP route.
  const registered = new Set(createApp().routes.map(({ method, path }) => `${method} ${path}`))
  expect([...registered].sort()).toEqual(
    [
      'ALL /*', // global middleware
      'GET /health', // public health check
      'ALL /api/auth/*', // separately budgeted Better Auth mount
      ...budgets.map(({ route }) => route),
    ].sort(),
  )
})

it.each(budgets)('$route stays within its session and API key budgets', async (budget) => {
  const { env, request, cookie, measure } = await createRouteFixture()
  const session = await request('/api/auth/get-session', { headers: { cookie } })
  expect(session.status).toBe(200)
  const { user } = (await session.json()) as { user: { id: string } }
  const db = createDb(env.DB, schema)
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
  const fromSession = await measure(budget.route, budget.session, { path })
  const fromKey = await measure(budget.route, budget.apiKey, {
    path,
    headers: { authorization: `Bearer ${key}` },
  })
  if (budget.route === 'GET /api/me') {
    expect(await fromSession.json()).toMatchObject({ subject: user.id, authMethod: 'session' })
    expect(await fromKey.json()).toMatchObject({ subject: user.id, authMethod: 'api_key' })
  } else {
    for (const response of [fromSession, fromKey]) {
      expect(await response.json()).toMatchObject({
        members: expect.arrayContaining([expect.objectContaining({ userId: user.id })]),
      })
    }
  }
})
