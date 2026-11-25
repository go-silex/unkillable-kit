import { getOAuthApi } from '@cloudflare/workers-oauth-provider'
import { countD1RoundTrips } from '@kit/db/testing'
import { expect } from 'vitest'
import { createAuthFixture } from './auth-fixture.test-support'
import { createHostedMcpWorker, type HostedMcpWorkerOptions } from './create-worker'
import type { HostedMcpEnv } from './env'

const ORIGIN = 'http://127.0.0.1:8788'
const REDIRECT = 'http://127.0.0.1:9999/cb'
export const USER = 'user_demo'

type Options = HostedMcpWorkerOptions<HostedMcpEnv>
export type Admission = NonNullable<Options['grantAdmission']>
type AuthorizationCode = { clientId: string; verifier: string; code: string }

type AccountState = 'active' | 'disabled' | 'missing' | 'unavailable'

function admissionDb() {
  const { db, sqlite } = createAuthFixture(USER)
  let unavailable = false
  let unreadable = false
  let beforeBatch: (() => void) | undefined
  const budget = countD1RoundTrips({
    ...db,
    async batch(statements: unknown[]) {
      beforeBatch?.()
      if (unavailable) throw new Error('D1 unavailable')
      const results = await db.batch(statements)
      if (unreadable && Array.isArray(results)) {
        return [{ success: false }, ...results.slice(1)]
      }
      return results
    },
  })
  return {
    sqlite,
    budget,
    setBeforeBatch(fn: () => void) {
      beforeBatch = fn
    },
    setUnreadable(state: boolean) {
      unreadable = state
    },
    setAccountState(state: AccountState) {
      unavailable = state === 'unavailable'
      if (state === 'missing') {
        sqlite.prepare('DELETE FROM user WHERE id = ?').run(USER)
      } else if (!unavailable) {
        sqlite
          .prepare('UPDATE user SET disabled = ? WHERE id = ?')
          .run(Number(state === 'disabled'), USER)
      }
    },
  }
}

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

export function fixture(
  admission?: Admission,
  composition?: {
    app: NonNullable<Options['app']>
    authorization: NonNullable<Options['authorization']>
    register: Options['register']
  },
) {
  const kv = new MemoryKv()
  const auth = admissionDb()
  const env: HostedMcpEnv = {
    OAUTH_KV: kv as unknown as KVNamespace,
    DB: auth.budget.db as unknown as D1Database,
  }
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
  const registrations: Parameters<Options['register']>[1][] = []
  let executed = 0
  const options: HostedMcpWorkerOptions<HostedMcpEnv> = {
    name: 'admission-test',
    identityPort: { resolve: async () => ({ userId: USER, email: 'demo@kit.local' }) },
    apiBaseUrl: () => 'http://127.0.0.1:8787',
    consent: { mode: 'demo-loopback', email: 'demo@kit.local' },
    register(server, call) {
      registrations.push(call)
      server.addTool({
        name: 'who',
        description: 'test tool',
        execute: async () => {
          executed++
          return USER
        },
      })
      composition?.register(server, call)
    },
    ...(admission !== undefined ? { grantAdmission: admission } : {}),
    ...(composition ? { app: composition.app, authorization: composition.authorization } : {}),
  }
  const hosted = createHostedMcpWorker(options)
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
    const before = auth.budget.count
    const c = await code()
    expect(auth.budget.count - before).toBe(1)
    const response = await exchange(c)
    expect(response.status).toBe(200)
    expect(auth.budget.count - before).toBe(2)
    const body = (await response.json()) as { access_token: string; refresh_token: string }
    expect(body.access_token).toBeTruthy()
    expect(body.refresh_token).toBeTruthy()
    const summary = await helpers.unwrapToken(body.access_token)
    expect(summary).not.toBeNull()
    return { ...c, ...body, summary: summary! }
  }
  function fetchMcp(accessToken: string, payload: unknown, extraHeaders?: HeadersInit) {
    const headers = new Headers(extraHeaders)
    headers.set('authorization', `Bearer ${accessToken}`)
    headers.set('content-type', 'application/json')
    headers.set('accept', 'application/json')
    return fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      }),
    )
  }

  function call(accessToken: string, extraHeaders?: HeadersInit) {
    return fetchMcp(
      accessToken,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'who', arguments: {} },
      },
      extraHeaders,
    )
  }
  return {
    code,
    exchange,
    refresh,
    issue,
    call,
    fetchMcp,
    helpers,
    auth,
    setAccountState: auth.setAccountState,
    options,
    registrations,
    counts: () => ({ registered: registrations.length, executed }),
  }
}
