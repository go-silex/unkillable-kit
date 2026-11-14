import { getOAuthApi, OAuthError } from '@cloudflare/workers-oauth-provider'
import { describe, expect, it } from 'vitest'
import { createHostedMcpWorker, type HostedMcpWorkerOptions } from './create-worker'
import type { HostedMcpEnv } from './env'

const ORIGIN = 'http://127.0.0.1:8788'
const REDIRECT = 'http://127.0.0.1:9999/cb'
const USER = 'user_demo'

type Admission = NonNullable<HostedMcpWorkerOptions<HostedMcpEnv>['grantAdmission']>
type AuthorizationCode = { clientId: string; verifier: string; code: string }

class MemoryKv {
  private readonly data = new Map<string, { value: string; exp?: number }>()
  accountState: 'active' | 'disabled' | 'missing' | 'unavailable' = 'active'
  readonly db = {
    prepare: () => ({
      bind: (userId: string) => ({
        raw: async () => {
          if (this.accountState === 'unavailable') throw new Error('D1 unavailable')
          if (this.accountState === 'missing' || userId !== USER) return []
          return [[this.accountState === 'disabled' ? 1 : 0]]
        },
      }),
    }),
  } as unknown as D1Database

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

function fixture(admission?: Admission) {
  const kv = new MemoryKv()
  const env: HostedMcpEnv = { OAUTH_KV: kv as unknown as KVNamespace, DB: kv.db }
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
  let registered = 0
  let executed = 0
  const options: HostedMcpWorkerOptions<HostedMcpEnv> = {
    name: 'admission-test',
    identityPort: { resolve: async () => ({ userId: USER, email: 'demo@kit.local' }) },
    apiBaseUrl: () => 'http://127.0.0.1:8787',
    consent: { mode: 'demo-loopback', email: 'demo@kit.local' },
    register(server) {
      registered++
      server.addTool({
        name: 'who',
        description: 'test tool',
        execute: async () => {
          executed++
          return USER
        },
      })
    },
    ...(admission !== undefined ? { grantAdmission: admission } : {}),
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
    const c = await code()
    const response = await exchange(c)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { access_token: string; refresh_token: string }
    expect(body.access_token).toBeTruthy()
    expect(body.refresh_token).toBeTruthy()
    const summary = await helpers.unwrapToken(body.access_token)
    expect(summary).not.toBeNull()
    return { ...c, ...body, summary: summary! }
  }
  function call(accessToken: string, extraHeaders: Record<string, string> = {}) {
    return fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'who', arguments: {} },
        }),
      }),
    )
  }
  return {
    code,
    exchange,
    refresh,
    issue,
    call,
    helpers,
    setAccountState: (state: MemoryKv['accountState']) => {
      kv.accountState = state
    },
    options,
    counts: () => ({ registered, executed }),
  }
}

async function expectUnavailable(response: Response) {
  expect(response.status).toBe(503)
  expect(response.headers.get('cache-control')).toContain('no-store')
}

