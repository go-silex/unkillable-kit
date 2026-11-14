import { type Context, Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { describe, expect, it, vi } from 'vitest'
import type { BetterAuthLike } from '../better-auth-port'
import { generateApiKey } from '../keys'
import type { KitRepoDb } from '../repos/db-type'
import { findActiveOrgApiKeyByPrefix } from '../repos/keys'
import { createKitRequireAuth } from './kit-require-auth'

vi.mock('../repos/keys', () => ({ findActiveOrgApiKeyByPrefix: vi.fn(async () => null) }))

type Env = {
  Variables: {
    db?: KitRepoDb
    betterAuth?: BetterAuthLike
    subject?: string
    authMethod?: 'session' | 'api_key'
    keyOrganizationId?: string
    sessionId?: string
  }
}

const db = {} as KitRepoDb
const auth: BetterAuthLike = {
  api: {
    getSession: async () => ({
      user: { id: 'user-1' },
      session: { id: 'session-1', expiresAt: new Date(Date.now() + 60_000) },
    }),
  },
}

function app(options: { db?: boolean; auth?: boolean }) {
  const app = new Hono<Env>()
  app.use('*', async (c, next) => {
    if (options.db) c.set('db', db)
    if (options.auth) c.set('betterAuth', auth)
    await next()
  })
  app.get(
    '/protected',
    createKitRequireAuth<Context<Env>>(() => 'test.session'),
    (c) =>
      c.json({
        subject: c.get('subject'),
        method: c.get('authMethod'),
        session: c.get('sessionId'),
      }),
  )
  app.onError((err, c) =>
    c.json({ message: err.message }, ('status' in err ? err.status : 500) as ContentfulStatusCode),
  )
  return app
}

describe('createKitRequireAuth', () => {
  it('requires both request-scoped dependencies', async () => {
    expect((await app({ auth: true }).request('/protected')).status).toBe(500)
    expect((await app({ db: true }).request('/protected')).status).toBe(500)
  })

  it('resolves the Better Auth session into the request context', async () => {
    const response = await app({ db: true, auth: true }).request('/protected', {
      headers: { cookie: 'test.session=value' },
    })
    expect(await response.json()).toEqual({
      subject: 'user-1',
      method: 'session',
      session: 'session-1',
    })
  })

  it('uses organization-bound lookup for bearer credentials', async () => {
    const response = await app({ db: true, auth: true }).request('/protected', {
      headers: { authorization: `Bearer ${generateApiKey()}` },
    })
    expect(response.status).toBe(401)
    expect(findActiveOrgApiKeyByPrefix).toHaveBeenCalledWith(db, expect.any(String))
  })
})
