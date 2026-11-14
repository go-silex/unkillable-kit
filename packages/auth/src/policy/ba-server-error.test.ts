import { describe, expect, it } from 'vitest'
import { scrubBetterAuthServerError } from './ba-server-error'

describe('scrubBetterAuthServerError', () => {
  it('passes 2xx and 4xx through unchanged', async () => {
    const ok = new Response('{"status":true}', { status: 200 })
    expect(scrubBetterAuthServerError(ok, 'req_1')).toBe(ok)
    const four = new Response('{"code":"INVALID"}', { status: 400 })
    expect(scrubBetterAuthServerError(four, 'req_1')).toBe(four)
    const limited = new Response('rate', { status: 429 })
    expect(scrubBetterAuthServerError(limited, 'req_1')).toBe(limited)
  })

  it('replaces 5xx BA body with kit INTERNAL_ERROR and keeps status', async () => {
    const leak = new Response('{"message":"ECONNRESET postgres://secret"}', { status: 503 })
    const scrubbed = scrubBetterAuthServerError(leak, 'req_abc')
    expect(scrubbed.status).toBe(503)
    const body = (await scrubbed.json()) as {
      error: { code: string; message: string }
      requestId: string
    }
    expect(body.error.code).toBe('INTERNAL_ERROR')
    expect(body.error.message).toBe('Internal error')
    expect(body.requestId).toBe('req_abc')
    const text = JSON.stringify(body)
    expect(text).not.toMatch(/postgres|secret|ECONNRESET/i)
  })
})
