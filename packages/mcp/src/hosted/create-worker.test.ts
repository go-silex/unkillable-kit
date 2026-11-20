import { readFileSync } from 'node:fs'
import { getOAuthApi } from '@cloudflare/workers-oauth-provider'
import { createBetterAuth } from '@kit/auth/factory'
import { createOidcProvider, registerOidcClient } from '@kit/auth/oidc-provider'
import { createSqliteD1 } from '@kit/db/testing'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { McpIdentity, McpIdentityPort } from '../identity'
import { putConsent, readConsent } from './consent'
import {
  createHostedMcpWorker,
  type HostedMcpWorker,
  type HostedMcpWorkerOptions,
} from './create-worker'
import type { HostedMcpEnv } from './env'
import { createProductClient } from './product-registered'

class MemoryKv {
  readonly data = new Map<string, { value: string; exp?: number }>()

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

  async put(key: string, value: string, opts?: { expirationTtl?: number; expiration?: number }) {
    let exp: number | undefined
    if (opts?.expirationTtl !== undefined) exp = Date.now() + opts.expirationTtl * 1000
    if (opts?.expiration !== undefined) exp = opts.expiration * 1000
    this.data.set(key, { value, exp })
  }

  /** Seconds from now until a stored row expires; undefined when it never does. */
  secondsLeft(key: string): number | undefined {
    const exp = this.data.get(key)?.exp
    return exp === undefined ? undefined : Math.round((exp - Date.now()) / 1000)
  }

  grantKeys(): string[] {
    return [...this.data.keys()].filter((key) => key.startsWith('grant:'))
  }

  async delete(key: string) {
    this.data.delete(key)
  }

  async list(opts?: { prefix?: string }) {
    const prefix = opts?.prefix ?? ''
    const names = [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort()
    return { keys: names.map((name) => ({ name })), list_complete: true as const }
  }

  consentKeys(): string[] {
    return [...this.data.keys()].filter((key) => key.startsWith('mcp_consent:'))
  }
}

type Opts = HostedMcpWorkerOptions<HostedMcpEnv>
type Hosted = HostedMcpWorker<HostedMcpEnv>

const LOCAL = 'http://127.0.0.1:8788'
const PUBLIC = 'https://mcp.example.test'
const REDIRECT = 'http://127.0.0.1:9999/cb'
const DEMO: McpIdentity = { userId: 'user_demo', email: 'demo@kit.local' }
const OTHER: McpIdentity = { userId: 'user_b', email: 'b@kit.local' }
const DEMO_LOOPBACK = { mode: 'demo-loopback', email: 'demo@kit.local' } as const
const SHELL_PATHS = [
  '/mcp',
  '/authorize',
  '/token',
  '/register',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
]

/** Serves `clientId` as its own CIMD document through the global fetch. */
function stubCimd(clientId: string, redirectUri = REDIRECT): void {
  vi.stubGlobal('Cloudflare', { compatibilityFlags: { global_fetch_strictly_public: true } })
  vi.stubGlobal('fetch', async () =>
    Response.json({
      client_id: clientId,
      client_name: 'Claude',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    }),
  )
}

function ctx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext
}

function env(kv: MemoryKv, extra?: Partial<HostedMcpEnv>): HostedMcpEnv {
  const DB = {
    prepare: () => ({ bind: () => ({ raw: async () => [[0]] }) }),
  } as unknown as D1Database
  return { OAUTH_KV: kv as unknown as KVNamespace, DB, ...extra }
}

/** A deploy serving `origin`: a loopback development host serves itself, PUBLIC is configured. */
function envFor(kv: MemoryKv, origin: string): HostedMcpEnv {
  return env(kv, origin === PUBLIC ? { MCP_PUBLIC_URL: PUBLIC } : undefined)
}

function port(identity: McpIdentity | Response): McpIdentityPort {
  return { resolve: async () => identity }
}

function worker(overrides: Pick<Opts, 'identityPort'> & Partial<Opts>): Hosted {
  return createHostedMcpWorker({
    name: 'hosted-test',
    version: '0.0.1',
    apiBaseUrl: () => 'http://127.0.0.1:8787',
    register(server) {
      server.addTool({
        name: 'secret_tool',
        description: 'must not run unauthenticated',
        execute: async () => 'nope',
      })
    },
    ...overrides,
  })
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64Url(new Uint8Array(digest)) }
}

