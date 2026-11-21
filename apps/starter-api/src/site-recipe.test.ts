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
    const page = await worker.fetch('/dashboard?token=secret', { headers: { accept: 'text/html' } })
    expect(page.status).toBe(200)
    expect(page.headers.get('cache-control')).toBe('no-cache')
    expect(await page.text()).toContain('starter site fixture')
    // `/` matches index.html: only run_worker_first puts the shell headers (and a CSP) on it.
    const root = await worker.fetch('/', { headers: { accept: 'text/html' } })
    expect(root.status).toBe(200)
    expect(root.headers.get('cache-control')).toBe('no-cache')
    expect(root.headers.get('x-frame-options')).toBe('DENY')
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
    const api = await worker.fetch('/api/missing', {
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    })
    expect(api.status).toBe(404)
    expect(api.headers.get('content-type')).toContain('application/json')
  } finally {
    await worker.stop()
  }
}, 30_000)
