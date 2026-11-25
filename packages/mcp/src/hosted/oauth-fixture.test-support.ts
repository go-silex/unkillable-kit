import { getOAuthApi } from '@cloudflare/workers-oauth-provider'
import { expect } from 'vitest'
import type { HostedMcpWorker } from './create-worker'
import type { HostedMcpEnv } from './env'

export const ORIGIN = 'http://127.0.0.1:8788'
const REDIRECT = 'http://127.0.0.1:9999/cb'
export const USER = 'user_demo'

type AuthorizationCode = { clientId: string; verifier: string; code: string }

class MemoryKv {
  private readonly data = new Map<string, { value: string; exp?: number }>()

  async get(key: string, opts?: { type?: string } | string) {
    const row = this.data.get(key)
    if (!row || (row.exp !== undefined && Date.now() > row.exp)) return null
    return (typeof opts === 'string' ? opts : opts?.type) === 'json'
      ? JSON.parse(row.value)
      : row.value
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number; expiration?: number }) {
    const exp =
      opts?.expiration !== undefined
        ? opts.expiration * 1000
        : opts?.expirationTtl !== undefined
          ? Date.now() + opts.expirationTtl * 1000
          : undefined
    this.data.set(key, { value, exp })
  }

  async delete(key: string) {
    this.data.delete(key)
  }
  async list(opts?: { prefix?: string }) {
    const keys = [...this.data.keys()].filter((key) => key.startsWith(opts?.prefix ?? '')).sort()
    return { keys: keys.map((name) => ({ name })), list_complete: true as const }
  }
}

export function createOAuthFixture(
  hosted: HostedMcpWorker<HostedMcpEnv>,
  db: D1Database,
  budget: { readonly count: number },
) {
  const env: HostedMcpEnv = { OAUTH_KV: new MemoryKv() as unknown as KVNamespace, DB: db }
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
  const fetch = (request: Request) => hosted.fetch(request, env, ctx)
  const unused = { fetch: async () => new Response(null, { status: 404 }) }
  const helpers = getOAuthApi(
    {
      apiRoute: '/mcp',
      apiHandler: unused,
      defaultHandler: unused,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      resourceMetadata: { resource: `${ORIGIN}/mcp` },
    },
    env,
  )

  async function code(mismatchedIdentity = false) {
    const registration = await fetch(
      new Request(`${ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          client_name: 'test',
        }),
      }),
    )
    expect(registration.status).toBe(201)
    const { client_id: clientId } = (await registration.json()) as { client_id: string }
    const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'
    const hash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    )
    const challenge = btoa(String.fromCharCode(...hash))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '')
    const url = new URL(`${ORIGIN}/authorize`)
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${ORIGIN}/mcp`,
    }))
      url.searchParams.set(key, value)
    let location: string
    if (mismatchedIdentity) {
      const request = await helpers.parseAuthRequest(new Request(url))
      const result = await helpers.completeAuthorization({
        request,
        userId: USER,
        scope: ['mcp'],
        metadata: {},
        props: { userId: 'different_user' },
      })
      location = result.redirectTo
    } else {
      const response = await fetch(new Request(url))
      expect(response.status).toBe(302)
      location = response.headers.get('location') ?? ''
    }
    const authorizationCode = new URL(location).searchParams.get('code')
    expect(authorizationCode).toBeTruthy()
    return { clientId, verifier, code: authorizationCode ?? '' }
  }

  function token(params: Record<string, string>) {
    return fetch(
      new Request(`${ORIGIN}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
      }),
    )
  }
  function exchange(c: AuthorizationCode, verifier = c.verifier) {
    return token({
      grant_type: 'authorization_code',
      code: c.code,
      client_id: c.clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: `${ORIGIN}/mcp`,
    })
  }
  function refresh(clientId: string, refreshToken: string) {
    return token({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
      resource: `${ORIGIN}/mcp`,
    })
  }
  async function issue() {
    const before = budget.count
    const c = await code()
    expect(budget.count - before).toBe(1)
    const response = await exchange(c)
    expect(response.status).toBe(200)
    expect(budget.count - before).toBe(2)
    const body = (await response.json()) as { access_token: string; refresh_token: string }
    expect(body.access_token).toBeTruthy()
    expect(body.refresh_token).toBeTruthy()
    const summary = await helpers.unwrapToken(body.access_token)
    expect(summary).not.toBeNull()
    return { ...c, ...body, summary: summary! }
  }
  return { fetch, code, exchange, refresh, issue, helpers }
}