async function registerClient(hosted: Hosted, kv: MemoryKv): Promise<string> {
  const res = await hosted.fetch(
    new Request(`${LOCAL}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        client_name: 'hosted-test-client',
      }),
    }),
    env(kv),
    ctx(),
  )
  expect(res.status).toBe(201)
  const body = (await res.json()) as { client_id?: string }
  return body.client_id ?? ''
}

function oauthHelpers(kv: MemoryKv) {
  const unused = { fetch: async () => new Response(null, { status: 404 }) }
  return getOAuthApi(
    {
      apiRoute: '/mcp',
      apiHandler: unused,
      defaultHandler: unused,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      resourceMetadata: { resource: `${LOCAL}/mcp` },
    },
    env(kv),
  )
}

/** Trusted product path: `createProductClient` writes the positive `skip` receipt. */
async function productClient(kv: MemoryKv): Promise<string> {
  const client = await createProductClient(oauthHelpers(kv), kv as unknown as KVNamespace, {
    redirectUris: [REDIRECT],
    tokenEndpointAuthMethod: 'none',
  })
  return client.clientId
}

/** Bare provider registration: no package receipt. */
async function bareCreateClient(kv: MemoryKv): Promise<string> {
  const client = await oauthHelpers(kv).createClient({
    redirectUris: [REDIRECT],
    tokenEndpointAuthMethod: 'none',
  })
  return client.clientId
}

async function authorizeUrl(
  clientId: string,
  opts: { origin?: string; challenge?: string; scope?: string; redirect?: string } = {},
) {
  const origin = opts.origin ?? LOCAL
  const url = new URL(`${origin}/authorize`)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', opts.redirect ?? REDIRECT)
  url.searchParams.set('code_challenge', opts.challenge ?? (await pkce()).challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', 'state-ok')
  url.searchParams.set('resource', `${origin}/mcp`)
  if (opts.scope) url.searchParams.set('scope', opts.scope)
  return url
}

async function consentPage(hosted: Hosted, kv: MemoryKv, url: URL) {
  const res = await hosted.fetch(new Request(url), envFor(kv, url.origin), ctx())
  const html = await res.text()
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? ''
  const setCookie = res.headers.get('set-cookie') ?? ''
  return { res, html, csrf, setCookie, cookie: setCookie.split(';')[0] ?? '' }
}

function postConsent(
  hosted: Hosted,
  kv: MemoryKv,
  url: string,
  form: { cookie: string; csrf: string; consent?: string },
) {
  return hosted.fetch(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: form.cookie },
      body: new URLSearchParams({ csrf: form.csrf, consent: form.consent ?? 'yes' }),
    }),
    envFor(kv, new URL(url).origin),
    ctx(),
  )
}

type TokenBody = { access_token?: string; refresh_token?: string; expires_in?: number }

/** Runs the auto-approved code flow and returns the /token response body. */
async function exchangeCode(
  hosted: Hosted,
  kv: MemoryKv,
): Promise<TokenBody & { clientId: string }> {
  const clientId = await registerClient(hosted, kv)
  const { verifier, challenge } = await pkce()
  const authorize = await hosted.fetch(
    new Request(await authorizeUrl(clientId, { challenge })),
    env(kv),
    ctx(),
  )
  const code = new URL(authorize.headers.get('location') ?? '').searchParams.get('code') ?? ''
  const token = await hosted.fetch(
    new Request(`${LOCAL}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${LOCAL}/mcp`,
      }),
    }),
    env(kv),
    ctx(),
  )
  expect(token.status).toBe(200)
  return { ...((await token.json()) as TokenBody), clientId }
}

describe('hosted worker routing', () => {
  it('keeps /mcp behind the provider when a fallthrough hook is installed', async () => {
    const kv = new MemoryKv()
    const seen: string[] = []
    const hosted = worker({
      identityPort: port(DEMO),
      fallthrough(request) {
        seen.push(new URL(request.url).pathname)
        return new Response('hook', { status: 200 })
      },
    })
    const mcp = await hosted.fetch(
      new Request(`${LOCAL}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      env(kv),
      ctx(),
    )
    expect(mcp.status).toBe(401)
    const www = mcp.headers.get('www-authenticate') ?? ''
    expect(www.toLowerCase()).toContain('bearer')
    expect(www).toContain('resource_metadata')
    const body = await mcp.text()
    expect(body).not.toContain('secret_tool')
    expect(body).not.toContain('access_token')
    expect(seen).toEqual([])

    const health = await hosted.fetch(new Request(`${LOCAL}/health`), env(kv), ctx())
    expect(health.status).toBe(200)
    expect(await health.text()).toBe('hook')
    expect(seen).toEqual(['/health'])
  })

  it('404s a non-oauth path when no fallthrough hook is set', async () => {
    const kv = new MemoryKv()
    const hosted = worker({ identityPort: port(DEMO) })
    const res = await hosted.fetch(new Request(`${LOCAL}/health`), env(kv), ctx())
    expect(res.status).toBe(404)
  })

  it('serves the shell on MCP_PUBLIC_URL only and product routes on every other origin', async () => {
    const kv = new MemoryKv()
    const seen: string[] = []
    const hosted = worker({
      identityPort: port(DEMO),
      fallthrough(request) {
        seen.push(new URL(request.url).host)
        return new Response('hook', { status: 200 })
      },
    })
    const deployed = env(kv, { MCP_PUBLIC_URL: `${PUBLIC}/` })
    const prm = await hosted.fetch(
      new Request(`${PUBLIC}/.well-known/oauth-protected-resource/mcp`),
      deployed,
      ctx(),
    )
    expect(prm.status).toBe(200)
    expect(await prm.json()).toMatchObject({ resource: `${PUBLIC}/mcp` })
    // Cleartext, a sibling host, loopback, another port, a Host the provider cannot build on.
    const others = [
      'http://mcp.example.test',
      'https://preview.mcp.example.test',
      LOCAL,
      'https://mcp.example.test:8443',
      'https://mcp"example.test',
    ]
    for (const origin of others) {
      const health = await hosted.fetch(new Request(`${origin}/health`), deployed, ctx())
      expect(health.status, origin).toBe(200)
      for (const path of SHELL_PATHS) {
        const res = await hosted.fetch(
          new Request(`${origin}${path}`, { method: 'POST' }),
          deployed,
          ctx(),
        )
        expect(res.status, `${origin}${path}`).toBe(404)
      }
    }
    expect(seen).toEqual(others.map((origin) => new URL(origin).host))
    expect(kv.data.size).toBe(0)
  })

  it('answers 500 on the shell paths, and keeps product routes, while MCP_PUBLIC_URL is missing or unusable', async () => {
    const kv = new MemoryKv()
    const hosted = worker({
      identityPort: port(DEMO),
      fallthrough: () => new Response('hook', { status: 200 }),
    })
    const cleartext = 'http://mcp.example.test'
    const cases: [string, Partial<HostedMcpEnv>][] = [
      [PUBLIC, {}],
      ['http://127.0.0.2:8788', {}],
      [LOCAL, { ENVIRONMENT: 'production' }],
    ]
    for (const configured of [
      'mcp.example.test',
      `${PUBLIC}/mcp`,
      'https://user@mcp.example.test',
      cleartext,
      'ftp://mcp.example.test',
      'wss://mcp.example.test',
    ]) {
      for (const origin of [PUBLIC, cleartext]) cases.push([origin, { MCP_PUBLIC_URL: configured }])
    }
    for (const [origin, extra] of cases) {
      const label = `${origin} ${JSON.stringify(extra)}`
      const health = await hosted.fetch(new Request(`${origin}/health`), env(kv, extra), ctx())
      expect(health.status, label).toBe(200)
      for (const path of SHELL_PATHS) {
        const res = await hosted.fetch(
          new Request(`${origin}${path}`, { method: 'POST' }),
          env(kv, extra),
          ctx(),
        )
        expect(res.status, `${label} ${path}`).toBe(500)
      }
    }
    expect(kv.data.size).toBe(0)
  })

  it('serves a loopback host over http, on its own origin when unset or when configured', async () => {
    const kv = new MemoryKv()
    const hosted = worker({ identityPort: port(DEMO) })
    for (const origin of [LOCAL, 'http://localhost:8788', 'http://[::1]:8788']) {
      for (const extra of [{}, { MCP_PUBLIC_URL: origin, ENVIRONMENT: 'production' }]) {
        const res = await hosted.fetch(
          new Request(`${origin}/.well-known/oauth-protected-resource/mcp`),
          env(kv, extra),
          ctx(),
        )
        const label = `${origin} ${JSON.stringify(extra)}`
        expect(res.status, label).toBe(200)
        expect(await res.json(), label).toMatchObject({ resource: `${origin}/mcp` })
      }
    }
  })

  it('refuses open registration on a production-shaped host', async () => {
    const kv = new MemoryKv()
    const seen: string[] = []
    const hosted = worker({
      identityPort: port(DEMO),
      fallthrough(request) {
        seen.push(new URL(request.url).pathname)
        return new Response('hook', { status: 200 })
      },
    })
    const res = await hosted.fetch(
      new Request(`${LOCAL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      env(kv, { ENVIRONMENT: 'production', MCP_PUBLIC_URL: LOCAL }),
      ctx(),
    )
    expect(res.status).toBe(403)
    expect(seen).toEqual([])
  })

  it('never hands the shell paths, or their encoded and slashed forms, to the hook', async () => {
    const kv = new MemoryKv()
    const seen: string[] = []
    const hosted = worker({
      identityPort: port(Response.redirect('http://127.0.0.1:5173/login', 302)),
      fallthrough(request) {
        seen.push(new URL(request.url).pathname)
        return new Response('hook', { status: 200 })
      },
    })
    const clientId = await registerClient(hosted, kv)
    const authorize = await hosted.fetch(new Request(await authorizeUrl(clientId)), env(kv), ctx())
    expect(authorize.status).toBe(302)
    expect(authorize.headers.get('location')).toContain('/login')
    const token = await hosted.fetch(
      new Request(`${LOCAL}/token`, { method: 'POST' }),
      env(kv),
      ctx(),
    )
    expect(token.status).toBeGreaterThanOrEqual(400)
    expect(await token.json()).toHaveProperty('error')
    for (const path of [
      '/mcp-admin',
      '/%6Dcp-admin',
      '/authorize/',
      '/%61uthorize',
      '/token/',
      '/register/',
      '//mcp',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-other',
    ]) {
      const res = await hosted.fetch(new Request(`${LOCAL}${path}`), env(kv), ctx())
      expect(res.status, path).toBe(404)
    }
    expect(seen).toEqual([])
  })

  it('strips the oauth helper from the fallthrough env', async () => {
    const kv = new MemoryKv()
    let helperPresent = true
    const hosted = worker({
      identityPort: port(DEMO),
      fallthrough(_request, hookEnv) {
        helperPresent = 'OAUTH_PROVIDER' in hookEnv
        return new Response('ok')
      },
    })
    await hosted.fetch(new Request(`${LOCAL}/health`), env(kv), ctx())
    expect(helperPresent).toBe(false)
  })

  it('gives the identity port and apiBaseUrl an env without the oauth helper', async () => {
    const kv = new MemoryKv()
    const helper: boolean[] = []
    const hosted = worker({
      identityPort: (requestEnv) => {
        helper.push('OAUTH_PROVIDER' in requestEnv)
        return port(DEMO)
      },
      apiBaseUrl: (requestEnv) => {
        helper.push('OAUTH_PROVIDER' in requestEnv)
        return 'http://127.0.0.1:8787'
      },
    })
    const clientId = await registerClient(hosted, kv)
    await hosted.fetch(new Request(await authorizeUrl(clientId)), env(kv), ctx())
    expect(helper).toEqual([false, false])
  })

  it('calls a function identity port on every request with that env', async () => {
    const kv = new MemoryKv()
    const seen: string[] = []
    const hosted = worker({
      identityPort: (requestEnv) => {
        seen.push(requestEnv.ENVIRONMENT ?? '')
        return port(Response.redirect('http://127.0.0.1:5173/login', 302))
      },
    })
    const clientId = await registerClient(hosted, kv)
    await hosted.fetch(
      new Request(await authorizeUrl(clientId)),
      env(kv, { ENVIRONMENT: 'first' }),
      ctx(),
    )
    await hosted.fetch(
      new Request(await authorizeUrl(clientId)),
      env(kv, { ENVIRONMENT: 'second' }),
      ctx(),
    )
    expect(seen).toEqual(['first', 'second'])
  })

  it('binds each request to its own origin when the Worker env object is shared', async () => {
    const kv = new MemoryKv()
    const shared = env(kv)
    const hosted = worker({ identityPort: port(DEMO), consent: DEMO_LOOPBACK })
    const clientId = await registerClient(hosted, kv)
    const first = await hosted.fetch(new Request(await authorizeUrl(clientId)), shared, ctx())
    expect(first.headers.get('location')).toContain('code=')
    const localhost = await authorizeUrl(clientId, { origin: 'http://localhost:8788' })
    const second = await hosted.fetch(new Request(localhost), shared, ctx())
    expect(second.status).toBe(302)
    expect(second.headers.get('location')).toContain('code=')
  })

  it('registers tools per request with the token identity and a helper-free env', async () => {
    const kv = new MemoryKv()
    let helperPresent = true
    const hosted = worker({
      identityPort: port(DEMO),
      consent: DEMO_LOOPBACK,
      register(server, { identity, env: toolEnv }) {
        helperPresent = 'OAUTH_PROVIDER' in toolEnv
        server.addTool({ name: 'who', description: 'caller', execute: async () => identity.userId })
      },
    })
    const { access_token: accessToken } = await exchangeCode(hosted, kv)
    const call = await hosted.fetch(
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
          params: { name: 'who', arguments: {} },
        }),
      }),
      env(kv),
      ctx(),
    )
    expect(call.status).toBe(200)
    expect(await call.text()).toContain(DEMO.userId)
    expect(helperPresent).toBe(false)
  })
})

describe('hosted authorization-server contract', () => {
  it('keeps MCP discovery and the code exchange when OIDC is mounted in fallthrough', async () => {
    vi.stubGlobal('Cloudflare', { compatibilityFlags: { global_fetch_strictly_public: true } })
    const statement = {
      bind: (..._values: unknown[]) => statement,
      first: async () => null,
      run: async () => ({}),
      all: async () => ({}),
      raw: async <T = unknown>(): Promise<T[][]> => [],
    }
    const auth = createBetterAuth({
      database: { prepare: () => statement },
      secret: 'test-better-auth-secret-xxxxxxxx32c!!',
      baseURL: LOCAL,
      trustedOrigins: [LOCAL],
      allowLoopbackOrigins: true,
      oidcProvider: createOidcProvider({
        loginPage: '/login',
        waitUntil: (promise) => {
          void promise
        },
      }),
    })
    const baseline = worker({ identityPort: port(DEMO), consent: DEMO_LOOPBACK })
    const composed = worker({
      identityPort: port(DEMO),
      consent: DEMO_LOOPBACK,
      fallthrough: (request) => auth.handler(request),
    })
    const baselineKv = new MemoryKv()
    const composedKv = new MemoryKv()
    const discoveryPath = '/.well-known/oauth-authorization-server'
    const before = await baseline.fetch(
      new Request(`${LOCAL}${discoveryPath}`),
      env(baselineKv),
      ctx(),
    )
    const after = await composed.fetch(
      new Request(`${LOCAL}${discoveryPath}`),
      env(composedKv),
      ctx(),
    )
    expect(after.status).toBe(before.status)
    expect(await after.json()).toEqual(await before.json())
    const oidc = await composed.fetch(
      new Request(`${LOCAL}/api/auth/.well-known/openid-configuration`),
      env(composedKv),
      ctx(),
    )
    expect(oidc.status).toBe(200)
    expect(await oidc.json()).toMatchObject({
      issuer: `${LOCAL}/api/auth`,
      authorization_endpoint: `${LOCAL}/api/auth/oauth2/authorize`,
      token_endpoint: `${LOCAL}/api/auth/oauth2/token`,
    })
    const beforeToken = await exchangeCode(baseline, baselineKv)
    const afterToken = await exchangeCode(composed, composedKv)
    expect(beforeToken.access_token).toBeTruthy()
    expect(afterToken.access_token).toBeTruthy()
    expect(afterToken.expires_in).toBe(beforeToken.expires_in)
    const crossServer = await composed.fetch(
      new Request(`${LOCAL}/api/auth/oauth2/userinfo`, {
        headers: { authorization: `Bearer ${afterToken.access_token}` },
      }),
      env(composedKv),
      ctx(),
    )
    expect(crossServer.status).toBe(401)
  })

  it('rejects a real OIDC access token at MCP while accepting an MCP token', async () => {
    vi.stubGlobal('Cloudflare', { compatibilityFlags: { global_fetch_strictly_public: true } })
    const sqlite = new Database(':memory:')
    onTestFinished(() => {
      sqlite.close()
    })
    for (const migration of [
      '0005_better_auth.sql',
      '0006_better_auth_organization.sql',
      '0014_better_auth_1_7_additive.sql',
      '0025_account_state.sql',
      '0027_better_auth_oidc_provider.sql',
    ]) {
      sqlite.exec(
        readFileSync(
          new URL(`../../../../apps/example-api/migrations/${migration}`, import.meta.url),
          'utf8',
        ),
      )
    }
    const database = createSqliteD1(sqlite)
    const auth = createBetterAuth({
      database,
      secret: 'test-better-auth-secret-xxxxxxxx32c!!',
      baseURL: LOCAL,
      trustedOrigins: [LOCAL],
      allowLoopbackOrigins: true,
      allowPublicSignup: true,
      oidcProvider: createOidcProvider({
        loginPage: '/login',
        waitUntil: (promise) => {
          void promise
        },
      }),
    })
    const kv = new MemoryKv()
    const signup = await auth.handler(
      new Request(`${LOCAL}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: LOCAL },
        body: JSON.stringify({
          name: 'Example User',
          email: 'user@example.test',
          password: 'example-password-123',
        }),
      }),
    )
    expect(signup.status).toBe(200)
    const { user } = (await signup.json()) as { user: { id: string; email: string } }
    const cookie = signup.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    expect(cookie).not.toBe('')
    const oidcRedirect = 'https://client.example.test/callback'
    const client = await registerOidcClient(auth, {
      headers: new Headers({ cookie }),
      redirectUris: [oidcRedirect],
      firstParty: true,
    })
    expect(client.client_secret).toBeTruthy()
    const hosted = worker({
      identityPort: port({ userId: user.id, email: user.email }),
      consent: { mode: 'demo-loopback', email: user.email },
      fallthrough: (request) => auth.handler(request),
      register(server) {
        server.addTool({ name: 'who', description: 'caller', execute: async () => user.id })
      },
    })
    const hostedEnv = env(kv, { DB: database as unknown as D1Database })
    const { verifier, challenge } = await pkce()
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: oidcRedirect,
      scope: 'openid email profile',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      nonce: 'test-nonce',
    })
    const authorize = await hosted.fetch(
      new Request(`${LOCAL}/api/auth/oauth2/authorize?${params}`, {
        headers: { cookie, accept: 'text/html' },
      }),
      hostedEnv,
      ctx(),
    )
    expect(authorize.status).toBe(302)
    const redirect = new URL(authorize.headers.get('location') ?? '', LOCAL)
    expect(`${redirect.origin}${redirect.pathname}`).toBe(oidcRedirect)
    const code = redirect.searchParams.get('code')
    expect(code).toBeTruthy()
    const token = await hosted.fetch(
      new Request(`${LOCAL}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code as string,
          redirect_uri: oidcRedirect,
          code_verifier: verifier,
        }),
      }),
      hostedEnv,
      ctx(),
    )
    expect(token.status).toBe(200)
    const { access_token: oidcToken } = (await token.json()) as { access_token: string }
    expect(oidcToken).toBeTruthy()
    const userinfo = await hosted.fetch(
      new Request(`${LOCAL}/api/auth/oauth2/userinfo`, {
        headers: { authorization: `Bearer ${oidcToken}` },
      }),
      hostedEnv,
      ctx(),
    )
    expect(userinfo.status).toBe(200)
    expect(await userinfo.json()).toMatchObject({ sub: user.id })
    const mcpCall = (accessToken: string) =>
      hosted.fetch(
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
            params: { name: 'who', arguments: {} },
          }),
        }),
        hostedEnv,
        ctx(),
      )
    const rejected = await mcpCall(oidcToken)
    expect(rejected.status).toBe(401)
    expect(await rejected.text()).not.toContain(user.id)
    const mcpToken = await exchangeCode(hosted, kv)
    expect(mcpToken.access_token).toBeTruthy()
    const accepted = await mcpCall(mcpToken.access_token as string)
    expect(accepted.status).toBe(200)
    expect(await accepted.text()).toContain(user.id)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('advertises S256-only PKCE, the code response type and no token exchange', async () => {
    vi.stubGlobal('Cloudflare', { compatibilityFlags: { global_fetch_strictly_public: true } })
    const kv = new MemoryKv()
    const hosted = worker({ identityPort: port(DEMO) })
    const res = await hosted.fetch(
      new Request(`${LOCAL}/.well-known/oauth-authorization-server`),
      env(kv),
      ctx(),
    )
    const meta = (await res.json()) as Record<string, unknown>
    expect(meta.code_challenge_methods_supported).toEqual(['S256'])
    expect(meta.response_types_supported).toEqual(['code'])
    expect(meta.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
    expect(meta.client_id_metadata_document_supported).toBe(true)
  })

  it('refuses plain PKCE and the implicit response type at /authorize', async () => {
    const kv = new MemoryKv()
    const hosted = worker({ identityPort: port(DEMO), consent: DEMO_LOOPBACK })
    const clientId = await registerClient(hosted, kv)
    const plain = await authorizeUrl(clientId)
    plain.searchParams.set('code_challenge_method', 'plain')
    const implicit = await authorizeUrl(clientId)
    implicit.searchParams.set('response_type', 'token')
    for (const [url, error] of [
      [plain, 'invalid_request'],
      [implicit, 'unsupported_response_type'],
    ] as const) {
      const res = await hosted.fetch(new Request(url), env(kv), ctx())
      expect(res.status, error).toBe(302)
      const location = new URL(res.headers.get('location') ?? '')
      expect(location.searchParams.get('error')).toBe(error)
      expect(location.searchParams.get('code')).toBeNull()
      expect(location.hash).toBe('')
    }
  })

  it('refuses the token-exchange grant at /token', async () => {
    const kv = new MemoryKv()
    const hosted = worker({ identityPort: port(DEMO), consent: DEMO_LOOPBACK })
    const { access_token: accessToken, clientId } = await exchangeCode(hosted, kv)
    const res = await hosted.fetch(
      new Request(`${LOCAL}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          client_id: clientId,
          subject_token: accessToken ?? '',
          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        }),
      }),
      env(kv),
      ctx(),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'unsupported_grant_type' })
  })

  it('issues 8-hour access tokens', async () => {
    const kv = new MemoryKv()
    const hosted = worker({ identityPort: port(DEMO), consent: DEMO_LOOPBACK })
    const token = await exchangeCode(hosted, kv)
    expect(token.expires_in).toBe(8 * 60 * 60)
  })

  it('stores the refresh grant for refreshTokenTTL, else for the provider default', async () => {
    // 30 days: the provider default when refreshTokenTTL is omitted (workers-oauth-provider 1.2).
    for (const [refreshTokenTTL, expected] of [
      [2 * 60 * 60, 2 * 60 * 60],
      [undefined, 30 * 24 * 60 * 60],
    ] as const) {
      const kv = new MemoryKv()
      const hosted = worker({ identityPort: port(DEMO), consent: DEMO_LOOPBACK, refreshTokenTTL })
      const token = await exchangeCode(hosted, kv)
      expect(token.refresh_token, String(refreshTokenTTL)).toBeTruthy()
      const [grant] = kv.grantKeys()
      const left = kv.secondsLeft(grant ?? '') ?? 0
      expect(Math.abs(left - expected), String(refreshTokenTTL)).toBeLessThanOrEqual(2)
    }
  })

  it('refuses a refreshTokenTTL the provider rejects when the worker is created', async () => {
    for (const refreshTokenTTL of [30, 59, 1.5, -1]) {
      expect(
        () => worker({ identityPort: port(DEMO), refreshTokenTTL }),
        String(refreshTokenTTL),
      ).toThrow(TypeError)
    }
    for (const refreshTokenTTL of [0, 60]) {
      const hosted = worker({ identityPort: port(DEMO), refreshTokenTTL })
      const res = await hosted.fetch(
        new Request(`${LOCAL}/.well-known/oauth-authorization-server`),
        env(new MemoryKv()),
        ctx(),
      )
      expect(res.status, String(refreshTokenTTL)).toBe(200)
    }
  })
})

