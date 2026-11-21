import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { createSqliteD1 } from '@kit/db/testing'
import Database from 'better-sqlite3'
import { expect, it, onTestFinished } from 'vitest'
import worker from './index'
import type { Env } from './platform/types'

const origin = 'http://localhost:8787'
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

function fixture(withAssets: boolean) {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url))
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    sqlite.exec(readFileSync(`${directory}/${file}`, 'utf8'))
  }
  onTestFinished(() => {
    sqlite.close()
  })
  const assetUrls: string[] = []
  const assets = {
    async fetch(request: Request) {
      assetUrls.push(request.url)
      return new URL(request.url).pathname === '/'
        ? new Response('<html>site shell</html>', { headers: { 'content-type': 'text/html' } })
        : new Response('missing', { status: 404 })
    },
  } as Fetcher
  const env: Env & { ASSETS?: Fetcher } = {
    DB: createSqliteD1(sqlite) as unknown as D1Database,
    ENVIRONMENT: 'test',
    BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
    BETTER_AUTH_URL: origin,
    // originGuard checks every mutation's Origin, same-origin included.
    CORS_ORIGINS: origin,
    ALLOW_PUBLIC_SIGNUP: 'true',
    ...(withAssets ? { ASSETS: assets } : {}),
  }
  const request = (path: string, init?: RequestInit) =>
    worker.fetch(new Request(`${origin}${path}`, init), env, ctx)
  return { request, assetUrls }
}

it('composes the real API with the site and preserves same-origin sessions', async () => {
  const { request, assetUrls } = fixture(true)
  const page = await request('/dashboard', { headers: { accept: 'text/html' } })
  expect(page.status).toBe(200)
  expect(page.headers.get('content-type')).toContain('text/html')
  expect(page.headers.get('cache-control')).toBe('no-cache')
  expect(await page.text()).toContain('site shell')
  expect(assetUrls).toEqual([`${origin}/dashboard`, `${origin}/`])

  const missing = await request('/assets/missing.js', { headers: { accept: 'text/html' } })
  expect(missing.status).toBe(404)
  expect(missing.headers.get('content-type')).not.toContain('text/html')
  const unknown = await request('/api/missing', {
    headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
  })
  expect(unknown.status).toBe(404)
  expect(unknown.headers.get('content-type')).toContain('application/json')

  const credentials = { email: 'site@example.test', password: crypto.randomUUID(), name: 'Site' }
  const post = (path: string, body: object) =>
    request(path, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  expect((await post('/api/auth/sign-up/email', credentials)).status).toBeLessThan(400)
  const signin = await post('/api/auth/sign-in/email', {
    email: credentials.email,
    password: credentials.password,
  })
  expect(signin.status).toBe(200)
  const cookie = signin.headers.get('set-cookie')!.split(';')[0]!
  const me = await request('/api/me', { headers: { cookie } })
  expect(me.status).toBe(200)
  expect(((await me.json()) as { email: string }).email).toBe(credentials.email)
})

it('keeps API-only behavior when the binding is absent', async () => {
  const { request, assetUrls } = fixture(false)
  expect((await request('/health')).status).toBe(200)
  const missing = await request('/dashboard', { headers: { accept: 'text/html' } })
  expect(missing.status).toBe(404)
  expect(missing.headers.get('content-type')).toContain('application/json')
  expect(assetUrls).toEqual([])
})
