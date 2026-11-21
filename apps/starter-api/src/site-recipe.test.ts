import { fileURLToPath, URL } from 'node:url'
import { expect, it } from 'vitest'
import { unstable_dev } from 'wrangler'

it('routes the production Wrangler recipe through local Static Assets', async () => {
  const config = fileURLToPath(new URL('./site-fixtures/wrangler.toml', import.meta.url))
  const entry = fileURLToPath(new URL('./index.ts', import.meta.url))
  const worker = await unstable_dev(entry, {
    config,
    env: 'production',
    local: true,
    port: 0,
    logLevel: 'error',
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
  })
  try {
    const page = await worker.fetch('/dashboard?tab=keys', { headers: { accept: 'text/html' } })
    expect(page.status).toBe(200)
    expect(page.headers.get('cache-control')).toBe('no-cache')
    expect(await page.text()).toContain('starter site fixture')
    // `/` matches index.html: only run_worker_first puts the shell headers (and a CSP) on it.
    const root = await worker.fetch('/', { headers: { accept: 'text/html' } })
    expect(root.status).toBe(200)
    expect(root.headers.get('cache-control')).toBe('no-cache')
    expect(root.headers.get('x-frame-options')).toBe('DENY')
    // A revalidating navigation still gets the full shell with its headers, never a 304.
    const etag = root.headers.get('etag')
    expect(etag).toBeTruthy()
    const revalidated = await worker.fetch('/', {
      headers: { accept: 'text/html', 'if-none-match': etag ?? '' },
    })
    expect(revalidated.status).toBe(200)
    expect(revalidated.headers.get('cache-control')).toBe('no-cache')
    // Static Assets canonical redirects keep the browser's query.
    const canonical = await worker.fetch('/index.html?lang=fr', { redirect: 'manual' })
    expect(canonical.status).toBeGreaterThanOrEqual(300)
    expect(canonical.status).toBeLessThan(400)
    expect(new URL(canonical.headers.get('location') ?? '', 'http://x').search).toBe('?lang=fr')
    const robots = await worker.fetch('/robots.txt')
    expect(robots.status).toBe(200)
    expect(robots.headers.get('content-type')).toContain('text/plain')
    expect(await robots.text()).toContain('Disallow: /private')
    const asset = await worker.fetch('/assets/app-123abc.css')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('text/css')
    expect(await asset.text()).toContain('static asset')
    const missing = await worker.fetch('/assets/missing.js', { headers: { accept: 'text/html' } })
    expect(missing.status).toBe(404)
    expect(missing.headers.get('content-type') ?? '').not.toContain('text/html')
    // Static Assets alone answers under /assets/*: through the Worker this would be a JSON 405.
    const post = await worker.fetch('/assets/missing.js', { method: 'POST' })
    expect(post.status).toBe(404)
    expect(post.headers.get('x-request-id')).toBeNull()
    const api = await worker.fetch('/api/missing', {
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    })
    expect(api.status).toBe(404)
    expect(api.headers.get('content-type')).toContain('application/json')
  } finally {
    await worker.stop()
  }
}, 30_000)
