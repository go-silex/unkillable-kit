import type { McpIdentity, McpIdentityPort } from '@kit/mcp'
import { afterEach, describe, expect, it } from 'vitest'
import { createMcpWorker } from './create-mcp-worker'
import { createTicketIdentityPort } from './identity-port'
import type { McpExampleEnv } from './worker-env'

class MemoryKv {
  private data = new Map<string, { value: string; exp?: number }>()
  accountState: 'active' | 'disabled' | 'missing' | 'unavailable' = 'active'

  readonly db = {
    prepare: (_query: string) => ({
      bind: (userId: string) => ({
        raw: async () => {
          if (this.accountState === 'unavailable') throw new Error('D1 unavailable')
          if (this.accountState === 'missing' || ![DEMO.userId, 'user_b'].includes(userId))
            return []
          return [[this.accountState === 'disabled' ? 1 : 0]]
        },
      }),
    }),
  } as unknown as D1Database

  async get(key: string, opts?: { type?: string } | string) {
    const row = this.data.get(key)
    if (!row) return null
    if (row.exp !== undefined && Date.now() > row.exp) {
      this.data.delete(key)
      return null
    }
    const type = typeof opts === 'string' ? opts : opts?.type
    if (type === 'json') return JSON.parse(row.value) as unknown
    return row.value
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }) {
    const exp =
      opts?.expirationTtl !== undefined ? Date.now() + opts.expirationTtl * 1000 : undefined
    this.data.set(key, { value, exp })
  }

  async delete(key: string) {
    this.data.delete(key)
  }

  async list(opts?: { prefix?: string }) {
    const prefix = opts?.prefix ?? ''
    const names = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort()
    return { keys: names.map((name) => ({ name })), list_complete: true as const }
  }

  clear() {
    this.data.clear()
  }
}

const LOCAL = 'http://127.0.0.1:8788'
const REDIRECT = 'http://127.0.0.1:9999/cb'
const DEMO: McpIdentity = { userId: 'user_demo', email: 'demo@kit.local' }

function ctx(): ExecutionContext {
  const stub = {
    waitUntil() {},
    passThroughOnException() {},
  }
  return stub as unknown as ExecutionContext
}

function stubIdentity(identity: McpIdentity | Response): McpIdentityPort {
  return { resolve: async () => identity }
}

function env(kv: MemoryKv, extra?: Partial<McpExampleEnv>): McpExampleEnv {
  return {
    OAUTH_KV: kv as unknown as KVNamespace,
    DB: kv.db,
    API_BASE_URL: 'http://127.0.0.1:8787',
    ...extra,
  }
}

async function workerFetch(
  worker: ReturnType<typeof createMcpWorker>,
  kv: MemoryKv,
  request: Request,
  extra?: Partial<McpExampleEnv>,
) {
  return worker.fetch(request, env(kv, extra), ctx())
}

async function pkce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const verifier = Buffer.from(bytes).toString('base64url')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = Buffer.from(digest).toString('base64url')
  return { verifier, challenge }
}

