import { expect, it } from 'vitest'
import { createApp } from './app'
import { keyScopeRoutes } from './middleware/key-scopes'
import { measureFlowsAndTasks } from './test/d1-flows-tasks'
import { measureNotificationsAndAdmin } from './test/d1-notification-admin'
import { measureOrganizations } from './test/d1-organization'
import { measureResources } from './test/d1-resource-routes'

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
