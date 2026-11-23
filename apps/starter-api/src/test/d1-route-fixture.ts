import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { countD1RoundTrips, createSqliteD1 } from '@kit/db/testing'
import Database from 'better-sqlite3'
import { expect, onTestFinished } from 'vitest'
import worker from '../index'
import type { Env } from '../platform/types'

export const starterTestOrigin = 'http://localhost:8787'
export const routeFixtureCredentials = {
  email: 'route-budget@example.test',
  password: crypto.randomUUID(),
  name: 'Route Budget Fixture',
}
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

type SiteEnv = Env & { ASSETS?: Fetcher }
type Route = `${string} /${string}`
type MeasureOptions = { path?: string; headers?: HeadersInit; body?: unknown; status?: number }

export function createStarterHttpFixture(bindings: Pick<SiteEnv, 'ASSETS'> = {}) {
  const sqlite = new Database(':memory:')
  onTestFinished(() => {
    sqlite.close()
  })
  sqlite.pragma('foreign_keys = ON')
  const directory = fileURLToPath(new URL('../../migrations/', import.meta.url))
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    sqlite.exec(readFileSync(`${directory}/${file}`, 'utf8'))
  }
  const env: SiteEnv = {
    DB: createSqliteD1(sqlite) as unknown as D1Database,
    ENVIRONMENT: 'test',
    BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
    BETTER_AUTH_URL: starterTestOrigin,
    CORS_ORIGINS: starterTestOrigin,
    ALLOW_PUBLIC_SIGNUP: 'true',
    ...bindings,
  }
  const request = (path: string, init?: RequestInit, requestEnv = env) =>
    worker.fetch(new Request(`${starterTestOrigin}${path}`, init), requestEnv, ctx)
  return { env, request }
}

function headersWithOrigin(init?: HeadersInit) {
  const headers = new Headers(init)
  if (!headers.has('origin')) headers.set('origin', starterTestOrigin)
  return headers
}

export async function createRouteFixture() {
  const { env, request: dispatch } = createStarterHttpFixture()
  const request = (path: string, init?: RequestInit) =>
    dispatch(path, { ...init, headers: headersWithOrigin(init?.headers) })
  const signup = await request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(routeFixtureCredentials),
  })
  expect(signup.status, 'test session signup').toBe(200)
  const cookie = signup.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error('Test session signup did not set a cookie')

  const measure = async (route: Route, ceiling: number, options: MeasureOptions = {}) => {
    const split = route.indexOf(' ')
    const method = route.slice(0, split)
    const path = options.path ?? route.slice(split + 1)
    const headers = headersWithOrigin(options.headers)
    const apiKey = headers.has('authorization')
    if (!(headers.has('cookie') || apiKey)) headers.set('cookie', cookie)
    const body = JSON.stringify(options.body)
    if (body !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
    const counted = countD1RoundTrips(env.DB)
    const response = await dispatch(path, { method, headers, body }, { ...env, DB: counted.db })
    const label = apiKey ? `${route} (api-key)` : route
    expect(response.status, label).toBe(options.status ?? 200)
    counted.assertAtMost(label, ceiling)
    return response
  }
  return { env, request, cookie, measure }
}