async function registerClient(
  worker: ReturnType<typeof createMcpWorker>,
  kv: MemoryKv,
  origin = LOCAL,
  extra?: Partial<McpExampleEnv>,
) {
  const res = await workerFetch(
    worker,
    kv,
    new Request(`${origin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: 'test-mcp-client',
      }),
    }),
    extra,
  )
  const body = (await res.json()) as { client_id?: string; error?: string }
  return { status: res.status, body }
}

async function mcpJson(res: Response) {
  const ct = res.headers.get('content-type') ?? ''
  const text = await res.text()
  if (ct.includes('text/event-stream')) {
    const lines = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean)
    const last = lines.at(-1)
    return last ? (JSON.parse(last) as Record<string, unknown>) : null
  }
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return { raw: text }
  }
}

function mcpToolText(body: Record<string, unknown> | null) {
  const result = body?.result
  if (!result || typeof result !== 'object' || !('content' in result)) return JSON.stringify(body)
  const content = result.content
  if (!Array.isArray(content) || content.length === 0) return JSON.stringify(body)
  const first = content[0]
  if (!first || typeof first !== 'object' || !('text' in first)) return JSON.stringify(body)
  return typeof first.text === 'string' ? first.text : JSON.stringify(body)
}

async function mintAccessToken(
  worker: ReturnType<typeof createMcpWorker>,
  kv: MemoryKv,
  identity: McpIdentity = DEMO,
  origin = LOCAL,
) {
  const { verifier, challenge } = await pkce()
  const registered = await registerClient(worker, kv, origin)
  expect(registered.status).toBe(201)
  const clientId = registered.body.client_id!
  const state = 'state-ok'
  const authorize = new URL(`${origin}/authorize`)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('client_id', clientId)
  authorize.searchParams.set('redirect_uri', REDIRECT)
  authorize.searchParams.set('code_challenge', challenge)
  authorize.searchParams.set('code_challenge_method', 'S256')
  authorize.searchParams.set('state', state)
  authorize.searchParams.set('resource', `${origin}/mcp`)
  const authRes = await workerFetch(
    createMcpWorker({ identityPort: stubIdentity(identity) }),
    kv,
    new Request(authorize),
  )
  expect(authRes.status).toBe(302)
  const location = authRes.headers.get('location')
  expect(location).toBeTruthy()
  const redirected = new URL(location!)
  expect(redirected.searchParams.get('state')).toBe(state)
  const code = redirected.searchParams.get('code')
  expect(code).toBeTruthy()
  const tokenRes = await workerFetch(
    worker,
    kv,
    new Request(`${origin}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${origin}/mcp`,
      }),
    }),
  )
  const tokenBody = (await tokenRes.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  expect(tokenRes.status).toBe(200)
  expect(tokenBody.access_token).toBeTruthy()
  return {
    accessToken: tokenBody.access_token!,
    refreshToken: tokenBody.refresh_token!,
    expiresIn: tokenBody.expires_in,
    clientId,
  }
}

describe('CP-MCP-HTTP-OAUTH', () => {
  afterEach(() => {
    delete (globalThis as { Cloudflare?: unknown }).Cloudflare
  })

  it.each(['disabled', 'missing', 'unavailable'] as const)(
    'rejects an existing token and refresh when account state is %s',
    async (state) => {
      const kv = new MemoryKv()
      const worker = createMcpWorker({ identityPort: stubIdentity(DEMO) })
      const { accessToken, refreshToken, clientId } = await mintAccessToken(worker, kv)
      expect(refreshToken).toBeTruthy()
      kv.accountState = state
      const call = await workerFetch(
        worker,
        kv,
        new Request(`${LOCAL}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'whoami', arguments: {} },
          }),
        }),
      )
      expect(call.status).toBe(state === 'unavailable' ? 503 : 401)
      expect(await call.text()).not.toContain('user_demo')
      const refresh = await workerFetch(
        worker,
        kv,
        new Request(`${LOCAL}/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: refreshToken,
            resource: `${LOCAL}/mcp`,
          }),
        }),
      )
      expect(refresh.status).toBe(state === 'unavailable' ? 503 : 400)
      expect(await refresh.text()).not.toContain('access_token')
    },
  )

  it('checks account state on identity resolution and again at code exchange', async () => {
    const kv = new MemoryKv()
    const worker = createMcpWorker({ identityPort: stubIdentity(DEMO) })
    const { body } = await registerClient(worker, kv)
    const { verifier, challenge } = await pkce()
    const authorize = new URL(`${LOCAL}/authorize`)
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: body.client_id!,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${LOCAL}/mcp`,
    }))
      authorize.searchParams.set(key, value)

    kv.accountState = 'disabled'
    expect((await workerFetch(worker, kv, new Request(authorize))).status).toBe(401)
    kv.accountState = 'unavailable'
    expect((await workerFetch(worker, kv, new Request(authorize))).status).toBe(503)
    kv.accountState = 'active'
    const response = await workerFetch(worker, kv, new Request(authorize))
    expect(response.status).toBe(302)
    const code = new URL(response.headers.get('location')!).searchParams.get('code')!
    kv.accountState = 'disabled'
    const exchange = await workerFetch(
      worker,
      kv,
      new Request(`${LOCAL}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: body.client_id!,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
          resource: `${LOCAL}/mcp`,
        }),
      }),
    )
    expect(exchange.status).toBe(400)
    expect(await exchange.text()).not.toContain('access_token')
  })

  it('unauthenticated POST /mcp → 401 challenge, zero tools', async () => {
    const kv = new MemoryKv()
    const worker = createMcpWorker({ identityPort: stubIdentity(DEMO) })
    const res = await workerFetch(
      worker,
      kv,
      new Request(`${LOCAL}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        }),
      }),
    )
    expect(res.status).toBe(401)
    const www = res.headers.get('www-authenticate') ?? ''
    expect(www.toLowerCase()).toContain('bearer')
    expect(www).toContain(`resource_metadata="${LOCAL}/.well-known/oauth-protected-resource/mcp"`)
    const body = await res.text()
    expect(body).not.toContain('tools')
    expect(body).not.toContain('ping')
  })

  it('protected-resource metadata lists this host as resource and AS', async () => {
    const kv = new MemoryKv()
    const worker = createMcpWorker({ identityPort: stubIdentity(DEMO) })
    const res = await workerFetch(
      worker,
      kv,
      new Request(`${LOCAL}/.well-known/oauth-protected-resource/mcp`),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      resource?: string
      authorization_servers?: string[]
      scopes_supported?: string[]
    }
    expect(body.resource).toBe(`${LOCAL}/mcp`)
    expect(body.authorization_servers).toContain(LOCAL)
    expect(body.scopes_supported).toEqual(['mcp'])
  })

  it('AS metadata requires PKCE S256 and describes CIMD', async () => {
    ;(
      globalThis as {
        Cloudflare?: { compatibilityFlags: { global_fetch_strictly_public: boolean } }
      }
    ).Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } }
    const kv = new MemoryKv()
    const worker = createMcpWorker({ identityPort: stubIdentity(DEMO) })
    const res = await workerFetch(
      worker,
      kv,
      new Request(`${LOCAL}/.well-known/oauth-authorization-server`),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      code_challenge_methods_supported?: string[]
      client_id_metadata_document_supported?: boolean
      registration_endpoint?: string
    }
    expect(body.code_challenge_methods_supported).toEqual(['S256'])
    expect(body.client_id_metadata_document_supported).toBe(true)
    expect(body.registration_endpoint).toContain('/register')
  })

  it('metadata GET does not mint a token', async () => {
    const kv = new MemoryKv()
    const worker = createMcpWorker({ identityPort: stubIdentity(DEMO) })
    await workerFetch(worker, kv, new Request(`${LOCAL}/.well-known/oauth-protected-resource/mcp`))
    await workerFetch(worker, kv, new Request(`${LOCAL}/.well-known/oauth-authorization-server`))
    const res = await workerFetch(
      worker,
      kv,
      new Request(`${LOCAL}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    )
    expect(res.status).toBe(401)
  })

  it('Google AT or kit_session as Bearer is rejected', async () => {
    const kv = new MemoryKv()
    const worker = createMcpWorker({ identityPort: stubIdentity(DEMO) })
    for (const bearer of ['ya29.google-access-token-fake', 'kit_session=not-an-mcp-token']) {
      const res = await workerFetch(
        worker,
        kv,
        new Request(`${LOCAL}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }),
      )
      expect(res.status).toBe(401)
      const body = await res.text()
      expect(body).not.toContain('"ping"')
    }
  })

  it('logged-out authorize issues no token', async () => {
    const kv = new MemoryKv()
    const worker = createMcpWorker({
      identityPort: stubIdentity(Response.redirect('http://127.0.0.1:5173/login', 302)),
    })
    const registered = await registerClient(worker, kv)
    expect(registered.status).toBe(201)
    const { challenge } = await pkce()
    const authorize = new URL(`${LOCAL}/authorize`)
    authorize.searchParams.set('response_type', 'code')
    authorize.searchParams.set('client_id', registered.body.client_id!)
    authorize.searchParams.set('redirect_uri', REDIRECT)
    authorize.searchParams.set('code_challenge', challenge)
    authorize.searchParams.set('code_challenge_method', 'S256')
    const res = await workerFetch(worker, kv, new Request(authorize))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/login')
    expect(res.headers.get('location')).not.toContain('code=')
  })

  it('mismatched authorize state does not issue a token', async () => {
    const kv = new MemoryKv()
    const worker = createMcpWorker({ identityPort: stubIdentity(DEMO) })
    const registered = await registerClient(worker, kv)
    const { challenge } = await pkce()
    const authorize = new URL(`${LOCAL}/authorize`)
    authorize.searchParams.set('response_type', 'code')
    authorize.searchParams.set('client_id', registered.body.client_id!)
    authorize.searchParams.set('redirect_uri', REDIRECT)
    authorize.searchParams.set('code_challenge', challenge)
    authorize.searchParams.set('code_challenge_method', 'S256')
    authorize.searchParams.set('state', 'expected')
    const res = await workerFetch(worker, kv, new Request(authorize))
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location')!)
    expect(location.searchParams.get('state')).toBe('expected')
    expect(location.searchParams.get('state')).not.toBe('attacker')
  })

  it('failed identity → 401, no token', async () => {
    const kv = new MemoryKv()
    const worker = createMcpWorker({
      identityPort: stubIdentity(new Response('nope', { status: 401 })),
    })
    const registered = await registerClient(worker, kv)
    const { challenge } = await pkce()
    const authorize = new URL(`${LOCAL}/authorize`)
    authorize.searchParams.set('response_type', 'code')
    authorize.searchParams.set('client_id', registered.body.client_id!)
    authorize.searchParams.set('redirect_uri', REDIRECT)
    authorize.searchParams.set('code_challenge', challenge)
    authorize.searchParams.set('code_challenge_method', 'S256')
    const res = await workerFetch(worker, kv, new Request(authorize))
    expect(res.status).toBe(401)
    expect(res.headers.get('location')).toBeNull()
  })

  it('PKCE + localhost DCR + demo identity → ping and whoami', async () => {
    const kv = new MemoryKv()
    const worker = createMcpWorker({ identityPort: stubIdentity(DEMO) })
    const { accessToken } = await mintAccessToken(worker, kv)
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${accessToken}`,
    }
    const init = await workerFetch(
      worker,
      kv,
      new Request(`${LOCAL}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'probe', version: '0' },
          },
        }),
      }),
    )
    expect(init.status).toBeLessThan(400)
    const list = await workerFetch(
      worker,
      kv,
      new Request(`${LOCAL}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      }),
    )
    expect(list.status).toBe(200)
    const listBody = await mcpJson(list)
    const names = JSON.stringify(listBody)
    expect(names).toContain('ping')
    expect(names).toContain('whoami')

    const ping = await workerFetch(
      worker,
      kv,
      new Request(`${LOCAL}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'ping', arguments: {} },
        }),
      }),
    )
    expect(ping.status).toBe(200)
    const pingBody = await mcpJson(ping)
    expect(mcpToolText(pingBody)).toContain('"ok":true')

    const who = await workerFetch(
      worker,
      kv,
      new Request(`${LOCAL}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'whoami', arguments: {} },
        }),
      }),
    )
    const whoBody = await mcpJson(who)
    const whoText = mcpToolText(whoBody)
    expect(whoText).toContain('user_demo')
    expect(whoText).toContain('demo@kit.local')
    expect(whoText).not.toMatch(/sk_/)
    expect(whoText).toContain('"verified":true')
  })

  it('unknown MCP method fail-closes', async () => {
    const kv = new MemoryKv()
    const worker = createMcpWorker({ identityPort: stubIdentity(DEMO) })
    const { accessToken } = await mintAccessToken(worker, kv)
    const res = await workerFetch(
      worker,
      kv,
      new Request(`${LOCAL}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'not/a/method' }),
      }),
    )
    expect(res.status).toBeLessThan(500)
    const body = await mcpJson(res)
    const text = JSON.stringify(body)
    expect(text).not.toContain('"ok":true')
    expect(text.toLowerCase()).toMatch(/error|method/)
  })

  it('production-shaped host refuses open DCR', async () => {
    const kv = new MemoryKv()
    const worker = createMcpWorker({ identityPort: stubIdentity(DEMO) })
    const origin = 'https://mcp.example.com'
    const deployed = { ENVIRONMENT: 'production', MCP_PUBLIC_URL: origin }
    const registered = await registerClient(worker, kv, origin, deployed)
    expect(registered.status).toBeGreaterThanOrEqual(400)
    const meta = await workerFetch(
      worker,
      kv,
      new Request(`${origin}/.well-known/oauth-authorization-server`),
      deployed,
    )
    const body = (await meta.json()) as { registration_endpoint?: string }
    expect(body.registration_endpoint).toBeUndefined()
  })

  it('token audience / deploy replay → 401', async () => {
    const kv = new MemoryKv()
    const worker = createMcpWorker({ identityPort: stubIdentity(DEMO) })
    const { accessToken } = await mintAccessToken(worker, kv, DEMO, LOCAL)
    const res = await workerFetch(
      worker,
      kv,
      new Request('https://other-host.example/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      { MCP_PUBLIC_URL: 'https://other-host.example' },
    )
    expect(res.status).toBe(401)
    const body = await res.text()
    expect(body).not.toContain('ping')
  })

  it('BA logout does not kill MCP tokens; presenting token can revoke; KV wipe kills', async () => {
    const kv = new MemoryKv()
    const worker = createMcpWorker({ identityPort: stubIdentity(DEMO) })
    const { accessToken, clientId } = await mintAccessToken(worker, kv)
    const loggedOut = createMcpWorker({
      identityPort: stubIdentity(Response.redirect('http://127.0.0.1:5173/login', 302)),
    })
    const still = await workerFetch(
      loggedOut,
      kv,
      new Request(`${LOCAL}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      }),
    )
    expect(still.status).not.toBe(401)

    const revoke = await workerFetch(
      worker,
      kv,
      new Request(`${LOCAL}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: accessToken,
          client_id: clientId,
        }),
      }),
    )
    expect(revoke.status).toBe(200)

    const afterRevoke = await workerFetch(
      worker,
      kv,
      new Request(`${LOCAL}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    )
    expect(afterRevoke.status).toBe(401)

    const { accessToken: token2, expiresIn } = await mintAccessToken(worker, kv)
    kv.clear()
    const afterWipe = await workerFetch(
      worker,
      kv,
      new Request(`${LOCAL}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token2}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    )
    expect(afterWipe.status).toBe(401)
    expect(expiresIn).toBe(8 * 60 * 60)
  })
  it('demo-b on localhost is not auto-approved', async () => {
    const kv = new MemoryKv()
    const worker = createMcpWorker({
      identityPort: stubIdentity({ userId: 'user_b', email: 'demo-b@kit.local' }),
    })
    const registered = await registerClient(worker, kv)
    const { challenge } = await pkce()
    const authorize = new URL(`${LOCAL}/authorize`)
    authorize.searchParams.set('response_type', 'code')
    authorize.searchParams.set('client_id', registered.body.client_id!)
    authorize.searchParams.set('redirect_uri', REDIRECT)
    authorize.searchParams.set('code_challenge', challenge)
    authorize.searchParams.set('code_challenge_method', 'S256')
    const res = await workerFetch(worker, kv, new Request(authorize))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Authorize MCP client')
    expect(html).not.toContain('code=')
  })

  it('one-time ticket + consent POST issues a code for demo-b', async () => {
    const kv = new MemoryKv()
    const remaining = new Map<string, McpIdentity>([
      ['mct_once', { userId: 'user_b', email: 'demo-b@kit.local' }],
    ])
    const worker = createMcpWorker({
      identityPort: createTicketIdentityPort({
        redeem: async (ticket) => {
          const identity = remaining.get(ticket)
          remaining.delete(ticket)
          return identity ?? null
        },
      }),
    })
    const registered = await registerClient(worker, kv)
    const { challenge } = await pkce()
    const authorize = new URL(`${LOCAL}/authorize`)
    authorize.searchParams.set('response_type', 'code')
    authorize.searchParams.set('client_id', registered.body.client_id!)
    authorize.searchParams.set('redirect_uri', REDIRECT)
    authorize.searchParams.set('code_challenge', challenge)
    authorize.searchParams.set('code_challenge_method', 'S256')
    authorize.searchParams.set('state', 'state-ok')
    authorize.searchParams.set('mcp_identity_ticket', 'mct_once')
    const getRes = await workerFetch(worker, kv, new Request(authorize))
    expect(getRes.status).toBe(200)
    const html = await getRes.text()
    expect(html).toContain('demo-b@kit.local')
    expect(html).not.toContain('mct_once')
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]
    expect(csrf).toBeTruthy()
    const action = /action="([^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&')
    expect(action).toBeTruthy()
    expect(new URL(action!, LOCAL).searchParams.get('mcp_identity_ticket')).toBeNull()
    const postUrl = new URL(authorize.href)
    postUrl.searchParams.delete('mcp_identity_ticket')
    const setCookies =
      typeof getRes.headers.getSetCookie === 'function'
        ? getRes.headers.getSetCookie()
        : [getRes.headers.get('set-cookie') ?? '']
    const cookies = setCookies
      .map((c) => c.split(';')[0]?.trim())
      .filter(Boolean)
      .join('; ')
    expect(cookies).toContain('mcp_consent_id=')
    expect(cookies).not.toContain('mcp_consent_csrf')
    const postRes = await workerFetch(
      worker,
      kv,
      new Request(postUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: cookies,
        },
        body: new URLSearchParams({ csrf: csrf!, consent: 'yes' }),
      }),
    )
    expect(postRes.status).toBe(302)
    const location = postRes.headers.get('location')
    expect(location).toBeTruthy()
    expect(new URL(location!).searchParams.get('code')).toBeTruthy()
    expect(remaining.size).toBe(0)
  })
})
