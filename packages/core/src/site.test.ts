import { describe, expect, it, vi } from 'vitest'
import { createSiteFetch } from './site'

function setup(
  options: {
    shellHeaders?: HeadersInit
    assetPrefix?: string
    isApiPath?: (path: string) => boolean
  } = {},
) {
  const requests: Request[] = []
  const api = vi.fn((_request: Request, _env: unknown, _context: unknown) =>
    Response.json({ source: 'api' }, { status: 404 }),
  )
  const binding = {
    async fetch(request: Request) {
      requests.push(request)
      const path = new URL(request.url).pathname
      if (path === '/')
        return new Response(request.method === 'HEAD' ? null : '<html>shell</html>', {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public' },
        })
      if (path === '/existing.js')
        return new Response('javascript', { headers: { 'content-type': 'application/javascript' } })
      if (path === '/unchanged')
        return new Response(null, { status: 304, headers: { etag: '"v1"' } })
      return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } })
    },
  }
  const fetch = createSiteFetch({
    api,
    assets: (env: { ASSETS?: typeof binding }) => env.ASSETS,
    ...options,
  })
  const call = (
    path: string,
    init?: RequestInit,
    env: { ASSETS?: typeof binding } = { ASSETS: binding },
  ) => fetch(new Request(`https://site.example${path}`, init), env, {})
  return { call, api, requests, binding }
}

describe('createSiteFetch', () => {
  it('serves the shell for a deep link with browser headers and strips queries from both requests', async () => {
    const { call, requests } = setup()
    const response = await call('/dashboard/profile?token=secret', {
      headers: { accept: 'text/html' },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<html>shell</html>')
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(requests.map((request) => request.url)).toEqual([
      'https://site.example/dashboard/profile',
      'https://site.example/',
    ])
  })

  it('returns existing assets unchanged, without forwarding the query', async () => {
    const { call, requests } = setup()
    const response = await call('/existing.js?token=secret')
    expect(await response.text()).toBe('javascript')
    expect(response.headers.get('content-type')).toBe('application/javascript')
    expect(requests.map((request) => request.url)).toEqual(['https://site.example/existing.js'])
  })

  it.each(['/assets/missing.js', '/assets/missing', '/missing.js'])(
    'keeps missing file %s as a non-HTML 404',
    async (path) => {
      const { call, requests } = setup()
      const response = await call(path)
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).not.toContain('text/html')
      expect(requests).toHaveLength(1)
    },
  )

  it('never falls back under the asset prefix even for HTML navigation', async () => {
    const { call, requests } = setup()
    const response = await call('/assets/missing.js', { headers: { accept: 'text/html' } })
    expect(response.status).toBe(404)
    expect(requests).toHaveLength(1)
  })

  it('allows a dotted navigation when HTML is accepted', async () => {
    const { call } = setup()
    expect(await (await call('/a.b', { headers: { accept: 'text/html' } })).text()).toBe(
      '<html>shell</html>',
    )
  })

  it('preserves HEAD on asset and shell requests', async () => {
    const { call, requests } = setup()
    const response = await call('/dashboard', { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
    expect(requests.map((request) => request.method)).toEqual(['HEAD', 'HEAD'])
  })

  it.each(['/api', '/api/unknown', '/API/unknown', '/%61pi/unknown', '/health', '/%E0%A4%A'])(
    'routes %s to API even for navigation',
    async (path) => {
      const { call, api, requests } = setup()
      const response = await call(path, {
        headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
      })
      expect(await response.json()).toEqual({ source: 'api' })
      expect(api).toHaveBeenCalledOnce()
      expect(requests).toHaveLength(0)
    },
  )

  it('passes a 304 response through unchanged', async () => {
    const { call, requests } = setup()
    const response = await call('/unchanged')
    expect(response.status).toBe(304)
    expect(response.headers.get('etag')).toBe('"v1"')
    expect(response.headers.get('cache-control')).toBeNull()
    expect(requests).toHaveLength(1)
  })

  it('returns JSON 405 with Allow for non-API methods', async () => {
    const { call, requests, api } = setup()
    const response = await call('/dashboard', { method: 'POST' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', message: 'Method not allowed' },
    })
    expect(requests).toHaveLength(0)
    expect(api).not.toHaveBeenCalled()
  })

  it('forwards every request unchanged when no binding exists', async () => {
    const { call, requests, api } = setup()
    for (const path of ['/api/me', '/some/page?token=secret']) {
      const response = await call(path, { method: 'POST' }, {})
      expect(response.status).toBe(404)
    }
    expect(api).toHaveBeenCalledTimes(2)
    expect(api.mock.calls[1]?.[0].url).toBe('https://site.example/some/page?token=secret')
    expect(requests).toHaveLength(0)
  })

  it('applies caller header overrides to HTML, including existing HTML files', async () => {
    const { call } = setup({
      shellHeaders: { 'cache-control': 'private', 'content-security-policy': "default-src 'self'" },
    })
    const response = await call('/')
    expect(response.headers.get('cache-control')).toBe('private')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'self'")
  })

  it('supports custom API paths and asset prefixes', async () => {
    const { call, requests, api } = setup({
      isApiPath: (path) => path === '/rpc',
      assetPrefix: '/static/',
    })
    await call('/rpc')
    expect(api).toHaveBeenCalledOnce()
    expect((await call('/static/missing', { headers: { accept: 'text/html' } })).status).toBe(404)
    expect(requests).toHaveLength(1)
  })
})
