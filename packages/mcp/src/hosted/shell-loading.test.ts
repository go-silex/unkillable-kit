import type * as OAuthModule from '@cloudflare/workers-oauth-provider'
import { describe, expect, it, vi } from 'vitest'
import { createHostedMcpWorker } from './create-worker'
import type { HostedMcpEnv } from './env'

/** What the worker has evaluated or built so far. */
const seen = vi.hoisted(() => ({ shell: 0, edge: 0, providers: 0 }))

vi.mock('./shell', async (importOriginal) => {
  seen.shell += 1
  return importOriginal()
})
vi.mock('fastmcp/edge', async (importOriginal) => {
  seen.edge += 1
  return importOriginal()
})
vi.mock('@cloudflare/workers-oauth-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof OAuthModule>()
  class CountingProvider<Env> extends actual.OAuthProvider<Env> {
    constructor(...args: ConstructorParameters<typeof actual.OAuthProvider<Env>>) {
      super(...args)
      seen.providers += 1
    }
  }
  return { ...actual, OAuthProvider: CountingProvider }
})

const PUBLIC = 'https://mcp.example.test'
const LOCAL = 'http://127.0.0.1:8788'
// Never read: neither product routes nor protected-resource metadata touch storage.
const bindings = {
  OAUTH_KV: {} as KVNamespace,
  DB: {} as D1Database,
}
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

function worker(fallthrough?: boolean) {
  return createHostedMcpWorker<HostedMcpEnv>({
    name: 'loading-test',
    apiBaseUrl: () => 'http://127.0.0.1:8787',
    identityPort: { resolve: async () => ({ userId: 'user_demo' }) },
    register() {},
    ...(fallthrough
      ? {
          fallthrough: (request: Request) =>
            new Response(`product ${request.method} ${new URL(request.url).pathname}`),
        }
      : {}),
  })
}

/** Every origin and configuration a product route can arrive with; the shell's status there. */
const CASES: [string, string, Partial<HostedMcpEnv>, 'shell' | 404 | 500][] = [
  ['pinned origin', PUBLIC, { MCP_PUBLIC_URL: PUBLIC }, 'shell'],
  ['loopback, unconfigured', LOCAL, {}, 'shell'],
  ['another host', 'https://preview.mcp.example.test', { MCP_PUBLIC_URL: PUBLIC }, 404],
  ['cleartext', 'http://mcp.example.test', { MCP_PUBLIC_URL: PUBLIC }, 404],
  ['missing configuration', PUBLIC, {}, 500],
  ['unusable configuration', PUBLIC, { MCP_PUBLIC_URL: 'http://mcp.example.test' }, 500],
  ['production loopback, unconfigured', LOCAL, { ENVIRONMENT: 'production' }, 500],
]
const PRODUCT_PATHS = ['/', '/api/projects', '/MCP', '/.well-known/openid-configuration']

describe('hosted shell loading', () => {
  // One scenario: module evaluation is per test file, so the order is the assertion.
  it('evaluates the shell on the first shell request only, and builds a provider per shell request', async () => {
    const hosted = worker(true)
    const bare = worker(false)
    for (const [label, origin, extra, shell] of CASES) {
      for (const path of PRODUCT_PATHS) {
        for (const method of ['GET', 'POST', 'OPTIONS']) {
          const request = () => new Request(`${origin}${path}`, { method })
          const res = await hosted.fetch(request(), { ...bindings, ...extra }, ctx)
          expect(await res.text(), `${label} ${method} ${path}`).toBe(`product ${method} ${path}`)
          const missing = await bare.fetch(request(), { ...bindings, ...extra }, ctx)
          expect(missing.status, `${label} ${method} ${path}`).toBe(404)
        }
      }
      // A reserved path the pinned origin does not serve is answered before the shell, too.
      if (shell !== 'shell') {
        const res = await hosted.fetch(new Request(`${origin}/mcp`), { ...bindings, ...extra }, ctx)
        expect(res.status, label).toBe(shell)
      }
    }
    expect(seen).toEqual({ shell: 0, edge: 0, providers: 0 })

    const deployed = { ...bindings, MCP_PUBLIC_URL: PUBLIC }
    for (const providers of [1, 2]) {
      const res = await hosted.fetch(
        new Request(`${PUBLIC}/.well-known/oauth-protected-resource/mcp`),
        deployed,
        ctx,
      )
      expect(await res.json()).toMatchObject({ resource: `${PUBLIC}/mcp` })
      expect(seen).toEqual({ shell: 1, edge: 1, providers })
    }
    const product = await hosted.fetch(new Request(`${PUBLIC}/api/projects`), deployed, ctx)
    expect(await product.text()).toBe('product GET /api/projects')
    expect(seen).toEqual({ shell: 1, edge: 1, providers: 2 })
  })
})
