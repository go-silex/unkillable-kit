import { expect, it } from 'vitest'
import { createApp } from '../app'
import { keyScopeRoutes } from '../middleware/key-scopes'
import { measureFlowsAndTasks } from './d1-flows-tasks'
import { measureNotificationsAndAdmin } from './d1-notification-admin'
import { measureOrganizations } from './d1-organization'
import { measureResources } from './d1-resource-routes'

it('classifies the ALL registrations that do not have their own route budget', () => {
  const registrations = new Map<string, number>()
  for (const { method, path } of createApp().routes) {
    if (method === 'ALL') registrations.set(path, (registrations.get(path) ?? 0) + 1)
  }
  // Hono uses ALL for middleware too. Compare multiplicities so an added handler
  // cannot hide behind an existing middleware registration with the same path.
  expect(Object.fromEntries(registrations)).toEqual({
    '/*': 8,
    '/api/admin/audit-events': 1,
    '/api/admin/audit-events/*': 1,
    '/api/admin/users': 2,
    '/api/admin/users/*': 2,
    '/api/auth/*': 1, // Actual Better Auth endpoints have a separate budget suite.
    '/api/demo/*': 1,
    '/api/flows': 3,
    '/api/flows/*': 3,
    '/api/invitations/*': 2,
    '/api/items': 1,
    '/api/items/*': 1,
    '/api/jobs': 1,
    '/api/jobs/*': 1,
    '/api/keys': 1,
    '/api/keys/*': 1,
    '/api/me': 1,
    '/api/modules': 1,
    '/api/modules/*': 1,
    '/api/notes': 1,
    '/api/notes/*': 1,
    '/api/orgs': 2,
    '/api/orgs/*': 2,
    '/api/platform/*': 2,
    '/api/tasks': 2,
    '/api/tasks/*': 2,
    '/api/uploads': 1,
    '/api/uploads/*': 1,
  })
})

it('caps D1 round trips on authenticated Example API routes', async () => {
  const measured = new Set<string>()
  await measureResources(measured)
  await measureOrganizations(measured)
  await measureNotificationsAndAdmin(measured)
  await measureFlowsAndTasks(measured)

  const routes = createApp().routes.filter(
    ({ method, path }) => method !== 'ALL' && !(method === 'GET' && path === '/health'),
  )
  const expected = new Set(routes.map(({ method, path }) => `${method} ${path}`))
  const keyRoutes = keyScopeRoutes.map(({ method, path }) => `${method} ${path} (api-key)`)
  expect([...measured].sort()).toEqual([...expected, ...keyRoutes].sort())
})
