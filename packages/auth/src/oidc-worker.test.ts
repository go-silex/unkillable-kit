import { EventEmitter, once } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose'
import { Miniflare, Response as MiniflareResponse } from 'miniflare'
import { expect, it } from 'vitest'

const ORIGIN = 'https://auth.example.test'
const ISSUER = `${ORIGIN}/api/auth`
const REDIRECT = 'https://client.example.test/callback'
const LOGOUT_URI = 'https://client.example.test/backchannel-logout'
const VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'
const root = dirname(fileURLToPath(import.meta.url))

it('delivers a signed back-channel logout using the Workers execution context', async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./oidc-worker.fixture.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    external: ['node:*'],
  })
  const deliveries: { url: string; method: string; body: string }[] = []
  const events = new EventEmitter()
  const deliveryReceived = once(events, 'delivered')
  const miniflare = new Miniflare({
    workers: [
      {
        config: {
          name: 'oidc-logout-test',
          compatibilityDate: '2026-07-01',
          compatibilityFlags: ['nodejs_compat'],
          env: {
            DB: {
              type: 'd1',
              name: 'oidc-logout-test',
              id: '00000000-0000-0000-0000-000000000001',
            },
          },
          manifest: {
            mainModule: 'worker.mjs',
            modulesRoot: root,
            modules: { 'worker.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } },
          },
        },
        dev: {
          outboundService: {
            type: 'fetcher',
            handler: async (request) => {
              if (new URL(request.url).pathname === '/__test/background-complete') {
                events.emit('delivered')
              } else {
                deliveries.push({
                  url: request.url,
                  method: request.method,
                  body: await request.text(),
                })
              }
              return new MiniflareResponse(null, { status: 200 })
            },
          },
        },
      },
    ],
  })
  try {
    const db = await miniflare.getD1Database('DB')
    for (const migration of [
      '0005_better_auth.sql',
      '0006_better_auth_organization.sql',
      '0014_better_auth_1_7_additive.sql',
      '0025_account_state.sql',
      '0027_better_auth_oidc_provider.sql',
    ]) {
      const sql = readFileSync(
        new URL(`../../../apps/example-api/migrations/${migration}`, import.meta.url),
        'utf8',
      )
      const statements = sql
        .replace(/^\s*--.*$/gm, '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
      for (const statement of statements) await db.prepare(statement).run()
    }
    const signup = await miniflare.dispatchFetch(`${ISSUER}/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({
        name: 'Example User',
        email: 'user@example.test',
        password: 'example-password-123',
      }),
    })
    expect(signup.status).toBe(200)
    const { user } = (await signup.json()) as { user: { id: string } }
    const cookie = signup.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    expect(cookie).not.toBe('')
    const registration = await miniflare.dispatchFetch(`${ORIGIN}/__test/register`, {
      headers: { cookie },
    })
    expect(registration.status).toBe(200)
    const client = (await registration.json()) as { client_id: string; client_secret: string }
    expect(client.client_secret).toBeTruthy()
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(VERIFIER))
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      scope: 'openid email profile',
      code_challenge: Buffer.from(hash).toString('base64url'),
      code_challenge_method: 'S256',
      nonce: 'worker-test-nonce',
    })
    const authorization = await miniflare.dispatchFetch(`${ISSUER}/oauth2/authorize?${query}`, {
      headers: { cookie, accept: 'text/html' },
      redirect: 'manual',
    })
    // dispatchFetch is a fetch request; the provider returns its redirect as JSON.
    expect(authorization.status).toBe(200)
    const authorizationBody = (await authorization.json()) as { redirect: boolean; url: string }
    expect(authorizationBody.redirect).toBe(true)
    const callback = new URL(authorizationBody.url)
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT)
    const code = callback.searchParams.get('code')
    expect(code).toBeTruthy()
    const token = await miniflare.dispatchFetch(`${ISSUER}/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }),
    })
    expect(token.status).toBe(200)
    const storedToken = await db
      .prepare('SELECT session_id, client_id FROM oauth_access_token WHERE user_id = ?')
      .bind(user.id)
      .first<{ session_id: string | null; client_id: string }>()
    expect(storedToken).toMatchObject({
      client_id: client.client_id,
      session_id: expect.any(String),
    })
    const storedClient = await db
      .prepare('SELECT disabled, backchannel_logout_uri FROM oauth_client WHERE client_id = ?')
      .bind(client.client_id)
      .first<{ disabled: number | null; backchannel_logout_uri: string | null }>()
    expect(storedClient).toMatchObject({ backchannel_logout_uri: LOGOUT_URI })
    expect(storedClient?.disabled ?? 0).toBe(0)
    const logout = await miniflare.dispatchFetch(`${ORIGIN}/__test/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: user.id }),
    })
    expect(await logout.json()).toMatchObject({ success: true, backgroundTasks: 1 })
    expect(logout.status).toBe(200)
    await deliveryReceived
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({ url: LOGOUT_URI, method: 'POST' })
    const logoutToken = new URLSearchParams(deliveries[0].body).get('logout_token')
    expect(logoutToken).toBeTruthy()
    const jwksResponse = await miniflare.dispatchFetch(`${ISSUER}/jwks`)
    const jwks = (await jwksResponse.json()) as JSONWebKeySet
    const { payload, protectedHeader } = await jwtVerify(
      logoutToken as string,
      createLocalJWKSet(jwks),
      {
        issuer: ISSUER,
        audience: client.client_id,
        algorithms: ['RS256'],
      },
    )
    expect(protectedHeader.alg).toBe('RS256')
    expect(payload).toMatchObject({
      sub: user.id,
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    })
    expect(payload.jti).toEqual(expect.any(String))
    expect(payload.nonce).toBeUndefined()
  } finally {
    await miniflare.dispose()
  }
}, 30_000)