describe('hosted consent', () => {
  it('stores and reads consent using the SHA-256 digest of the cookie id', async () => {
    const kv = new MemoryKv()
    const namespace = kv as unknown as KVNamespace
    const id = '00000000000000000000000000000000'
    const key = 'mcp_consent:84e0c0eafaa95a34c293f278ac52e45ce537bab5e752a00e6959a13ae103b65a'
    const record: Parameters<typeof putConsent>[2] = {
      identity: DEMO,
      request: { clientId: 'client', redirectUri: REDIRECT } as Parameters<
        typeof putConsent
      >[2]['request'],
      scope: ['mcp'],
    }
    const random = vi.spyOn(crypto, 'getRandomValues').mockReturnValue(new Uint8Array(16))
    const put = vi.spyOn(kv, 'put')
    let result: { csrf: string; cookie: string }
    try {
      result = await putConsent(namespace, new URL(LOCAL), record)
    } finally {
      random.mockRestore()
    }
    expect(result.cookie).toContain(`mcp_consent_id=${id};`)
    expect(kv.consentKeys()).toEqual([key])
    expect(put).toHaveBeenCalledWith(key, expect.any(String), { expirationTtl: 600 })
    const request = (cookie: string) =>
      new Request(`${LOCAL}/authorize`, { headers: { cookie: `mcp_consent_id=${cookie}` } })
    expect(await readConsent(namespace, request(id))).toEqual({ ...record, csrf: result.csrf, key })
    expect(await readConsent(namespace, request('11111111111111111111111111111111'))).toBeNull()
    expect(await readConsent(namespace, request(`${id}x`))).toBeNull()
    await kv.delete(key)
    expect(await readConsent(namespace, request(id))).toBeNull()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('always-show names the client and redirect host on an unframable page', async () => {
    const kv = new MemoryKv()
    const hosted = worker({ identityPort: port(DEMO) })
    const clientId = await registerClient(hosted, kv)
    const { res, html, setCookie } = await consentPage(hosted, kv, await authorizeUrl(clientId))
    expect(res.status).toBe(200)
    expect(html).toContain('Authorize MCP client')
    expect(html).toContain('hosted-test-client')
    expect(html).toContain(clientId)
    expect(html).toContain('127.0.0.1:9999')
    expect(html).toContain('on your own computer')
    expect(html).toContain('action="/authorize"')
    expect(html).toMatch(/<meta\b[^>]*name=["']viewport["']/i)
    expect(html).not.toMatch(/<(?:img|picture|source)\b/i)
    expect(html).not.toMatch(/\burl\s*\(/i)
    expect(html).not.toMatch(/<link\b[^>]*rel=["']stylesheet["']/i)
    expect(res.headers.get('content-security-policy')).not.toContain('img-src')
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(setCookie).toMatch(/^mcp_consent_id=[0-9a-f]+; Path=\/authorize; HttpOnly; SameSite=Lax/)
    expect(setCookie).toContain('Max-Age=600')
    expect(setCookie).not.toContain('Secure')
  })
  it('snapshots branding and allows same-origin images and one nonced style', async () => {
    const kv = new MemoryKv()
    const brand = {
      logoPath: '/assets/v1.2/consent-logo.svg',
      backdropPath: '/assets/consent-backdrop.webp',
      accentColor: '#fffbeb',
      serifHeading: true,
    }
    const hosted = worker({
      identityPort: port(DEMO),
      consentPresentation: { brand, serviceName: 'Example Service' },
    })
    brand.logoPath = '/assets/changed-logo.png'
    brand.backdropPath = '/assets/changed-backdrop.png'
    brand.accentColor = '#abcdef'
    brand.serifHeading = false

    const clientId = await registerClient(hosted, kv)
    const { res, html, csrf } = await consentPage(hosted, kv, await authorizeUrl(clientId))
    expect(res.status).toBe(200)
    expect(html).toContain('/assets/v1.2/consent-logo.svg')
    expect(html).toContain('/assets/consent-backdrop.webp')
    expect(html).toContain('Example Service')
    expect(html).toMatch(/--accent: #fffbeb; --button-ink: black;/)
    expect(html).toMatch(/<main class="[^"]*\bserif\b/)
    expect(html).not.toContain('/assets/changed-logo.png')
    expect(html).not.toContain('/assets/changed-backdrop.png')
    expect(html).not.toContain('#abcdef')

    const csp = res.headers.get('content-security-policy') ?? ''
    const directives = new Map(
      csp.split(';').map((part) => {
        const [name, ...values] = part.trim().split(/\s+/)
        return [name, values] as const
      }),
    )
    expect(directives.get('default-src')).toEqual(["'none'"])
    expect(directives.get('img-src')).toEqual(["'self'"])
    const styles = [...html.matchAll(/<style\b([^>]*)>/gi)]
    expect(styles).toHaveLength(1)
    const nonce = /\bnonce=["']([^"']+)["']/i.exec(styles[0]?.[1] ?? '')?.[1]
    expect(nonce).toBeTruthy()
    expect(nonce).not.toBe(csrf)
    expect(directives.get('style-src')).toEqual([`'nonce-${nonce}'`])
    expect(csp).not.toContain("'unsafe-inline'")
    expect(html).not.toMatch(/<script\b/i)
    expect(html.match(/<form\b/gi)).toHaveLength(1)
    expect(html).toMatch(/<form\b[^>]*method="post"[^>]*action="\/authorize"/i)
    for (const value of ['yes', 'no']) {
      const control = html.match(
        new RegExp(
          `<button\\b(?=[^>]*\\bname=["']consent["'])(?=[^>]*\\bvalue=["']${value}["'])[^>]*>`,
          'i',
        ),
      )?.[0]
      expect(control).toBeTruthy()
      expect(control).not.toMatch(/\bdisabled\b/i)
    }
    expect(csrf).toBeTruthy()
    expect(csp).toContain("frame-ancestors 'none'")
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it.each([
    { logoPath: 'https://other.example/logo.svg' },
    { backdropPath: '/assets/document.html' },
    { accentColor: 'red' },
  ])('rejects invalid branding at construction: %o', (brand) => {
    expect(() =>
      worker({ identityPort: port(DEMO), consentPresentation: { brand, serviceName: 'Service' } }),
    ).toThrow(TypeError)
  })

  it('requires a text service name when a logo identifies the service', () => {
    expect(() =>
      worker({
        identityPort: port(DEMO),
        consentPresentation: { brand: { logoPath: '/assets/logo.svg' } },
      }),
    ).toThrow(/serviceName/)
  })

  it('renders French presentation as text in one protected consent form and snapshots its data', async () => {
    const kv = new MemoryKv()
    const disclosure = { label: '<img src=x>', text: 'Read "this" & <script>bad()</script>' }
    const presentation: {
      locale: 'fr' | 'en'
      serviceName: string
      disclosures: { label: string; text: string }[]
    } = {
      locale: 'fr',
      serviceName: 'Service <svg onload="bad()">',
      disclosures: [disclosure],
    }
    const hosted = worker({ identityPort: port(DEMO), consentPresentation: presentation })
    presentation.locale = 'en'
    presentation.serviceName = 'Changed service'
    disclosure.label = 'Changed label'
    disclosure.text = 'Changed text'
    presentation.disclosures.push({ label: 'Added later', text: 'Not in the snapshot' })

    const clientId = await registerClient(hosted, kv)
    const { res, html, csrf } = await consentPage(hosted, kv, await authorizeUrl(clientId))
    expect(res.status).toBe(200)
    expect(html).toMatch(/<html\s+lang="fr"/)
    expect(html).toContain('Service &lt;svg onload=&quot;bad()&quot;&gt;')
    expect(html).toContain('&lt;img src=x&gt;')
    expect(html).toContain('Read &quot;this&quot; &amp; &lt;script&gt;bad()&lt;/script&gt;')
    expect(html).not.toMatch(/<svg|<img|<script/i)
    expect(html).not.toContain('Changed')
    expect(html).not.toContain('Added later')
    expect(html.match(/<form\b/gi)).toHaveLength(1)
    expect(html).toMatch(/<form\b[^>]*method="post"[^>]*action="\/authorize"/i)
    expect(html).toContain('name="consent" value="yes"')
    expect(html).toContain('name="consent" value="no"')
    expect(csrf).toBeTruthy()
    expect(html).toContain(DEMO.email)
    expect(html).toContain(clientId)
    expect(html).toContain('127.0.0.1:9999')
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('keeps redirect-class warnings on French pages', async () => {
    const cimd = 'https://client.example.test/client.json'
    for (const [redirect, warning] of [
      ['https://client.example.test/cb', null],
      ['http://127.0.0.1:9/cb', 'Le code est envoyé à un programme sur votre ordinateur'],
      ['com.example.app:/cb', 'Le code est envoyé à une application sur cet appareil'],
    ] as const) {
      stubCimd(cimd, redirect)
      const kv = new MemoryKv()
      const hosted = worker({ identityPort: port(DEMO), consentPresentation: { locale: 'fr' } })
      const { res, html } = await consentPage(hosted, kv, await authorizeUrl(cimd, { redirect }))
      expect(res.status, redirect).toBe(200)
      expect(html).toMatch(/<html\s+lang="fr"/)
      if (warning) expect(html, redirect).toContain(warning)
      else expect(html, redirect).not.toContain('Le code est envoyé à')
      if (redirect.startsWith('com.example.app:')) {
        expect(html).toContain('<strong>com.example.app:</strong>')
      }
    }
  })

  it('binds French Allow and Deny to the authenticated GET and enforces CSRF and PKCE', async () => {
    const kv = new MemoryKv()
    let identity = OTHER
    const hosted = worker({
      identityPort: { resolve: async () => identity },
      consentPresentation: { locale: 'fr', serviceName: 'Example service' },
    })
    const clientId = await registerClient(hosted, kv)
    const { verifier, challenge } = await pkce()
    const page = await consentPage(hosted, kv, await authorizeUrl(clientId, { challenge }))
    expect(page.res.status).toBe(200)
    expect(page.html).toContain(OTHER.email)
    const invalid = await postConsent(hosted, kv, `${LOCAL}/authorize`, {
      cookie: page.cookie,
      csrf: 'wrong',
    })
    expect(invalid.status).toBe(400)
    expect(kv.grantKeys()).toEqual([])
    identity = DEMO
    const swapped = new URL(`${LOCAL}/authorize`)
    swapped.searchParams.set('client_id', 'someone-else')
    swapped.searchParams.set('redirect_uri', 'http://127.0.0.1:7777/steal')
    swapped.searchParams.set('state', 'state-swapped')
    swapped.searchParams.set('code_challenge', (await pkce()).challenge)
    const allowed = await postConsent(hosted, kv, swapped.toString(), page)
    expect(allowed.status).toBe(302)
    expect(allowed.headers.get('set-cookie')).toMatch(/^mcp_consent_id=; .*Max-Age=0/)
    const location = new URL(allowed.headers.get('location') ?? '')
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT)
    expect(location.searchParams.get('state')).toBe('state-ok')
    const code = location.searchParams.get('code') ?? ''
    expect(code).toBeTruthy()
    const token = await hosted.fetch(
      new Request(`${LOCAL}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
          resource: `${LOCAL}/mcp`,
        }),
      }),
      env(kv),
      ctx(),
    )
    expect(token.status).toBe(200)
    expect(kv.grantKeys().some((key) => key.startsWith(`grant:${OTHER.userId}:`))).toBe(true)
    expect(kv.grantKeys().some((key) => key.startsWith(`grant:${DEMO.userId}:`))).toBe(false)
    expect((await postConsent(hosted, kv, `${LOCAL}/authorize`, page)).status).toBe(401)

    const deniedPage = await consentPage(hosted, kv, await authorizeUrl(clientId))
    const denied = await postConsent(hosted, kv, swapped.toString(), {
      ...deniedPage,
      consent: 'no',
    })
    expect(denied.status).toBe(302)
    expect(denied.headers.get('set-cookie')).toMatch(/^mcp_consent_id=; .*Max-Age=0/)
    const deniedLocation = new URL(denied.headers.get('location') ?? '')
    expect(`${deniedLocation.origin}${deniedLocation.pathname}`).toBe(REDIRECT)
    expect(deniedLocation.searchParams.get('state')).toBe('state-ok')
    expect(deniedLocation.searchParams.get('error')).toBe('access_denied')
    expect(deniedLocation.searchParams.get('code')).toBeNull()
    expect(kv.consentKeys()).toEqual([])
  })

  it('warns for the redirect class the code really goes to', async () => {
    const cimd = 'https://client.example.test/client.json'
    const LOCAL_TEXT = 'a program on your own computer'
    const APP_TEXT = 'an app on this device (com.example.app:)'
    for (const [redirect, expected] of [
      ['https://127.0.0.1.evil.example/cb', null],
      ['https://client.example.test/cb', null],
      ['http://127.0.0.1:9/cb', LOCAL_TEXT],
      ['http://[::1]:9/cb', LOCAL_TEXT],
      ['https://[::ffff:127.0.0.1]:9/cb', LOCAL_TEXT],
      ['https://foo.localhost/cb', LOCAL_TEXT],
      ['com.example.app:/cb', APP_TEXT],
    ] as const) {
      stubCimd(cimd, redirect)
      const kv = new MemoryKv()
      const hosted = worker({ identityPort: port(DEMO) })
      const { res, html } = await consentPage(hosted, kv, await authorizeUrl(cimd, { redirect }))
      expect(res.status, redirect).toBe(200)
      for (const text of [LOCAL_TEXT, APP_TEXT]) {
        expect(html.includes(text), `${redirect}: ${text}`).toBe(text === expected)
      }
    }
  })

  it('refuses http off the provider loopback hosts before the identity port or a consent page', async () => {
    let identityCalls = 0
    const counted: McpIdentityPort = {
      resolve: async () => {
        identityCalls += 1
        return DEMO
      },
    }
    const cimd = 'https://client.example.test/client.json'
    for (const redirect of ['http://evil.example/cb', 'http://[::ffff:127.0.0.1]:9/cb']) {
      stubCimd(cimd, redirect)
      const kv = new MemoryKv()
      const hosted = worker({ identityPort: counted })
      const page = await consentPage(hosted, kv, await authorizeUrl(cimd, { redirect }))
      expect(page.res.status, redirect).toBe(400)
      expect(page.res.headers.get('location'), redirect).toBeNull()
      expect(page.html, redirect).not.toContain('name="csrf"')
      expect(page.setCookie, redirect).toBe('')
      expect(kv.consentKeys(), redirect).toEqual([])
    }
    expect(identityCalls).toBe(0)

    // A registered client may list one beside a loopback URI: only the loopback one is served.
    vi.unstubAllGlobals()
    const kv = new MemoryKv()
    const hosted = worker({ identityPort: counted })
    const registered = await hosted.fetch(
      new Request(`${LOCAL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: [REDIRECT, 'http://evil.example/cb'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code'],
          response_types: ['code'],
        }),
      }),
      env(kv),
      ctx(),
    )
    expect(registered.status).toBe(201)
    const { client_id: clientId = '' } = (await registered.json()) as { client_id?: string }
    const redirect = 'http://evil.example/cb'
    const evil = await consentPage(hosted, kv, await authorizeUrl(clientId, { redirect }))
    expect(evil.res.status).toBe(400)
    expect(evil.setCookie).toBe('')
    expect(identityCalls).toBe(0)
    const loopback = await consentPage(hosted, kv, await authorizeUrl(clientId))
    expect(loopback.res.status).toBe(200)
    expect(identityCalls).toBe(1)
  })

  it('uses a __Host- Secure cookie off loopback and reads only that name there', async () => {
    const kv = new MemoryKv()
    const hosted = worker({ identityPort: port(OTHER) })
    const clientId = await registerClient(hosted, kv)
    const url = await authorizeUrl(clientId, { origin: PUBLIC })
    const page = await consentPage(hosted, kv, url)
    expect(page.res.status).toBe(200)
    expect(page.setCookie).toMatch(/^__Host-mcp_consent_id=[0-9a-f]+; Path=\/; Secure; HttpOnly/)
    const id = page.cookie.split('=')[1] ?? ''
    const plain = await postConsent(hosted, kv, `${PUBLIC}/authorize`, {
      cookie: `mcp_consent_id=${id}`,
      csrf: page.csrf,
    })
    expect(plain.status).toBe(401)
    const done = await postConsent(hosted, kv, `${PUBLIC}/authorize`, {
      cookie: page.cookie,
      csrf: page.csrf,
    })
    expect(done.status).toBe(302)
    expect(done.headers.get('location')).toContain('code=')
    expect(done.headers.get('set-cookie')).toMatch(/^__Host-mcp_consent_id=; .*Max-Age=0/)
  })

  it('skip completes without a page for a client the product registered', async () => {
    const kv = new MemoryKv()
    const hosted = worker({ identityPort: port(DEMO), consent: 'skip' })
    const clientId = await productClient(kv)
    for (const origin of [LOCAL, PUBLIC]) {
      const res = await hosted.fetch(
        new Request(await authorizeUrl(clientId, { origin })),
        envFor(kv, origin),
        ctx(),
      )
      expect(res.status, origin).toBe(302)
      expect(res.headers.get('location')).toContain('code=')
    }
  })

  it('skip shows the page to open DCR and bare createClient clients', async () => {
    const kv = new MemoryKv()
    const hosted = worker({ identityPort: port(DEMO), consent: 'skip' })
    const dcrId = await registerClient(hosted, kv)
    const bareId = await bareCreateClient(kv)
    for (const [label, clientId] of [
      ['dcr', dcrId],
      ['bare', bareId],
    ] as const) {
      for (const origin of [LOCAL, PUBLIC]) {
        const { res } = await consentPage(hosted, kv, await authorizeUrl(clientId, { origin }))
        expect(res.status, `${label}@${origin}`).toBe(200)
        expect(res.headers.get('location')).toBeNull()
      }
    }
  })

  it('skip shows the page when the provider client is visible but the product receipt is not', async () => {
    const kv = new MemoryKv()
    const hosted = worker({ identityPort: port(DEMO), consent: 'skip' })
    const clientId = await productClient(kv)
    const receipt = `mcp_product_client:${clientId}`
    expect(kv.data.has(receipt)).toBe(true)
    expect(kv.data.has(`client:${clientId}`)).toBe(true)
    kv.data.delete(receipt)
    for (const origin of [LOCAL, PUBLIC]) {
      const { res } = await consentPage(hosted, kv, await authorizeUrl(clientId, { origin }))
      expect(res.status, origin).toBe(200)
      expect(res.headers.get('location')).toBeNull()
    }
  })

  it('skip and demo-loopback still show the page to a self-declared (CIMD) client', async () => {
    const cimd = 'https://evil.example.test/client.json'
    stubCimd(cimd)
    const kv = new MemoryKv()
    for (const consent of ['skip', DEMO_LOOPBACK] as const) {
      const hosted = worker({ identityPort: port(DEMO), consent })
      const { res, html } = await consentPage(hosted, kv, await authorizeUrl(cimd))
      expect(res.status, String(consent)).toBe(200)
      expect(html).toContain(cimd)
    }
  })

  it('answers 400 when a CIMD document cannot be fetched', async () => {
    vi.stubGlobal('Cloudflare', { compatibilityFlags: { global_fetch_strictly_public: true } })
    vi.stubGlobal('fetch', async () => new Response('gone', { status: 404 }))
    const kv = new MemoryKv()
    const hosted = worker({ identityPort: port(DEMO) })
    const url = await authorizeUrl('https://gone.example.test/client.json')
    const res = await hosted.fetch(new Request(url), env(kv), ctx())
    expect(res.status).toBe(400)
  })

  it('sends client-bound errors to the redirect URI only after the user is authenticated', async () => {
    const cimd = 'https://attacker.example.test/client.json'
    const landing = 'https://attacker.example.test/land'
    stubCimd(cimd, landing)
    const kv = new MemoryKv()
    const login = 'http://127.0.0.1:5173/login'
    const anonymous = worker({ identityPort: port(Response.redirect(login, 302)) })
    const signedIn = worker({ identityPort: port(DEMO) })
    const badScope = await authorizeUrl(cimd, { redirect: landing, scope: 'admin' })
    const noPkce = await authorizeUrl(cimd, { redirect: landing })
    noPkce.searchParams.delete('code_challenge')
    noPkce.searchParams.delete('code_challenge_method')
    for (const [url, error] of [
      [badScope, 'invalid_scope'],
      [noPkce, 'invalid_request'],
    ] as const) {
      const before = await anonymous.fetch(new Request(url), env(kv), ctx())
      expect(before.status, error).toBe(302)
      expect(before.headers.get('location'), error).toBe(login)
      const after = await signedIn.fetch(new Request(url), env(kv), ctx())
      const location = new URL(after.headers.get('location') ?? '')
      expect(`${location.origin}${location.pathname}`, error).toBe(landing)
      expect(location.searchParams.get('error')).toBe(error)
    }
  })

  it('skip returns a login redirect without completing', async () => {
    const kv = new MemoryKv()
    const hosted = worker({
      identityPort: port(Response.redirect('http://127.0.0.1:5173/login', 302)),
      consent: 'skip',
    })
    const clientId = await registerClient(hosted, kv)
    const res = await hosted.fetch(new Request(await authorizeUrl(clientId)), env(kv), ctx())
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/login')
    expect(res.headers.get('location')).not.toContain('code=')
  })

  it('demo-loopback auto-approves only that email on loopback', async () => {
    const kv = new MemoryKv()
    const consent = DEMO_LOOPBACK
    const hosted = worker({ identityPort: port(DEMO), consent })
    const clientId = await registerClient(hosted, kv)
    const approved = await hosted.fetch(new Request(await authorizeUrl(clientId)), env(kv), ctx())
    expect(approved.status).toBe(302)
    expect(approved.headers.get('location')).toContain('code=')

    const other = worker({ identityPort: port(OTHER), consent })
    const page = await consentPage(other, kv, await authorizeUrl(clientId))
    expect(page.res.status).toBe(200)
    expect(page.html).toContain('Authorize MCP client')
  })

  it('refuses a cookie for one record with the csrf of another, and keeps both', async () => {
    const kv = new MemoryKv()
    const hosted = worker({ identityPort: port(OTHER) })
    const clientId = await registerClient(hosted, kv)
    const a = await consentPage(hosted, kv, await authorizeUrl(clientId))
    const b = await consentPage(hosted, kv, await authorizeUrl(clientId))
    expect(a.csrf).not.toBe(b.csrf)
    const crossed = await postConsent(hosted, kv, `${LOCAL}/authorize`, {
      cookie: a.cookie,
      csrf: b.csrf,
    })
    expect(crossed.status).toBe(400)
    expect(kv.consentKeys()).toHaveLength(2)
    const own = await postConsent(hosted, kv, `${LOCAL}/authorize`, {
      cookie: a.cookie,
      csrf: a.csrf,
    })
    expect(own.status).toBe(302)
    expect(own.headers.get('location')).toContain('code=')
  })

  it('completes the request the page was shown for, not the POST query', async () => {
    const kv = new MemoryKv()
    const hosted = worker({ identityPort: port(OTHER) })
    const clientId = await registerClient(hosted, kv)
    const page = await consentPage(hosted, kv, await authorizeUrl(clientId))
    const swapped = new URL(`${LOCAL}/authorize`)
    swapped.searchParams.set('client_id', 'someone-else')
    swapped.searchParams.set('redirect_uri', 'http://127.0.0.1:7777/steal')
    swapped.searchParams.set('state', 'state-swapped')
    const res = await postConsent(hosted, kv, swapped.toString(), page)
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT)
    expect(location.searchParams.get('state')).toBe('state-ok')
    expect(location.searchParams.get('code')).toBeTruthy()
  })

  it('spends the consent record once and clears the cookie', async () => {
    const kv = new MemoryKv()
    const hosted = worker({ identityPort: port(OTHER) })
    const clientId = await registerClient(hosted, kv)
    const page = await consentPage(hosted, kv, await authorizeUrl(clientId))
    expect(kv.consentKeys()).toHaveLength(1)
    const first = await postConsent(hosted, kv, `${LOCAL}/authorize`, page)
    expect(first.status).toBe(302)
    expect(first.headers.get('set-cookie')).toMatch(/^mcp_consent_id=; .*Max-Age=0/)
    expect(kv.consentKeys()).toEqual([])
    const second = await postConsent(hosted, kv, `${LOCAL}/authorize`, page)
    expect(second.status).toBe(401)
  })

  it('redirects access_denied to the client on Deny', async () => {
    const kv = new MemoryKv()
    const hosted = worker({ identityPort: port(OTHER) })
    const clientId = await registerClient(hosted, kv)
    const page = await consentPage(hosted, kv, await authorizeUrl(clientId))
    const res = await postConsent(hosted, kv, `${LOCAL}/authorize`, { ...page, consent: 'no' })
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT)
    expect(location.searchParams.get('error')).toBe('access_denied')
    expect(location.searchParams.get('state')).toBe('state-ok')
    expect(location.searchParams.get('code')).toBeNull()
    expect(kv.consentKeys()).toEqual([])
  })

  it('answers 405 to methods other than GET and POST', async () => {
    const kv = new MemoryKv()
    const hosted = worker({ identityPort: port(DEMO), consent: 'skip' })
    const clientId = await registerClient(hosted, kv)
    const res = await hosted.fetch(
      new Request(await authorizeUrl(clientId), { method: 'PUT' }),
      env(kv),
      ctx(),
    )
    expect(res.status).toBe(405)
  })

  it('redirects invalid_scope for a scope other than mcp', async () => {
    const kv = new MemoryKv()
    const hosted = worker({ identityPort: port(DEMO), consent: 'skip' })
    const clientId = await registerClient(hosted, kv)
    const res = await hosted.fetch(
      new Request(await authorizeUrl(clientId, { scope: 'mcp admin' })),
      env(kv),
      ctx(),
    )
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.searchParams.get('error')).toBe('invalid_scope')
    expect(location.searchParams.get('state')).toBe('state-ok')
    expect(location.searchParams.get('code')).toBeNull()
  })

  it('refuses an identity whose user id would collide in grant keys', async () => {
    const kv = new MemoryKv()
    const hosted = worker({ identityPort: port({ userId: 'user:b' }), consent: 'skip' })
    const clientId = await registerClient(hosted, kv)
    const res = await hosted.fetch(new Request(await authorizeUrl(clientId)), env(kv), ctx())
    expect(res.status).toBe(500)
    expect(res.headers.get('location')).toBeNull()
  })
})
