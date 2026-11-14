import { describe, expect, it } from 'vitest'
import { isPasswordSignInPath, normalizePasswordSignInResponse } from './sign-in-anti-enum'

function req(path: string, method = 'POST') {
  return new Request(`http://localhost${path}`, { method })
}

describe('normalizePasswordSignInResponse', () => {
  it('only targets POST /api/auth/sign-in/email', () => {
    expect(isPasswordSignInPath('/api/auth/sign-in/email')).toBe(true)
    expect(isPasswordSignInPath('/api/auth/sign-in/email/')).toBe(true)
    expect(isPasswordSignInPath('/api/auth/sign-in/magic-link')).toBe(false)
    expect(isPasswordSignInPath('/api/auth/sign-up/email')).toBe(false)
  })

  it('passes through success and rate-limit', async () => {
    const ok = new Response('{}', { status: 200, headers: { 'set-cookie': 'session=1' } })
    const outOk = normalizePasswordSignInResponse(req('/api/auth/sign-in/email'), ok, 'req_1')
    expect(outOk).toBe(ok)
    expect(outOk.headers.get('set-cookie')).toBe('session=1')

    const rl = new Response('slow down', { status: 429 })
    expect(normalizePasswordSignInResponse(req('/api/auth/sign-in/email'), rl, 'req_2')).toBe(rl)
  })

  it('collapses 400 and 401 BA failures to identical 401 kit envelope', async () => {
    const bad400 = new Response(JSON.stringify({ message: 'User not found' }), { status: 400 })
    const bad401 = new Response(JSON.stringify({ message: 'Invalid password' }), {
      status: 401,
      headers: { 'set-cookie': 'should-not-leak=1' },
    })
    const a = normalizePasswordSignInResponse(req('/api/auth/sign-in/email'), bad400, 'req_a')
    const b = normalizePasswordSignInResponse(req('/api/auth/sign-in/email'), bad401, 'req_b')
    expect(a.status).toBe(401)
    expect(b.status).toBe(401)
    const bodyA = (await a.json()) as {
      error: { code: string; message: string }
      requestId: string
    }
    const bodyB = (await b.json()) as {
      error: { code: string; message: string }
      requestId: string
    }
    expect(bodyA.error).toEqual(bodyB.error)
    expect(bodyA.error.code).toBe('UNAUTHORIZED')
    expect(bodyA.error.message).toBe('Invalid email or password')
    expect(bodyA.requestId).toBe('req_a')
    expect(a.headers.get('set-cookie')).toBeNull()
    expect(b.headers.get('set-cookie')).toBeNull()
  })

  it('does not rewrite other auth paths', () => {
    const res = new Response('x', { status: 400 })
    const out = normalizePasswordSignInResponse(req('/api/auth/sign-up/email'), res, 'req_x')
    expect(out).toBe(res)
  })
})
