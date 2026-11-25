import { AppError } from '@kit/core'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { KitBetterAuth } from '../better-auth-factory'
import { createRequestAuthorization } from '../request/request-authorization'
import { continuation, exchange, login, request, setup, start } from './oidc-login-flow.fixture'

// The Example key and Platform Role columns the Kit core reads; the OIDC fixture omits them.
const KEY_SCHEMA = `
CREATE TABLE api_keys (id TEXT PRIMARY KEY NOT NULL, key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL UNIQUE, subject TEXT NOT NULL, name TEXT, created_at INTEGER NOT NULL,
  expires_at INTEGER, revoked_at INTEGER, organization_id TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT '');
CREATE TABLE user_platform_roles (user_id TEXT PRIMARY KEY NOT NULL, role TEXT NOT NULL,
  updated_at INTEGER NOT NULL);`

describe('Better Auth OIDC through the guarded mount', () => {
  it('lets Better Auth authenticate its own access token and keeps Kit keys refused', async () => {
    const fixture = await setup(true)
    fixture.sqlite.exec(KEY_SCHEMA)
    const authorization = createRequestAuthorization({
      db: () => fixture.database,
      auth: () => fixture.auth,
    })
    const app = new Hono()
    app.onError((error) => {
      if (error instanceof AppError)
        return Response.json({ kit: error.message }, { status: error.status })
      throw error
    })
    app.get('/api/me', authorization.requireAuth, (c) => c.json(authorization.view(c)))
    app.all('/api/auth/*', authorization.betterAuthMount, (c) => fixture.auth.handler(c.req.raw))
    // Every fixture request, the token exchange and userinfo included, crosses the Hono App.
    const mounted: KitBetterAuth = { ...fixture.auth, handler: (raw: Request) => app.fetch(raw) }

    const oauthQuery = await start(mounted, fixture.client.client_id, 'GET')
    const tokens = await exchange(
      mounted,
      fixture.client,
      await continuation(await login(mounted, oauthQuery)),
      'user@example.test',
    )

    const kitRoute = await request(mounted, '/api/me', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    expect(kitRoute.status).toBe(401)
    const unknownKey = 'sk_unknown_key_material'
    const kitKey = await request(mounted, '/api/auth/oauth2/userinfo', {
      headers: { authorization: `Bearer ${unknownKey}` },
    })
    expect(kitKey.status).toBe(401)
    expect(await kitKey.json()).toEqual({ kit: 'Unauthorized' })
  })
})