describe('hosted OAuth grant admission', () => {
  it.each(['disabled', 'missing', 'unavailable'] as const)(
    'checks live account state without optional admission: %s',
    async (state) => {
      const f = fixture()
      const grant = await f.issue()
      f.setAccountState(state)
      expect((await f.call(grant.access_token)).status).toBe(state === 'unavailable' ? 503 : 401)
      expect(f.counts()).toEqual({ registered: 0, executed: 0 })
      const response = await f.refresh(grant.clientId, grant.refresh_token)
      expect(response.status).toBe(state === 'unavailable' ? 503 : 400)
      expect(await response.json()).not.toHaveProperty('access_token')
    },
  )

  it('denies refresh after the account is disabled without optional admission', async () => {
    const f = fixture()
    const grant = await f.issue()
    f.setAccountState('disabled')
    const response = await f.refresh(grant.clientId, grant.refresh_token)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' })
  })

  it('denies code exchange after the account is disabled without optional admission', async () => {
    const f = fixture()
    const code = await f.code()
    f.setAccountState('disabled')
    const response = await f.exchange(code)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' })
  })

  it('preserves existing issuance and tool access when omitted', async () => {
    const f = fixture()
    const grant = await f.issue()
    const response = await f.call(grant.access_token)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain(USER)
    expect(f.counts()).toEqual({ registered: 1, executed: 1 })
    expect((await f.refresh(grant.clientId, grant.refresh_token)).status).toBe(200)
  })

  it('rejects a falsy non-function admission option at construction', () => {
    expect(() => fixture(false as unknown as Admission)).toThrow(TypeError)
  })

  it('snapshots the admission callback when the worker is created', async () => {
    const f = fixture(async (input) => input.phase !== 'request')
    f.options.grantAdmission = async () => true
    const grant = await f.issue()
    expect((await f.call(grant.access_token)).status).toBe(401)
    expect(f.counts()).toEqual({ registered: 0, executed: 0 })
  })

  it('cannot bypass provider PKCE or bearer validation when admission allows', async () => {
    const f = fixture(async () => true)
    const c = await f.code()
    const bad = await f.exchange(c, 'wrong-verifier-abcdefghijklmnopqrstuvwxyz0123456789')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: 'invalid_grant' })
    const denied = await f.call('not-a-valid-token')
    expect(denied.status).toBe(401)
    expect(f.counts()).toEqual({ registered: 0, executed: 0 })
  })

  it('refuses a request before registering or executing tools', async () => {
    const f = fixture(async (input) => input.phase !== 'request')
    const grant = await f.issue()
    const response = await f.call(grant.access_token)
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata')
    expect(f.counts()).toEqual({ registered: 0, executed: 0 })
    expect((await f.helpers.listUserGrants(USER)).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: grant.summary.grantId })]),
    )
    expect(await f.helpers.unwrapToken(grant.access_token)).not.toBeNull()
  })

  it('refuses an authorization code without issuing tokens', async () => {
    const f = fixture(async (input) => input.phase !== 'token')
    const c = await f.code()
    const before = (await f.helpers.listUserGrants(USER)).items
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({ clientId: c.clientId })
    const response = await f.exchange(c)
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body).toMatchObject({ error: 'invalid_grant' })
    expect(body).not.toHaveProperty('access_token')
    expect(body).not.toHaveProperty('refresh_token')
    expect((await f.helpers.listUserGrants(USER)).items).toEqual([])
  })

  it('refuses refresh and revokes only the targeted grant', async () => {
    let blocked = ''
    const f = fixture(
      async (input) =>
        input.phase !== 'token' || input.grantType !== 'refresh_token' || input.grantId !== blocked,
    )
    const first = await f.issue()
    const second = await f.issue()
    blocked = first.summary.grantId
    const denied = await f.refresh(first.clientId, first.refresh_token)
    expect(denied.status).toBe(400)
    const body = await denied.json()
    expect(body).toMatchObject({ error: 'invalid_grant' })
    expect(body).not.toHaveProperty('access_token')
    expect(await f.helpers.unwrapToken(first.access_token)).toBeNull()
    expect((await f.call(second.access_token)).status).toBe(200)
    expect((await f.refresh(second.clientId, second.refresh_token)).status).toBe(200)
  })

  it('isolates a request refusal to the selected grant', async () => {
    let blocked = ''
    const f = fixture(async (input) => input.phase !== 'request' || input.grantId !== blocked)
    const first = await f.issue()
    const second = await f.issue()
    blocked = first.summary.grantId
    expect((await f.call(first.access_token)).status).toBe(401)
    expect(f.counts()).toEqual({ registered: 0, executed: 0 })
    expect((await f.call(second.access_token)).status).toBe(200)
    expect(f.counts()).toEqual({ registered: 1, executed: 1 })
  })

  it.each([
    ['ordinary error', () => new Error('offline')],
    [
      'caller OAuth invalid_grant',
      () => new OAuthError('invalid_grant', { description: 'offline' }),
    ],
  ])(
    'returns unavailable for %s during code admission and permits retry',
    async (_label, error) => {
      let unavailable = true
      const f = fixture(async (input) => {
        if (input.phase === 'token' && unavailable) throw error()
        return true
      })
      const c = await f.code()
      const response = await f.exchange(c)
      await expectUnavailable(response)
      expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' })
      unavailable = false
      expect((await f.exchange(c)).status).toBe(200)
    },
  )

  it('returns unavailable on refresh without revocation and permits retry', async () => {
    let unavailable = false
    const f = fixture(async (input) => {
      if (input.phase === 'token' && unavailable) throw new Error('offline')
      return true
    })
    const grant = await f.issue()
    unavailable = true
    const response = await f.refresh(grant.clientId, grant.refresh_token)
    await expectUnavailable(response)
    expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' })
    expect(await f.helpers.unwrapToken(grant.access_token)).not.toBeNull()
    unavailable = false
    expect((await f.refresh(grant.clientId, grant.refresh_token)).status).toBe(200)
  })

  it('fails closed on request admission errors and recovers without revocation', async () => {
    let unavailable = true
    const f = fixture(async (input) => {
      if (input.phase === 'request' && unavailable) throw new Error('offline')
      return true
    })
    const grant = await f.issue()
    await expectUnavailable(await f.call(grant.access_token))
    expect(f.counts()).toEqual({ registered: 0, executed: 0 })
    unavailable = false
    expect((await f.call(grant.access_token)).status).toBe(200)
  })

  it('treats a nonboolean admission result as unavailable, without consuming the code', async () => {
    let valid = false
    const f = fixture(async () => (valid ? true : (undefined as unknown as boolean)))
    const c = await f.code()
    await expectUnavailable(await f.exchange(c))
    valid = true
    expect((await f.exchange(c)).status).toBe(200)
  })

  it('binds admission to the provider-verified tuple rather than caller headers', async () => {
    let target = ''
    let client = ''
    const f = fixture(async (input, env) => {
      if ('OAUTH_PROVIDER' in env) return false
      if (input.phase === 'token')
        return (
          input.userId === USER &&
          input.clientId === client &&
          input.grantType === 'authorization_code'
        )
      return input.userId === USER && input.grantId === target && input.clientId === client
    })
    const c = await f.code()
    client = c.clientId
    const response = await f.exchange(c)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { access_token: string }
    const summary = await f.helpers.unwrapToken(body.access_token)
    expect(summary).not.toBeNull()
    target = summary!.grantId
    const allowed = await f.call(body.access_token, {
      'x-user-id': 'forged',
      'x-client-id': 'forged',
      'x-grant-id': 'forged',
    })
    expect(allowed.status).toBe(200)
    target = 'wrong-grant'
    expect((await f.call(body.access_token)).status).toBe(401)
    expect(f.counts()).toEqual({ registered: 1, executed: 1 })
  })

  it('rejects a provider grant whose token identity disagrees with the verified user', async () => {
    const f = fixture(async () => true)
    const c = await f.code(true)
    const exchange = await f.exchange(c)
    expect(exchange.status).toBe(200)
    const body = (await exchange.json()) as { access_token: string }
    expect((await f.call(body.access_token)).status).toBe(401)
    expect(f.counts()).toEqual({ registered: 0, executed: 0 })
  })
})
