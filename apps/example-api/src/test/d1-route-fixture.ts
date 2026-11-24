import { countD1RoundTrips } from '@kit/db/testing'
import { expect } from 'vitest'
import { DEMO_EMAIL, DEMO_PASSWORD } from '../services/auth'
import { createSeededDemoApi, loginCookie, sessionHeaders, TEST_ORIGIN } from './api-fixture'

type Route = `${string} /${string}`

export type Probe = (
  route: Route,
  ceiling: number,
  options?: {
    path?: string
    headers?: HeadersInit
    body?: unknown
    status?: number
    exact?: true
    variant?: string
  },
) => Promise<Response>

export async function createRouteFixture(record?: Set<string>) {
  const { app, env, db } = await createSeededDemoApi({
    env: { CORS_ORIGINS: TEST_ORIGIN },
    seed: { environment: 'test' },
  })
  const cookie = await loginCookie(app, env, DEMO_EMAIL, DEMO_PASSWORD)
  const headers = sessionHeaders(cookie)
  const probe: Probe = async (route, ceiling, options = {}) => {
    const space = route.indexOf(' ')
    const requestHeaders = new Headers(headers)
    for (const [name, value] of new Headers(options.headers)) requestHeaders.set(name, value)
    if (requestHeaders.has('authorization')) requestHeaders.delete('cookie')
    const measured = countD1RoundTrips(env.DB)
    const response = await app.request(
      options.path ?? route.slice(space + 1),
      {
        method: route.slice(0, space),
        headers: requestHeaders,
        body: JSON.stringify(options.body),
      },
      { ...env, DB: measured.db },
    )
    const label = options.variant ? `${route} (${options.variant})` : route
    expect(response.status, label).toBe(options.status ?? 200)
    if (options.exact) expect(measured.count, label).toBe(ceiling)
    else measured.assertAtMost(label, ceiling)
    record?.add(label)
    return response
  }
  return { app, env, db, cookie, probe }
}
