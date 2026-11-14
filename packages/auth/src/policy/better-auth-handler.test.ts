import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { throttleBetterAuthRequest } from '../repos/ba-throttle'
import type { KitRepoDb } from '../repos/db-type'
import { type BetterAuthHandlerEnv, createBetterAuthHandler } from './better-auth-handler'

vi.mock('../repos/ba-throttle', () => ({ throttleBetterAuthRequest: vi.fn() }))

const db = {} as KitRepoDb
const getSession = vi.fn(async () => ({ user: { id: 'u' }, session: { id: 's' } }))
const handler = vi.fn(async (_request: Request) => new Response('ok'))

function app(options: { auth?: boolean; db?: boolean } = { auth: true, db: true }) {
  const app = new Hono<BetterAuthHandlerEnv>()
  app.use('*', async (c, next) => {
    if (options.db) c.set('db', db)
    if (options.auth) c.set('betterAuth', { api: { getSession }, handler })
    c.set('requestId', 'req_test')
    await next()
  })
  app.all('/api/auth/*', createBetterAuthHandler())
  app.onError((err, c) =>
    c.json({ message: err.message }, ('status' in err ? err.status : 500) as ContentfulStatusCode),
  )
  return app
}

describe('createBetterAuthHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requires the request-scoped auth and database', async () => {
    expect((await app({ db: true }).request('/api/auth/ok')).status).toBe(500)
    expect((await app({ auth: true }).request('/api/auth/ok')).status).toBe(500)
    expect(throttleBetterAuthRequest).not.toHaveBeenCalled()
  })

  it('denies Better Auth organization routes before spending throttle budget', async () => {
    expect((await app().request('/api/auth/organization/create', { method: 'POST' })).status).toBe(
      404,
    )
    expect(throttleBetterAuthRequest).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('throttles before proxying and provides the verified session id', async () => {
    const response = await app().request('/api/auth/ok')
    expect(await response.text()).toBe('ok')
    expect(throttleBetterAuthRequest).toHaveBeenCalledOnce()
    const input = vi.mocked(throttleBetterAuthRequest).mock.calls[0]![1]
    expect(await input.sessionId()).toBe('s')
    expect(handler).toHaveBeenCalledOnce()
    expect(getSession).toHaveBeenCalledWith({
      headers: input.request.headers,
      query: { disableRefresh: true },
    })
  })

  it('scrubs server errors and normalizes failed password sign-in', async () => {
    handler.mockResolvedValueOnce(new Response('secret', { status: 503 }))
    const failed = await app().request('/api/auth/ok')
    expect(failed.status).toBe(503)
    expect(await failed.text()).not.toContain('secret')
    handler.mockResolvedValueOnce(new Response('account detail', { status: 403 }))
    const signIn = await app().request('/api/auth/sign-in/email', { method: 'POST' })
    expect(signIn.status).toBe(401)
    expect(await signIn.text()).not.toContain('account detail')
  })
})
