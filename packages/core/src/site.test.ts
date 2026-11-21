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
  const files: Record<string, { type: string; body: string }> = {
    '/': { type: 'text/html; charset=utf-8', body: '<html>shell</html>' },
    '/guide.v2': { type: 'text/html', body: '<html>guide</html>' },
    '/existing.js': { type: 'application/javascript', body: 'javascript' },
    '/assets/app.js': { type: 'application/javascript', body: 'built' },
  }
  const binding = {
    async fetch(request: Request) {
      requests.push(request)
      const file = files[new URL(request.url).pathname]
      if (!file) {
        return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } })
      }
      const headers = { 'content-type': file.type, 'cache-control': 'public', etag: '"v1"' }
      if (request.headers.has('if-none-match')) {
        return new Response(null, {
          status: 304,
          headers: { ...headers, 'cache-control': 'public, max-age=0, must-revalidate' },
        })
      }
      return new Response(request.method === 'HEAD' ? null : file.body, { headers })
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
  it('serves the shell for a deep link with browser headers', async () => {
    const { call, requests } = setup()
    const response = await call('/dashboard/profile?tab=keys', {
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
      'https://site.example/dashboard/profile?tab=keys',
      'https://site.example/',
    ])
  })

  it('returns existing assets unchanged', async () => {
    const { call } = setup()
    const response = await call('/existing.js')
    expect(await response.text()).toBe('javascript')
    expect(response.headers.get('content-type')).toBe('application/javascript')
    expect(response.headers.get('vary')).toBeNull()
  })

  it.each(['/assets/missing.js', '/assets/missing', '/missing.js', '//assets/missing'])(
    'keeps missing file %s as a non-HTML 404',
    async (path) => {
      const { call, requests } = setup()
      const response = await call(path)
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).not.toContain('text/html')
      expect(requests).toHaveLength(1)
    },
  )

  it.each(['/assets/missing.js', '//assets/missing.js'])(
    'never falls back under the asset prefix for HTML navigation to %s',
    async (path) => {
      const { call, requests } = setup()
      const response = await call(path, { headers: { accept: 'text/html' } })
      expect(response.status).toBe(404)
      expect(requests).toHaveLength(1)
    },
  )

  it('lets Accept choose between the shell and the 404 on a dotted miss, and says so', async () => {
    const { call } = setup()
    const page = await call('/users/jane.doe', {
      headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    })
    expect(await page.text()).toBe('<html>shell</html>')
    expect(page.headers.get('vary')).toBe('Accept')
    const data = await call('/users/jane.doe', { headers: { accept: 'application/json' } })
    expect(data.status).toBe(404)
    expect(data.headers.get('vary')).toBe('Accept')
    const refused = await call('/users/jane.doe', {
      headers: { accept: 'application/json, text/html;q=0' },
    })
    expect(refused.status).toBe(404)
  })

  it('preserves HEAD on asset and shell requests', async () => {
    const { call, requests } = setup()
    const response = await call('/dashboard', { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
    expect(requests.map((request) => request.method)).toEqual(['HEAD', 'HEAD'])
  })

  it.each([
    '/api',
    '/api/unknown',
    '/API/unknown',
    '/%61pi/unknown',
    '//api/unknown',
    '/health',
    '/%E0%A4%A',
  ])('routes %s to API even for navigation', async (path) => {
    const { call, api, requests } = setup()
    const response = await call(path, {
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    })
    expect(await response.json()).toEqual({ source: 'api' })
    expect(api).toHaveBeenCalledOnce()
    expect(requests).toHaveLength(0)
  })

  it('passes a 304 for a built file under the asset prefix through unchanged', async () => {
    const { call } = setup()
    const response = await call('/assets/app.js', { headers: { 'if-none-match': '"v1"' } })
    expect(response.status).toBe(304)
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
  })

  it.each([
    ['/', 'text/html'],
    ['/guide.v2', '*/*'],
  ])(
    'answers a revalidation of HTML at %s in full, so it keeps its headers',
    async (path, accept) => {
      const { call, requests } = setup({ shellHeaders: { 'cache-control': 'private, no-cache' } })
      const response = await call(path, {
        headers: { accept, 'if-none-match': '"v1"', 'if-modified-since': 'x' },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('private, no-cache')
      expect(requests[0]?.headers.has('if-none-match')).toBe(false)
      expect(requests[0]?.headers.has('if-modified-since')).toBe(false)
    },
  )

  it('returns JSON 405 with Allow and a request id for non-API methods', async () => {
    const { call, requests, api } = setup()
    const response = await call('/dashboard', { method: 'POST' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = (await response.json()) as { error: { code: string }; requestId: string }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(response.headers.get('x-request-id')).toBe(body.requestId)
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
